import {
  KEYRING_ACCOUNT,
  KEYRING_SERVICE,
  PENDING_KEYRING_ACCOUNT,
} from "./constants.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const KEYRING_WORKER_PATH = fileURLToPath(
  new URL("./keyring-worker.js", import.meta.url),
);
const MISSING_ENTRY_PATTERN = /not found|no entry|no matching|credential.*missing/iu;

function workerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateTokenSet(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new Error("本机凭据格式无效，请重新运行 shiliu login");
  }
  return value;
}

export function runKeyringWorker(
  request,
  { spawnImpl = spawn, timeoutMs = 10000, killGraceMs = 1000 } = {},
) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        !Number.isFinite(killGraceMs) || killGraceMs < 0) {
      reject(new TypeError("凭据库等待时间必须是有效的正数"));
      return;
    }
    let child;
    let input;
    try {
      input = JSON.stringify(request);
      child = spawnImpl(process.execPath, [KEYRING_WORKER_PATH], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(workerError("KEYRING_WORKER_FAILED", "无法启动系统凭据库子进程"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopping;
    let timer;
    let killTimer;
    const closeInput = () => {
      try { child.stdin?.destroy?.(); } catch { /* Cleanup cannot prevent settlement. */ }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      closeInput();
      if (error) reject(error);
      else resolve(value);
    };
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = error;
      clearTimeout(timer);
      closeInput();
      if (!child.pid) { finish(error); return; }
      // This is the exact worker we spawned, never a shell or process tree.
      // Wait for close before releasing a caller's refresh lock when possible.
      try { child.kill("SIGKILL"); } catch { /* The deadline remains bounded. */ }
      if (!settled) killTimer = setTimeout(() => finish(error), killGraceMs);
    };
    const ioFailure = () => stop(workerError("KEYRING_WORKER_FAILED", "系统凭据库子进程通信失败"));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled || stopping) return;
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (settled || stopping) return;
      stderr += chunk;
    });
    // Keep guarded error listeners attached: late error/close events are benign.
    child.on("error", ioFailure);
    child.stdin?.on?.("error", ioFailure);
    child.stdout?.on("error", ioFailure);
    child.stderr?.on("error", ioFailure);
    child.on("close", (code) => {
      if (settled) return;
      if (stopping) { finish(stopping); return; }
      if (code !== 0) {
        // Preserve missing-entry semantics without serializing worker output.
        finish(MISSING_ENTRY_PATTERN.test(stderr)
          ? workerError("KEYRING_ENTRY_MISSING", "系统凭据库中未找到条目")
          : workerError("KEYRING_WORKER_FAILED", `凭据库子进程返回退出码 ${code}`));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout));
      } catch {
        finish(workerError("KEYRING_RESPONSE_INVALID", "凭据库子进程返回了无效响应"));
      }
    });
    timer = setTimeout(() => stop(workerError("KEYRING_TIMEOUT", "本机系统凭据库请求超时，请稍后重试")), timeoutMs);
    try { child.stdin.end(input); } catch { ioFailure(); }
  });
}

export async function createSystemEntry(
  account,
  {
    platform = process.platform,
    runWorker = runKeyringWorker,
  } = {},
) {
  if (platform === "win32") {
    return {
      async setPassword(password) {
        await runWorker({
          operation: "set",
          service: KEYRING_SERVICE,
          account,
          password,
        });
      },
      async getPassword() {
        const result = await runWorker({
          operation: "get",
          service: KEYRING_SERVICE,
          account,
        });
        return result.value;
      },
      async deletePassword() {
        await runWorker({
          operation: "delete",
          service: KEYRING_SERVICE,
          account,
        });
      },
    };
  }
  let module;
  try {
    module = await import("@napi-rs/keyring");
  } catch (error) {
    throw new Error(`无法加载系统凭据库：${error.message}`);
  }
  return new module.Entry(KEYRING_SERVICE, account);
}

async function defaultEntryFactory() {
  return createSystemEntry(KEYRING_ACCOUNT);
}

async function defaultPendingEntryFactory() {
  return createSystemEntry(PENDING_KEYRING_ACCOUNT);
}

export class TokenStore {
  constructor({ entryFactory = defaultEntryFactory } = {}) {
    this.entryFactory = entryFactory;
  }

  async save(tokenSet) {
    const entry = await this.entryFactory();
    await entry.setPassword(JSON.stringify(validateTokenSet(tokenSet)));
  }

  async load() {
    const entry = await this.entryFactory();
    try {
      const serialized = await entry.getPassword();
      if (!serialized) return null;
      return validateTokenSet(JSON.parse(serialized));
    } catch (error) {
      if (this.isMissingEntry(error)) return null;
      throw new Error(`无法读取系统凭据库：${error.message}`);
    }
  }

  async clear() {
    const entry = await this.entryFactory();
    try {
      await entry.deletePassword();
    } catch (error) {
      if (!this.isMissingEntry(error)) {
        throw new Error(`无法清除系统凭据库：${error.message}`);
      }
    }
  }

  isMissingEntry(error) {
    return error?.code === "KEYRING_ENTRY_MISSING" ||
      MISSING_ENTRY_PATTERN.test(error?.message || "");
  }
}

function validatePendingLogin(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.sessionId !== "string" ||
    typeof value.deviceCode !== "string" ||
    typeof value.expiresAt !== "number" ||
    typeof value.interval !== "number" ||
    typeof value.authUrl !== "string" ||
    (value.qrCodePath !== undefined && typeof value.qrCodePath !== "string") ||
    (value.qrCodeValue !== undefined &&
      typeof value.qrCodeValue !== "string") ||
    (value.allowLocalhost !== undefined &&
      typeof value.allowLocalhost !== "boolean")
  ) {
    throw new Error("待处理登录会话格式无效，请重新运行 shiliu login");
  }
  return value;
}

export class PendingLoginStore extends TokenStore {
  constructor({ entryFactory = defaultPendingEntryFactory } = {}) {
    super({ entryFactory });
  }

  async save(value) {
    const entry = await this.entryFactory();
    await entry.setPassword(JSON.stringify(validatePendingLogin(value)));
  }

  async load() {
    const entry = await this.entryFactory();
    try {
      const serialized = await entry.getPassword();
      if (!serialized) return null;
      return validatePendingLogin(JSON.parse(serialized));
    } catch (error) {
      if (this.isMissingEntry(error)) return null;
      throw new Error(`无法读取待处理登录会话：${error.message}`);
    }
  }
}
