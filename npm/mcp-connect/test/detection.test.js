import assert from "node:assert/strict";
import test from "node:test";

import { commandExists } from "../src/detection.js";

test("uses cmd.exe when detecting npm command shims on Windows", () => {
  let invocation;
  const exists = commandExists(
    "codex",
    (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
    {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    },
  );

  assert.equal(exists, true);
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args, [
    "/d",
    "/s",
    "/c",
    "codex --version",
  ]);
  assert.equal(invocation.options.shell, false);
});

test("rejects unsafe command names before Windows shell detection", () => {
  let called = false;
  assert.equal(
    commandExists("codex & calc", () => {
      called = true;
      return { status: 0 };
    }),
    false,
  );
  assert.equal(called, false);
});
