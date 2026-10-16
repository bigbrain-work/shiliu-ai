import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCliInvocation, parseCliArguments } from "../src/arguments.js";
import { runEntry } from "../src/cli-entry.js";

test("invocation detection agrees with strict parsing and ignores option values", () => {
  for (const argv of [
    [], ["mcp"], ["proxy"], ["--home", "mcp", "status", "--json"],
    ["--agent", "mcp"], ["-a", "proxy"], ["-amcp"], ["-hamcp"],
    ["--agent=proxy"], ["call", "mcp"], ["call", "proxy", "--args=--json"],
    ["--", "mcp"], ["--", "call", "--json"], ["--home", "proxy", "mcp"],
    ["--json", "mcp"], ["--target-dir", "mcp", "skill", "install"],
  ]) {
    const parsed = parseCliArguments(argv);
    assert.deepEqual(inspectCliInvocation(argv), { command: parsed.command, json: parsed.json }, JSON.stringify(argv));
  }
});

test("packaged CLI argument errors preserve specific human and JSON messages without fatal logs", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-cli-errors-"));
  try {
    for (const bin of ["shiliu.js", "mcp-connect.js"]) {
      for (const argv of [
        ["--bogus"], ["--json", "--bogus"], ["login", "--json", "--session", "bad"],
        ["call", "--json"], ["unknown-command", "--json"],
        ["--agent", "mcp", "--bogus"], ["-a", "proxy", "--bogus", "--json"],
        ["call", "mcp", "--bogus", "--json"], ["--home=mcp", "--bogus"],
        ["call", "--", "--json", "extra"], ["--agent=--json", "--bogus"],
      ]) {
        let expected;
        try { parseCliArguments(argv); assert.fail("Expected invalid arguments"); }
        catch (error) { expected = error.message; }
        const result = spawnSync(process.execPath, [path.resolve("bin", bin), ...argv], {
          env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: "utf8", timeout: 10000, windowsHide: true,
        });
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        if (inspectCliInvocation(argv).json) {
          assert.deepEqual(JSON.parse(result.stderr), { status: "error", error: "command_failed", message: expected });
        } else {
          assert.equal(result.stderr.trim(), `错误：${expected}`);
        }
      }
    }
    assert.deepEqual(await readdir(home), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("MCP parse errors still use redacted diagnostics when options precede the command", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-mcp-errors-"));
  try {
    for (const argv of [
      ["mcp", "--unknown-sensitive-fixture-value"],
      ["--home", "proxy", "mcp", "--session", "sensitive-fixture-value"],
      ["--json", "proxy", "--url"], ["--", "mcp", "sensitive-fixture-value"],
    ]) {
      const result = spawnSync(process.execPath, [path.resolve("bin/shiliu.js"), ...argv], {
        env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: "utf8", timeout: 10000, windowsHide: true,
      });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      const record = JSON.parse(result.stderr);
      assert.equal(record.code, "CONFIG_INVALID");
      assert.equal(record.stage, "argument_parse");
      assert.doesNotMatch(result.stderr, /sensitive-fixture-value/u);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("invalid CLI arguments need no CLI dependencies or MCP process handlers", async () => {
  const processImpl = new EventEmitter();
  const stderr = [];
  const originalError = console.error;
  console.error = (...values) => stderr.push(values.join(" "));
  try {
    await runEntry({
      argv: ["--agent", "mcp", "--bogus", "--json"], processImpl,
      loadCli: async () => assert.fail("Argument errors must not load optional dependencies"),
      reporter: { record: () => assert.fail("CLI errors must not create fatal diagnostics") },
    });
    assert.equal(processImpl.exitCode, 1);
    assert.equal(processImpl.eventNames().length, 0);
    assert.equal(JSON.parse(stderr[0]).error, "command_failed");
  } finally { console.error = originalError; }
});

test("option values do not turn ordinary command failures into fatal MCP failures", async () => {
  const { formatCliError, runCli } = await import("../src/cli.js");
  await assert.rejects(runCli(["login", "--session", "bad"]), error =>
    error.message === "登录会话编号格式无效" && error.diagnosticCode === undefined);
  const stderr = [];
  const originalError = console.error;
  console.error = (...values) => stderr.push(values.join(" "));
  try {
    for (const [argv, json] of [
      [["--agent", "mcp", "--json"], true], [["call", "proxy", "--args=--json"], false],
    ]) {
      const processImpl = new EventEmitter();
      await runEntry({
        argv, processImpl,
        loadCli: async () => ({ runCli: async () => { throw new Error("command fixture failed"); }, formatCliError }),
        reporter: { record: () => assert.fail("CLI failures must not emit MCP diagnostics") },
      });
      assert.equal(processImpl.exitCode, 1);
      assert.equal(processImpl.eventNames().length, 0);
      const output = stderr.pop();
      if (json) assert.deepEqual(JSON.parse(output), { status: "error", error: "command_failed", message: "command fixture failed" });
      else assert.equal(output, "错误：command fixture failed");
    }
  } finally { console.error = originalError; }
});
