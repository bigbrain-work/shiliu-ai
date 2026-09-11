import { spawnSync } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const SKILL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SHILIU_SKILL_NAME = "shiliu-ai-mcp";
export const SHILIU_SKILL_SOURCE = "https://bigbrain.work/shiliuAI";
const STALE_LOCK_MS = 15 * 60 * 1000;

function stateFile(home) {
  return path.join(home, ".shiliu-ai", "skill-refresh.json");
}

function lockFile(home) {
  return path.join(home, ".shiliu-ai", "skill-refresh.lock");
}

async function acquireLock(home, retried = false) {
  await mkdir(path.dirname(lockFile(home)), { recursive: true });
  let handle;
  try {
    handle = await open(lockFile(home), "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    await handle?.close();
    if (error.code === "EEXIST") {
      if (!retried) {
        try {
          const lockStat = await stat(lockFile(home));
          if (Date.now() - lockStat.mtimeMs >= STALE_LOCK_MS) {
            await unlink(lockFile(home));
            return acquireLock(home, true);
          }
        } catch (lockError) {
          if (lockError.code === "ENOENT") return acquireLock(home, true);
          throw lockError;
        }
      }
      return null;
    }
    throw error;
  }
  await handle.close();
  return async () => {
    try {
      await unlink(lockFile(home));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

async function readState(home) {
  try {
    const value = JSON.parse(await readFile(stateFile(home), "utf8"));
    if (value?.version === 1 && value.scopes && typeof value.scopes === "object") {
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

function targetRoot({ home, cwd, scope }) {
  return path.resolve(scope === "user" ? home : cwd);
}

function targetKey({ home, cwd, scope }) {
  const root = targetRoot({ home, cwd, scope });
  return scope === "user" ? `user:${root}` : root;
}

function skillInstallPath(root) {
  return path.join(root, ".agents", "skills", SHILIU_SKILL_NAME);
}

async function verifySkillInstall(installPath) {
  try {
    const metadata = await stat(path.join(installPath, "SKILL.md"));
    return metadata.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function selectRefreshEntry(state, { home, cwd }) {
  const absoluteCwd = path.resolve(cwd);
  const projects = Object.entries(state.scopes)
    .filter(([, entry]) => {
      const target = entry?.target;
      return (
        target?.scope === "project" &&
        typeof target.root === "string" &&
        isPathInside(absoluteCwd, path.resolve(target.root))
      );
    })
    .sort(
      ([, left], [, right]) =>
        path.resolve(right.target.root).length - path.resolve(left.target.root).length,
    );
  if (projects.length > 0) return projects[0];
  const userEntry = state.scopes[targetKey({ home, cwd, scope: "user" })];
  if (userEntry?.target?.scope === "user") {
    return [targetKey({ home, cwd, scope: "user" }), userEntry];
  }
  const legacyKey = path.resolve(cwd);
  return [legacyKey, state.scopes[legacyKey] || {}];
}

export function runSkillUpdate({
  cwd,
  agent,
  scope = "project",
  platform = process.platform,
  env = process.env,
  spawnImpl = spawnSync,
}) {
  if (agent && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agent)) {
    throw new Error("Skill 客户端标识格式无效");
  }
  const isWindows = platform === "win32";
  const targetArguments = [
    "--skill",
    SHILIU_SKILL_NAME,
    ...(agent ? ["-a", agent] : []),
    ...(scope === "user" ? ["-g"] : []),
    "-y",
  ];
  const command = isWindows ? env.ComSpec || "cmd.exe" : "npx";
  const args = isWindows
    ? [
        "/d",
        "/s",
        "/c",
        `npx.cmd -y skills add ${SHILIU_SKILL_SOURCE} ${targetArguments.join(" ")}`,
      ]
    : ["-y", "skills", "add", SHILIU_SKILL_SOURCE, ...targetArguments];
  const result = spawnImpl(
    command,
    args,
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `skills add 返回退出码 ${result.status}`,
    );
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

export async function installShiliuSkill({
  home,
  cwd = process.cwd(),
  agent,
  scope = "project",
  now = Date.now(),
  dryRun = false,
  runUpdate = runSkillUpdate,
  verifyInstall = verifySkillInstall,
} = {}) {
  if (!home) throw new Error("缺少用户目录，无法记录 Skill 安装目标");
  if (!agent) throw new Error("缺少 Skill 客户端标识");
  if (!["project", "user"].includes(scope)) {
    throw new Error("Skill 安装范围只能是 project 或 user");
  }
  const root = targetRoot({ home, cwd, scope });
  const key = targetKey({ home, cwd, scope });
  const installPath = skillInstallPath(root);
  if (dryRun) {
    return {
      status: "dry_run",
      agent,
      scope,
      root,
      installPath,
      installedAt: null,
      refreshTargetRecorded: false,
    };
  }
  const releaseLock = await acquireLock(home);
  if (!releaseLock) throw new Error("另一个石榴 Skill 操作正在进行，请稍后重试");
  try {
    await runUpdate({ cwd: root, agent, scope });
    if (!(await verifyInstall(installPath))) {
      throw new Error(
        `skills add 已结束，但未在预期位置找到 ${path.join(installPath, "SKILL.md")}`,
      );
    }
    const installedAt = new Date(now).toISOString();
    const state = await readState(home);
    const previous = state.scopes[key] || {};
    const agents = [...new Set([...(previous.target?.agents || []), agent])].sort();
    state.scopes[key] = {
      ...previous,
      target: {
        scope,
        root,
        installPath,
        agents,
      },
      lastAttemptAt: installedAt,
      lastSuccessAt: installedAt,
    };
    await writeState(home, state);
    return {
      status: "installed",
      agent,
      scope,
      root,
      installPath,
      installedAt,
      refreshTargetRecorded: true,
    };
  } finally {
    await releaseLock();
  }
}

function validTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function refreshShiliuSkill({
  home,
  cwd = process.cwd(),
  now = Date.now(),
  force = false,
  intervalMs = SKILL_REFRESH_INTERVAL_MS,
  runUpdate = runSkillUpdate,
  verifyInstall = verifySkillInstall,
} = {}) {
  if (!home) throw new Error("缺少用户目录，无法记录 Skill 检查时间");
  const state = await readState(home);
  const [, previous] = selectRefreshEntry(state, { home, cwd });
  const lastAttemptAt = validTimestamp(previous.lastAttemptAt);
  if (!force && lastAttemptAt !== null && now - lastAttemptAt < intervalMs) {
    return {
      status: "skipped",
      reason: "within_interval",
      nextCheckAt: new Date(lastAttemptAt + intervalMs).toISOString(),
      target: previous.target || null,
    };
  }

  const releaseLock = await acquireLock(home);
  if (!releaseLock) {
    return {
      status: "skipped",
      reason: "refresh_in_progress",
    };
  }

  try {
    const latestState = await readState(home);
    const [latestScopeKey, latestPrevious] = selectRefreshEntry(latestState, {
      home,
      cwd,
    });
    const latestAttemptAt = validTimestamp(latestPrevious.lastAttemptAt);
    if (
      !force &&
      latestAttemptAt !== null &&
      now - latestAttemptAt < intervalMs
    ) {
      return {
        status: "skipped",
        reason: "within_interval",
        nextCheckAt: new Date(latestAttemptAt + intervalMs).toISOString(),
        target: latestPrevious.target || null,
      };
    }

    const attemptedAt = new Date(now).toISOString();
    latestState.scopes[latestScopeKey] = {
      ...latestPrevious,
      lastAttemptAt: attemptedAt,
    };
    await writeState(home, latestState);

    try {
      const target = latestPrevious.target;
      if (target) {
        for (const agent of target.agents) {
          await runUpdate({
            cwd: target.root,
            agent,
            scope: target.scope,
          });
        }
        if (!(await verifyInstall(target.installPath))) {
          throw new Error(
            `刷新命令已结束，但未在记录位置找到 ${path.join(target.installPath, "SKILL.md")}`,
          );
        }
      } else {
        await runUpdate({ cwd: path.resolve(cwd) });
      }
      latestState.scopes[latestScopeKey].lastSuccessAt = attemptedAt;
      await writeState(home, latestState);
      return {
        status: "checked",
        checkedAt: attemptedAt,
        nextCheckAt: new Date(now + intervalMs).toISOString(),
        target: target || null,
      };
    } catch (error) {
      return {
        status: "failed",
        checkedAt: attemptedAt,
        nextCheckAt: new Date(now + intervalMs).toISOString(),
        message: error.message,
        target: latestPrevious.target || null,
      };
    }
  } finally {
    await releaseLock();
  }
}

export async function printSkillInstall(options = {}) {
  const result = await installShiliuSkill(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(
    result.status === "dry_run"
      ? `演练模式：将为客户端 ${result.agent} 把石榴 Skill 安装到 ${result.installPath}（${result.scope} 范围），未执行安装或记录刷新目标。`
      : `石榴 Skill 已安装到 ${result.installPath}（${result.scope} 范围，客户端 ${result.agent}），后续刷新目标已记录。`,
  );
  return result;
}

export async function printSkillRefresh(options = {}) {
  const result = await refreshShiliuSkill(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (result.status === "skipped") {
    console.log(
      result.reason === "refresh_in_progress"
        ? "另一个石榴 Skill 检查正在进行，本次继续使用已安装 Skill。"
        : `石榴 Skill 在24小时内已检查，下次检查时间：${result.nextCheckAt}`,
    );
  } else if (result.status === "checked") {
    console.log(`石榴 Skill 检查完成，下次检查时间：${result.nextCheckAt}`);
  } else {
    console.warn(
      `石榴 Skill 检查失败：${result.message}。已进入24小时冷却，本次继续使用已安装 Skill。`,
    );
  }
  return result;
}
