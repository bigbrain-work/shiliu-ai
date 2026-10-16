import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startPendingDeviceLogin, pollPendingDeviceLogin } from "../src/cli.js";
import { withCredentialRefreshLock } from "../src/credential-refresh-lock.js";
import { createLoginQrCode, removeLoginQrCode } from "../src/device-auth-client.js";
import { TokenStore } from "../src/token-store.js";
import { resolveAuthorization } from "../src/authorization.js";

test("parallel login starts share one cross-process-locked pending session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-login-lock-"));
  let pending, starts = 0; const output = [], log = console.log;
  console.log = value => output.push(JSON.parse(value));
  try {
    const options = { authUrl: "https://example.test/auth/device", json: true,
      withLock: op => withCredentialRefreshLock(op, { home: root, name: "device-login" }),
      pendingLoginStore: { load: async () => pending, save: async value => { pending = value; } },
      clientFactory: () => ({ start: async () => { starts++; return {
        user_code: "ABCD-2345", device_code: "secret", verification_uri_complete: "https://example.test/qr", expires_in: 600, interval: 5,
      }; } }),
    };
    await Promise.all([startPendingDeviceLogin(options), startPendingDeviceLogin(options)]);
    assert.equal(starts, 1); assert.equal(output.length, 2);
    assert.equal(output.filter(item => item.reused_session).length, 1);
    assert.equal(output[0].qr_code_path, output[1].qr_code_path);
    await removeLoginQrCode(pending.qrCodePath);
  } finally { console.log = log; await rm(root, { recursive: true, force: true }); }
});

for (const failure of ["validation", "save"]) test(`consumed device code is cleared after ${failure} fails`, async () => {
  let pending = { sessionId: "ABCD-2345", deviceCode: "secret", expiresAt: Date.now() + 10000, interval: 1, authUrl: "http://127.0.0.1/auth/device", allowLocalhost: true };
  let revokes = 0;
  await assert.rejects(pollPendingDeviceLogin({ session: "ABCD-2345", json: true,
    tokenStore: { save: async () => { throw new Error("save failed"); } },
    pendingLoginStore: { load: async () => pending, clear: async () => { pending = null; } },
    clientFactory: () => ({ exchange: async () => ({ access_token: "new", refresh_token: "new", expires_in: 3600 }), revoke: async () => { revokes++; } }),
    probe: async () => ({ ok: failure !== "validation", detail: "validation failed" }),
  }));
  assert.equal(pending, null); assert.equal(revokes, 1);
});

test("memory-only rotated token can rotate again without reusing the spent token", async () => {
  const spent = { accessToken: "old", refreshToken: "spent", expiresAt: 0 };
  let writes = 0, clock = 0; const used = [];
  const store = new TokenStore({ entryFactory: async () => ({ getPassword: async () => JSON.stringify(spent), setPassword: async () => {
    writes++; throw Object.assign(new Error("timeout"), { code: "KEYRING_TIMEOUT" });
  } }) });
  const options = { tokenStore: store, withRefreshLock: op => op(), now: () => clock,
    authClient: { refresh: async token => { used.push(token); return { access_token: `access-${used.length}`, refresh_token: `refresh-${used.length}`, expires_in: 120 }; } } };
  assert.equal((await resolveAuthorization(options)).token, "access-1");
  clock = 120000;
  assert.equal((await resolveAuthorization(options)).token, "access-2");
  assert.deepEqual(used, ["spent", "refresh-1"]); assert.ok(writes >= 4);
});
