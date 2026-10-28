import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { onboardingState } from '../src/onboarding-state.js';
import { remoteCodexArguments, remoteServerDefinition, configureCursor } from '../src/configurators.js';
import { parseCliArguments } from '../src/arguments.js';

test('native success finishes even when optional components fail and never acquires API key', () => {
  const result = onboardingState({ mcp: 'connected', nativeBalance: true, toolList: true, charged: false, consumedCredits: 0, cli: 'failed', skill: 'failed' });
  assert.equal(result.state, 'mcp_ready');
  assert.equal(result.next, 'finish');
  assert.equal(result.api_key_allowed, false);
  assert.equal(result.message, '安装已完成，可以正常使用。');
  assert.match(result.optional_notice, /不影响正常使用/);
});
test('pending reload, authorization, cancellation, CLI success and tool list alone never trigger fallback', () => {
  for (const mcp of ['awaiting_reload', 'authorizing', 'cancelled', 'connected', 'not_configured']) {
    const state = onboardingState({ mcp, cli: 'installed', skill: 'installed', toolList: true });
    assert.equal(state.installed, false);
    assert.equal(state.api_key_allowed, false);
    assert.notEqual(state.next, 'open_http_consent_page');
  }
});
test('HTTP requires a classified terminal failure, separate consent and free balance proof', () => {
  assert.equal(onboardingState({ mcp: 'failed' }).api_key_allowed, false);
  const base = { mcp: 'failed', failure: 'connection_failed' };
  assert.equal(onboardingState(base).state, 'http_consent_required');
  assert.equal(onboardingState({ ...base, apiKeyConsent: true }).installed, false);
  assert.equal(onboardingState({ ...base, apiKeyConsent: true, httpBalance: true, charged: true }).installed, false);
  assert.equal(onboardingState({ ...base, apiKeyConsent: true, httpBalance: true, charged: false }).installed, false);
  assert.equal(onboardingState({ ...base, apiKeyConsent: true, httpBalance: true, charged: false, consumedCredits: 0 }).state, 'http_ready');
});
test('remote install defaults contain no local runtime or credentials', () => {
  assert.equal(parseCliArguments(['install']).transport, 'http');
  assert.equal(parseCliArguments(['install', '--transport', 'stdio']).transport, 'stdio');
  assert.deepEqual(remoteCodexArguments(), ['mcp', 'add', 'shiliu_mcp', '--url', 'https://api.bigbrain.work/shiliu/mcp']);
  assert.deepEqual(remoteServerDefinition(), { url: 'https://api.bigbrain.work/shiliu/mcp' });
  for (const url of ['http://insecure.example/mcp', 'https://user:key@example.com/mcp', 'https://example.com/mcp?token=secret'])
    assert.throws(() => remoteServerDefinition(url));
});
test('remote CLI configuration never needs CLI login or access to the keyring', async () => {
  // Isolated HOME: an existing stdio entry on the test machine would correctly keep stdio.
  const home = await mkdtemp(path.join(os.tmpdir(), 'shiliu-remote-cli-'));
  const result = spawnSync(process.execPath, ['bin/shiliu.js', 'install', '--agent', 'other', '--json', '--home', home], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: path.join(home, '.codex'), SHILIU_AI_API_KEY: '' }, timeout: 10000,
  });
  await rm(home, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.results[0].transport, 'http');
  assert.equal(report.results[0].authentication, 'oauth');
  assert.doesNotMatch(result.stdout + result.stderr, /二维码|KEYRING|Bearer|access_token/);
});
test('remote Cursor configuration preserves unrelated server definitions', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'shiliu-remote-config-'));
  try {
    await mkdir(path.join(home, '.cursor'));
    const file = path.join(home, '.cursor', 'mcp.json');
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: 'unchanged' } } }));
    await configureCursor({ home, transport: 'http' });
    const config = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(config.mcpServers.other, { command: 'unchanged' });
    assert.deepEqual(config.mcpServers.shiliu_mcp, remoteServerDefinition());
  } finally { await rm(home, { recursive: true, force: true }); }
});
