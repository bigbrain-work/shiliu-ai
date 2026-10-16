import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureClaude, configureCodex, isDuplicateError } from "../src/configurators.js";
import { inspectLocalConfiguration, getStatus } from "../src/status.js";
import { createLoginQrCode, readLoginQrCode, removeLoginQrCode, DeviceAuthError, waitForDeviceAuthorization } from "../src/device-auth-client.js";
import { installSkillArchive } from "../src/direct-skill-install.js";
import { writeResultFile } from "../src/tool-call.js";
import { compareVersions } from "../src/updater.js";
import { launchContext, runNpm } from "../src/launch-context.js";
import { archiveInstaller } from "../test-support/skill-archive.js";
import { installShiliuSkill } from "../src/skill-refresh.js";
import { clearPersistedApiKey } from "../src/credentials.js";
import { logout } from "../src/cli.js";

async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-p3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("QR creation ignores an attacker-precreated shared directory and rejects linked images", async t => {
  const root = await sandbox(t), shared = path.join(root, "shiliu-ai");
  await mkdir(shared); await writeFile(path.join(shared, "attacker.png"), "keep");
  const file = await createLoginQrCode("https://example.test/qr", "ABCD-2345", { temporaryDirectory: root });
  assert.notEqual(path.dirname(file), shared);
  assert.ok(await readLoginQrCode(file, { temporaryDirectory: root }));
  await rm(file);
  const victim = path.join(root, "victim"); await writeFile(victim, "unchanged");
  await symlink(victim, file);
  await assert.rejects(readLoginQrCode(file, { temporaryDirectory: root }), /不安全/u);
  assert.equal(await readFile(victim, "utf8"), "unchanged");
  assert.equal(await readFile(path.join(shared, "attacker.png"), "utf8"), "keep");
  await removeLoginQrCode(file, { temporaryDirectory: root });
});

test("QR reader refuses a directory symlink", async t => {
  const root = await sandbox(t), real = path.join(root, "real"); await mkdir(real);
  const link = path.join(root, "shiliu-ai-forged"); await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
  const image = path.join(link, "shiliu-login-ABCD-2345.png"); await writeFile(image, "forged");
  await assert.rejects(readLoginQrCode(image, { temporaryDirectory: root }), /非私有|符号链接/u);
});

test("polling honors retry_after_seconds, retries transient failures, and stops before expired exchange", async () => {
  let clock = 0, calls = 0; const sleeps = [];
  const response = await waitForDeviceAuthorization({ device_code: "x", expires_in: 40, interval: 1 }, {
    exchange: async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      if (calls === 2) throw new DeviceAuthError("authorization_pending", "pending", 400, { retry_after_seconds: 7 });
      return "ok";
    },
  }, { now: () => clock, sleep: async ms => { clock += ms; sleeps.push(ms); } });
  assert.equal(response, "ok"); assert.deepEqual(sleeps, [1000, 2000, 7000]);
  calls = 0; clock = 0;
  await assert.rejects(waitForDeviceAuthorization({ expires_in: 1, interval: 5 }, { exchange: async () => { calls++; } },
    { now: () => clock, sleep: async ms => { clock += ms; } }), { code: "expired_token" });
  assert.equal(calls, 0);
  clock = 0;
  await assert.rejects(waitForDeviceAuthorization({ expires_in: 300, interval: 1 }, {
    exchange: async () => { calls++; throw Object.assign(new Error("temporary"), { code: "ECONNRESET" }); },
  }, { now: () => clock, sleep: async ms => { clock += ms; } }));
  assert.equal(calls, 4);
});

test("configuration checks parse tables/objects, respect CODEX_HOME, and reject substring decoys", async t => {
  const root = await sandbox(t), codex = path.join(root, "custom");
  await mkdir(codex); await mkdir(path.join(root, ".cursor"));
  await writeFile(path.join(codex, "config.toml"), '# shiliu_mcp @bigbrain-work/mcp-connect\n[mcp_servers.other]\ncommand="npx"\n');
  await writeFile(path.join(root, ".claude.json"), JSON.stringify({ note: "shiliu_mcp @bigbrain-work/mcp-connect" }));
  assert.deepEqual(await inspectLocalConfiguration(root, { CODEX_HOME: codex }), { codex: false, claude: false, cursor: false });
  await writeFile(path.join(codex, "config.toml"), '[mcp_servers."shiliu_mcp"]\ncommand="npx"\nargs=["-y", "@bigbrain-work/mcp-connect", "mcp"]\n');
  assert.equal((await inspectLocalConfiguration(root, { CODEX_HOME: codex })).codex, true);
});

for (const agent of ["claude", "codex"]) test(`${agent} restores exact configuration after remove/add fails`, async t => {
  const root = await sandbox(t), directory = agent === "codex" ? path.join(root, ".codex") : root;
  await mkdir(directory, { recursive: true });
  const config = path.join(directory, agent === "codex" ? "config.toml" : ".claude.json");
  const original = 'original configuration with unrelated servers\r\n'; await writeFile(config, original);
  let calls = 0;
  assert.throws(() => (agent === "claude" ? configureClaude : configureCodex)({ home: root, env: {}, spawnImpl: () => {
    calls++;
    if (calls === 1) return { status: 1, stderr: "Server already exists" };
    if (calls === 2) { writeFileSync(config, "removed"); return { status: 0 }; }
    return { status: 1, stderr: "add failed" };
  } }), /add failed/u);
  assert.equal(await readFile(config, "utf8"), original);
  assert.equal(calls, 3);
});

test("does not exist is never interpreted as a duplicate", () => {
  assert.equal(isDuplicateError(new Error("configuration does not exist")), false);
  assert.equal(isDuplicateError(new Error("server already exists")), true);
});

test("Windows pnpm/yarn .cmd shims preserve JSON arguments", { skip: process.platform !== "win32" }, async t => {
  const root = await sandbox(t);
  await writeFile(path.join(root, "claude.cmd"), '@echo off\r\nnode "%~dp0shim.cjs" %*\r\n');
  await writeFile(path.join(root, "shim.cjs"), 'require("fs").writeFileSync(process.env.SHILIU_ARGS_OUTPUT,JSON.stringify(process.argv.slice(2)));');
  const output = path.join(root, "args.json");
  configureClaude({ home: root, env: { ...process.env, PATH: `${root};${process.env.PATH}`, SHILIU_ARGS_OUTPUT: output } });
  const args = JSON.parse(await readFile(output, "utf8"));
  assert.equal(args[0], "mcp"); assert.equal(JSON.parse(args.at(-1)).type, "stdio");
});

test("failed atomic output replacement preserves the original bytes", async t => {
  const root = await sandbox(t), file = path.join(root, "result.json"); await writeFile(file, "keep");
  await assert.rejects(writeResultFile(file, { updated: true }, { force: true, move: async () => { throw new Error("rename failed"); } }), /rename failed/u);
  assert.equal(await readFile(file, "utf8"), "keep");
  assert.deepEqual(await readdir(root), ["result.json"]);
  await writeResultFile(file, { updated: true }, { force: true });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { updated: true });
});

test("Skill downloads reject unsafe final redirect and cancel oversized streaming bodies", async t => {
  const root = await sandbox(t), options = { targetDirectory: path.join(root, "skills"), sourceBaseUrl: "https://example.test", skillName: "shiliu-ai-mcp" };
  for (const url of ["http://example.test/index.json", "https://attacker.test/index.json"]) {
    await assert.rejects(installSkillArchive({ ...options, fetchImpl: async () => ({ ok: true, url, body: { cancel: async () => {} } }) }), /重定向/u);
  }
  let reads = 0, cancelled = false;
  await assert.rejects(installSkillArchive({ ...options, fetchImpl: async () => ({ ok: true, url: "https://example.test/index.json",
    body: new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(3 * 1024 * 1024)); }, cancel() { cancelled = true; } }),
  }) }), /5 MiB/u);
  assert.equal(cancelled, true); assert.ok(reads <= 3);
});

test("Volta/asdf POSIX layout resolves npm-cli beside the bin directory", async t => {
  const root = await sandbox(t), bin = path.join(root, "bin");
  await mkdir(bin); const node = path.join(bin, "node"); await writeFile(node, "fixture");
  const cli = path.join(root, "lib/node_modules/npm/bin/npm-cli.js"); await mkdir(path.dirname(cli), { recursive: true }); await writeFile(cli, "fixture");
  assert.equal((await launchContext({ nodePath: node })).npmCli, cli);
});

test("invalid credentials produce an actionable status and dry-run is read-only", async t => {
  const root = await sandbox(t);
  const status = await getStatus({ home: root, resolveAuth: async () => { throw Object.assign(new Error("spent"), { code: "invalid_grant" }); } });
  assert.equal(status.loginRequired, true); assert.match(status.remote.detail, /重新登录/u);
  await getStatus({ home: root, dryRun: true, resolveAuth: async options => { assert.equal(options.readOnly, true); return { token: "" }; } });
  assert.deepEqual(await readdir(root), []);
});

test("logout force clears only local credentials without attempting revoke", async () => {
  let cleared = 0;
  const log = console.log; console.log = () => {};
  try {
  await logout({ force: true, tokenStore: { load: async () => ({ refreshToken: "token" }), clear: async () => { cleared++; } },
    pendingLoginStore: { load: async () => null, clear: async () => {} }, clearLegacyApiKey: async () => {},
    clientFactory: () => assert.fail("force does not revoke") });
  assert.equal(cleared, 1);
  } finally { console.log = log; }
});

test("prepare falls back to npx with the selected environment when npm-cli is absent", () => {
  const env = { PATH: "fixture" };
  const output = runNpm({ env, node: process.execPath }, ["exec", "--yes", "--prefer-online", "--", "@bigbrain-work/mcp-connect", "--version"], 1234, {
    spawnImpl: (command, args, options) => {
      assert.equal(command, process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx");
      assert.deepEqual(args.slice(-4), ["--yes", "--prefer-online", "@bigbrain-work/mcp-connect", "--version"]);
      assert.equal(options.env, env); assert.equal(options.timeout, 1234);
      return { status: 0, stdout: "fixture-version" };
    },
  });
  assert.equal(output, "fixture-version");
});

test("Skill reports a retained backup when cleanup fails", async t => {
  const root = await sandbox(t), cwd = path.join(root, "project"), home = path.join(root, "home");
  await mkdir(cwd); const archive = await archiveInstaller(root);
  const options = { cwd, home, agent: "codex", directInstall: archive.install };
  await installShiliuSkill(options);
  await assert.rejects(installShiliuSkill({ ...options, directInstall: opts => archive.install({ ...opts, removeBackup: async () => { throw Object.assign(new Error("locked"), { code: "EACCES" }); } }) }), /备份目录清理失败/u);
  const directory = path.join(cwd, ".agents/skills");
  assert.ok((await readdir(directory)).some(name => name.startsWith(".shiliu-ai-mcp-backup-")));
  assert.match(await readFile(path.join(directory, "shiliu-ai-mcp/SKILL.md"), "utf8"), /fixture/u);
});

test("a completed Skill operation never unlinks a replacement lock", async t => {
  const root = await sandbox(t), cwd = path.join(root, "project"), home = path.join(root, "home");
  await mkdir(cwd); const archive = await archiveInstaller(root);
  const lock = path.join(home, ".shiliu-ai/skill-refresh.lock");
  await installShiliuSkill({ home, cwd, agent: "codex", directInstall: async options => {
    const result = await archive.install(options);
    await writeFile(lock, "another-owner\n");
    return result;
  } });
  assert.equal(await readFile(lock, "utf8"), "another-owner\n");
});

test("semver prerelease ordering is numeric, ASCII and build-independent", () => {
  for (const [a,b] of [["1.0.0-beta.10", "1.0.0-beta.9"], ["1.0.0-beta", "1.0.0-10"], ["1.0.0-beta.1", "1.0.0-beta"], ["1.0.0", "1.0.0-rc.1"]]) assert.equal(compareVersions(a,b), 1);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
});

test("dry-run install and refresh leave a fresh home empty", async t => {
  const root = await sandbox(t), bin = path.resolve("bin/shiliu.js");
  for (const args of [["install", "--agent", "cursor"], ["skill", "refresh"]]) {
    const run = spawnSync(process.execPath, [bin, ...args, "--dry-run", "--json", "--home", root], { windowsHide: true, encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root } });
    assert.equal(run.status, 0, run.stderr); assert.deepEqual(await readdir(root), []);
  }
});

test("profile cleanup removes only the exact managed source line", async t => {
  const root = await sandbox(t), file = path.join(root, ".profile");
  await writeFile(file, `echo 'keep # shiliu-ai'\n. '${path.join(root, ".config/shiliu-ai/env")}' # shiliu-ai\necho done\n`);
  await clearPersistedApiKey({ home: root, platform: "linux", env: { SHELL: "/bin/sh" } });
  assert.equal(await readFile(file, "utf8"), "echo 'keep # shiliu-ai'\necho done\n");
});
