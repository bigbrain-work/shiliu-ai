import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withCredentialRefreshLock } from "../src/credential-refresh-lock.js";
import { resolveAuthorization } from "../src/authorization.js";
import { createProxySession } from "../src/proxy-session.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-refresh-process-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, "synthetic-credentials.json"),
    JSON.stringify({
      accessToken: "synthetic-old",
      refreshToken: "synthetic-refresh",
      expiresAt: 0,
    }),
  );
  return root;
}
function child(root, url, mode, slot) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      [
        path.resolve("test-support/refresh-process.js"),
        root,
        url,
        mode,
        path.join(root, `cli-${slot}`),
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...globalThis.process.env, HOME: root, USERPROFILE: root },
      },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      process.kill();
      reject(new Error("refresh process timeout"));
    }, 12000);
    process.stdout.on("data", (x) => {
      stdout += x;
    });
    process.stderr.on("data", (x) => {
      stderr += x;
    });
    process.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr));
    });
  });
}
for (const mode of ["locked", "legacy", "default-home"])
  test(
    `two processes recover to ready with ${mode} refresh`,
    { timeout: 15000 },
    async (t) => {
      const root = await fixture(t);
      let calls = 0;
      const waiting = [];
      const reply = (res, status, body) =>
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      const server = createServer(async (req, res) => {
        const data = [];
        for await (const chunk of req) data.push(chunk);
        const request = JSON.parse(Buffer.concat(data).toString());
        assert.equal(request.refresh_token, "synthetic-refresh");
        calls++;
        if (mode === "legacy") {
          waiting.push(res);
          if (waiting.length < 2) return;
          reply(waiting[0], 200, {
            access_token: "synthetic-new",
            refresh_token: "synthetic-next",
            expires_in: 3600,
          });
          reply(waiting[1], 400, { error: "invalid_grant" });
        } else
          reply(
            res,
            calls === 1 ? 200 : 400,
            calls === 1
              ? {
                  access_token: "synthetic-new",
                  refresh_token: "synthetic-next",
                  expires_in: 3600,
                }
              : { error: "invalid_grant" },
          );
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const url = `http://127.0.0.1:${server.address().port}`;
        const results = await Promise.all([
          child(root, url, mode, "a"),
          child(root, url, mode, "b"),
        ]);
        for (const result of results) {
          assert.equal(result.status, "ready");
          assert.equal(result.business_tool_count, 1);
        }
        assert.equal(calls, mode === "legacy" ? 2 : 1);
        if (mode === "default-home") {
          assert.deepEqual(await readdir(path.join(root, ".shiliu-ai")), []);
          for (const slot of ["a", "b"]) {
            await assert.rejects(readdir(path.join(root, `cli-${slot}`)), {
              code: "ENOENT",
            });
          }
        }
        assert.equal(
          JSON.parse(
            await readFile(
              path.join(root, "synthetic-credentials.json"),
              "utf8",
            ),
          ).refreshToken,
          "synthetic-next",
        );
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

test("lock releases after refresh failure and stale process locks can be recovered", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    withCredentialRefreshLock(
      async () => {
        throw new Error("fixture failure");
      },
      { home: root },
    ),
    /fixture failure/u,
  );
  assert.equal(
    await withCredentialRefreshLock(async () => "released", { home: root }),
    "released",
  );
  assert.deepEqual(await readdir(path.join(root, ".shiliu-ai")), []);
  const stale = path.join(root, ".shiliu-ai", "credential-refresh.lock");
  await mkdir(stale);
  const old = new Date(Date.now() - 180000);
  await utimes(stale, old, old);
  assert.equal(
    await withCredentialRefreshLock(async () => "recovered", { home: root }),
    "recovered",
  );
});

test(
  "a held refresh lock reports credential unavailable, deduplicates polls and recovers without login",
  { timeout: 5000 },
  async (t) => {
    const root = await fixture(t);
    let acquired, unblock;
    const ready = new Promise((resolve) => {
      acquired = resolve;
    });
    const held = new Promise((resolve) => {
      unblock = resolve;
    });
    const owner = withCredentialRefreshLock(
      async () => {
        acquired();
        await held;
      },
      { home: root },
    );
    await ready;
    let reads = 0,
      refreshes = 0,
      connections = 0,
      lockError;
    let stored = {
      accessToken: "synthetic-old",
      refreshToken: "synthetic-spent",
      expiresAt: 0,
    };
    const diagnostics = [];
    const session = createProxySession({
      resolveAuth: () =>
        resolveAuthorization({
          home: path.join(root, "alternate-cli-home"),
          tokenStore: {
            load: async () => {
              reads++;
              return stored;
            },
            save: async (value) => {
              stored = value;
            },
          },
          authClient: {
            refresh: async () => {
              refreshes++;
              return {
                access_token: "synthetic-new",
                refresh_token: "synthetic-next",
                expires_in: 3600,
              };
            },
          },
          // Use the real lock implementation with no retries to exercise exhaustion promptly.
          withRefreshLock: (operation) =>
            withCredentialRefreshLock(operation, {
              home: root,
              retries: 0,
            }).catch((error) => {
              lockError = error;
              throw error;
            }),
        }),
      reportDiagnostic: (code) => diagnostics.push(code),
      connectRemote: async () => {
        connections++;
        return {
          getServerCapabilities: () => ({ tools: {} }),
          listTools: async () => ({ tools: [{ name: "echo" }] }),
          close: async () => {},
        };
      },
    });
    try {
      const first = session.refresh();
      assert.equal(session.refresh(), first);
      await first;
      assert.equal(lockError.code, "ELOCKED");
      assert.equal(reads, 1);
      assert.equal(refreshes, 0);
      assert.equal(connections, 0);
      assert.equal(session.snapshot().code, "CREDENTIAL_UNAVAILABLE");
      assert.equal(session.snapshot().status, "credential_unavailable");
      assert.equal(session.snapshot().mcp_connected, true);
      assert.equal(diagnostics.includes("AUTH_EXPIRED"), false);
      assert.doesNotMatch(
        JSON.stringify(session.snapshot()),
        /synthetic-|扫码/u,
      );
      unblock();
      await owner;
      await session.refresh();
      assert.equal(session.snapshot().code, "CONNECTION_READY");
      assert.equal(refreshes, 1);
      assert.equal(connections, 1);
      assert.deepEqual(
        session.tools().map((tool) => tool.name),
        ["echo"],
      );
    } finally {
      unblock();
      await owner;
      await session.close();
    }
  },
);
