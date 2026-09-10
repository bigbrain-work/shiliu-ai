import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createSystemEntry,
  PendingLoginStore,
  runKeyringWorker,
  TokenStore,
} from "../src/token-store.js";

test("sends keyring secrets through stdin instead of process arguments", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let invocation;
  let input;
  child.stdin = {
    end(value) {
      input = value;
      child.stdout.write('{"ok":true}');
      queueMicrotask(() => child.emit("close", 0));
    },
  };

  await runKeyringWorker(
    { operation: "set", password: "never-in-process-list" },
    {
      spawnImpl(command, args, options) {
        invocation = { command, args, options };
        return child;
      },
    },
  );

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args.length, 1);
  assert.equal(invocation.args.join(" ").includes("never-in-process-list"), false);
  assert.equal(JSON.parse(input).password, "never-in-process-list");
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
});

test("uses a short-lived keyring worker on Windows", async () => {
  const requests = [];
  const entry = await createSystemEntry("test-account", {
    platform: "win32",
    runWorker: async (request) => {
      requests.push(request);
      if (request.operation === "get") return { value: "saved-value" };
      return { ok: true };
    },
  });

  await entry.setPassword("secret-value");
  assert.equal(await entry.getPassword(), "saved-value");
  await entry.deletePassword();

  assert.deepEqual(requests, [
    {
      operation: "set",
      service: "work.bigbrain.shiliu-ai",
      account: "test-account",
      password: "secret-value",
    },
    {
      operation: "get",
      service: "work.bigbrain.shiliu-ai",
      account: "test-account",
    },
    {
      operation: "delete",
      service: "work.bigbrain.shiliu-ai",
      account: "test-account",
    },
  ]);
});

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
    qrCodePath: "C:\\Temp\\shiliu-login-ABCD-2345.png",
    qrCodeValue: "https://example.test/authorize",
  };

  await store.save(pending);
  assert.deepEqual(await store.load(), pending);
  await store.clear();
  assert.equal(await store.load(), null);
});
