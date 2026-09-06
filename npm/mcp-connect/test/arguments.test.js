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
    legacyApiKey: false,
    noWait: false,
    wait: false,
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
    "mcp",
    "proxy",
    "update",
  ]) {
    assert.equal(parseCliArguments([command]).command, command);
  }
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
});
