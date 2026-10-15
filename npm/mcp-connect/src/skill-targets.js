import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const SHILIU_SKILL_NAME = "shiliu-ai-mcp";

export function isInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function clientSkillDirectory({
  agent,
  scope,
  home,
  cwd,
  env = process.env,
}) {
  const root = path.resolve(scope === "user" ? home : cwd);
  if (agent === "claude-code") {
    return scope === "user" && env.CLAUDE_CONFIG_DIR?.trim()
      ? path.resolve(cwd, env.CLAUDE_CONFIG_DIR.trim(), "skills")
      : path.join(root, ".claude", "skills");
  }
  if (["codex", "cursor"].includes(agent))
    return path.join(root, ".agents", "skills");
  throw new Error(
    "未知 Skill 客户端，请使用 --target-dir 指定客户端文档中的 Skill 父目录",
  );
}

export async function validSkill(installPath) {
  try {
    if (!(await stat(installPath)).isDirectory()) return false;
    const text = await readFile(path.join(installPath, "SKILL.md"), "utf8");
    const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1];
    return /^name:\s*["']?shiliu-ai-mcp["']?\s*$/mu.test(frontmatter || "");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

export function registeredTargets(target, { home, cwd, env = process.env }) {
  const targets = [];
  const issues = [];
  if (
    !target ||
    !["project", "user"].includes(target.scope) ||
    !path.isAbsolute(target.root || "")
  ) {
    return { targets, issues: ["invalid_target_record"] };
  }
  for (const item of target.directTargets || []) {
    if (
      !path.isAbsolute(item.installPath || "") ||
      path.basename(item.installPath) !== SHILIU_SKILL_NAME ||
      path.resolve(item.targetDirectory || "") !==
        path.dirname(item.installPath)
    ) {
      issues.push("invalid_target_record");
    } else targets.push(item);
  }
  for (const agent of target.agents || []) {
    if (targets.some((item) => item.agent === agent)) continue;
    try {
      const expected = path.join(
        clientSkillDirectory({
          agent,
          scope: target.scope,
          home,
          cwd: target.root,
          env,
        }),
        SHILIU_SKILL_NAME,
      );
      const oldPath =
        target.legacyInstallPath ||
        target.managedInstallPath ||
        target.installPath;
      if (
        !path.isAbsolute(oldPath || "") ||
        path.relative(expected, oldPath) !== ""
      ) {
        issues.push(`target_path_migration_required:${agent}`);
      } else
        targets.push({
          agent,
          installPath: expected,
          targetDirectory: path.dirname(expected),
        });
    } catch {
      issues.push(`target_path_migration_required:${agent}`);
    }
  }
  if (targets.length === 0 && issues.length === 0)
    issues.push("invalid_target_record");
  return { targets, issues };
}

const physicalPath = async (value) =>
  realpath(value).catch(() => path.resolve(value));

// Only inspect known Skill locations up to this repository root, never a filesystem root search.
export async function findUnmanagedSkills({
  state,
  home,
  cwd,
  env = process.env,
}) {
  let root = path.resolve(cwd);
  try {
    const candidate = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (candidate) {
      const repository = await physicalPath(candidate);
      // Git may expand Windows 8.3 aliases. Walk lexical parents only while their
      // real paths remain inside the reported repo, retaining the caller's path spelling.
      let ancestor = root;
      while (isInside(await physicalPath(ancestor), repository)) {
        if (path.relative(await physicalPath(ancestor), repository) === "") {
          root = ancestor;
          break;
        }
        if (path.dirname(ancestor) === ancestor) break;
        ancestor = path.dirname(ancestor);
      }
    }
  } catch {
    /* Without a repository, only inspect cwd. */
  }
  const excluded = new Set();
  const exclude = async (value) => {
    if (!path.isAbsolute(value || "")) return;
    excluded.add(path.resolve(value));
    excluded.add(await physicalPath(value));
  };
  for (const directory of [".agents", ".claude", ".hermes"]) {
    await exclude(path.join(home, directory, "skills", SHILIU_SKILL_NAME));
  }
  if (env.CLAUDE_CONFIG_DIR?.trim()) {
    await exclude(
      path.resolve(
        cwd,
        env.CLAUDE_CONFIG_DIR.trim(),
        "skills",
        SHILIU_SKILL_NAME,
      ),
    );
  }
  for (const entry of Object.values(state.scopes)) {
    const target = entry?.target;
    await exclude(target?.installPath);
    await exclude(target?.legacyInstallPath);
    await exclude(target?.managedInstallPath);
    for (const item of target?.directTargets || [])
      await exclude(item.installPath);
  }
  const result = [];
  let current = path.resolve(cwd);
  while (true) {
    for (const client of [".agents", ".claude", ".hermes"]) {
      const installPath = path.join(
        current,
        client,
        "skills",
        SHILIU_SKILL_NAME,
      );
      const physical = await physicalPath(installPath);
      if (
        excluded.has(installPath) ||
        excluded.has(physical) ||
        !(await validSkill(installPath))
      )
        continue;
      excluded.add(physical);
      result.push({
        installPath,
        registration: {
          cwd: current,
          command: [
            "shiliu",
            "skill",
            "install",
            "--target-dir",
            path.dirname(installPath),
            "--scope",
            "project",
            "--json",
          ],
        },
        action:
          "显式安装并登记此目标，或确认不再使用后手动删除此 Skill 副本；保留其他 Skill 和共享锁文件。",
      });
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return result;
}
