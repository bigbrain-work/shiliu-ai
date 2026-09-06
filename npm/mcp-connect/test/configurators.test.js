import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeServerDefinition,
  codexArguments,
  configureCursor,
  cursorServerDefinition,
  stdioServerDefinition,
} from "../src/configurators.js";
import { PACKAGE_NAME, SERVER_NAME } from "../src/constants.js";

test("all generated configs use the credential-free stdio bridge", () => {
  const windowsProxy = stdioServerDefinition("win32");
  assert.deepEqual(windowsProxy, {
    command: "cmd",
    args: ["/d", "/s", "/c", "npx", "-y", PACKAGE_NAME, "mcp"],
  });
  assert.deepEqual(codexArguments("win32").slice(3), [
    "--",
    windowsProxy.command,
    ...windowsProxy.args,
  ]);
  assert.deepEqual(claudeServerDefinition("win32"), {
    type: "stdio",
    ...windowsProxy,
  });
  assert.deepEqual(cursorServerDefinition("win32"), windowsProxy);
});

test("cursor merge preserves unrelated MCP servers", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-cursor-"));
  try {
    const directory = path.join(home, ".cursor");
    const configPath = path.join(directory, "mcp.json");
    await mkdir(directory, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { existing: { url: "https://example.com/mcp" } },
      }),
      "utf8",
    );

    await configureCursor({ home });
    const result = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(result.mcpServers.existing.url, "https://example.com/mcp");
    assert.equal(result.mcpServers[SERVER_NAME].command, "cmd");
    assert.equal(result.mcpServers[SERVER_NAME].args.at(-1), "mcp");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
