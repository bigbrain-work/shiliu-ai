import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createDiagnosticReporter, diagnosticSummary, classifyFatalError, parseDiagnosticOutput, McpDiagnosticError } from "../src/mcp-diagnostics.js";
import { createProxySession } from "../src/proxy-session.js";
import { verifyStdioLaunch } from "../src/doctor.js";
import { supportsNode } from "../src/cli-entry.js";

async function sandbox(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-diagnostics-"));
  try { await run(home); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test("both packaged entry points exit 2 for configuration failures without leaking input", async () => sandbox(async (home) => {
  for (const bin of ["shiliu.js", "mcp-connect.js"]) {
    const result = spawnSync(process.execPath, [path.resolve("bin", bin), "mcp", "--url", "https://user:sensitive-fixture-value@api.bigbrain.work/shiliu/mcp"], {
      env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    const record = JSON.parse(result.stderr.trim());
    assert.equal(record.code, "CONFIG_INVALID");
    assert.equal(record.stage, "endpoint_validation");
    assert.equal(record.exit_code, 2);
    assert.doesNotMatch(result.stderr, /sensitive-fixture-value|https:\/\//u);
    assert.ok((await readFile(record.diagnostic_path, "utf8")).includes("CONFIG_INVALID"));
  }
}));

test("invalid command arguments exit 2 and report a safe argument_parse diagnostic", async () => sandbox(async (home) => {
  const result = spawnSync(process.execPath, [path.resolve("bin/shiliu.js"), "mcp", "--unknown-sensitive-fixture-value"], {
    env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr.trim()).stage, "argument_parse");
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /sensitive-fixture-value/u);
}));

test("dependency load failures exit 3, and early/late internal exceptions exit 4", async () => sandbox(async (home) => {
  for (const [mode, code, exit] of [["runtime", "RUNTIME_UNAVAILABLE", 3], ["internal", "INTERNAL_ERROR", 4], ["late", "INTERNAL_ERROR", 4]]) {
    const result = spawnSync(process.execPath, [path.resolve("test-support/entry-failure.js"), mode], {
      env: { ...process.env, SHILIU_TEST_HOME: home }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, exit, result.stderr);
    assert.equal(result.stdout, "");
    const record = JSON.parse(result.stderr.trim());
    assert.equal(record.code, code);
    assert.equal(record.fatal, true);
    assert.equal(record.exit_code, exit);
    assert.doesNotMatch(result.stderr, /sensitive-fixture-value/u);
    assert.ok((await readFile(record.diagnostic_path, "utf8")).includes(code));
  }
}));

test("diagnostics rotate a bounded local file and never serialize error details", async () => sandbox(async (home) => {
  let stderr = "";
  const reporter = createDiagnosticReporter({ home, stderr: { write: (line) => { stderr += line; } }, maxBytes: 700 });
  for (let index = 0; index < 5; index += 1) await reporter.record("REMOTE_UNAVAILABLE", { stage: "remote_initialize" });
  assert.equal(reporter.available(), true);
  assert.ok((await readFile(`${reporter.path}.1`, "utf8")).includes("REMOTE_UNAVAILABLE"));
  const malicious = new McpDiagnosticError("INTERNAL_ERROR", "business_call", "sensitive-fixture-value", { token: "sensitive-fixture-value" });
  const fatal = classifyFatalError(malicious);
  await reporter.record(fatal.code, { stage: fatal.stage, fatal: true, error: malicious });
  assert.doesNotMatch(`${stderr}${await readFile(reporter.path, "utf8")}`, /sensitive-fixture-value|token|stack|cause/u);
  assert.equal(parseDiagnosticOutput(stderr).code, "INTERNAL_ERROR");
}));

test("unwritable diagnostic storage does not crash MCP reporting", async () => sandbox(async (home) => {
  const file = path.join(home, "not-a-directory");
  await writeFile(file, "fixture");
  const reporter = createDiagnosticReporter({ home: file, stderr: { write: () => {} } });
  await reporter.record("LOGIN_REQUIRED", { stage: "credential_resolution" });
  assert.equal(reporter.available(), false);
}));

test("a client closing stderr does not make diagnostic reporting fatal", async () => sandbox(async (home) => {
  const stderr = new EventEmitter();
  stderr.write = () => { queueMicrotask(() => stderr.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }))); };
  const reporter = createDiagnosticReporter({ home, stderr });
  await reporter.record("CONNECTION_CLOSED", { stage: "mcp_shutdown" });
  assert.equal(reporter.available(), true);
  assert.equal(JSON.parse((await readFile(reporter.path, "utf8")).trim()).exit_code, 0);
}));

test("doctor preserves the categorized fatal reason instead of generic Connection closed or raw stderr", async () => sandbox(async (home) => {
  const result = await verifyStdioLaunch({
    definition: { command: process.execPath, args: [path.resolve("bin/shiliu.js"), "mcp", "--unknown-sensitive-fixture-value"] },
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "CONFIG_INVALID");
  assert.equal(result.error_stage, "argument_parse");
  assert.equal(result.process_exit_code, 2);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture-value/u);
}));

test("recoverable connection failures have distinct codes and only log status transitions", async () => {
  let credentials = "missing";
  const records = [];
  const session = createProxySession({
    reportDiagnostic: (code, options) => records.push({ code, ...options }),
    resolveAuth: async () => {
      if (credentials === "missing") return { token: "" };
      throw Object.assign(new Error("sensitive-fixture-value"), credentials === "expired" ? { code: "invalid_grant" } : {});
    },
    connectRemote: async () => assert.fail("No valid credentials"),
  });
  try {
    await session.refresh(); await session.refresh();
    assert.equal(session.snapshot().code, "LOGIN_REQUIRED");
    assert.equal(records.length, 1);
    credentials = "expired"; await session.refresh();
    assert.equal(session.snapshot().code, "AUTH_EXPIRED");
    credentials = "unreadable"; await session.refresh();
    assert.equal(session.snapshot().code, "CREDENTIAL_UNAVAILABLE");
    assert.equal(session.snapshot().mcp_connected, true);
    assert.doesNotMatch(JSON.stringify(records), /sensitive-fixture-value/u);
  } finally { await session.close(); }
});

test("diagnostic parsing ignores raw messages and preserves fatal reasons across shutdown", () => {
  const fatal = { component: "shiliu_mcp", code: "CONFIG_INVALID", stage: "argument_parse", fatal: true, message: "sensitive-fixture-value", stack: "sensitive-fixture-value" };
  const closing = { component: "shiliu_mcp", code: "CONNECTION_CLOSED", stage: "mcp_shutdown" };
  const summary = parseDiagnosticOutput(`${JSON.stringify(fatal)}\n${JSON.stringify(closing)}\nraw sensitive-fixture-value`);
  assert.equal(summary.code, "CONFIG_INVALID");
  assert.doesNotMatch(JSON.stringify(summary), /sensitive-fixture-value/u);
  assert.equal(diagnosticSummary("__proto__", "sensitive-fixture-value", true).code, "INTERNAL_ERROR");
  assert.equal(supportsNode("18.14.0"), false);
  assert.equal(supportsNode("18.14.1"), true);
  assert.equal(supportsNode("22.16.0"), true);
});
