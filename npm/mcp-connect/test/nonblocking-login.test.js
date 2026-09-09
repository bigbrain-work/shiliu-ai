import assert from "node:assert/strict";
import test from "node:test";

import { buildLoginInstructions } from "../src/cli.js";

test("machine-readable login continuation returns an Agent-displayable QR image", () => {
  const result = buildLoginInstructions(
    {
      device_code: "secret-device-code-that-must-not-be-returned",
      user_code: "ABCD-2345",
      verification_uri_complete:
        "https://example.test/authorize?state=public-state",
      expires_in: 600,
    },
    { qrCodePath: "C:\\Temp\\shiliu-ai\\shiliu-login-ABCD-2345.png" },
  );
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "authorization_pending");
  assert.equal(result.login_session_id, "ABCD-2345");
  assert.match(result.poll_command, /--session ABCD-2345 --wait --json/u);
  assert.equal(result.qr_code_mime_type, "image/png");
  assert.match(result.qr_code_path, /shiliu-login-ABCD-2345\.png$/u);
  assert.match(result.next_action_hint, /二维码已由石榴 CLI 生成/u);
  assert.match(result.next_action_hint, /展示 qr_code_path/u);
  assert.match(result.next_action_hint, /不要把 verification_uri 当作普通网页打开/u);
  assert.equal(serialized.includes("secret-device-code"), false);
  assert.equal(Object.hasOwn(result, "device_code"), false);
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
