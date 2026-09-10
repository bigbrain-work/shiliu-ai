import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeServerDefinition,
  codexArguments,
  configureClaude,
  configureCodex,
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

    const configuration = await configureCursor({ home });
    const result = JSON.parse(await readFile(configPath, "utf8"));
    const expectedServer = stdioServerDefinition();
    assert.equal(result.mcpServers.existing.url, "https://example.com/mcp");
    assert.equal(
      result.mcpServers[SERVER_NAME].command,
      expectedServer.command,
    );
    assert.equal(result.mcpServers[SERVER_NAME].args.at(-1), "mcp");
    assert.equal(configuration.configuration_state, "written");
    assert.equal(configuration.config_path, configPath);
    assert.equal(configuration.reload_required, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("built-in configurators report their target path and reload state", () => {
  const home = path.join(os.tmpdir(), "shiliu-config-result");
  const codex = configureCodex({ home, dryRun: true, env: {} });
  const claude = configureClaude({ home, dryRun: true });

  assert.equal(codex.configuration_state, "dry_run");
  assert.equal(codex.config_path, path.join(home, ".codex", "config.toml"));
  assert.equal(codex.reload_required, false);
  assert.equal(claude.configuration_state, "dry_run");
  assert.equal(claude.config_path, path.join(home, ".claude.json"));
  assert.equal(claude.reload_required, false);
});
