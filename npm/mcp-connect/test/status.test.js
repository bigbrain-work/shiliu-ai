import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { API_KEY_ENV } from "../src/constants.js";
import { getStatus, probeMcp } from "../src/status.js";

test("probe performs tools/list and reports the live count", async () => {
  let received;
  const result = await probeMcp("secret-value", {
    url: "https://example.test/mcp",
    readCatalog: async (options) => {
      received = options;
      return [{ name: "one" }, { name: "two" }];
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.toolCount, 2);
  assert.deepEqual(received, {
    apiKey: "secret-value",
    url: "https://example.test/mcp",
  });
});

test("JSON-ready status never includes the credential value", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-status-"));
  const secret = "sk-secret-never-returned";
  try {
    const result = await getStatus({
      home,
      platform: "linux",
      env: { [API_KEY_ENV]: secret },
      readCatalog: async () => [{ name: "example" }],
    });
    assert.equal(result.credential, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
