import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export async function processStartIdentity(pid, { platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (platform === "linux") {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  }
  const windows = platform === "win32";
  const command = windows ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") : "ps";
  const args = windows ? ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.CreationDate.ToUniversalTime().Ticks.ToString() }`] : ["-p", String(pid), "-o", "lstart="];
  const result = spawnImpl(command, args, { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("进程启动时间不可用");
  return result.stdout.trim();
}

// Only ESRCH proves that an owner is gone. EPERM and malformed metadata fail closed.
export async function inspectRepairLock(lockPath, { kill = process.kill, startIdentity = processStartIdentity, now = Date.now, emptyStaleMs = 60000 } = {}) {
  let text;
  try { text = await readFile(lockPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { state: "absent" }; throw error; }
  let owner;
  try { owner = JSON.parse(text); } catch {
    if (!text.trim()) {
      const info = await stat(lockPath).catch(() => null);
      if (info && now() - info.mtimeMs >= emptyStaleMs) return { state: "stale" };
    }
    return { state: "unknown" };
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return { state: "unknown", owner };
  try {
    kill(owner.pid, 0);
    if (typeof owner.process_start === "string") {
      let current;
      try { current = await startIdentity(owner.pid); } catch { return { state: "unknown", owner }; }
      if (current !== owner.process_start) return { state: "stale", owner };
    }
    return { state: "active", owner };
  }
  catch (error) { return { state: error.code === "ESRCH" ? "stale" : "unknown", owner }; }
}
