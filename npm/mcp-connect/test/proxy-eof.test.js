import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const shell of [false, ...(process.platform === "win32" ? [true] : [])]) {
  test(`stdin EOF with an in-flight remote call exits ${shell ? "cmd wrapper and Node" : "Node"} without replay`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-eof-"));
    let started, calls = 0;
    const callStarted = new Promise((resolve) => { started = resolve; });
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      let result;
      if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion,
        serverInfo: { name: "local-only", version: "1" }, capabilities: { tools: {} } };
      else if (message.method === "tools/list") result = { tools: [{ name: "hang", inputSchema: { type: "object" } }] };
      else if (message.method === "tools/call") { calls += 1; started(); return; }
      else { response.writeHead(500).end(); return; }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const entry = path.resolve("test-support/lifecycle-proxy-entry.js");
    const pidFile = path.join(root, "node.pid");
    const child = shell
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${process.execPath}" "${entry}""`], {
        windowsHide: true, windowsVerbatimArguments: true, env: environment(), stdio: ["pipe", "pipe", "pipe"],
      })
      : spawn(process.execPath, [entry], { windowsHide: true, env: environment(), stdio: ["pipe", "pipe", "pipe"] });
    function environment() { return { ...process.env,
      SHILIU_LIFECYCLE_FIXTURE_URL: `http://127.0.0.1:${server.address().port}/mcp`,
      SHILIU_LIFECYCLE_HOME: root, SHILIU_LIFECYCLE_PID_FILE: pidFile }; }
    const ended = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const replies = new Map();
    let buffer = "", malformed = false;
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { const message = JSON.parse(line); replies.get(message.id)?.(message); }
        catch { malformed = true; }
      }
    });
    child.stderr.resume();
    function send(id, method, params) {
      const response = new Promise((resolve) => { replies.set(id, resolve); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    }
    async function bounded(promise) {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture timed out")), 6000);
      })]); } finally { clearTimeout(timer); }
    }
    try {
      await bounded(send(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "eof-fixture", version: "1" } }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const catalog = await bounded(send(2, "tools/list", {}));
      assert.ok(catalog.result.tools.some((tool) => tool.name === "hang"));
      void send(3, "tools/call", { name: "hang", arguments: {} });
      await bounded(callStarted);
      const start = Date.now(); child.stdin.end();
      const exit = await bounded(ended);
      assert.equal(exit.code, 0);
      assert.ok(Date.now() - start < 5000);
      assert.equal(calls, 1); assert.equal(malformed, false);
      const pid = Number(await readFile(pidFile, "utf8"));
      if (shell) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await ended; }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
