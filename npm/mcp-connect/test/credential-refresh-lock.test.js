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
function child(root, url, mode) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      [path.resolve("test-support/refresh-process.js"), root, url, mode],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
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
for (const mode of ["locked", "legacy"])
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
          child(root, url, mode),
          child(root, url, mode),
        ]);
        for (const result of results) {
          assert.equal(result.status, "ready");
          assert.equal(result.business_tool_count, 1);
        }
        assert.equal(calls, mode === "locked" ? 1 : 2);
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
