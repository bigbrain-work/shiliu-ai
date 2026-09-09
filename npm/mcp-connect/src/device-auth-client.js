import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import QRCode from "qrcode";

import { AUTH_URL } from "./constants.js";

export class DeviceAuthError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = "DeviceAuthError";
    this.code = code;
    this.status = status;
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

const QR_CODE_DIRECTORY = "shiliu-ai";
const QR_CODE_PREFIX = "shiliu-login-";
const QR_CODE_MAX_AGE_MS = 15 * 60 * 1000;

function qrCodeDirectory(temporaryDirectory = os.tmpdir()) {
  return path.resolve(temporaryDirectory, QR_CODE_DIRECTORY);
}

function isManagedQrCodePath(filePath, temporaryDirectory = os.tmpdir()) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const resolvedPath = path.resolve(filePath);
  return (
    path.dirname(resolvedPath) === qrCodeDirectory(temporaryDirectory) &&
    path.basename(resolvedPath).startsWith(QR_CODE_PREFIX) &&
    path.extname(resolvedPath).toLowerCase() === ".png"
  );
}

async function removeStaleQrCodes(directory, now) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(QR_CODE_PREFIX) &&
          entry.name.endsWith(".png"),
      )
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const metadata = await stat(filePath);
        if (now() - metadata.mtimeMs > QR_CODE_MAX_AGE_MS) {
          await unlink(filePath).catch(() => {});
        }
      }),
  );
}

export async function createLoginQrCode(
  value,
  sessionId,
  { temporaryDirectory = os.tmpdir(), now = Date.now } = {},
) {
  if (!/^[A-Z0-9-]{4,64}$/u.test(sessionId)) {
    throw new Error("登录会话编号格式无效");
  }
  const directory = qrCodeDirectory(temporaryDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await removeStaleQrCodes(directory, now);
  const filePath = path.join(directory, `${QR_CODE_PREFIX}${sessionId}.png`);
  await QRCode.toFile(filePath, value, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 480,
  });
  await chmod(filePath, 0o600).catch(() => {});
  return path.resolve(filePath);
}

export async function removeLoginQrCode(
  filePath,
  { temporaryDirectory = os.tmpdir() } = {},
) {
  if (!isManagedQrCodePath(filePath, temporaryDirectory)) return false;
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForDeviceAuthorization(
  start,
  client,
  { sleep = defaultSleep, now = Date.now, onPending = () => {} } = {},
) {
  const deadline = now() + Number(start.expires_in) * 1000;
  let intervalSeconds = Number(start.interval) || 5;

  while (now() < deadline) {
    await sleep(intervalSeconds * 1000);
    try {
      return await client.exchange(start.device_code);
    } catch (error) {
      if (!(error instanceof DeviceAuthError)) throw error;
      if (error.code === "authorization_pending") {
        onPending();
        continue;
      }
      if (error.code === "slow_down") {
        intervalSeconds += 5;
        continue;
      }
      throw error;
    }
  }
  throw new DeviceAuthError("expired_token", "登录二维码已过期，请重试");
}
