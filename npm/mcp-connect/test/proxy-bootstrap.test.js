import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { runProxy, LOGIN_TOOLS } from "../src/proxy.js";
import { createProxySession, refreshBriefly } from "../src/proxy-session.js";
import { loginCommandArguments, safeLoginResult } from "../src/proxy-login.js";

const loginNames = LOGIN_TOOLS.map((tool) => tool.name);
const echo = { name: "echo", inputSchema: { type: "object", properties: {} } };

async function fixture(options = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const proxy = await runProxy({
    transport: serverTransport, resolveAuth: async () => ({ token: "" }),
    diagnosticReporter: { path: "", available: () => false, record: async () => {} },
    pollIntervalMs: 0, ...options,
  });
  const client = new Client({ name: "bootstrap-test", version: "1" });
  await client.connect(clientTransport, { timeout: 1000 });
  return { client, proxy, close: async () => { await client.close(); await proxy.close(); } };
}

test("no credentials: actual stdio initialize/list succeeds and business calls stay gated", { timeout: 10000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve("test-support/anonymous-proxy-entry.js")], stderr: "pipe",
  });
  const client = new Client({ name: "anonymous-client", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport, { timeout: 2000 });
    assert.equal(client.getServerCapabilities().tools.listChanged, true);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), loginNames);
    const denied = await client.callTool({ name: "echo", arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.status, "login_required");
    assert.deepEqual(await client.ping(), {});
    assert.equal(stderr, "");
  } finally { await client.close(); }
});

test("initialize is independent of a stalled credential store", async () => {
  let release;
  const credential = new Promise((resolve) => { release = resolve; });
  const { client, proxy, close } = await fixture({ resolveAuth: () => credential });
  try {
    assert.deepEqual(await client.ping(), {});
    await refreshBriefly(proxy.session, 10);
    assert.equal(proxy.session.snapshot().status, "checking_login");
  } finally { release({ token: "" }); await close(); }
});

test("login tools authorize on the existing connection and notify catalog changes without leaking secrets", async () => {
  let token = "";
  let exchanges = 0;
  let notifications = 0;
  let connections = 0;
  const { client, proxy, close } = await fixture({
    resolveAuth: async () => ({ token }),
    remoteConnector: async ({ token: supplied }) => {
      assert.equal(supplied, "test-private-token");
      connections += 1;
      return {
        getServerCapabilities: () => ({ tools: {} }), close: async () => {},
        listTools: async () => ({ tools: [echo] }),
        callTool: async () => ({ content: [{ type: "text", text: "business-ok" }] }),
      };
    },
    loginRunner: async (action, options) => {
      if (action === "start") return { status: "authorization_pending", login_session_id: "TEST-1234", poll_after_seconds: 5, device_code: "private-device-code" };
      assert.equal(options.session, "TEST-1234");
      exchanges += 1;
      if (exchanges === 1) return { status: "authorization_pending", login_session_id: "TEST-1234", poll_after_seconds: 5 };
      token = "test-private-token";
      return { status: "success", tool_count: 1, access_token: token, refresh_token: "private-refresh-token" };
    },
  });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications += 1; });
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), loginNames);
    const start = await client.callTool({ name: "shiliu_login", arguments: {} });
    assert.equal(start.structuredContent.status, "authorization_pending");
    assert.doesNotMatch(JSON.stringify(start), /private-device-code|device_code/u);
    const pollParams = { name: "shiliu_login_poll", arguments: { session: "TEST-1234" } };
    assert.equal((await client.callTool(pollParams)).structuredContent.status, "authorization_pending");
    const success = await client.callTool(pollParams);
    assert.equal(success.structuredContent.status, "success");
    assert.doesNotMatch(JSON.stringify(success), /test-private-token|private-refresh-token|access_token|refresh_token/u);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [...loginNames, "echo"]);
    assert.ok(notifications >= 1);
    assert.equal(connections, 1);
    assert.equal((await client.callTool({ name: "echo", arguments: {} })).content[0].text, "business-ok");
    // Unsupported optional features must not discard a working business connection.
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listPrompts(), { prompts: [] });
    assert.equal(proxy.session.snapshot().status, "ready");
    token = "";
    const status = await client.callTool({ name: "shiliu_connection_status", arguments: {} });
    assert.equal(status.structuredContent.status, "login_required");
    assert.equal(status.structuredContent.mcp_connected, true);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), loginNames);
    assert.deepEqual(await client.ping(), {});
  } finally { await close(); }
});

test("external login is discovered by the running proxy without reconnect", async () => {
  let token = "";
  const { client, close } = await fixture({
    pollIntervalMs: 25,
    resolveAuth: async () => ({ token }),
    remoteConnector: async () => ({
      getServerCapabilities: () => ({ tools: {} }), listTools: async () => ({ tools: [echo] }), close: async () => {},
    }),
  });
  try {
    await client.listTools();
    const changed = new Promise((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
    token = "external-token";
    let timer;
    try { await Promise.race([changed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No tools notification")), 1000); })]); }
    finally { clearTimeout(timer); }
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "echo"));
  } finally { await close(); }
});

test("remote outage and rejected credentials leave bootstrap connection usable", async () => {
  let rejected = false;
  const { client, close } = await fixture({
    resolveAuth: async () => ({ token: "test-token" }),
    remoteConnector: async () => { throw Object.assign(new Error("private transport diagnostic"), rejected ? { status: 401 } : {}); },
  });
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), loginNames);
    const failure = await client.callTool({ name: "echo", arguments: {} });
    assert.equal(failure.structuredContent.status, "remote_unavailable");
    assert.doesNotMatch(JSON.stringify(failure), /private transport/u);
    rejected = true;
    const status = await client.callTool({ name: "shiliu_connection_status", arguments: {} });
    assert.equal(status.structuredContent.status, "login_required");
    assert.deepEqual(await client.ping(), {});
  } finally { await close(); }
});

test("business validation errors preserve the connection and paginated catalog is complete", async () => {
  const session = createProxySession({
    resolveAuth: async () => ({ token: "test" }),
    connectRemote: async () => ({
      getServerCapabilities: () => ({ tools: {} }), close: async () => {},
      listTools: async (params) => params?.cursor ? { tools: [{ name: "second" }] } : { tools: [echo], nextCursor: "page-2" },
      callTool: async () => { throw new McpError(ErrorCode.InvalidParams, "Invalid arguments"); },
    }),
  });
  try {
    await session.refresh();
    assert.deepEqual(session.tools().map((tool) => tool.name), ["echo", "second"]);
    await assert.rejects(session.invoke("callTool", {}), { code: ErrorCode.InvalidParams });
    assert.equal(session.snapshot().remote_connected, true);
  } finally { await session.close(); }
});

test("credentials revoked during a business call keep MCP alive and a new login restores tools", async () => {
  let token = "old-token";
  let revoked = false;
  const { client, close } = await fixture({
    resolveAuth: async () => ({ token }),
    remoteConnector: async ({ token: supplied }) => {
      if (revoked && supplied === "old-token") throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
      return {
        getServerCapabilities: () => ({ tools: {} }), listTools: async () => ({ tools: [echo] }), close: async () => {},
        callTool: async () => {
          if (revoked && supplied === "old-token") throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
          return { content: [{ type: "text", text: "restored" }] };
        },
      };
    },
  });
  try {
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "echo"));
    revoked = true;
    const failure = await client.callTool({ name: "echo", arguments: {} });
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent.status, "login_required");
    assert.deepEqual(await client.ping(), {});
    token = "new-token";
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "echo"));
    assert.equal((await client.callTool({ name: "echo", arguments: {} })).content[0].text, "restored");
  } finally { await close(); }
});

test("login subprocess arguments are fixed, and login output uses a safe field allowlist", () => {
  assert.deepEqual(loginCommandArguments("poll", { session: "TEST-1234" }), ["login", "poll", "--session", "TEST-1234", "--json"]);
  assert.throws(() => loginCommandArguments("poll", { session: "$(calc)" }));
  const safe = safeLoginResult({ status: "success", tool_count: 27, access_token: "private", refresh_token: "private", device_code: "private", message: "private" }, true);
  assert.doesNotMatch(JSON.stringify(safe), /private|access_token|refresh_token|device_code/u);
});
