import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export function commandExists(
  command,
  spawn = spawnSync,
  { platform = process.platform, env = process.env } = {},
) {
  if (!/^[a-z0-9_-]+$/iu.test(command)) return false;
  const isWindows = platform === "win32";
  const executable = isWindows ? env.ComSpec || "cmd.exe" : command;
  const args = isWindows
    ? ["/d", "/s", "/c", `${command} --version`]
    : ["--version"];
  const result = spawn(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5000,
  });
  return !result.error && result.status === 0;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function detectInstalledAgents({
  home,
  hasCommand = commandExists,
  exists = pathExists,
} = {}) {
  const agents = [];
  if (hasCommand("codex")) agents.push("codex");
  if (hasCommand("claude")) agents.push("claude");
  if (hasCommand("cursor") || (await exists(path.join(home, ".cursor")))) {
    agents.push("cursor");
  }
  return agents;
}
