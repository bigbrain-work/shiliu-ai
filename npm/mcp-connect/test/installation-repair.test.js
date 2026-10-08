import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkActiveLaunch, repairInstallation, validateCacheEntry } from "../src/repair.js";
import { launchContext } from "../src/launch-context.js";
import { getDoctorReport } from "../src/doctor.js";
import { verifyStdioLaunch } from "../src/stdio-probe.js";
import { parseCliArguments } from "../src/arguments.js";

async function sandbox(run) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "shiliu-repair-")));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function cacheFixture(root, dependencies = { "@bigbrain-work/mcp-connect": "1.3.10" }) {
  const cache = path.join(root, "cache");
  const entry = path.join(cache, "_npx", "abcdef0123456789");
  const packageRoot = path.join(entry, "node_modules", "@bigbrain-work", "mcp-connect");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(entry, "package.json"), JSON.stringify({ dependencies }));
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@bigbrain-work/mcp-connect", type: "module", version: "1.3.10" }));
  await writeFile(path.join(packageRoot, "evidence.txt"), "original installation");
  return { cache, entry, packageRoot };
}

test("repair only accepts a direct, exclusive Shiliu npx cache entry", async () => sandbox(async (root) => {
  const f = await cacheFixture(root);
  assert.equal((await validateCacheEntry(f.cache, f.entry)).entry, f.entry);
  for (const target of [f.cache, path.dirname(f.entry), root, path.join(f.entry, "node_modules")]) {
    await assert.rejects(validateCacheEntry(f.cache, target), /UNSAFE_CACHE_PATH/u);
  }
  await writeFile(path.join(f.entry, "package.json"), JSON.stringify({ dependencies: { "@bigbrain-work/mcp-connect": "1", other: "2" } }));
  await assert.rejects(validateCacheEntry(f.cache, f.entry), /NOT_EXCLUSIVE_SHILIU_CACHE/u);
}));

test("repair refuses an active MCP or a concurrent repair without moving anything", async () => sandbox(async (root) => {
  const f = await cacheFixture(root);
  const options = { cacheEntry: f.entry, npmCache: f.cache, npmCli: path.resolve("package.json") };
  const active = await repairInstallation(options, { activeCheck: () => { throw Object.assign(new Error("active"), { reason: "MCP_STILL_RUNNING", exitCode: 3 }); } });
  assert.equal(active.error_code, "MCP_STILL_RUNNING");
  assert.equal(await readFile(path.join(f.packageRoot, "evidence.txt"), "utf8"), "original installation");
  const lock = path.join(f.cache, ".shiliu-mcp-repair.lock");
  await writeFile(lock, "other repair");
  const concurrent = await repairInstallation(options);
  assert.equal(concurrent.error_code, "REPAIR_ALREADY_RUNNING");
  assert.equal(await readFile(lock, "utf8"), "other repair");
}));

test("repair quarantines one entry, reinstalls once, validates that entry and configured launch, preserves other caches and credentials", async () => sandbox(async (root) => {
  const f = await cacheFixture(root);
  const credential = path.join(root, "credential-fixture");
  await writeFile(credential, "unchanged-secret-fixture");
  const other = path.join(f.cache, "_npx", "0123456789abcdef");
  await mkdir(other);
  await writeFile(path.join(other, "other.txt"), "keep");
  let installs = 0;
  const result = await repairInstallation({ cacheEntry: f.entry, npmCache: f.cache, npmCli: path.resolve("package.json") }, {
    activeCheck: () => {},
    npm: (context, args) => {
      assert.equal(context.env.npm_config_cache, f.cache);
      assert.deepEqual(args, ["exec", "--yes", "--prefer-online", "--", "@bigbrain-work/mcp-connect", "--version"]);
      installs += 1;
      // synchronous fixture represents npm's fresh extraction
      return "ignored";
    },
    verify: async () => assert.fail("npm did not rebuild the entry"),
  });
  assert.equal(installs, 1);
  assert.equal(result.ok, false);
  assert.equal(await readFile(path.join(result.backup_path, "node_modules/@bigbrain-work/mcp-connect/evidence.txt"), "utf8"), "original installation");
  assert.equal(await readFile(credential, "utf8"), "unchanged-secret-fixture");
  assert.equal(await readFile(path.join(other, "other.txt"), "utf8"), "keep");
  assert.equal(await lstat(path.join(f.cache, ".shiliu-mcp-repair.lock")).catch(() => null), null);
}));

test("a successful repair verifies both the fresh cache entry and the launch command", async () => sandbox(async (root) => {
  const f = await cacheFixture(root);
  const launches = [];
  const result = await repairInstallation({ cacheEntry: f.entry, npmCache: f.cache, npmCli: path.resolve("package.json") }, {
    activeCheck: () => {},
    npm: () => {
      // runNpm is synchronous; recreate the cache using the Node filesystem API.
      const child = spawnSync(process.execPath, [path.resolve("test-support/rebuild-cache.js"), f.entry], { encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
    },
    verify: async ({ definition }) => { launches.push(definition); return { ok: true, tool_count: 3 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].args[0], path.join(f.packageRoot, "bin/mcp-connect.js"));
  assert.equal(result.reload_required, true);
}));

test("the damaged package itself can show version, run doctor and enter repair without SDK or Ajv", async () => sandbox(async (root) => {
  const f = await cacheFixture(root);
  for (const file of ["src", "bin", "package.json"]) await cp(path.resolve(file), path.join(f.packageRoot, file), { recursive: true });
  // Copy the real dependencies then reproduce the customer's exact missing file.
  await cp(path.resolve("node_modules"), path.join(f.packageRoot, "node_modules"), { recursive: true });
  await rename(path.join(f.packageRoot, "node_modules/ajv/dist/2020.js"), path.join(f.packageRoot, "node_modules/ajv/dist/2020.saved"));
  const launchFile = path.join(root, "mcp.json");
  await writeFile(launchFile, JSON.stringify({ mcpServers: { shiliu_mcp: { command: process.execPath, args: [path.join(f.packageRoot, "bin/shiliu.js"), "mcp"] } } }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, SHILIU_AI_API_KEY: "" };
  const version = spawnSync(process.execPath, [path.join(f.packageRoot, "bin/shiliu.js"), "--version"], { env, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const doctor = spawnSync(process.execPath, [path.join(f.packageRoot, "bin/shiliu.js"), "doctor", "--launch-file", launchFile, "--json"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(doctor.status, 3, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.stdio_launch.error_code, "RUNTIME_UNAVAILABLE");
  assert.equal(report.stdio_launch.child_runtime.reason, "DEPENDENCY_INCOMPLETE");
  assert.equal(report.stdio_launch.child_runtime.missing_module, "ajv/dist/2020.js");
  assert.equal(report.stdio_launch.child_runtime.node_path, process.execPath);
  assert.equal(report.stdio_launch.child_runtime.install_root, f.packageRoot);
  const lockPath = path.join(f.cache, ".shiliu-mcp-repair.lock");
  await writeFile(lockPath, JSON.stringify({ probe_id: "fixture-repair-lock" }));
  const locked = spawnSync(process.execPath, [path.join(f.packageRoot, "bin/shiliu.js"), "mcp"], { env, encoding: "utf8" });
  assert.equal(locked.status, 3, locked.stderr);
  assert.equal(JSON.parse(locked.stderr.trim()).runtime.reason, "REPAIR_IN_PROGRESS");
  await unlink(lockPath);
  const repair = spawnSync(process.execPath, [path.join(f.packageRoot, "bin/shiliu.js"), "repair", "--cache-entry", f.entry, "--npm-cache", f.cache, "--npm-cli", path.resolve("package.json"), "--dry-run", "--json"], { env, encoding: "utf8" });
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(JSON.parse(repair.stdout).status, "dry_run");
  // Execute the public repair command end to end with an offline npm fixture.
  // npm re-extracts the quarantined package and restores the missing dependency;
  // the fresh CLI uses anonymous auth so no real credential store is consulted.
  const npmCli = path.join(root, "npm-cli.js");
  await writeFile(npmCli, `
    const fs = require('node:fs'); const path = require('node:path');
    const cache = process.env.npm_config_cache;
    const backups = path.join(cache, '.shiliu-mcp-backups');
    const backup = path.join(backups, fs.readdirSync(backups)[0]);
    const entry = path.join(cache, '_npx', 'abcdef0123456789');
    fs.cpSync(backup, entry, { recursive: true });
    const pkg = path.join(entry, 'node_modules/@bigbrain-work/mcp-connect');
    fs.renameSync(path.join(pkg, 'node_modules/ajv/dist/2020.saved'), path.join(pkg, 'node_modules/ajv/dist/2020.js'));
    fs.writeFileSync(path.join(pkg, 'src/cli.js'), ${JSON.stringify('import { runProxy } from "./proxy.js"; export async function runCli() { await runProxy({ home: process.env.HOME, resolveAuth: async () => ({ token: "" }), pollIntervalMs: 100 }); }')});
    console.log('fixture installation complete');
  `);
  const fixed = spawnSync(process.execPath, [path.join(f.packageRoot, "bin/shiliu.js"), "repair", "--cache-entry", f.entry, "--npm-cache", f.cache, "--npm-cli", npmCli, "--launch-file", launchFile, "--json"], { env, encoding: "utf8", timeout: 65000 });
  assert.equal(fixed.status, 0, `${fixed.stdout}\n${fixed.stderr}`);
  const repaired = JSON.parse(fixed.stdout);
  assert.equal(repaired.status, "repaired");
  assert.equal(repaired.installation_verification.bootstrap_tool_count, 3);
  assert.equal(repaired.verification.bootstrap_tool_count, 3);
  assert.equal(repaired.reload_required, true);
  assert.equal(repaired.verification.child_runtime.install_root, f.packageRoot);
  assert.ok(await lstat(path.join(repaired.backup_path, "node_modules/@bigbrain-work/mcp-connect/node_modules/ajv/dist/2020.saved")));
  const active = spawn(process.execPath, [path.join(f.packageRoot, "bin/shiliu.js"), "mcp"], { env, stdio: ["pipe", "ignore", "ignore"] });
  try {
    await new Promise((resolve, reject) => { active.once("spawn", resolve); active.once("error", reject); });
    assert.throws(() => checkActiveLaunch(f.entry), /MCP_STILL_RUNNING/u);
  } finally {
    const exited = new Promise((resolve) => active.once("close", resolve));
    active.kill();
    await exited;
  }
}));

test("healthy anonymous MCP handshake succeeds without requiring login", async () => sandbox(async (root) => {
  const report = await verifyStdioLaunch({
    definition: { command: process.execPath, args: [path.resolve("test-support/anonymous-proxy-entry.js")] },
    env: { ...process.env, SHILIU_TEST_HOME: root }, timeoutMs: 10000,
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.bootstrap_tool_count, 3);
  assert.equal(report.remote_connected, false);
}));

test("specified client launch has no fallback that hides its failure, and credential-bearing definitions are rejected", async () => sandbox(async (root) => {
  const launchFile = path.join(root, "launch.json");
  await writeFile(launchFile, JSON.stringify({ command: process.execPath, args: [path.resolve("bin/shiliu.js"), "mcp"] }));
  let seen;
  const report = await getDoctorReport({ launchFile, nodePath: process.execPath,
    verifyLaunch: async ({ definition }) => { seen = definition; return { ok: false, attempted: true, process_exit_code: 3, error_code: "RUNTIME_UNAVAILABLE" }; } });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.status, "stdio_launch_failed");
  assert.equal(seen.command, process.execPath);
  await writeFile(launchFile, JSON.stringify({ command: process.execPath, args: ["secret-token"], env: { TOKEN: "secret-token" } }));
  await assert.rejects(launchContext({ launchFile }), /配置或参数无效/u);
  assert.throws(() => parseCliArguments(["repair"]), /cache-entry/u);
  assert.throws(() => parseCliArguments(["status", "--node-path", process.execPath]), /doctor 或 repair/u);
}));
