import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  refreshShiliuSkill,
  SKILL_REFRESH_INTERVAL_MS,
} from "../src/skill-refresh.js";

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
