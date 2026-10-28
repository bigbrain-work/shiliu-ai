import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existingServerEntry } from '../src/configurators.js';
import { onboardingState } from '../src/onboarding-state.js';

const stdioToml = '[mcp_servers.shiliu_mcp]\ncommand = "cmd"\nargs = ["/d", "/s", "/c", "npx", "-y", "@bigbrain-work/mcp-connect", "mcp"]\n';

async function withHome(files, run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'shiliu-legacy-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
      await writeFile(path.join(home, relative), content);
    }
    await run(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}
// Always --dry-run with an isolated HOME/CODEX_HOME so a regression can never touch real client configuration.
function install(home, ...args) {
  const result = spawnSync(process.execPath, ['bin/shiliu.js', ...args, '--dry-run', '--json', '--home', home], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: path.join(home, '.codex'), SHILIU_AI_API_KEY: '' }, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split(/\r?\n/u);
  return { report: JSON.parse(lines.slice(lines.findIndex((line) => line.trim() === '{')).join('\n')), stdout: result.stdout };
}

test('existing stdio entries are reported per client and unknown files count as existing', async () => {
  await withHome({
    '.codex/config.toml': stdioToml,
    '.claude.json': JSON.stringify({ mcpServers: { shiliu_mcp: { type: 'http', url: 'https://api.bigbrain.work/shiliu/mcp' } } }),
    '.cursor/mcp.json': '{ not json but mentions shiliu_mcp',
  }, async (home) => {
    const env = { CODEX_HOME: path.join(home, '.codex') };
    assert.equal(existingServerEntry('codex', { home, env }).transport, 'stdio');
    assert.equal(existingServerEntry('claude', { home, env }).transport, 'http');
    assert.equal(existingServerEntry('cursor', { home, env }).transport, 'unknown');
  });
  await withHome({ '.cursor/mcp.json': '{ broken', '.claude.json': JSON.stringify({ mcpServers: { other: {} } }) }, async (home) => {
    assert.equal(existingServerEntry('cursor', { home }), null);
    assert.equal(existingServerEntry('claude', { home }), null);
  });
});

for (const args of [['install', '--agent', 'codex'], ['install'], []]) {
  test(`"shiliu ${args.join(' ')}" preserves an existing stdio bridge instead of switching to OAuth`, async () => {
    await withHome({ '.codex/config.toml': stdioToml }, async (home) => {
      const { report, stdout } = install(home, ...args);
      const codex = report.results.find((result) => result.agent === 'codex');
      assert.equal(codex.configuration_state, 'existing_preserved');
      assert.equal(codex.existing_transport, 'stdio');
      assert.equal(report.legacy_stdio_present, true);
      assert.doesNotMatch(stdout, /\[dry-run\] codex/u);
      assert.equal(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8'), stdioToml);
      if (report.results.every((result) => result.configuration_state === 'existing_preserved')) {
        assert.equal(report.status, 'existing_preserved');
        assert.equal(report.onboarding.state, 'existing_installation');
        assert.equal(report.onboarding.api_key_allowed, false);
      }
    });
  });
}

test('explicit --transport remains an intentional replacement and new clients default to remote OAuth', async () => {
  await withHome({ '.codex/config.toml': stdioToml }, async (home) => {
    const { report, stdout } = install(home, 'install', '--agent', 'codex', '--transport', 'http');
    assert.equal(report.results[0].configuration_state, 'dry_run');
    assert.match(stdout, /\[dry-run\] codex mcp add shiliu_mcp --url/u);
  });
  await withHome({}, async (home) => {
    const { report, stdout } = install(home, 'install', '--agent', 'codex');
    assert.equal(report.legacy_stdio_present, false);
    assert.equal(report.results[0].configuration_state, 'dry_run');
    assert.match(stdout, /--url https:\/\/api\.bigbrain\.work\/shiliu\/mcp/u);
  });
});

test('a stdio user adding another client keeps the stdio bridge instead of OAuth', async () => {
  await withHome({ '.codex/config.toml': stdioToml }, async (home) => {
    const { report, stdout } = install(home, 'install', '--agent', 'claude');
    assert.equal(report.transport, 'stdio');
    assert.equal(report.results[0].configuration_state, 'dry_run');
    assert.ok(stdout.includes('\\"type\\":\\"stdio\\"'), stdout);
    assert.ok(!stdout.includes('\\"type\\":\\"http\\"'), stdout);
  });
});

test('existing installation state never allows API key fallback', () => {
  const state = onboardingState({ mcp: 'existing' });
  assert.equal(state.state, 'existing_installation');
  assert.equal(state.api_key_allowed, false);
});
