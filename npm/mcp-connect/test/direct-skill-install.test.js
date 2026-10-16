import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { c as createTar, Header } from "tar";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";

import { installSkillArchive } from "../src/direct-skill-install.js";

test("unsafe archive entry rejects normally and releases staging and Skill lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiliu-invalid-archive-"));
  try {
    const header = new Header({
      path: "unsafe-link",
      type: "SymbolicLink",
      linkpath: "outside",
      size: 0,
      mode: 511,
      uid: 0,
      gid: 0,
    });
    header.encode();
    const archive = gzipSync(Buffer.concat([header.block, Buffer.alloc(1024)]));
    const index = Buffer.from(
      JSON.stringify({
        skills: [
          {
            name: "shiliu-ai-mcp",
            type: "archive",
            url: "skill.tar.gz",
            digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
          },
        ],
      }),
    );
    const script = `import{installShiliuSkill}from'./src/skill-refresh.js';import{installSkillArchive}from'./src/direct-skill-install.js';
      try{await installShiliuSkill({home:${JSON.stringify(root)},cwd:${JSON.stringify(root)},targetDirectory:${JSON.stringify(path.join(root, "skills"))},directInstall:o=>installSkillArchive({...o,fetchImpl:async url=>({ok:true,arrayBuffer:async()=>Buffer.from(String(url).endsWith('index.json')?${JSON.stringify(index.toString("base64"))}:${JSON.stringify(archive.toString("base64"))},'base64')})})});}catch(e){console.log('caught unsafe archive');}finally{console.log('finally completed');}`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /caught unsafe archive/u);
    assert.match(child.stdout, /finally completed/u);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(path.join(root, "skills")), []);
    assert.deepEqual(await readdir(path.join(root, ".shiliu-ai")), []);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

function byteResponse(bytes, status = 200) {
  const value = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  };
}

async function fixture(home) {
  const source = path.join(home, "source");
  const archive = path.join(home, "skill.tar.gz");
  await mkdir(path.join(source, "references"), { recursive: true });
  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: shiliu-ai-mcp\ndescription: test\n---\n\n# Skill\n",
  );
  await writeFile(path.join(source, "references", "usage.md"), "usage\n");
  await createTar({ cwd: source, file: archive, gzip: true, portable: true }, [
    "SKILL.md",
    "references/usage.md",
  ]);
  const archiveBytes = await readFile(archive);
  const digest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
  const indexBytes = Buffer.from(
    JSON.stringify({
      skills: [
        {
          name: "shiliu-ai-mcp",
          type: "archive",
          url: "shiliu-ai-mcp.tar.gz",
          digest,
        },
      ],
    }),
  );
  return {
    digest,
    fetchImpl: async (url) =>
      byteResponse(
        String(url).endsWith("index.json") ? indexBytes : archiveBytes,
      ),
  };
}

test("installs the verified website Skill into a client-selected directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-direct-skill-"));
  try {
    const targetDirectory = path.join(home, ".workbuddy", "skills");
    const source = await fixture(home);
    const result = await installSkillArchive({
      targetDirectory,
      sourceBaseUrl: "https://example.test/shiliuAI",
      skillName: "shiliu-ai-mcp",
      fetchImpl: source.fetchImpl,
    });
    assert.equal(
      result.installPath,
      path.join(targetDirectory, "shiliu-ai-mcp"),
    );
    assert.equal(result.digest, source.digest);
    assert.match(
      await readFile(path.join(result.installPath, "SKILL.md"), "utf8"),
      /name: shiliu-ai-mcp/u,
    );
    assert.equal(
      await readFile(
        path.join(result.installPath, "references", "usage.md"),
        "utf8",
      ),
      "usage\n",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects a digest mismatch before creating the Skill directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-direct-digest-"));
  try {
    const source = await fixture(home);
    const fetchImpl = async (url) => {
      if (!String(url).endsWith("index.json")) return source.fetchImpl(url);
      return byteResponse(
        Buffer.from(
          JSON.stringify({
            skills: [
              {
                name: "shiliu-ai-mcp",
                type: "archive",
                url: "shiliu-ai-mcp.tar.gz",
                digest: `sha256:${"0".repeat(64)}`,
              },
            ],
          }),
        ),
      );
    };
    await assert.rejects(
      installSkillArchive({
        targetDirectory: path.join(home, "skills"),
        sourceBaseUrl: "https://example.test/shiliuAI",
        skillName: "shiliu-ai-mcp",
        fetchImpl,
      }),
      /摘要不匹配/u,
    );
    await assert.rejects(
      readFile(path.join(home, "skills", "shiliu-ai-mcp", "SKILL.md")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("does not overwrite an unrelated existing directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shiliu-direct-existing-"));
  try {
    const targetDirectory = path.join(home, "skills");
    const installPath = path.join(targetDirectory, "shiliu-ai-mcp");
    await mkdir(installPath, { recursive: true });
    await writeFile(path.join(installPath, "keep.txt"), "keep\n");
    const source = await fixture(home);
    await assert.rejects(
      installSkillArchive({
        targetDirectory,
        sourceBaseUrl: "https://example.test/shiliuAI",
        skillName: "shiliu-ai-mcp",
        fetchImpl: source.fetchImpl,
      }),
      /拒绝覆盖/u,
    );
    assert.equal(
      await readFile(path.join(installPath, "keep.txt"), "utf8"),
      "keep\n",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
