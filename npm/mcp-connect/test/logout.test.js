import assert from "node:assert/strict";
import test from "node:test";

import { logout } from "../src/cli.js";

test("revokes remotely before clearing local credentials", async () => {
  const events = [];
  await logout({
    home: "C:\\test-home",
    dryRun: false,
    authUrl: "https://api.bigbrain.work/shiliu/auth/device",
    tokenStore: {
      load: async () => ({ refreshToken: "refresh-secret" }),
      clear: async () => events.push("clear-token"),
    },
    pendingLoginStore: {
      clear: async () => events.push("clear-pending"),
    },
    clientFactory: () => ({
      revoke: async (token) => {
        assert.equal(token, "refresh-secret");
        events.push("revoke");
      },
    }),
    clearLegacyApiKey: async () => events.push("clear-legacy"),
  });

  assert.deepEqual(events, [
    "revoke",
    "clear-token",
    "clear-pending",
    "clear-legacy",
  ]);
});

test("keeps all local credentials when remote revoke fails", async () => {
  const events = [];
  await assert.rejects(
    logout({
      home: "C:\\test-home",
      dryRun: false,
      authUrl: "https://api.bigbrain.work/shiliu/auth/device",
      tokenStore: {
        load: async () => ({ refreshToken: "refresh-secret" }),
        clear: async () => events.push("clear-token"),
      },
      pendingLoginStore: {
        clear: async () => events.push("clear-pending"),
      },
      clientFactory: () => ({
        revoke: async () => {
          events.push("revoke");
          throw new Error("network unavailable");
        },
      }),
      clearLegacyApiKey: async () => events.push("clear-legacy"),
    }),
    /本机凭据已保留/u,
  );

  assert.deepEqual(events, ["revoke"]);
});
