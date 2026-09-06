import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArguments } from "../src/arguments.js";

test("defaults to smart install", () => {
  assert.deepEqual(parseCliArguments([]), {
    command: "install",
    agent: undefined,
    dryRun: false,
    home: undefined,
    url: undefined,
    json: false,
    help: false,
    version: false,
  });
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
