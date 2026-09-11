import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArguments } from "../src/arguments.js";

test("defaults to smart install", () => {
  assert.deepEqual(parseCliArguments([]), {
    command: "install",
    subcommand: undefined,
    agent: undefined,
    dryRun: false,
    home: undefined,
    url: undefined,
    authUrl: undefined,
    allowLocalhost: false,
    legacyApiKey: false,
    noWait: false,
    wait: false,
    force: false,
    transport: "stdio",
    toolName: undefined,
    argumentsJson: undefined,
    argumentsFile: undefined,
    argumentsStdin: false,
    outputPath: undefined,
    skillScope: "project",
    session: undefined,
    json: false,
    help: false,
    version: false,
  });
});

test("parses the nonblocking device login flow", () => {
  const result = parseCliArguments([
    "login",
    "poll",
    "--session",
    "ABCD-2345",
    "--wait",
    "--json",
  ]);
  assert.equal(result.command, "login");
  assert.equal(result.subcommand, "poll");
  assert.equal(result.session, "ABCD-2345");
  assert.equal(result.wait, true);
  assert.equal(result.json, true);
  assert.equal(parseCliArguments(["login", "--no-wait"]).noWait, true);
});

test("supports the formal command surface", () => {
  for (const command of [
    "install",
    "login",
    "logout",
    "status",
    "tools",
    "doctor",
    "mcp",
    "proxy",
    "update",
  ]) {
    assert.equal(parseCliArguments([command]).command, command);
  }
  const skillRefresh = parseCliArguments(["skill", "refresh", "--force"]);
  assert.equal(skillRefresh.command, "skill");
  assert.equal(skillRefresh.subcommand, "refresh");
  assert.equal(skillRefresh.force, true);
  const skillInstall = parseCliArguments([
    "skill",
    "install",
    "--agent",
    "claude-code",
    "--scope",
    "user",
  ]);
  assert.equal(skillInstall.agent, "claude-code");
  assert.equal(skillInstall.skillScope, "user");
  const call = parseCliArguments([
    "call",
    "web_search",
    "--args-file",
    "input.json",
    "--out",
    "result.json",
  ]);
  assert.equal(call.toolName, "web_search");
  assert.equal(call.argumentsFile, "input.json");
  assert.equal(call.outputPath, "result.json");
});

test("rejects command-specific options outside their valid context", () => {
  assert.throws(
    () => parseCliArguments(["status", "--transport", "stdio"]),
    /--transport 仅适用于/u,
  );
  assert.throws(
    () => parseCliArguments(["call", "example", "--force"]),
    /--force 仅能与 --out/u,
  );
  assert.throws(
    () => parseCliArguments(["skill", "install"]),
    /需要 --agent/u,
  );
  assert.throws(
    () => parseCliArguments(["skill", "refresh", "--agent", "codex"]),
    /使用已记录目标/u,
  );
  assert.throws(
    () => parseCliArguments(["install", "--scope", "user"]),
    /--scope 仅适用于/u,
  );
});

test("allows arbitrary safe agent names", () => {
  assert.equal(
    parseCliArguments(["install", "--agent", "openclaw"]).agent,
    "openclaw",
  );
  assert.equal(
    parseCliArguments(["install", "--agent", "work-buddy"]).agent,
    "work-buddy",
  );
});

test("rejects unsafe agent names and extra positionals", () => {
  assert.throws(
    () => parseCliArguments(["install", "--agent", "../unknown"]),
    /客户端名称/u,
  );
  assert.throws(() => parseCliArguments(["status", "extra"]), /无法识别/u);
  assert.throws(() => parseCliArguments(["skill"]), /无法识别/u);
  assert.throws(() => parseCliArguments(["call"]), /指定工具名称/u);
  assert.throws(
    () =>
      parseCliArguments([
        "call",
        "example",
        "--args",
        "{}",
        "--args-stdin",
      ]),
    /只能选择一种/u,
  );
  assert.throws(
    () => parseCliArguments(["doctor", "--transport", "http"]),
    /仅支持/u,
  );
  assert.throws(
    () => parseCliArguments(["login", "poll", "--session", "$(calc)"]),
    /登录会话编号格式无效/u,
  );
});
