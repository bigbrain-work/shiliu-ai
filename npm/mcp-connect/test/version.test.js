import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");

test("CLI version always matches package metadata", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("bin/shiliu.js"), "--version"],
    { cwd: path.resolve("."), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageMetadata.version);
});
