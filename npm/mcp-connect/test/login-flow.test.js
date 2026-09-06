import assert from "node:assert/strict";
import test from "node:test";

import { verifyAndPersistLogin } from "../src/login-flow.js";

const response = {
  access_token: "issued-access-token",
  refresh_token: "issued-refresh-token",
  expires_in: 3600,
};

test("verifies tools/list before saving an issued token set", async () => {
  const events = [];
  const remote = await verifyAndPersistLogin({
    response,
    client: { revoke: async () => events.push("revoke") },
    tokenStore: { save: async () => events.push("save") },
    url: "https://example.test/mcp",
    probe: async (token, options) => {
      events.push("probe");
      assert.equal(token, "issued-access-token");
      assert.equal(options.url, "https://example.test/mcp");
      return { ok: true, detail: "tools/list 返回 21 个工具" };
    },
  });

  assert.equal(remote.ok, true);
  assert.deepEqual(events, ["probe", "save"]);
});

test("revokes and does not save a token rejected by MCP", async () => {
  const events = [];
  await assert.rejects(
    verifyAndPersistLogin({
      response,
      client: { revoke: async () => events.push("revoke") },
      tokenStore: { save: async () => events.push("save") },
      url: "https://example.test/mcp",
      probe: async () => ({ ok: false, detail: "401 Unauthorized" }),
    }),
    /401 Unauthorized/u,
  );

  assert.deepEqual(events, ["revoke"]);
});

test("revokes an issued token if the operating-system store rejects it", async () => {
  const events = [];
  await assert.rejects(
    verifyAndPersistLogin({
      response,
      client: { revoke: async () => events.push("revoke") },
      tokenStore: {
        save: async () => {
          events.push("save");
          throw new Error("credential store unavailable");
        },
      },
      url: "https://example.test/mcp",
      probe: async () => ({ ok: true, detail: "ok" }),
    }),
    /credential store unavailable/u,
  );

  assert.deepEqual(events, ["save", "revoke"]);
});
