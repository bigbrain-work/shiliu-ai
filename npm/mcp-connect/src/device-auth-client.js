import { lstat, mkdtemp, open, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

import QRCode from "qrcode";

import { AUTH_URL } from "./constants.js";
import { isNetworkError } from "./cli-errors.js";

export class DeviceAuthError extends Error {
  constructor(code, message, status, details = {}) {
    super(message || code);
    this.name = "DeviceAuthError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function requestJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = payload.response || payload;
    throw new DeviceAuthError(
      body.error || "request_failed",
      body.error_description || body.message || `HTTP ${response.status}`,
      response.status,
      body,
    );
  }
  return payload;
}

export class DeviceAuthClient {
  constructor({ baseUrl = AUTH_URL, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
  }

  start() {
    return requestJson(
      `${this.baseUrl}/code`,
      { method: "POST" },
      this.fetchImpl,
    );
  }

  exchange(deviceCode) {
    return requestJson(
      `${this.baseUrl}/token`,
      { method: "POST", body: JSON.stringify({ device_code: deviceCode }) },
      this.fetchImpl,
    );
  }

  refresh(refreshToken) {
    return requestJson(
      `${this.baseUrl}/refresh`,
      { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) },
      this.fetchImpl,
    );
  }

  revoke(refreshToken) {
    return requestJson(
      `${this.baseUrl}/revoke`,
      { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) },
      this.fetchImpl,
    );
  }
}

export function normalizeTokenResponse(response, now = Date.now()) {
  if (
    typeof response?.access_token !== "string" ||
    typeof response?.refresh_token !== "string" ||
    !Number.isFinite(Number(response?.expires_in))
  ) {
    throw new Error("授权服务返回的令牌格式无效");
  }
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: now + Number(response.expires_in) * 1000,
    tokenType: response.token_type || "Bearer",
    scope: response.scope || "mcp",
  };
}

export async function renderQrCode(value) {
  return QRCode.toString(value, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "M",
  });
}

const QR_CODE_PREFIX = "shiliu-login-";
function isManagedQrCodePath(filePath, temporaryDirectory = os.tmpdir()) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const resolvedPath = path.resolve(filePath);
  return (
    path.dirname(path.dirname(resolvedPath)) === path.resolve(temporaryDirectory) &&
    /^shiliu-ai-[A-Za-z0-9_-]+$/u.test(path.basename(path.dirname(resolvedPath))) &&
    path.basename(resolvedPath).startsWith(QR_CODE_PREFIX) &&
    path.extname(resolvedPath).toLowerCase() === ".png"
  );
}

async function assertPrivateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
    throw new Error("拒绝使用非私有或符号链接二维码目录");
  }
}

export async function readLoginQrCode(filePath, { temporaryDirectory = os.tmpdir() } = {}) {
  if (!isManagedQrCodePath(filePath, temporaryDirectory)) return null;
  await assertPrivateDirectory(path.dirname(filePath));
  const info = await lstat(filePath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 ||
      (process.platform !== "win32" && info.uid !== BigInt(process.getuid()))) throw new Error("二维码文件不安全");
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat({ bigint: true });
    // Windows lstat.dev is zero while fstat.dev is the volume serial number.
    if (current.ino !== info.ino || (process.platform !== "win32" && current.dev !== info.dev) || current.size > 1024 * 1024) throw new Error("二维码文件已变化");
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function createLoginQrCode(
  value,
  sessionId,
  { temporaryDirectory = os.tmpdir() } = {},
) {
  if (!/^[A-Z0-9-]{4,64}$/u.test(sessionId)) {
    throw new Error("登录会话编号格式无效");
  }
  const directory = await mkdtemp(path.join(temporaryDirectory, "shiliu-ai-"));
  await assertPrivateDirectory(directory);
  const filePath = path.join(directory, `${QR_CODE_PREFIX}${sessionId}.png`);
  try {
  const bytes = await QRCode.toBuffer(value, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 480,
  });
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
  return path.resolve(filePath);
  } catch (error) {
    await unlink(filePath).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw error;
  }
}

export async function removeLoginQrCode(
  filePath,
  { temporaryDirectory = os.tmpdir() } = {},
) {
  if (!isManagedQrCodePath(filePath, temporaryDirectory)) return false;
  await assertPrivateDirectory(path.dirname(filePath));
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await rmdir(path.dirname(filePath)).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
  return true;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function exchangeWithNetworkRetry(client, deviceCode, deadline, {
  sleep = defaultSleep, now = Date.now, maxNetworkRetries = 3,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    if (now() >= deadline) throw new DeviceAuthError("expired_token", "登录二维码已过期，请重试");
    try { return await client.exchange(deviceCode); }
    catch (error) {
      if (!(isNetworkError(error) || (error instanceof DeviceAuthError && error.status >= 500)) || attempt >= maxNetworkRetries) throw error;
      await sleep(Math.min(1000 * 2 ** (attempt + 1), Math.max(0, deadline - now())));
    }
  }
}

export async function waitForDeviceAuthorization(
  start,
  client,
  { sleep = defaultSleep, now = Date.now, onPending = () => {}, maxNetworkRetries = 3 } = {},
) {
  const deadline = now() + Number(start.expires_in) * 1000;
  let intervalSeconds = Number(start.interval) || 5;
  let networkFailures = 0;

  while (now() < deadline) {
    await sleep(Math.min(intervalSeconds * 1000, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    try {
      return await client.exchange(start.device_code);
    } catch (error) {
      if (isNetworkError(error) || (error instanceof DeviceAuthError && error.status >= 500)) {
        if (++networkFailures > maxNetworkRetries) throw error;
        intervalSeconds = Math.min(30, Math.max(intervalSeconds, 2 ** networkFailures));
        continue;
      }
      networkFailures = 0;
      if (!(error instanceof DeviceAuthError)) throw error;
      const previousInterval = intervalSeconds;
      const serverInterval = Number(error.details?.retry_after_seconds);
      if (Number.isFinite(serverInterval) && serverInterval > 0) intervalSeconds = Math.max(intervalSeconds, serverInterval);
      if (error.code === "authorization_pending") {
        onPending();
        continue;
      }
      if (error.code === "slow_down") {
        intervalSeconds = Math.max(previousInterval + 5, serverInterval || 0);
        continue;
      }
      throw error;
    }
  }
  throw new DeviceAuthError("expired_token", "登录二维码已过期，请重试");
}
