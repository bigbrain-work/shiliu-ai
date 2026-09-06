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
