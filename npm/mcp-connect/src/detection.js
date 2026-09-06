import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export function commandExists(command, spawn = spawnSync) {
  const result = spawn(command, ["--version"], {
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
