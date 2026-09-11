import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installShiliuSkill,
  refreshShiliuSkill,
  runSkillUpdate,
  SKILL_REFRESH_INTERVAL_MS,
  SHILIU_SKILL_SOURCE,
} from "../src/skill-refresh.js";

test("uses cmd.exe to launch npx.cmd on Windows", () => {
  let invocation;
  runSkillUpdate({
    cwd: "C:\\project",
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    invocation.args[3],
    `npx.cmd -y skills add ${SHILIU_SKILL_SOURCE} --skill shiliu-ai-mcp -y`,
  );
  assert.doesNotMatch(invocation.args[3], /github|\bgit\b/iu);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, "C:\\project");
});

test("uses the website skill source without Git on POSIX", () => {
  let invocation;
  runSkillUpdate({
    cwd: "/project",
    platform: "linux",
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(invocation.command, "npx");
  assert.deepEqual(invocation.args, [
    "-y",
    "skills",
    "add",
    SHILIU_SKILL_SOURCE,
    "--skill",
    "shiliu-ai-mcp",
    "-y",
  ]);
  assert.doesNotMatch(invocation.args.join(" "), /github|\bgit\b/iu);
  assert.equal(invocation.options.shell, false);
});

test("records the exact Skill install target and reuses it for refresh", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-target-"));
  const project = path.join(home, "project");
  const invocations = [];
  const runUpdate = async (options) => {
    invocations.push(options);
  };
  const now = Date.UTC(2026, 8, 8, 0, 0, 0);
  try {
    const installed = await installShiliuSkill({
      home,
      cwd: project,
      agent: "claude-code",
      scope: "project",
      now,
      runUpdate,
      verifyInstall: async () => true,
    });
    assert.equal(installed.scope, "project");
    assert.equal(
      installed.installPath,
      path.join(project, ".agents", "skills", "shiliu-ai-mcp"),
    );
    assert.deepEqual(invocations[0], {
      cwd: path.resolve(project),
      agent: "claude-code",
      scope: "project",
    });

    await refreshShiliuSkill({
      home,
      cwd: path.join(project, "nested"),
      now: now + SKILL_REFRESH_INTERVAL_MS,
      runUpdate,
      verifyInstall: async () => true,
    });
    assert.deepEqual(invocations[1], {
      cwd: path.resolve(project),
      agent: "claude-code",
      scope: "project",
    });
    const stored = JSON.parse(
      await readFile(path.join(home, ".shiliu-ai", "skill-refresh.json")),
    );
    assert.deepEqual(stored.scopes[path.resolve(project)].target.agents, [
      "claude-code",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a user-scope Skill target follows the user across working directories", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-user-"));
  const invocations = [];
  const runUpdate = async (options) => invocations.push(options);
  const now = Date.UTC(2026, 8, 8, 0, 0, 0);
  try {
    await installShiliuSkill({
      home,
      cwd: path.join(home, "first"),
      agent: "codex",
      scope: "user",
      now,
      runUpdate,
      verifyInstall: async () => true,
    });
    await refreshShiliuSkill({
      home,
      cwd: path.join(home, "second"),
      now: now + SKILL_REFRESH_INTERVAL_MS,
      runUpdate,
      verifyInstall: async () => true,
    });
    assert.deepEqual(invocations[1], {
      cwd: path.resolve(home),
      agent: "codex",
      scope: "user",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Skill install dry-run neither runs the installer nor records state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-dry-"));
  let calls = 0;
  try {
    const result = await installShiliuSkill({
      home,
      cwd: path.join(home, "project"),
      agent: "codex",
      scope: "project",
      dryRun: true,
      runUpdate: async () => {
        calls += 1;
      },
    });
    assert.equal(result.status, "dry_run");
    assert.equal(result.refreshTargetRecorded, false);
    assert.equal(calls, 0);
    await assert.rejects(
      readFile(path.join(home, ".shiliu-ai", "skill-refresh.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("does not record a successful target when the installed Skill is missing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-missing-"));
  try {
    await assert.rejects(
      installShiliuSkill({
        home,
        cwd: path.join(home, "project"),
        agent: "codex",
        runUpdate: async () => {},
        verifyInstall: async () => false,
      }),
      /未在预期位置找到/u,
    );
    await assert.rejects(
      readFile(path.join(home, ".shiliu-ai", "skill-refresh.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("checks once per scope during the 24 hour interval", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-refresh-"));
  let calls = 0;
  const now = Date.UTC(2026, 8, 7, 0, 0, 0);
  const runUpdate = async () => {
    calls += 1;
  };
  try {
    const first = await refreshShiliuSkill({
      home,
      cwd: path.join(home, "project"),
      now,
      runUpdate,
    });
    const second = await refreshShiliuSkill({
      home,
      cwd: path.join(home, "project"),
      now: now + 60_000,
      runUpdate,
    });
    const nextDay = await refreshShiliuSkill({
      home,
      cwd: path.join(home, "project"),
      now: now + SKILL_REFRESH_INTERVAL_MS,
      runUpdate,
    });

    assert.equal(first.status, "checked");
    assert.equal(second.status, "skipped");
    assert.equal(nextDay.status, "checked");
    assert.equal(calls, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed checks enter the same cooldown without blocking later work", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-failure-"));
  const cwd = path.join(home, "project");
  const now = Date.UTC(2026, 8, 7, 0, 0, 0);
  try {
    const failed = await refreshShiliuSkill({
      home,
      cwd,
      now,
      runUpdate: async () => {
        throw new Error("network unavailable");
      },
    });
    const skipped = await refreshShiliuSkill({
      home,
      cwd,
      now: now + 60_000,
      runUpdate: async () => {
        throw new Error("must not run");
      },
    });
    const stored = JSON.parse(
      await readFile(path.join(home, ".shiliu-ai", "skill-refresh.json")),
    );

    assert.equal(failed.status, "failed");
    assert.equal(skipped.status, "skipped");
    assert.ok(stored.scopes[path.resolve(cwd)].lastAttemptAt);
    assert.equal(stored.scopes[path.resolve(cwd)].lastSuccessAt, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("force bypasses the cooldown", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-force-"));
  let calls = 0;
  const runUpdate = async () => {
    calls += 1;
  };
  try {
    await refreshShiliuSkill({ home, now: 1_000, runUpdate });
    const forced = await refreshShiliuSkill({
      home,
      now: 2_000,
      force: true,
      runUpdate,
    });
    assert.equal(forced.status, "checked");
    assert.equal(calls, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent refreshes run the network update only once", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-lock-"));
  let calls = 0;
  let releaseUpdate;
  const waitForRelease = new Promise((resolve) => {
    releaseUpdate = resolve;
  });
  const runUpdate = async () => {
    calls += 1;
    await waitForRelease;
  };

  try {
    const first = refreshShiliuSkill({ home, cwd: home, runUpdate });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await refreshShiliuSkill({ home, cwd: home, runUpdate });
    releaseUpdate();
    const firstResult = await first;

    assert.equal(firstResult.status, "checked");
    assert.equal(second.status, "skipped");
    assert.ok(
      ["refresh_in_progress", "within_interval"].includes(second.reason),
    );
    assert.equal(calls, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
