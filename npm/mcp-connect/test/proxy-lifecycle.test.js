import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode,
  ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProxySession } from "../src/proxy-session.js";
import { runProxy } from "../src/proxy.js";
import { connectRecoveringRemote } from "../src/recovering-remote.js";
import { runToolCall } from "../src/tool-call.js";
import { createRequestContext } from "../src/request-context.js";

const tool = (name = "echo") => ({ name, inputSchema: { type: "object", properties: {} } });
const result = (text) => ({ content: [{ type: "text", text }] });
const gate = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function until(check) {
  for (let n = 0; n < 100; n += 1) { if (check()) return; await delay(5); }
  assert.fail("Expected state was not reached");
}

async function sdkRemote(t, { list = async () => ({ tools: [tool()] }), call = async () => result("ok") } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "synthetic-remote", version: "1" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, (request) => list(request.params));
  server.setRequestHandler(CallToolRequestSchema, call);
  await server.connect(serverTransport);
  const client = new Client({ name: "synthetic-client", version: "1" });
  await client.connect(clientTransport);
  let closes = 0;
  const close = client.close.bind(client);
  client.close = async () => { closes += 1; await close(); };
  t.after(() => server.close());
  return { client, server, closes: () => closes };
}

test("token rotation drains old calls, routes new calls to the new client and ignores old notifications", async (t) => {
  let token = "a", changes = 0;
  const started = gate(), finish = gate();
  const a = await sdkRemote(t, { call: async () => { started.resolve(); await finish.promise; return result("a"); } });
  const b = await sdkRemote(t, { list: async () => ({ tools: [tool("new")] }), call: async () => result("b") });
  const session = createProxySession({ resolveAuth: async () => ({ token }),
    connectRemote: async ({ token }) => (token === "a" ? a : b).client, onToolsChanged: () => { changes += 1; } });
  t.after(() => session.close());
  await session.refresh();
  const oldCall = session.invoke("callTool", { name: "echo", arguments: {} });
  await started.promise;
  token = "b";
  await session.refresh();
  assert.equal(a.closes(), 0);
  const changesBefore = changes;
  await a.server.sendToolListChanged();
  await delay(5);
  assert.equal(changes, changesBefore);
  assert.deepEqual(session.tools().map((entry) => entry.name), ["new"]);
  assert.equal((await session.invoke("callTool", { name: "new", arguments: {} })).result.content[0].text, "b");
  finish.resolve();
  assert.equal((await oldCall).result.content[0].text, "a");
  await until(() => a.closes() === 1);
});

test("a failed replacement preserves the healthy old connection and complete catalog", async (t) => {
  let token = "a";
  const old = await sdkRemote(t);
  const session = createProxySession({ resolveAuth: async () => ({ token }), connectRemote: async ({ token }) => {
    if (token === "b") throw new Error("synthetic network failure");
    return old.client;
  } });
  t.after(() => session.close());
  await session.refresh(); token = "b"; await session.refresh();
  assert.equal(old.closes(), 0);
  assert.equal(session.snapshot().remote_connected, true);
  assert.equal((await session.invoke("callTool", { name: "echo", arguments: {} })).result.content[0].text, "ok");
  assert.equal(session.tools().length, 1);
});

test("business RPC failures preserve connection and catalog; invalid_grant gates calls without removing tools", async (t) => {
  let invalid = false, calls = 0, changes = 0;
  const remote = await sdkRemote(t, { call: async () => { calls += 1; throw new McpError(-32603, "business 401 token invalid"); } });
  const session = createProxySession({ resolveAuth: async () => {
    if (invalid) throw Object.assign(new Error("expired"), { code: "invalid_grant" });
    return { token: "a" };
  }, connectRemote: async () => remote.client, onToolsChanged: () => { changes += 1; } });
  t.after(() => session.close());
  await session.refresh();
  await assert.rejects(session.invoke("callTool", { name: "echo", arguments: {} }), { code: -32603 });
  assert.equal(calls, 1); assert.equal(remote.closes(), 0); assert.equal(changes, 1);
  invalid = true; await session.refresh();
  assert.equal(session.snapshot().code, "AUTH_EXPIRED");
  assert.equal(session.tools().length, 1); assert.equal(changes, 1);
  assert.equal((await session.invoke("callTool", { name: "echo", arguments: {} })).unavailable.code, "AUTH_EXPIRED");
  assert.equal(calls, 1);
});

test("live catalog notification replaces only a complete paginated snapshot", async (t) => {
  let version = 1, failedPage = false, changes = 0;
  const remote = await sdkRemote(t, { list: async (params) => {
    if (!params?.cursor) return { tools: [tool(`first-${version}`)], nextCursor: "two" };
    if (failedPage) throw new McpError(-32603, "second page failed");
    return { tools: [tool(`second-${version}`)] };
  } });
  const session = createProxySession({ resolveAuth: async () => ({ token: "a" }), connectRemote: async () => remote.client,
    onToolsChanged: () => { changes += 1; } });
  t.after(() => session.close());
  await session.refresh(); assert.equal(session.tools().length, 2);
  version = 2; failedPage = true;
  await remote.server.sendToolListChanged(); await delay(20);
  assert.deepEqual(session.tools().map((entry) => entry.name), ["first-1", "second-1"]);
  assert.equal(changes, 1);
  failedPage = false; await remote.server.sendToolListChanged();
  await until(() => changes === 2);
  assert.deepEqual(session.tools().map((entry) => entry.name), ["first-2", "second-2"]);
  assert.equal(session.snapshot().status, "ready");
});

test("SDK option positions, per-request progress tokens and cancellation are isolated through the proxy", async (t) => {
  const cancelled = [], finished = gate(), bothStarted = gate();
  let starts = 0;
  const remote = await sdkRemote(t, { call: async (request, extra) => {
    const id = request.params.arguments.id;
    extra.signal.addEventListener("abort", () => cancelled.push(id), { once: true });
    await extra.sendNotification({ method: "notifications/progress", params: {
      progressToken: request.params._meta.progressToken, progress: id, total: 999,
    } });
    if (++starts === 2) bothStarted.resolve();
    await finished.promise;
    return result(String(id));
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const proxy = await runProxy({ transport: serverTransport, resolveAuth: async () => ({ token: "a" }),
    remoteConnector: async () => remote.client, pollIntervalMs: 0,
    diagnosticReporter: { record: async () => {}, path: "", available: () => false } });
  const client = new Client({ name: "native-protocol-fixture", version: "1" });
  await client.connect(clientTransport);
  t.after(async () => { finished.resolve(); await client.close(); await proxy.close(); });
  await client.listTools();
  await client.ping(); await client.ping();
  const controller = new AbortController(), firstProgress = [], secondProgress = [];
  const first = client.callTool({ name: "echo", arguments: { id: 101 } }, undefined,
    { signal: controller.signal, onprogress: (progress) => firstProgress.push(progress.progress) });
  const firstRejected = assert.rejects(first);
  const second = client.callTool({ name: "echo", arguments: { id: 202 } }, undefined,
    { onprogress: (progress) => secondProgress.push(progress.progress) });
  await bothStarted.promise;
  await until(() => firstProgress.length === 1 && secondProgress.length === 1);
  assert.deepEqual(firstProgress, [101]); assert.deepEqual(secondProgress, [202]);
  controller.abort(); await firstRejected;
  await until(() => cancelled.includes(101));
  assert.deepEqual(cancelled, [101]);
  assert.equal(remote.closes(), 0);
  finished.resolve();
  assert.equal((await second).content[0].text, "202");
  assert.equal(proxy.session.snapshot().status, "ready");
});

test("progress resets idle timeout and a hard total deadline still cancels only that request", async (t) => {
  let cancelled = 0, calls = 0;
  const remote = await sdkRemote(t, { call: async (request, extra) => {
    calls += 1;
    extra.signal.addEventListener("abort", () => { cancelled += 1; }, { once: true });
    if (request.params.arguments.hang) {
      await delay(10);
      await extra.sendNotification({ method: "notifications/progress", params: {
        progressToken: request.params._meta.progressToken, progress: 1,
      } });
      await new Promise((resolve) => extra.signal.addEventListener("abort", resolve, { once: true }));
      return result("late");
    }
    for (let step = 1; step <= 5; step += 1) {
      await delay(20);
      await extra.sendNotification({ method: "notifications/progress", params: {
        progressToken: request.params._meta.progressToken, progress: step,
      } });
    }
    return result("progress completed");
  } });
  const recovering = await connectRecoveringRemote({ resolveAuthorization: async () => ({ token: "a" }), connectRemote: async () => remote.client });
  t.after(() => recovering.close());
  const progress = [];
  assert.equal((await recovering.invoke("callTool", { name: "echo", arguments: {} }, {
    timeoutMs: 60, deadline: Date.now() + 1000, onprogress: (p) => progress.push(p.progress),
  })).content[0].text, "progress completed");
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  const started = Date.now();
  await assert.rejects(recovering.invoke("callTool", { name: "echo", arguments: { hang: true } }, {
    timeoutMs: 1000, deadline: Date.now() + 70,
  }), (error) => error.code === ErrorCode.RequestTimeout && /总时长/u.test(error.message));
  assert.ok(Date.now() - started < 600);
  await until(() => cancelled === 1);
  assert.equal(calls, 2); assert.equal(remote.closes(), 0);
});

test("idle timeout without progress cancels the request while keeping the connection", async (t) => {
  let cancelled = false, calls = 0;
  const remote = await sdkRemote(t, { call: async (_request, extra) => {
    calls += 1;
    await new Promise((resolve) => extra.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
    return result("late");
  } });
  const recovering = await connectRecoveringRemote({ resolveAuthorization: async () => ({ token: "a" }), connectRemote: async () => remote.client });
  t.after(() => recovering.close());
  await assert.rejects(recovering.invoke("callTool", { name: "echo", arguments: {} }, {
    timeoutMs: 30, deadline: Date.now() + 1000,
  }), { code: ErrorCode.RequestTimeout });
  await until(() => cancelled);
  assert.equal(calls, 1); assert.equal(remote.closes(), 0);
});

test("CLI SIGINT during authentication prevents dispatch and removes its signal handler", async () => {
  const auth = gate(), started = gate(), processImpl = new EventEmitter();
  let connects = 0;
  const running = runToolCall({ toolName: "echo", argumentsValue: {}, processImpl,
    resolveAuth: async () => { started.resolve(); return auth.promise; },
    connect: async () => { connects += 1; throw new Error("must not connect"); },
  });
  const rejected = assert.rejects(running, { code: "REQUEST_CANCELLED" });
  await started.promise;
  processImpl.emit("SIGINT");
  await rejected;
  auth.resolve({ token: "a" }); await delay(5);
  assert.equal(connects, 0); assert.equal(processImpl.listenerCount("SIGINT"), 0);
});

test("shutdown is bounded during connection setup and closes a late candidate once", async () => {
  const connector = gate(), started = gate();
  let closes = 0;
  const session = createProxySession({ resolveAuth: async () => ({ token: "a" }),
    connectRemote: async () => { started.resolve(); return connector.promise; } });
  const refreshing = session.refresh(); await started.promise;
  await session.close(); await refreshing;
  connector.resolve({ close: async () => { closes += 1; } });
  await until(() => closes === 1);
  assert.equal(session.snapshot().remote_connected, false);
  assert.deepEqual(session.tools(), []);
});

test("an already expired deadline cannot dispatch an operation before its timer fires", async () => {
  const context = createRequestContext({ deadline: Date.now() - 1 });
  let calls = 0;
  try {
    await assert.rejects(context.run(() => { calls += 1; }), { code: ErrorCode.RequestTimeout });
    assert.throws(() => context.options(), { code: ErrorCode.RequestTimeout });
    assert.equal(calls, 0);
  } finally { context.dispose(); }
});

test("CLI call finds a second-page tool and rejects repeated cursors without execution", async () => {
  let calls = 0, repeat = false, closed = 0;
  const connector = async () => ({
    invoke: async (method, params) => {
      if (method === "callTool") { calls += 1; return result("second page"); }
      return params?.cursor
        ? { tools: [tool("target")], ...(repeat ? { nextCursor: "two" } : {}) }
        : { tools: [tool("first")], nextCursor: "two" };
    }, close: async () => { closed += 1; },
  });
  assert.equal((await runToolCall({ toolName: "target", argumentsValue: {}, connectRecovering: connector })).content[0].text, "second page");
  repeat = true;
  await assert.rejects(runToolCall({ toolName: "target", argumentsValue: {}, connectRecovering: connector }), /Repeated tool cursor/u);
  assert.equal(calls, 1); assert.equal(closed, 2);
});
