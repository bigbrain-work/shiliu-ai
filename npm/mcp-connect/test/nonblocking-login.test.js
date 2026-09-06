import assert from "node:assert/strict";
import test from "node:test";

import { buildLoginInstructions } from "../src/cli.js";

test("machine-readable login continuation never exposes the device code", () => {
  const result = buildLoginInstructions({
    device_code: "secret-device-code-that-must-not-be-returned",
    user_code: "ABCD-2345",
    verification_uri_complete:
      "https://example.test/authorize?state=public-state",
    expires_in: 600,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "authorization_pending");
  assert.equal(result.login_session_id, "ABCD-2345");
  assert.match(result.poll_command, /--session ABCD-2345 --wait --json/u);
  assert.equal(serialized.includes("secret-device-code"), false);
  assert.equal(Object.hasOwn(result, "device_code"), false);
});
