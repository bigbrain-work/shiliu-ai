import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { compressSkillArchive } from "./build-skill-distribution.mjs";
import { verifyPublicSkillArchive } from "./public-skill-integrity.mjs";

const contents = Buffer.from("canonical tar contents\n".repeat(100));
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const index = archive => ({
  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  skills: [{ name: "shiliu-ai-mcp", type: "archive", description: "Skill", url: "shiliu-ai-mcp.tar.gz", digest: digest(archive) }],
});
const encode = value => Buffer.from(JSON.stringify(value));
const expectedArchive = compressSkillArchive(contents);
function verify(archive, metadata = index(archive)) {
  return verifyPublicSkillArchive({
    publicIndex: encode(metadata), publicArchive: archive,
    expectedIndex: encode(index(expectedArchive)), expectedArchive,
  });
}

test("new archives have a platform-independent header and round-trip", () => {
  assert.equal(expectedArchive[9], 255);
  assert.equal(expectedArchive.readUInt32LE(4), 0);
  assert.deepEqual(gunzipSync(expectedArchive), contents);
  assert.deepEqual(compressSkillArchive(contents), expectedArchive);
});

for (const osByte of [3, 10, 255]) {
  test(`accept legacy gzip OS byte ${osByte} with valid digest and same content`, () => {
    const archive = gzipSync(contents, { level: 9 });
    archive[9] = osByte;
    assert.equal(verify(archive), digest(archive));
  });
}

test("accept different compression while preserving integrity checks", () => {
  const archive = gzipSync(contents, { level: 1 });
  assert.notDeepEqual(archive, expectedArchive);
  assert.equal(verify(archive), digest(archive));
});

test("reject mismatched or missing published digest", () => {
  const metadata = index(expectedArchive);
  metadata.skills[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => verify(expectedArchive, metadata), /digest does not match/);
  delete metadata.skills[0].digest;
  assert.throws(() => verify(expectedArchive, metadata), /invalid archive digest/);
});

test("reject changed contents even with a valid published digest", () => {
  assert.throws(() => verify(gzipSync(Buffer.from("changed"))), /contents differ/);
});

for (const key of ["url", "description", "name", "type"]) {
  test(`reject changed discovery ${key}`, () => {
    const metadata = index(expectedArchive);
    metadata.skills[0][key] = "changed";
    assert.throws(() => verify(expectedArchive, metadata), /metadata differs/);
  });
}

test("reject unexpected entries or schema changes", () => {
  const metadata = index(expectedArchive);
  metadata.skills.push({ ...metadata.skills[0] });
  assert.throws(() => verify(expectedArchive, metadata), /metadata differs/);
  metadata.skills.pop();
  metadata.$schema = "changed";
  assert.throws(() => verify(expectedArchive, metadata), /metadata differs/);
});

test("reject invalid gzip even when its digest matches", () => {
  assert.throws(() => verify(Buffer.from("not gzip")));
});
