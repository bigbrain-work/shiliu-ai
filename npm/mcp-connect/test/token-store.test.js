import assert from "node:assert/strict";
import test from "node:test";

import { PendingLoginStore, TokenStore } from "../src/token-store.js";

test("stores token JSON through the operating-system credential entry", async () => {
  let value = null;
  const entry = {
    setPassword: async (next) => {
      value = next;
    },
    getPassword: async () => value,
    deletePassword: async () => {
      value = null;
    },
  };
  const store = new TokenStore({ entryFactory: async () => entry });
  const tokenSet = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 123456789,
    tokenType: "Bearer",
    scope: "mcp",
  };

  await store.save(tokenSet);
  assert.deepEqual(await store.load(), tokenSet);
  assert.equal(value.includes("access"), true);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("stores a pending device code separately from access tokens", async () => {
  let value = null;
  const entry = {
    setPassword: async (next) => {
      value = next;
    },
    getPassword: async () => value,
    deletePassword: async () => {
      value = null;
    },
  };
  const store = new PendingLoginStore({ entryFactory: async () => entry });
  const pending = {
    sessionId: "ABCD-2345",
    deviceCode: "device-code-secret",
    expiresAt: 123456789,
    interval: 5,
    authUrl: "https://example.test/auth/device",
  };

  await store.save(pending);
  assert.deepEqual(await store.load(), pending);
  await store.clear();
  assert.equal(await store.load(), null);
});
