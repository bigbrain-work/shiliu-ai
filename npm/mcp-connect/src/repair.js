import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { PACKAGE_NAME } from "./constants.js";
import { launchContext, runNpm } from "./launch-context.js";
import { verifyStdioLaunch } from "./stdio-probe.js";

class RepairError extends Error {
  constructor(reason, exitCode = 2) { super(reason); this.reason = reason; this.exitCode = exitCode; }
}

const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function plainDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RepairError("UNSAFE_CACHE_PATH");
  }
}

export async function validateCacheEntry(cache, entry) {
  if (!path.isAbsolute(cache) || !path.isAbsolute(entry)) throw new RepairError("UNSAFE_CACHE_PATH");
  cache = path.resolve(cache);
  entry = path.resolve(entry);
  const npxRoot = path.join(cache, "_npx");
  if (!samePath(path.dirname(entry), npxRoot) || !/^[a-f0-9]{8,64}$/u.test(path.basename(entry))) {
    throw new RepairError("UNSAFE_CACHE_PATH");
  }
  await plainDirectory(cache);
  await plainDirectory(npxRoot);
  await plainDirectory(entry);
  // Windows 8.3 aliases and macOS /var aliases are legitimate. Compare canonical
  // parents while still rejecting links inside the selected extraction tree.
  cache = await realpath(cache);
  const canonicalEntry = path.join(cache, "_npx", path.basename(entry));
  if (!samePath(await realpath(npxRoot), path.join(cache, "_npx")) || !samePath(await realpath(entry), canonicalEntry)) {
    throw new RepairError("UNSAFE_CACHE_PATH");
  }
  entry = canonicalEntry;
  const manifestPath = path.join(entry, "package.json");
  if ((await lstat(manifestPath)).isSymbolicLink()) throw new RepairError("UNSAFE_CACHE_PATH");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packages = Object.keys(manifest.dependencies || {});
  if (packages.length !== 1 || packages[0] !== PACKAGE_NAME) throw new RepairError("NOT_EXCLUSIVE_SHILIU_CACHE");
  const packageRoot = path.join(entry, "node_modules", "@bigbrain-work", "mcp-connect");
  await plainDirectory(packageRoot);
  if (!samePath(await realpath(packageRoot), packageRoot)) throw new RepairError("UNSAFE_CACHE_PATH");
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== PACKAGE_NAME) throw new RepairError("NOT_EXCLUSIVE_SHILIU_CACHE");
  return { cache, entry, packageRoot };
}

// Inspect process command lines locally; never include them in the report.
export function checkActiveLaunch(entry) {
  let rows;
  if (process.platform === "win32") {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress";
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (result.error || result.status !== 0) throw new RepairError("PROCESS_CHECK_UNAVAILABLE", 3);
    try {
      const parsed = JSON.parse(result.stdout || "[]");
      rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({ pid: row.ProcessId, parent: row.ParentProcessId, command: row.CommandLine }));
    } catch { throw new RepairError("PROCESS_CHECK_UNAVAILABLE", 3); }
  } else {
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: 10000 });
    if (result.error || result.status !== 0) throw new RepairError("PROCESS_CHECK_UNAVAILABLE", 3);
    rows = result.stdout.split("\n").map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match ? { pid: Number(match[1]), parent: Number(match[2]), command: match[3] } : {};
    });
  }
  const normalizedEntry = entry.replaceAll("\\", "/").toLowerCase();
  const normalizedCommand = (row) => String(row.command || "").replaceAll("\\", "/").toLowerCase();
  const resolvedLaunch = (row) => /\/mcp-connect\/(?:bin\/[^\s]+\.js|src\/cli\.js)/u.test(normalizedCommand(row));
  const parents = new Map(rows.map((row) => [row.pid, row.parent]));
  const descendant = (child, parent) => {
    let pid = child.pid;
    for (let depth = 0; depth < 32; depth += 1) {
      pid = parents.get(pid);
      if (pid === parent.pid) return true;
      if (!pid) return false;
    }
    return false;
  };
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    const command = normalizedCommand(row);
    if (!/(?:^|[\s"'])mcp(?:[\s"']|$)|(?:^|[\s"'])proxy(?:[\s"']|$)/u.test(command)) continue;
    if (command.includes(normalizedEntry)) throw new RepairError("MCP_STILL_RUNNING", 3);
    if (resolvedLaunch(row)) continue; // a different, already resolved installation
    const generic = command.includes(PACKAGE_NAME) || /(?:shiliu|mcp-connect)(?:\.js|\.cmd)?["']?\s+(?:mcp|proxy)\b/u.test(command);
    if (generic && !rows.some((child) => resolvedLaunch(child) && descendant(child, row))) {
      throw new RepairError("MCP_STILL_RUNNING", 3); // unresolved launch could enter this cache
    }
  }
}

export async function repairInstallation(options, {
  env = process.env, npm = runNpm, activeCheck = checkActiveLaunch, verify = verifyStdioLaunch,
  progress = () => {},
} = {}) {
  let backup;
  let lock;
  let lockPath;
  let ownedLock = false;
  let target;
  try {
    const context = await launchContext(options, env);
    const cache = options.npmCache || npm(context, ["config", "get", "cache"], 15000);
    target = await validateCacheEntry(cache, options.cacheEntry);
    // The real cache is always explicit for reinstallation and the probe.
    context.env.npm_config_cache = target.cache;
    const definition = context.definition || { command: context.node, args: [context.npmCli, "exec", "--yes", "--", PACKAGE_NAME, "mcp"] };
    if (!context.npmCli) throw new RepairError("NPM_CLI_NOT_FOUND", 3);
    if (options.dryRun) return {
      ok: true, status: "dry_run", cache_entry: target.entry,
      action: "检查活动 MCP 进程；独占锁定此缓存；备份此目录；按原包名重装一次；验证 initialize 和 tools/list。未修改文件。",
    };
    lockPath = path.join(target.cache, ".shiliu-mcp-repair.lock");
    try { lock = await open(lockPath, "wx", 0o600); ownedLock = true; }
    catch (error) { if (error.code === "EEXIST") throw new RepairError("REPAIR_ALREADY_RUNNING", 3); throw error; }
    const probeId = randomUUID();
    await lock.writeFile(JSON.stringify({ pid: process.pid, entry: target.entry, probe_id: probeId }));
    context.env.SHILIU_REPAIR_PROBE_ID = probeId;
    progress("process_check");
    await activeCheck(target.entry);
    const backupRoot = path.join(target.cache, ".shiliu-mcp-backups");
    await mkdir(backupRoot, { recursive: true });
    await plainDirectory(backupRoot);
    backup = path.join(backupRoot, `${path.basename(target.entry)}-${randomUUID()}`);
    // Revalidate immediately before moving; never delete or move the entire cache.
    await validateCacheEntry(target.cache, target.entry);
    await activeCheck(target.entry);
    progress("backup");
    await rename(target.entry, backup);
    progress("reinstall");
    try { npm(context, ["exec", "--yes", "--prefer-online", "--", PACKAGE_NAME, "--version"]); }
    catch { throw new RepairError("NPM_REINSTALL_FAILED", 3); }
    // A global/local fallback can report a version without rebuilding this cache.
    try { await validateCacheEntry(target.cache, target.entry); }
    catch { throw new RepairError("CACHE_REBUILD_INCOMPLETE", 3); }
    progress("installation_probe");
    const installation = await verify({
      definition: { command: context.node, args: [path.join(target.packageRoot, "bin", "mcp-connect.js"), "mcp"] },
      env: context.env,
    });
    if (!installation.ok) return {
      ok: false, status: "repair_verification_failed", backup_path: backup,
      cache_entry: target.entry, verification: installation, process_exit_code: installation.process_exit_code || 3,
      action: "新缓存的实际依赖仍不能完成握手。备份已保留；不要清除凭据。",
    };
    progress("launch_probe");
    const verification = await verify({ definition, env: context.env });
    if (!verification.ok) return {
      ok: false, status: "repair_verification_failed", backup_path: backup,
      cache_entry: target.entry, verification, process_exit_code: verification.process_exit_code || 3,
      action: "备份已保留。检查指定客户端运行时与缓存；不要清除凭据。",
    };
    return {
      ok: true, status: "repaired", backup_path: backup, cache_entry: target.entry,
      verification, installation_verification: installation, reload_required: true,
      action: "安装目录已重建并通过握手验证。请在目标 Agent 中重连；本机验证不代表 Agent 已加载。",
    };
  } catch (error) {
    return {
      ok: false, status: "repair_failed", error_code: error.reason || error.diagnosticCode || "REPAIR_FAILED",
      process_exit_code: error.exitCode || (error.diagnosticCode === "CONFIG_INVALID" ? 2 : 3),
      ...(backup ? { backup_path: backup } : {}),
      ...(target ? { cache_entry: target.entry } : {}),
      action: "先停用客户端中石榴 MCP 的自动启动，再核对缓存目录与实际 Node/npm。仅处理独占石榴包的 _npx 安装目录；不删除凭据、其他包或整个缓存。",
    };
  } finally {
    await lock?.close().catch(() => {});
    if (ownedLock) await unlink(lockPath).catch(() => {});
  }
}

export async function printRepair(options) {
  const report = await repairInstallation(options, { progress: (stage) => {
    try { process.stderr.write(`${JSON.stringify({ component: "shiliu_repair", stage })}\n`); } catch { /* closed terminal */ }
  } });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status}${report.error_code ? `：${report.error_code}` : ""}`);
    if (report.backup_path) console.log(`备份目录：${report.backup_path}`);
    console.log(report.action);
  }
  return report;
}
