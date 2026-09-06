import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { API_KEY_ENV } from "../src/constants.js";

test("dry-run never prints the credential", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-cli-"));
  const apiKey = "sk-test-secret-that-must-not-appear";
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("bin/shiliu.js"),
        "install",
        "--agent",
        "codex",
        "--dry-run",
        "--home",
        home,
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, [API_KEY_ENV]: apiKey },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(`${result.stdout}${result.stderr}`.includes(apiKey), false);
    assert.match(result.stdout, /mcp-connect/u);
    assert.doesNotMatch(result.stdout, /Authorization|Bearer/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unknown agent gets a portable stdio configuration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-generic-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("bin/shiliu.js"),
        "install",
        "--agent",
        "openclaw",
        "--dry-run",
        "--home",
        home,
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, [API_KEY_ENV]: "sk-test-secret-value" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /标准 stdio MCP/u);
    assert.match(result.stdout, /openclaw/u);
    assert.match(result.stdout, /"mcp"/u);
    assert.doesNotMatch(result.stdout, /Authorization.*Bearer/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
