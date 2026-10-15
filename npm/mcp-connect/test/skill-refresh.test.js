import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installShiliuSkill,
  refreshShiliuSkill,
  printSkillRefresh,
  SKILL_REFRESH_INTERVAL_MS,
} from "../src/skill-refresh.js";
import { archiveInstaller } from "../test-support/skill-archive.js";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-refresh-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home"),
    cwd = path.join(home, "projects", "a");
  await mkdir(cwd, { recursive: true });
  const archive = await archiveInstaller(root);
  return {
    root,
    home,
    cwd,
    archive,
    options: { home, cwd, env: {}, now: 1000, directInstall: archive.install },
  };
}
async function skill(p) {
  await mkdir(p, { recursive: true });
  await writeFile(
    path.join(p, "SKILL.md"),
    "---\nname: shiliu-ai-mcp\n---\nold\n",
  );
}
const stateFile = (home) => path.join(home, ".shiliu-ai", "skill-refresh.json");
async function saveState(home, scopes) {
  await mkdir(path.dirname(stateFile(home)), { recursive: true });
  await writeFile(stateFile(home), JSON.stringify({ version: 1, scopes }));
}
for (const agent of ["codex", "claude-code", "cursor"])
  for (const scope of ["project", "user"])
    test(`real archive path, state and refresh: ${agent}/${scope}`, async (t) => {
      const f = await fixture(t);
      const root = scope === "user" ? f.home : f.cwd;
      const expected = path.join(
        root,
        agent === "claude-code" ? ".claude" : ".agents",
        "skills",
        "shiliu-ai-mcp",
      );
      const dry = await installShiliuSkill({
        ...f.options,
        agent,
        scope,
        dryRun: true,
      });
      assert.equal(dry.installPath, expected);
      assert.equal(f.archive.calls(), 0);
      assert.deepEqual(await readdir(f.cwd), []);
      const installed = await installShiliuSkill({
        ...f.options,
        agent,
        scope,
      });
      assert.equal(installed.installPath, expected);
      assert.equal(installed.installMethod, "direct_website");
      assert.equal(installed.refreshTargetRecorded, true);
      assert.match(
        await readFile(path.join(expected, "SKILL.md"), "utf8"),
        /name: shiliu-ai-mcp/u,
      );
      const other =
        scope === "user"
          ? path.join(f.home, "projects", "b")
          : path.join(f.cwd, "nested");
      await mkdir(other, { recursive: true });
      assert.equal(
        (
          await refreshShiliuSkill({
            ...f.options,
            cwd: other,
            now: 1000 + SKILL_REFRESH_INTERVAL_MS,
          })
        ).status,
        "checked",
      );
      assert.equal(f.archive.calls(), 2);
      assert.deepEqual(await readdir(other), []);
      const state = JSON.parse(await readFile(stateFile(f.home), "utf8"));
      assert.equal(
        state.scopes[scope === "user" ? `user:${root}` : root].target
          .directTargets[0].installPath,
        expected,
      );
    });
test("explicit directories and custom Claude home survive later environment changes", async (t) => {
  const f = await fixture(t),
    custom = path.join(f.root, "claude-custom");
  const installed = await installShiliuSkill({
    ...f.options,
    agent: "claude-code",
    scope: "user",
    env: { CLAUDE_CONFIG_DIR: custom },
  });
  assert.equal(
    installed.installPath,
    path.join(custom, "skills", "shiliu-ai-mcp"),
  );
  const explicit = await installShiliuSkill({
    ...f.options,
    targetDirectory: path.join(f.cwd, ".client", "skills"),
  });
  assert.equal(
    (await refreshShiliuSkill({ ...f.options, force: true })).status,
    "checked",
  );
  assert.match(
    await readFile(path.join(explicit.installPath, "SKILL.md"), "utf8"),
    /fixture/u,
  );
  assert.equal(
    (
      await refreshShiliuSkill({
        ...f.options,
        cwd: f.root,
        force: true,
        env: { CLAUDE_CONFIG_DIR: path.join(f.root, "elsewhere") },
      })
    ).status,
    "checked",
  );
  await assert.rejects(readdir(path.join(f.root, "elsewhere")), {
    code: "ENOENT",
  });
});
test("no registration including force is normal success without project or home writes", async (t) => {
  const f = await fixture(t);
  for (const force of [false, true]) {
    const result = await printSkillRefresh({ ...f.options, force, json: true });
    assert.equal(result.reason, "target_not_registered");
    assert.equal(result.status, "skipped");
    assert.equal(f.archive.calls(), 0);
    assert.deepEqual(await readdir(f.cwd), []);
    assert.deepEqual(await readdir(f.home), ["projects"]);
  }
});
test("project A registration never authorizes sibling B", async (t) => {
  const f = await fixture(t);
  await installShiliuSkill({ ...f.options, agent: "codex" });
  const b = path.join(f.home, "projects", "b");
  await mkdir(b);
  const state = await readFile(stateFile(f.home), "utf8");
  assert.equal(
    (await refreshShiliuSkill({ ...f.options, cwd: b })).reason,
    "target_not_registered",
  );
  assert.equal(f.archive.calls(), 1);
  assert.deepEqual(await readdir(b), []);
  assert.equal(await readFile(stateFile(f.home), "utf8"), state);
});
test("missing registered target is not recreated even with force", async (t) => {
  const f = await fixture(t);
  const installed = await installShiliuSkill({ ...f.options, agent: "codex" });
  assert.ok(installed.installPath.startsWith(f.root + path.sep));
  await rm(installed.installPath, { recursive: true });
  assert.equal(
    (await refreshShiliuSkill({ ...f.options, force: true })).reason,
    "target_missing",
  );
  assert.equal(f.archive.calls(), 1);
  await assert.rejects(readdir(installed.installPath), { code: "ENOENT" });
});
test("legacy wrong Claude path needs explicit install; shared Codex remains", async (t) => {
  const f = await fixture(t),
    shared = path.join(f.cwd, ".agents", "skills", "shiliu-ai-mcp");
  await skill(shared);
  await saveState(f.home, {
    [f.cwd]: {
      target: {
        root: f.cwd,
        scope: "project",
        agents: ["codex", "claude-code"],
        installPath: shared,
      },
    },
  });
  const migration = await refreshShiliuSkill({ ...f.options, force: true });
  assert.equal(migration.reason, "target_migration_required");
  assert.deepEqual(migration.installCommands, [
    {
      cwd: f.cwd,
      command: [
        "shiliu",
        "skill",
        "install",
        "--agent",
        "claude-code",
        "--scope",
        "project",
        "--json",
      ],
    },
  ]);
  assert.equal(f.archive.calls(), 0);
  await assert.rejects(readdir(path.join(f.cwd, ".claude")), {
    code: "ENOENT",
  });
  await installShiliuSkill({ ...f.options, agent: "claude-code" });
  assert.match(await readFile(path.join(shared, "SKILL.md"), "utf8"), /old/u);
  assert.equal(
    (await refreshShiliuSkill({ ...f.options, force: true })).status,
    "checked",
  );
});
test("legacy valid Codex refresh updates only its existing path", async (t) => {
  const f = await fixture(t),
    p = path.join(f.cwd, ".agents", "skills", "shiliu-ai-mcp");
  await skill(p);
  await saveState(f.home, {
    [f.cwd]: {
      target: {
        root: f.cwd,
        scope: "project",
        agents: ["codex"],
        installPath: p,
      },
    },
  });
  assert.equal((await refreshShiliuSkill(f.options)).status, "checked");
  assert.match(await readFile(path.join(p, "SKILL.md"), "utf8"), /fixture/u);
});

test("refresh records the digest of the newly installed archive", async (t) => {
  const f = await fixture(t);
  const installed = await installShiliuSkill({ ...f.options, agent: "codex" });
  const next = await archiveInstaller(f.root, "updated release");
  assert.notEqual(next.digest, installed.digest);
  assert.equal(
    (
      await refreshShiliuSkill({
        ...f.options,
        force: true,
        directInstall: next.install,
      })
    ).status,
    "checked",
  );
  const state = JSON.parse(await readFile(stateFile(f.home), "utf8"));
  assert.equal(state.scopes[f.cwd].target.directTargets[0].digest, next.digest);
  assert.match(
    await readFile(path.join(installed.installPath, "SKILL.md"), "utf8"),
    /updated release/u,
  );
});
test("orphan scan is bounded by repo root and excludes user and registered paths", async (t) => {
  const f = await fixture(t),
    repo = path.join(f.home, "repo"),
    cwd = path.join(repo, "nested");
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo], { windowsHide: true });
  const orphan = path.join(repo, ".agents", "skills", "shiliu-ai-mcp");
  await skill(orphan);
  await skill(path.join(f.home, ".claude", "skills", "shiliu-ai-mcp"));
  const registered = path.join(repo, ".hermes", "skills", "shiliu-ai-mcp");
  await skill(registered);
  await saveState(f.home, {
    unrelated: {
      target: {
        scope: "project",
        root: path.join(f.root, "elsewhere"),
        installPath: registered,
      },
    },
  });
  const result = await refreshShiliuSkill({ ...f.options, cwd });
  assert.deepEqual(
    result.unmanagedInstallations.map((x) => x.installPath),
    [orphan],
  );
  assert.deepEqual(await readdir(cwd), []);
  assert.equal(f.archive.calls(), 0);
  const outside = path.join(f.home, "outside", "nested");
  await mkdir(outside, { recursive: true });
  await skill(
    path.join(f.home, "outside", ".agents", "skills", "shiliu-ai-mcp"),
  );
  assert.deepEqual(
    (await refreshShiliuSkill({ ...f.options, cwd: outside }))
      .unmanagedInstallations,
    [],
  );
});
test("project under home with user registration has no orphans and no project writes", async (t) => {
  const f = await fixture(t);
  await installShiliuSkill({ ...f.options, agent: "codex", scope: "user" });
  const result = await refreshShiliuSkill({ ...f.options, force: true });
  assert.equal(result.status, "checked");
  assert.deepEqual(result.unmanagedInstallations || [], []);
  assert.deepEqual(await readdir(f.cwd), []);
});
test("cooldown, failure cooldown and force apply only to valid registered targets", async (t) => {
  const f = await fixture(t);
  await installShiliuSkill({ ...f.options, agent: "codex" });
  assert.equal((await refreshShiliuSkill(f.options)).reason, "within_interval");
  assert.equal(
    (
      await refreshShiliuSkill({
        ...f.options,
        force: true,
        now: 2000,
        directInstall: async () => {
          throw new Error("network unavailable");
        },
      })
    ).status,
    "failed",
  );
  assert.equal(
    (await refreshShiliuSkill({ ...f.options, now: 3000 })).reason,
    "within_interval",
  );
  assert.equal(
    (await refreshShiliuSkill({ ...f.options, force: true, now: 3000 })).status,
    "checked",
  );
});
test("symlinked targets refresh physical storage once without breaking aliases", async (t) => {
  const f = await fixture(t),
    shared = path.join(f.cwd, ".agents", "skills", "shiliu-ai-mcp");
  await skill(shared);
  const parent = path.join(f.cwd, ".claude", "skills");
  await mkdir(parent, { recursive: true });
  const alias = path.join(parent, "shiliu-ai-mcp");
  await symlink(
    shared,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await saveState(f.home, {
    [f.cwd]: {
      target: {
        root: f.cwd,
        scope: "project",
        directTargets: [
          {
            agent: "codex",
            installPath: shared,
            targetDirectory: path.dirname(shared),
          },
          { agent: "claude-code", installPath: alias, targetDirectory: parent },
        ],
      },
    },
  });
  assert.equal((await refreshShiliuSkill(f.options)).status, "checked");
  assert.equal(f.archive.calls(), 1);
  assert.match(
    await readFile(path.join(alias, "SKILL.md"), "utf8"),
    /fixture/u,
  );
});
test("concurrent refresh serializes real extraction and state writes", async (t) => {
  const f = await fixture(t);
  await installShiliuSkill({ ...f.options, agent: "codex" });
  const results = await Promise.all(
    [1, 2].map(() =>
      refreshShiliuSkill({
        ...f.options,
        now: 1000 + SKILL_REFRESH_INTERVAL_MS,
      }),
    ),
  );
  assert.equal(results.filter((x) => x.status === "checked").length, 1);
  assert.equal(f.archive.calls(), 2);
});

test("repo rooted at home excludes normal user Skill paths even without registration", async (t) => {
  const f = await fixture(t);
  execFileSync("git", ["init", "--quiet", f.home], { windowsHide: true });
  for (const p of [".agents", ".claude", ".hermes"])
    await skill(path.join(f.home, p, "skills", "shiliu-ai-mcp"));
  assert.deepEqual(
    (await refreshShiliuSkill(f.options)).unmanagedInstallations,
    [],
  );
});
test("real CLI exits 0 for an unregistered project and leaves it untouched", async (t) => {
  const f = await fixture(t);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("bin/shiliu.js"),
      "skill",
      "refresh",
      "--home",
      f.home,
      "--json",
    ],
    { cwd: f.cwd, encoding: "utf8", windowsHide: true, timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, "target_not_registered");
  assert.deepEqual(await readdir(f.cwd), []);
});
