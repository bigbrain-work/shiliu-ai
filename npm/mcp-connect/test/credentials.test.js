import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearPersistedApiKey,
  persistApiKey,
  readPersistedApiKey,
  validateApiKey,
} from "../src/credentials.js";

test("validates credentials without exposing them", () => {
  assert.equal(
    validateApiKey("  sk-valid-example-123  "),
    "sk-valid-example-123",
  );
  assert.throws(() => validateApiKey("short"), /长度/u);
  assert.throws(() => validateApiKey("sk-has whitespace"), /空白/u);
});

test("persists and clears the POSIX compatibility credential", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-credential-"));
  const env = { SHELL: "/bin/bash" };
  try {
    await persistApiKey("sk-test-secret-value", {
      home,
      platform: "linux",
      env,
    });
    assert.equal(
      readPersistedApiKey({ home, platform: "linux", env }),
      "sk-test-secret-value",
    );
    await clearPersistedApiKey({ home, platform: "linux", env });
    assert.equal(readPersistedApiKey({ home, platform: "linux", env }), "");
    assert.doesNotMatch(
      await readFile(path.join(home, ".bash_profile"), "utf8"),
      /shiliu-ai/u,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
