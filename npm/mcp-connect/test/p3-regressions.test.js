import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCliInvocation, parseCliArguments } from "../src/arguments.js";
import { formatCliErrorPayload } from "../src/cli-errors.js";
import { inspectRepairLock, processStartIdentity } from "../src/repair-lock-state.js";
import { createSystemEntry, runKeyringWorker, TokenStore } from "../src/token-store.js";
import { resolveAuthorization } from "../src/authorization.js";
import { verifyAndPersistLogin } from "../src/login-flow.js";

test("invocation and strict parsing agree on a lone dash option value", () => {
  for (const args of [["--home", "-", "mcp"], ["-a", "-", "mcp"], ["--args", "-", "call", "x"]]) {
    const expected = args.at(-1) === "mcp" ? "mcp" : "call";
    assert.equal(inspectCliInvocation(args).command, expected);
    if (args[0] === "--home") assert.equal(parseCliArguments(args).command, expected);
  }
});

test("user supplied text cannot classify argument errors as network failures", () => {
  for (const name of ["--network", "--ECONNRESET", "--timeout", "--fetch failed"]) {
    assert.equal(formatCliErrorPayload(new Error(name)).error, "command_failed");
  }
  assert.equal(formatCliErrorPayload(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })).error, "network_error");
  const cyclic = new Error("network"); cyclic.cause = cyclic;
  assert.equal(formatCliErrorPayload(cyclic).error, "command_failed");
});

test("repair checks process identity and recovers only old empty files", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, process_start: "previous-process" }));
  assert.equal((await inspectRepairLock(lock, { startIdentity: async () => "new-process" })).state, "stale");
  const identity = await processStartIdentity(process.pid);
  await writeFile(lock, JSON.stringify({ pid: process.pid, process_start: identity }));
  assert.equal((await inspectRepairLock(lock)).state, "active");
  await writeFile(lock, "");
  assert.equal((await inspectRepairLock(lock)).state, "unknown");
  await utimes(lock, new Date(0), new Date(0));
  assert.equal((await inspectRepairLock(lock)).state, "stale");
});

test("rotated credentials survive real hung write workers and retry persistence without login", async () => {
  let stored = JSON.stringify({ accessToken: "old", refreshToken: "spent", expiresAt: 0 });
  let hang = true, writes = 0, refreshes = 0;
  const entry = await createSystemEntry("synthetic", { platform: "win32", runWorker: async (request, options) => {
    if (request.operation === "get") return { value: stored };
    writes++;
    if (hang) return runKeyringWorker(request, { ...options, timeoutMs: 60, spawnImpl: (_exe, _args, opts) =>
      spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"], opts) });
    stored = request.password; return { ok: true };
  } });
  const factory = async () => entry;
  const store = new TokenStore({ entryFactory: factory });
  const authClient = { refresh: async token => {
    refreshes++; assert.equal(token, "spent");
    return { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 };
  } };
  const options = { tokenStore: store, authClient, withRefreshLock: op => op(), now: () => 1000 };
  assert.equal((await resolveAuthorization(options)).token, "rotated-access");
  assert.equal(writes, 2);
  // A different default-lifetime store instance shares process recovery state.
  const other = new TokenStore({ entryFactory: factory });
  assert.equal((await resolveAuthorization({ ...options, tokenStore: other })).token, "rotated-access");
  assert.equal(refreshes, 1);
  hang = false;
  assert.equal((await resolveAuthorization(options)).token, "rotated-access");
  assert.equal(JSON.parse(stored).refreshToken, "rotated-refresh");
  assert.equal(store.pendingSave, undefined);
});

test("post-rotation read failure retains the token and respects a subsequent logout", async () => {
  let reads = 0, stored = { accessToken: "old", refreshToken: "spent", expiresAt: 0 };
  const store = new TokenStore({ entryFactory: async () => ({
    getPassword: async () => { if (++reads === 3) throw new Error("unavailable"); return stored && JSON.stringify(stored); },
    setPassword: async () => assert.fail("logout cannot be overwritten"),
  }) });
  const options = { tokenStore: store, withRefreshLock: op => op(), now: () => 1,
    authClient: { refresh: async () => ({ access_token: "new", refresh_token: "new", expires_in: 3600 }) } };
  assert.equal((await resolveAuthorization(options)).token, "new");
  stored = null;
  assert.equal((await resolveAuthorization(options)).source, "none");
});

test("login persistence retries timeout and reports memory-only credentials explicitly", async () => {
  let calls = 0;
  const store = new TokenStore({ entryFactory: async () => ({ setPassword: async () => {
    calls++; throw Object.assign(new Error("timeout"), { code: "KEYRING_TIMEOUT" });
  } }) });
  const remote = await verifyAndPersistLogin({ response: { access_token: "new", refresh_token: "new", expires_in: 3600 },
    client: { revoke: async () => assert.fail("retained token must remain usable") }, tokenStore: store, probe: async () => ({ ok: true }) });
  assert.equal(calls, 2);
  assert.equal(remote.credentialPersisted, false);
  assert.equal((await store.load()).accessToken, "new");
});

test("Windows credential length is checked before invoking the worker", async () => {
  const entry = await createSystemEntry("synthetic", { platform: "win32", runWorker: () => assert.fail("too large") });
  await assert.rejects(entry.setPassword("x".repeat(1281)), { code: "KEYRING_VALUE_TOO_LARGE" });
});
