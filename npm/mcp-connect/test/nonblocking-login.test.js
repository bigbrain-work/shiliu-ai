import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLoginInstructions,
  buildPendingPollResult,
  formatCliError,
  startPendingDeviceLogin,
} from "../src/cli.js";
import { DeviceAuthError } from "../src/device-auth-client.js";

test("machine-readable login continuation returns an Agent-displayable QR image", () => {
  const result = buildLoginInstructions(
    {
      device_code: "secret-device-code-that-must-not-be-returned",
      user_code: "ABCD-2345",
      verification_uri_complete:
        "https://example.test/authorize?state=public-state",
      expires_in: 600,
      interval: 5,
    },
    { qrCodePath: "C:\\Temp\\shiliu-ai\\shiliu-login-ABCD-2345.png" },
  );
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "authorization_pending");
  assert.equal(result.login_session_id, "ABCD-2345");
  assert.match(result.poll_command, /--session ABCD-2345 --json$/u);
  assert.equal(result.poll_after_seconds, 5);
  assert.equal(result.latest_qr_only, true);
  assert.equal(result.mobile_confirmation_required, false);
  assert.equal(result.qr_code_mime_type, "image/png");
  assert.match(result.qr_code_path, /shiliu-login-ABCD-2345\.png$/u);
  assert.match(result.next_action_hint, /二维码已由石榴 CLI 生成/u);
  assert.match(result.next_action_hint, /qr_code_path 本地图片/u);
  assert.match(result.next_action_hint, /旧二维码/u);
  assert.match(result.next_action_hint, /立即运行 poll_command/u);
  assert.match(result.next_action_hint, /手机端没有二次确认按钮/u);
  assert.match(result.next_action_hint, /不要把 verification_uri 当作网页打开/u);
  assert.equal(serialized.includes("secret-device-code"), false);
  assert.equal(Object.hasOwn(result, "device_code"), false);
});

test("pending poll results tell Agents when to retry without blocking", () => {
  const result = buildPendingPollResult(
    {
      sessionId: "ABCD-2345",
      interval: 5,
      expiresAt: 31_000,
    },
    1_000,
  );

  assert.deepEqual(result, {
    status: "authorization_pending",
    login_session_id: "ABCD-2345",
    poll_after_seconds: 5,
    expires_in: 30,
    poll_command: "shiliu login poll --session ABCD-2345 --json",
    next_action_hint:
      "等待 poll_after_seconds 后自动再次运行 poll_command；不要等待用户回复。用户只需微信扫码。",
  });
});

test("slow-down results expose the increased polling interval", () => {
  const result = buildPendingPollResult(
    {
      sessionId: "ABCD-2345",
      interval: 10,
      expiresAt: 31_000,
    },
    1_000,
    "slow_down",
  );

  assert.equal(result.status, "slow_down");
  assert.equal(result.poll_after_seconds, 10);
  assert.match(result.next_action_hint, /轮询过快/u);
});

test("pending poll results preserve the server authorization stage", () => {
  const result = buildPendingPollResult(
    {
      sessionId: "ABCD-2345",
      interval: 5,
      expiresAt: 31_000,
    },
    1_000,
    "authorization_pending",
    { authorization_stage: "processing_callback" },
  );

  assert.equal(result.authorization_stage, "processing_callback");
});

test("an unexpired pending login is reused instead of creating another session", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "shiliu-reuse-login-"),
  );
  const qrCodePath = path.join(temporaryDirectory, "existing.png");
  await writeFile(qrCodePath, "existing-qr", "utf8");
  const saved = [];
  const pendingLoginStore = {
    async load() {
      return {
        sessionId: "ABCD-2345",
        deviceCode: "secret-device-code",
        expiresAt: Date.now() + 60_000,
        interval: 5,
        authUrl: "https://example.test/auth/device",
        qrCodePath,
        qrCodeValue: "https://example.test/authorize",
      };
    },
    async save(value) {
      saved.push(value);
    },
  };
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(value);
  try {
    await startPendingDeviceLogin({
      authUrl: "https://example.test/auth/device",
      allowLocalhost: false,
      json: true,
      pendingLoginStore,
    });
  } finally {
    console.log = originalLog;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  assert.equal(saved.length, 0);
  const result = JSON.parse(output.join("\n"));
  assert.equal(result.reused_session, true);
  assert.equal(result.login_session_id, "ABCD-2345");
  assert.equal(result.qr_code_path, qrCodePath);
});

test("machine-readable errors distinguish expiry, rejection, and networking", () => {
  assert.deepEqual(
    formatCliError(
      new DeviceAuthError("expired_token", "expired", 400, {
        authorization_stage: "expired",
        expires_in: 0,
      }),
    ),
    {
      status: "expired",
      error: "expired_token",
      message: "expired",
      authorization_stage: "expired",
      expires_in: 0,
    },
  );
  assert.equal(
    formatCliError(new DeviceAuthError("access_denied", "denied", 400))
      .status,
    "rejected",
  );
  assert.equal(formatCliError(new TypeError("fetch failed")).status, "network_error");
});

test("machine-readable continuation rejects a command-injection user code", () => {
  assert.throws(
    () =>
      buildLoginInstructions({
        device_code: "secret-device-code",
        user_code: "ABCD-2345 && calc",
        verification_uri_complete: "https://example.test/authorize",
        expires_in: 600,
      }),
    /登录会话编号格式无效/u,
  );
});
