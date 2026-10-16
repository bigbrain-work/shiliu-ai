import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSystemEntry, runKeyringWorker, TokenStore } from "../src/token-store.js";
import { withCredentialRefreshLock } from "../src/credential-refresh-lock.js";
import { resolveAuthorization } from "../src/authorization.js";
import { createProxySession } from "../src/proxy-session.js";

function fakeChild(start = () => {}, onKill) {
  const child = new EventEmitter();
  child.pid = 123456; // Test double only; never passed to a system process API.
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (onKill) return onKill(child);
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  child.stdin.on("finish", () => start(child));
  return child;
}
const run = (child, options = {}) => runKeyringWorker({ operation: "get" }, {
  spawnImpl: () => child, timeoutMs: 15, killGraceMs: 20, ...options,
});
async function temporaryHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-keyring-lock-"));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test("a hung worker times out, closes stdin and kills only its own child", async () => {
  const child = fakeChild(c => {
    c.stdout.write('{"value":"synthetic-secret');
    c.stderr.write("synthetic-secret token invalid 401");
  });
  await assert.rejects(run(child), error => {
    assert.equal(error.code, "KEYRING_TIMEOUT");
    assert.doesNotMatch(error.message, /synthetic|token|401|扫码|登录/u);
    return true;
  });
  assert.equal(child.stdin.destroyed, true);
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  child.emit("error", new Error("late synthetic-secret"));
  child.emit("close", 0);
});

test("worker termination cannot make the request wait without bound", async () => {
  const child = fakeChild(() => {}, () => false);
  await assert.rejects(run(child, { timeoutMs: 5, killGraceMs: 5 }), { code: "KEYRING_TIMEOUT" });
  assert.equal(child.killCalls.length, 1);
  child.emit("close", 0);
});

test("normal close clears the deadline and consumes late error/close races", async () => {
  const child = fakeChild(c => {
    c.stdout.end('{"value":"saved"}');
    c.emit("close", 0);
  });
  assert.deepEqual(await run(child), { value: "saved" });
  await delay(25);
  assert.equal(child.killCalls.length, 0);
  child.emit("error", new Error("late"));
  child.stdin.emit("error", new Error("late pipe"));
  child.stdout.emit("error", new Error("late output"));
  child.emit("close", 1);
});

test("stdin/error/close races settle once without exposing worker data", async () => {
  const child = fakeChild(c => {
    c.stdin.emit("error", new Error("synthetic-secret token invalid"));
    c.emit("error", new Error("synthetic-secret"));
    c.emit("close", 0);
  });
  await assert.rejects(run(child), error => error.code === "KEYRING_WORKER_FAILED" && !error.message.includes("synthetic"));
  assert.equal(child.killCalls.length, 1);
});

test("synchronous spawn/input failures do not leak data or leave a worker running", async () => {
  await assert.rejects(runKeyringWorker({}, { spawnImpl() { throw new Error("synthetic-secret"); } }), error =>
    error.code === "KEYRING_WORKER_FAILED" && !error.message.includes("synthetic"));
  const child = fakeChild();
  child.stdin.end = () => { throw new Error("synthetic-secret"); };
  await assert.rejects(run(child), { code: "KEYRING_WORKER_FAILED" });
  assert.equal(child.killCalls.length, 1);
});

test("partial JSON and early nonzero exit have redacted, distinct failures", async () => {
  await assert.rejects(run(fakeChild(c => {
    c.stdout.write('{"value":"synthetic-secret');
    c.emit("close", 0);
  })), { code: "KEYRING_RESPONSE_INVALID" });
  await assert.rejects(run(fakeChild(c => {
    c.stderr.write("synthetic-secret token invalid 401");
    c.emit("close", 1);
  })), error => error.code === "KEYRING_WORKER_FAILED" && !/synthetic|401|token/u.test(error.message));
});

test("missing entries still load as null and clear without requiring credentials", async () => {
  const entry = await createSystemEntry("fixture", {
    platform: "win32",
    runWorker: request => runKeyringWorker(request, { spawnImpl: () => fakeChild(c => {
      c.stderr.write("No matching entry found");
      c.emit("close", 1);
    }) }),
  });
  const store = new TokenStore({ entryFactory: async () => entry });
  assert.equal(await store.load(), null);
  await store.clear();
});

test("a real hung process has exited before the timeout rejects", { timeout: 8000 }, async () => {
  let child;
  await assert.rejects(runKeyringWorker({ operation: "get" }, {
    timeoutMs: 500,
    killGraceMs: 2000,
    spawnImpl(command, _args, options) {
      child = spawn(command, [path.resolve("test-support/keyring-hang.js")], {
        ...options, env: { ...process.env, SHILIU_KEYRING_HANG_FIXTURE: "1" },
      });
      return child;
    },
  }), { code: "KEYRING_TIMEOUT" });
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("a timed out worker releases the refresh lock before another owner proceeds", async t => {
  const home = await temporaryHome(t);
  let closed = false;
  const child = fakeChild(() => {}, c => {
    queueMicrotask(() => { closed = true; c.emit("close", null); });
    return true;
  });
  await assert.rejects(withCredentialRefreshLock(() => run(child), { home, retries: 0 }), { code: "KEYRING_TIMEOUT" });
  assert.equal(await withCredentialRefreshLock(() => {
    assert.equal(closed, true);
    return "recovered";
  }, { home, retries: 0 }), "recovered");
});

test("proxy reports CREDENTIAL_UNAVAILABLE and recovers on the next deduplicated refresh", async t => {
  const home = await temporaryHome(t);
  let attempts = 0;
  let connections = 0;
  const serialized = JSON.stringify({ accessToken: "synthetic", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000 });
  const entry = await createSystemEntry("fixture", {
    platform: "win32",
    runWorker: request => {
      attempts++;
      return runKeyringWorker(request, { timeoutMs: 10, spawnImpl: () => fakeChild(c => {
        if (attempts === 1) return;
        c.stdout.write(JSON.stringify({ value: serialized }));
        c.emit("close", 0);
      }) });
    },
  });
  const tokenStore = new TokenStore({ entryFactory: async () => entry });
  const session = createProxySession({
    resolveAuth: () => resolveAuthorization({ home, tokenStore, env: {} }),
    connectRemote: async () => {
      connections++;
      return { getServerCapabilities: () => ({}), listTools: async () => ({ tools: [{ name: "fixture_tool" }] }), close: async () => {} };
    },
  });
  try {
    await Promise.all([session.refresh(), session.refresh()]);
    assert.equal(session.snapshot().code, "CREDENTIAL_UNAVAILABLE");
    assert.equal(attempts, 1);
    assert.equal(connections, 0);
    await Promise.all([session.refresh(), session.refresh()]);
    assert.equal(session.snapshot().code, "CONNECTION_READY");
    assert.equal(attempts, 2);
    assert.equal(connections, 1);
  } finally { await session.close(); }
});
