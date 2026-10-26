import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SHILIU_SKILL_NAME, clientSkillDirectory, findUnmanagedSkills,
  isInside, registeredTargets, validSkill,
} from "./skill-targets.js";

// This module must remain usable by doctor even when SDK/npm dependencies are missing.
export async function inspectShiliuSkill({
  home = os.homedir(), cwd = process.cwd(), env = process.env,
} = {}) {
  home = path.resolve(home);
  cwd = path.resolve(cwd);
  let state = { version: 1, scopes: {} };
  try {
    state = JSON.parse(await readFile(path.join(home, ".shiliu-ai", "skill-refresh.json"), "utf8"));
    if (state?.version !== 1 || !state.scopes || typeof state.scopes !== "object" || Array.isArray(state.scopes)) {
      return { status: "state_invalid", installations: [], issues: [], detail: "Skill 登记记录格式异常，请核对记录后显式安装；未修改文件。" };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      return { status: "state_unreadable", installations: [], issues: [], detail: "无法读取 Skill 登记记录，请检查文件格式和访问权限；未修改文件。" };
    }
  }
  const installations = new Map();
  const issues = [];
  const physical = value => realpath(value).catch(() => path.resolve(value));
  const registered = new Set();
  const registration = (installPath, scope, root) => ({
    cwd: root,
    command: ["shiliu", "skill", "install", "--target-dir", path.dirname(installPath), "--scope", scope, "--home", home, "--json"],
  });
  const add = async (installPath, scope, root, recorded = false) => {
    installPath = path.resolve(installPath);
    const exists = await validSkill(installPath);
    if (!exists && !recorded) return;
    const key = `${scope}:${root}:${installPath}`;
    installations.set(key, {
      installPath, scope, root, exists,
      registered: recorded || registered.has(await physical(installPath)),
      registration: registration(installPath, scope, root),
    });
  };
  const applicable = Object.values(state.scopes).filter(entry => {
    const target = entry?.target;
    return path.isAbsolute(target?.root || "") &&
      (target.scope === "user" ? path.relative(home, target.root) === "" : target.scope === "project" && isInside(cwd, target.root));
  });
  for (const entry of applicable) {
    const target = entry.target;
    const resolved = registeredTargets(target, { home, cwd, env });
    for (const item of resolved.targets) registered.add(await physical(item.installPath));
    for (const reason of resolved.issues) {
      const agent = reason.split(":")[1];
      issues.push({
        reason, scope: target.scope, root: target.root,
        ...(["codex", "cursor", "claude-code"].includes(agent) ? {
          registration: {
            cwd: target.root,
            command: ["shiliu", "skill", "install", "--agent", agent, "--scope", target.scope, "--home", home, "--json"],
          },
        } : {}),
      });
    }
  }
  for (const entry of applicable) {
    for (const item of registeredTargets(entry.target, { home, cwd, env }).targets) {
      await add(item.installPath, entry.target.scope, entry.target.root, true);
    }
  }
  // Inspect known user locations explicitly; the ordinary refresh orphan scan excludes them.
  for (const directory of [".agents", ".claude", ".hermes"]) {
    await add(path.join(home, directory, "skills", SHILIU_SKILL_NAME), "user", home);
  }
  await add(path.join(clientSkillDirectory({ agent: "claude-code", scope: "user", home, cwd, env }), SHILIU_SKILL_NAME), "user", home);
  // Early refresh records only stored timestamps under an absolute project key.
  // Diagnose those exact ancestor locations; do not broaden the automatic refresh scan.
  for (const [root, entry] of Object.entries(state.scopes)) {
    if (entry?.target || !path.isAbsolute(root) || root === path.parse(root).root || path.relative(home, root) === "" || !isInside(cwd, root)) continue;
    for (const directory of [".agents", ".claude", ".hermes"]) {
      await add(path.join(root, directory, "skills", SHILIU_SKILL_NAME), "project", root);
    }
  }
  for (const item of await findUnmanagedSkills({ state, home, cwd, env })) {
    await add(item.installPath, "project", item.registration.cwd);
  }
  const found = [...installations.values()];
  const requiresAction = issues.length > 0 || found.some(item => !item.registered || !item.exists);
  return {
    status: requiresAction ? "registration_required" : found.length ? "registered" : "not_installed",
    installations: found, issues,
    detail: requiresAction
      ? "发现未登记、缺失或需要迁移的 Skill。请确认路径后显式执行对应安装命令；doctor 不登记、不安装，refresh 不接管旧目录。"
      : found.length ? "当前范围内的 Skill 已登记。" : "当前范围内未发现已安装的石榴 Skill；如需使用，请显式选择客户端和安装范围。",
  };
}

export function formatSkillCommand(command, platform = process.platform) {
  return command.map(argument => /^[a-zA-Z0-9_./:\\-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", platform === "win32" ? "''" : "'\"'\"'")}'`).join(" ");
}
