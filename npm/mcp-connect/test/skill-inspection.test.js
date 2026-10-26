import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectShiliuSkill, formatSkillCommand } from "../src/skill-inspection.js";
import { installShiliuSkill, refreshShiliuSkill } from "../src/skill-refresh.js";
import { archiveInstaller } from "../test-support/skill-archive.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-skill-inspection-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home"), cwd = path.join(home, "project");
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", cwd], { windowsHide: true });
  return { root, home, cwd, env: {}, stateFile: path.join(home, ".shiliu-ai", "skill-refresh.json") };
}
async function skill(installPath) {
  await mkdir(installPath, { recursive: true });
  await writeFile(path.join(installPath, "SKILL.md"), "---\nname: shiliu-ai-mcp\n---\nOld installation\n");
}
async function state(f, scopes) {
  await mkdir(path.dirname(f.stateFile), { recursive: true });
  await writeFile(f.stateFile, JSON.stringify({ version: 1, scopes }));
}

test("inspection finds old user and project copies with exact explicit commands and no registration writes", async t => {
  const f = await fixture(t);
  const user = path.join(f.home, ".agents", "skills", "shiliu-ai-mcp");
  const project = path.join(f.cwd, ".hermes", "skills", "shiliu-ai-mcp");
  await skill(user); await skill(project);
  await skill(path.join(f.home, ".hermes", "skills", "shiliu-ai-mcp"));
  await skill(path.join(f.home, "sibling", ".agents", "skills", "shiliu-ai-mcp"));
  const report = await inspectShiliuSkill(f);
  assert.equal(report.status, "registration_required");
  assert.equal(report.installations.length, 3);
  for (const item of report.installations) {
    assert.equal(item.registered, false);
    assert.equal(item.exists, true);
    assert.deepEqual(item.registration.command, ["shiliu", "skill", "install", "--target-dir", path.dirname(item.installPath), "--scope", item.scope, "--home", f.home, "--json"]);
    assert.equal(item.registration.cwd, item.scope === "user" ? f.home : f.cwd);
  }
  await assert.rejects(readFile(f.stateFile), { code: "ENOENT" });
  assert.equal(await readFile(path.join(user, "SKILL.md"), "utf8"), "---\nname: shiliu-ai-mcp\n---\nOld installation\n");
  const refresh = await refreshShiliuSkill({ ...f, force: true, directInstall: () => assert.fail("Inspection must not authorize refresh") });
  assert.equal(refresh.reason, "target_not_registered");
  await assert.rejects(readFile(f.stateFile), { code: "ENOENT" });
});

test("explicit install preview and registration affect only the selected old copy", async t => {
  const f = await fixture(t), archive = await archiveInstaller(f.root);
  const selected = path.join(f.home, ".agents", "skills", "shiliu-ai-mcp");
  const other = path.join(f.home, ".claude", "skills", "shiliu-ai-mcp");
  await skill(selected); await skill(other);
  const options = { ...f, agent: "codex", scope: "user", directInstall: archive.install };
  const preview = await installShiliuSkill({ ...options, dryRun: true });
  assert.equal(preview.existingInstallation, true);
  assert.equal(preview.refreshTargetRecorded, false);
  assert.equal(archive.calls(), 0);
  await assert.rejects(readFile(f.stateFile), { code: "ENOENT" });
  const installed = await installShiliuSkill(options);
  assert.equal(installed.refreshTargetRecorded, true);
  assert.equal(archive.calls(), 1);
  const report = await inspectShiliuSkill(f);
  assert.equal(report.installations.find(item => item.installPath === selected).registered, true);
  assert.equal(report.installations.find(item => item.installPath === other).registered, false);
  assert.match(await readFile(path.join(other, "SKILL.md"), "utf8"), /Old installation/u);
});

test("inspection recognizes custom registered user storage and missing targets without recreating them", async t => {
  const f = await fixture(t), installPath = path.join(f.root, "custom", "shiliu-ai-mcp");
  await skill(installPath);
  await state(f, { [`user:${f.home}`]: { target: { scope: "user", root: f.home, directTargets: [{ installPath, targetDirectory: path.dirname(installPath) }] } } });
  const original = await readFile(f.stateFile, "utf8");
  assert.equal((await inspectShiliuSkill(f)).status, "registered");
  await rm(path.join(installPath, "SKILL.md"));
  const report = await inspectShiliuSkill(f);
  assert.equal(report.status, "registration_required");
  assert.equal(report.installations[0].exists, false);
  assert.equal(await readFile(f.stateFile, "utf8"), original);
  assert.deepEqual(await readdir(installPath), []);
});

test("custom Claude home and legacy wrong-path records produce guidance without migrating or changing records", async t => {
  const f = await fixture(t), custom = path.join(f.root, "custom-claude");
  f.env = { CLAUDE_CONFIG_DIR: custom };
  const correct = path.join(custom, "skills", "shiliu-ai-mcp");
  await skill(correct);
  await state(f, { [`user:${f.home}`]: { target: { scope: "user", root: f.home, agents: ["claude-code"], installPath: path.join(f.home, ".agents", "skills", "shiliu-ai-mcp") } } });
  const original = await readFile(f.stateFile, "utf8");
  const report = await inspectShiliuSkill(f);
  assert.ok(report.installations.some(item => item.installPath === correct && !item.registered));
  assert.deepEqual(report.issues[0].registration.command, ["shiliu", "skill", "install", "--agent", "claude-code", "--scope", "user", "--home", f.home, "--json"]);
  assert.equal(await readFile(f.stateFile, "utf8"), original);
});

test("invalid state is reported safely and never overwritten by diagnosis", async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.stateFile), { recursive: true });
  const invalid = "invalid secret-fixture";
  await writeFile(f.stateFile, invalid);
  const report = await inspectShiliuSkill(f);
  assert.equal(report.status, "state_unreadable");
  assert.doesNotMatch(JSON.stringify(report), /secret-fixture/u);
  assert.equal(await readFile(f.stateFile, "utf8"), invalid);
});

test("timestamp-only legacy records identify their exact ancestor copy without scanning siblings or registering it", async t => {
  const f = await fixture(t);
  const legacyRoot = f.cwd, nested = path.join(f.cwd, "nested-repo");
  await mkdir(nested);
  execFileSync("git", ["init", "--quiet", nested], { windowsHide: true });
  const oldPath = path.join(legacyRoot, ".hermes", "skills", "shiliu-ai-mcp");
  await skill(oldPath);
  await skill(path.join(f.root, "sibling", ".agents", "skills", "shiliu-ai-mcp"));
  await state(f, { [legacyRoot]: { lastAttemptAt: "2026-09-01T00:00:00Z" }, [path.join(f.root, "sibling")]: { lastAttemptAt: "2026-09-01T00:00:00Z" } });
  const original = await readFile(f.stateFile, "utf8");
  const report = await inspectShiliuSkill({ ...f, cwd: nested });
  const legacy = report.installations.find(item => item.installPath === oldPath && item.scope === "project");
  assert.equal(legacy.registered, false);
  assert.equal(legacy.registration.cwd, legacyRoot);
  assert.ok(report.installations.every(item => !item.installPath.includes(`${path.sep}sibling${path.sep}`)));
  assert.equal(await readFile(f.stateFile, "utf8"), original);
});

test("printed explicit commands quote spaces, apostrophes and shell substitutions literally", () => {
  assert.equal(formatSkillCommand(["shiliu", "--target-dir", "C:\\a b\\$x'skills"], "win32"), "shiliu --target-dir 'C:\\a b\\$x''skills'");
  assert.equal(formatSkillCommand(["shiliu", "--target-dir", "/a b/$x'skills"], "linux"), "shiliu --target-dir '/a b/$x'\"'\"'skills'");
});
