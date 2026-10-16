import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { x as extractTar } from "tar";

const MAX_SKILL_ARCHIVE_BYTES = 5 * 1024 * 1024;

function hasExpectedSkillName(content, skillName) {
  const frontmatter = String(content).match(
    /^---\s*\r?\n([\s\S]*?)\r?\n---/u,
  )?.[1];
  if (!frontmatter) return false;
  const name = frontmatter.match(/^name:\s*["']?([^"'\s]+)["']?\s*$/imu)?.[1];
  return name === skillName;
}

async function verifySkillDirectory(installPath, skillName) {
  const metadata = await stat(installPath);
  if (!metadata.isDirectory()) {
    throw new Error(`Skill 目标不是目录：${installPath}`);
  }
  const skillFile = path.join(installPath, "SKILL.md");
  const content = await readFile(skillFile, "utf8");
  if (!hasExpectedSkillName(content, skillName)) {
    throw new Error(`目标目录中的 SKILL.md 不是 ${skillName}`);
  }
}

function validateArchiveEntry(entryPath, entry) {
  const normalized = String(entryPath).replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    segments.includes("..") ||
    ["SymbolicLink", "Link"].includes(entry.type)
  ) {
    throw new Error(`Skill 安装包包含不安全路径：${entryPath}`);
  }
  return true;
}

async function fetchBytes(url, { fetchImpl, label }) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${label}下载失败：HTTP ${response.status}`);
  }
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== "https:" || finalUrl.origin !== new URL(url).origin) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`${label}重定向到不可信来源`);
  }
  const declaredSize = Number(response.headers?.get?.("content-length"));
  if (declaredSize > MAX_SKILL_ARCHIVE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`${label}大小超过 5 MiB`);
  }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_SKILL_ARCHIVE_BYTES) { await reader.cancel(); throw new Error(`${label}大小超过 5 MiB`); }
        chunks.push(Buffer.from(value));
      }
      bytes = Buffer.concat(chunks, length);
    } finally { reader.releaseLock(); }
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length === 0 || bytes.length > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error(`${label}大小异常：${bytes.length} bytes`);
  }
  return bytes;
}

export async function installSkillArchive({
  targetDirectory,
  sourceBaseUrl,
  skillName,
  fetchImpl = fetch,
  extractImpl = extractTar,
  requireExisting = false,
  removeBackup = rm,
} = {}) {
  if (!targetDirectory) throw new Error("缺少 Skill 目标父目录");
  if (!sourceBaseUrl) throw new Error("缺少 Skill 官网来源");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(skillName || ""))
    throw new Error("Skill 名称无效");

  const targetRoot = path.resolve(targetDirectory);
  if (targetRoot === path.parse(targetRoot).root) {
    throw new Error("拒绝把文件系统根目录用作 Skill 目标目录");
  }
  const installPath = path.join(targetRoot, skillName);
  if (requireExisting) await verifySkillDirectory(installPath, skillName);
  else await mkdir(targetRoot, { recursive: true });

  const indexUrl = new URL(
    ".well-known/agent-skills/index.json",
    `${sourceBaseUrl.replace(/\/$/u, "")}/`,
  );
  if (indexUrl.protocol !== "https:") {
    throw new Error("Skill 官网索引必须使用 HTTPS");
  }
  const indexBytes = await fetchBytes(indexUrl, {
    fetchImpl,
    label: "Skill 索引",
  });
  let index;
  try {
    index = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    throw new Error("Skill 索引不是有效 JSON");
  }
  const entry = index?.skills?.find(
    (candidate) => candidate?.name === skillName,
  );
  if (
    entry?.type !== "archive" ||
    typeof entry.url !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(entry.digest || "")
  ) {
    throw new Error(`Skill 索引缺少 ${skillName} 的 archive 或 SHA-256 摘要`);
  }
  const archiveUrl = new URL(entry.url, indexUrl);
  if (
    archiveUrl.protocol !== "https:" ||
    archiveUrl.origin !== indexUrl.origin
  ) {
    throw new Error("Skill 安装包必须与官网索引使用同一 HTTPS 来源");
  }
  const archiveBytes = await fetchBytes(archiveUrl, {
    fetchImpl,
    label: "Skill 安装包",
  });
  const actualDigest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
  if (actualDigest !== entry.digest) {
    throw new Error(
      `Skill 安装包摘要不匹配：expected ${entry.digest}, received ${actualDigest}`,
    );
  }

  let existingMetadata = null;
  try {
    existingMetadata = await stat(installPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existingMetadata) {
    if (!existingMetadata.isDirectory()) {
      throw new Error(`Skill 安装目标已存在且不是目录：${installPath}`);
    }
    try {
      await verifySkillDirectory(installPath, skillName);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(`拒绝覆盖无法验证的现有 Skill 目录：${installPath}`);
    }
  }
  const existing = Boolean(existingMetadata);
  if (requireExisting && !existing)
    throw new Error("刷新目标已不存在，请显式安装；未创建目标目录");

  const stagingRoot = await mkdtemp(
    path.join(targetRoot, `.${skillName}-install-`),
  );
  const extractedPath = path.join(stagingRoot, "content");
  const archivePath = path.join(stagingRoot, "skill.tar.gz");
  const backupPath = path.join(
    targetRoot,
    `.${skillName}-backup-${randomUUID()}`,
  );
  let backupCreated = false;
  try {
    await mkdir(extractedPath);
    await writeFile(archivePath, archiveBytes, { mode: 0o600 });
    let archiveError;
    let extractedBytes = 0;
    let entries = 0;
    await extractImpl({
      cwd: extractedPath,
      file: archivePath,
      filter(entryPath, entry) {
        try {
          validateArchiveEntry(entryPath, entry);
          extractedBytes += entry.size || 0;
          entries += 1;
          if (
            !["File", "Directory"].includes(entry.type) ||
            extractedBytes > 20 * 1024 * 1024 ||
            entries > 1024
          ) {
            throw new Error("Skill 安装包条目类型或解压大小异常");
          }
          return !archiveError;
        } catch (error) {
          archiveError ||= error;
          return false;
        }
      },
      noChmod: true,
      preservePaths: false,
      strict: true,
    });
    if (archiveError) throw archiveError;
    await verifySkillDirectory(extractedPath, skillName);

    if (existing) {
      await rename(installPath, backupPath);
      backupCreated = true;
    }
    try {
      await rename(extractedPath, installPath);
    } catch (error) {
      if (backupCreated) {
        await rename(backupPath, installPath).catch(() => {});
        backupCreated = false;
      }
      throw error;
    }
    if (backupCreated) {
      backupCreated = false;
      try { await removeBackup(backupPath, { recursive: true, force: true }); }
      catch (error) { throw new Error(`Skill 已安装，但备份目录清理失败，请手动检查 ${backupPath}：${error.code || "unknown"}`); }
    }
    return {
      installPath,
      targetDirectory: targetRoot,
      source: archiveUrl.href,
      digest: actualDigest,
    };
  } finally {
    if (backupCreated) {
      await rename(backupPath, installPath).catch(() => {});
    }
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
