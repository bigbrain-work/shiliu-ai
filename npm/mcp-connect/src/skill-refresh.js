import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { installSkillArchive } from "./direct-skill-install.js";
import {
  SHILIU_SKILL_NAME,
  clientSkillDirectory,
  validSkill,
  isInside,
  registeredTargets,
  findUnmanagedSkills,
} from "./skill-targets.js";
export { SHILIU_SKILL_NAME } from "./skill-targets.js";
export const SKILL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SHILIU_SKILL_SOURCE = "https://www.bigbrain.work/shiliuai";
const STALE_LOCK_MS = 15 * 60 * 1000;

function stateFile(home) {
  return path.join(home, ".shiliu-ai", "skill-refresh.json");
}

function lockFile(home) {
  return path.join(home, ".shiliu-ai", "skill-refresh.lock");
}

async function acquireLock(home) {
  await mkdir(path.dirname(lockFile(home)), { recursive: true });
  let releaseGuard;
  let compromised;
  try {
    releaseGuard = await lockfile.lock(lockFile(home), { realpath: false, lockfilePath: `${lockFile(home)}.guard`, stale: STALE_LOCK_MS, update: 10000, retries: 0,
      onCompromised: error => { compromised = error; } });
  } catch (error) { if (error.code === "ELOCKED") return null; throw error; }
  const owner = `${process.pid}\n${randomUUID()}\n`;
  let handle;
  try {
    try { handle = await open(lockFile(home), "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await readFile(lockFile(home), "utf8");
      const metadata = await stat(lockFile(home));
      if (Date.now() - metadata.mtimeMs < STALE_LOCK_MS) { await releaseGuard(); return null; }
      try { process.kill(Number(previous.split("\n")[0]), 0); await releaseGuard(); return null; }
      catch (failure) { if (failure.code !== "ESRCH") { await releaseGuard(); return null; } }
      if (await readFile(lockFile(home), "utf8") !== previous) { await releaseGuard(); return null; }
      await unlink(lockFile(home));
      handle = await open(lockFile(home), "wx", 0o600);
    }
    await handle.writeFile(owner, "utf8");
  } catch (error) {
    await handle?.close();
    await releaseGuard();
    if (error.code === "EEXIST") return null;
    throw error;
  }
  await handle.close();
  const release = async () => {
    try {
      if (await readFile(lockFile(home), "utf8") === owner) await unlink(lockFile(home));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally { await releaseGuard().catch(error => { if (!compromised) throw error; }); }
  };
  release.assertOwned = () => { if (compromised) throw new Error("Skill 操作锁已失效，停止写入并保留现有文件"); };
  return release;
}

async function readState(home) {
  try {
    const value = JSON.parse(await readFile(stateFile(home), "utf8"));
    if (
      value?.version === 1 &&
      value.scopes &&
      typeof value.scopes === "object"
    ) {
      return value;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
  }
  return { version: 1, scopes: {} };
}

async function writeState(home, state) {
  const file = stateFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryFile, file);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
}

function scopeKey(root, scope) {
  return scope === "user" ? `user:${root}` : root;
}

function selectEntry(state, home, cwd) {
  const projects = Object.entries(state.scopes)
    .filter(
      ([, entry]) =>
        entry?.target?.scope === "project" &&
        path.isAbsolute(entry.target.root || "") &&
        isInside(cwd, entry.target.root),
    )
    .sort(([, a], [, b]) => b.target.root.length - a.target.root.length);
  if (projects.length) return projects[0];
  const key = scopeKey(path.resolve(home), "user");
  return [
    key,
    state.scopes[key]?.target?.scope === "user" ? state.scopes[key] : undefined,
  ];
}

export async function installShiliuSkill({
  home,
  cwd = process.cwd(),
  env = process.env,
  agent,
  scope = "project",
  targetDirectory,
  now = Date.now(),
  dryRun = false,
  directInstall = installSkillArchive,
} = {}) {
  if (!home) throw new Error("缺少用户目录，无法记录 Skill 安装目标");
  if (!["project", "user"].includes(scope))
    throw new Error("Skill 安装范围只能是 project 或 user");
  if ((!agent && !targetDirectory) || (agent && targetDirectory))
    throw new Error("请选择 --agent 或 --target-dir 中的一种安装方式");
  const root = path.resolve(scope === "user" ? home : cwd);
  const parent = targetDirectory
    ? path.resolve(cwd, targetDirectory)
    : clientSkillDirectory({ agent, scope, home, cwd, env });
  const installPath = path.join(parent, SHILIU_SKILL_NAME);
  const description = {
    agent: agent || null,
    scope,
    root,
    targetDirectory: parent,
    installPath,
    installMethod: "direct_website",
    refreshTargetRecorded: false,
    existingInstallation: await validSkill(installPath),
  };
  if (dryRun) return { status: "dry_run", ...description, installedAt: null };
  const releaseLock = await acquireLock(home);
  if (!releaseLock)
    throw new Error("另一个石榴 Skill 操作正在进行，请稍后重试");
  try {
    releaseLock.assertOwned();
    const installed = await directInstall({
      targetDirectory: parent,
      sourceBaseUrl: SHILIU_SKILL_SOURCE,
      skillName: SHILIU_SKILL_NAME,
    });
    if (
      path.resolve(installed.installPath) !== installPath ||
      !(await validSkill(installPath))
    ) {
      throw new Error(
        `未在预期位置找到有效的 ${SHILIU_SKILL_NAME}：${installPath}`,
      );
    }
    const state = await readState(home);
    const key = scopeKey(root, scope);
    const previous = state.scopes[key] || {};
    const previousTarget = previous.target || {};
    const directTargets = (previousTarget.directTargets || []).filter((item) =>
      agent
        ? item.agent !== agent
        : path.resolve(item.installPath) !== installPath,
    );
    directTargets.push({
      agent: agent || null,
      targetDirectory: parent,
      installPath,
      source: installed.source,
      digest: installed.digest,
      installMethod: "direct_website",
    });
    const stillLegacy = (previousTarget.agents || []).some(
      (name) => !directTargets.some((item) => item.agent === name),
    );
    const installedAt = new Date(now).toISOString();
    state.scopes[key] = {
      ...previous,
      target: {
        ...previousTarget,
        scope,
        root,
        installPath: directTargets[0].installPath,
        legacyInstallPath: stillLegacy
          ? previousTarget.legacyInstallPath || previousTarget.installPath
          : undefined,
        agents: [
          ...new Set([
            ...(previousTarget.agents || []),
            ...(agent ? [agent] : []),
          ]),
        ],
        directTargets,
      },
      lastAttemptAt: installedAt,
      lastSuccessAt: installedAt,
    };
    releaseLock.assertOwned();
    await writeState(home, state);
    return {
      status: "installed",
      ...description,
      installedAt,
      source: installed.source,
      digest: installed.digest,
      refreshTargetRecorded: true,
      unmanagedInstallations: await findUnmanagedSkills({
        state,
        home,
        cwd,
        env,
      }),
    };
  } finally {
    await releaseLock();
  }
}

async function inspectEntry(entry, options) {
  const resolved = registeredTargets(entry.target, options);
  if (resolved.issues.length)
    return {
      reason: "target_migration_required",
      issues: resolved.issues,
      installCommands: resolved.issues.flatMap((issue) => {
        const agent = issue.split(":")[1];
        return ["codex", "cursor", "claude-code"].includes(agent)
          ? [
              {
                cwd: entry.target.root,
                command: [
                  "shiliu",
                  "skill",
                  "install",
                  "--agent",
                  agent,
                  "--scope",
                  entry.target.scope,
                  "--json",
                ],
              },
            ]
          : [];
      }),
    };
  for (const target of resolved.targets) {
    if (!(await validSkill(target.installPath)))
      return {
        reason: "target_missing",
        installPath: target.installPath,
        installCommands: [
          {
            cwd: entry.target.root,
            command: [
              "shiliu",
              "skill",
              "install",
              "--target-dir",
              target.targetDirectory,
              "--scope",
              entry.target.scope,
              "--json",
            ],
          },
        ],
      };
  }
  return resolved;
}

export async function refreshShiliuSkill({
  home,
  cwd = process.cwd(),
  env = process.env,
  now = Date.now(),
  force = false,
  intervalMs = SKILL_REFRESH_INTERVAL_MS,
  directInstall = installSkillArchive,
} = {}) {
  if (!home) throw new Error("缺少用户目录，无法记录 Skill 检查时间");
  const state = await readState(home);
  const [, entry] = selectEntry(state, home, cwd);
  if (!entry)
    return {
      status: "skipped",
      reason: "target_not_registered",
      target: null,
      unmanagedInstallations: await findUnmanagedSkills({
        state,
        home,
        cwd,
        env,
      }),
    };
  const initial = await inspectEntry(entry, { home, cwd, env });
  if (initial.reason)
    return {
      status: "skipped",
      ...initial,
      target: entry.target,
      action:
        "请显式运行 shiliu skill install 登记正确路径；refresh 不补装、不迁移安装目录。",
    };
  const previousAttempt = Date.parse(entry.lastAttemptAt || "");
  if (
    !force &&
    Number.isFinite(previousAttempt) &&
    now - previousAttempt < intervalMs
  ) {
    return {
      status: "skipped",
      reason: "within_interval",
      nextCheckAt: new Date(previousAttempt + intervalMs).toISOString(),
      target: entry.target,
    };
  }
  const releaseLock = await acquireLock(home);
  if (!releaseLock) return { status: "skipped", reason: "refresh_in_progress" };
  try {
    releaseLock.assertOwned();
    const latest = await readState(home);
    const [key, current] = selectEntry(latest, home, cwd);
    if (!current)
      return {
        status: "skipped",
        reason: "target_not_registered",
        target: null,
      };
    const inspection = await inspectEntry(current, { home, cwd, env });
    if (inspection.reason)
      return { status: "skipped", ...inspection, target: current.target };
    const lastAttempt = Date.parse(current.lastAttemptAt || "");
    if (
      !force &&
      Number.isFinite(lastAttempt) &&
      now - lastAttempt < intervalMs
    ) {
      return {
        status: "skipped",
        reason: "within_interval",
        target: current.target,
      };
    }
    const attemptedAt = new Date(now).toISOString();
    current.lastAttemptAt = attemptedAt;
    releaseLock.assertOwned();
    await writeState(home, latest);
    try {
      const updated = new Map();
      for (const target of inspection.targets) {
        releaseLock.assertOwned();
        // Existing symlinked targets share one physical installation; do not replace their links.
        const storage = await realpath(target.installPath);
        if (path.basename(storage) !== SHILIU_SKILL_NAME)
          throw new Error("Skill 链接目标名称不匹配，请显式安装到正确目录");
        const result =
          updated.get(storage) ||
          (await directInstall({
            targetDirectory: path.dirname(storage),
            sourceBaseUrl: SHILIU_SKILL_SOURCE,
            skillName: SHILIU_SKILL_NAME,
            requireExisting: true,
          }));
        if (
          path.resolve(result.installPath) !== storage ||
          !(await validSkill(target.installPath))
        )
          throw new Error("Skill 刷新目标校验失败");
        updated.set(storage, result);
        target.source = result.source;
        target.digest = result.digest;
      }
      current.lastSuccessAt = attemptedAt;
      releaseLock.assertOwned();
      await writeState(home, latest);
      return {
        status: "checked",
        checkedAt: attemptedAt,
        nextCheckAt: new Date(now + intervalMs).toISOString(),
        target: current.target,
      };
    } catch (error) {
      return {
        status: "failed",
        checkedAt: attemptedAt,
        nextCheckAt: new Date(now + intervalMs).toISOString(),
        message: error.message,
        target: current.target,
      };
    }
  } finally {
    await releaseLock();
  }
}

export async function printSkillInstall(options = {}) {
  const result = await installShiliuSkill(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    if (result.status === "dry_run" && result.existingInstallation) {
      console.log("此路径已有石榴 Skill；正式执行将更新并登记所选路径，其他安装保持不变。");
    }
    console.log(
      `${result.status === "dry_run" ? "演练模式，未安装：" : "Skill 已安装并登记："}${result.installPath}（${result.scope}，direct_website）`,
    );
  }
  return result;
}

export async function printSkillRefresh(options = {}) {
  const result = await refreshShiliuSkill(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.reason === "target_not_registered")
    console.log("未登记刷新目标；继续使用当前可用能力，未执行安装。");
  else if (
    result.reason === "target_missing" ||
    result.reason === "target_migration_required"
  )
    console.log(
      "刷新目标缺失或需要迁移，请显式运行 shiliu skill install；未执行安装。",
    );
  else if (result.status === "failed")
    console.warn(
      `石榴 Skill 检查失败：${result.message}。本次继续使用已安装 Skill。`,
    );
  else if (result.status === "checked")
    console.log(`石榴 Skill 检查完成，下次检查时间：${result.nextCheckAt}`);
  else console.log("刷新已跳过；继续使用已安装 Skill。");
  return result;
}
