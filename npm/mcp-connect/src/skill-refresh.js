import { spawnSync } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
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
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function runSkillUpdate({
  cwd,
  platform = process.platform,
  env = process.env,
  spawnImpl = spawnSync,
}) {
  const isWindows = platform === "win32";
  const command = isWindows ? env.ComSpec || "cmd.exe" : "npx";
  const args = isWindows
    ? [
        "/d",
        "/s",
        "/c",
        `npx.cmd -y skills add ${SHILIU_SKILL_SOURCE} -y`,
      ]
    : ["-y", "skills", "add", SHILIU_SKILL_SOURCE, "-y"];
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
} = {}) {
  if (!home) throw new Error("缺少用户目录，无法记录 Skill 检查时间");
  const scope = path.resolve(cwd);
  const state = await readState(home);
  const previous = state.scopes[scope] || {};
  const lastAttemptAt = validTimestamp(previous.lastAttemptAt);
  if (!force && lastAttemptAt !== null && now - lastAttemptAt < intervalMs) {
    return {
      status: "skipped",
      reason: "within_interval",
      nextCheckAt: new Date(lastAttemptAt + intervalMs).toISOString(),
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
    const latestPrevious = latestState.scopes[scope] || {};
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
      };
    }

    const attemptedAt = new Date(now).toISOString();
    latestState.scopes[scope] = {
      ...latestPrevious,
      lastAttemptAt: attemptedAt,
    };
    await writeState(home, latestState);

    try {
      await runUpdate({ cwd: scope });
      latestState.scopes[scope].lastSuccessAt = attemptedAt;
      await writeState(home, latestState);
      return {
        status: "checked",
        checkedAt: attemptedAt,
        nextCheckAt: new Date(now + intervalMs).toISOString(),
      };
    } catch (error) {
      return {
        status: "failed",
        checkedAt: attemptedAt,
        nextCheckAt: new Date(now + intervalMs).toISOString(),
        message: error.message,
      };
    }
  } finally {
    await releaseLock();
  }
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
