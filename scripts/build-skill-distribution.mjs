import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
export const skillName = "shiliu-ai-mcp";
export const skillSourceDirectory = path.join(
  repositoryRoot,
  "skills",
  skillName,
);
export const archiveFileName = `${skillName}.tar.gz`;
export const discoverySchema =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".txt",
  ".yaml",
  ".yml",
]);

function normalizedFileBytes(relativePath, bytes) {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) {
    return bytes;
  }
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

async function walkFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Skill distribution does not allow symlinks: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function collectSkillFiles() {
  const files = await walkFiles(skillSourceDirectory);
  if (!files.includes("SKILL.md")) {
    throw new Error("Skill distribution must contain SKILL.md at its root.");
  }
  return Promise.all(
    files.map(async (relativePath) => ({
      relativePath,
      bytes: normalizedFileBytes(
        relativePath,
        await readFile(
          path.join(skillSourceDirectory, ...relativePath.split("/")),
        ),
      ),
    })),
  );
}

function parseSkillDescription(skillMarkdown) {
  const match = skillMarkdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    throw new Error("SKILL.md is missing YAML frontmatter.");
  }
  const descriptionLine = match[1]
    .split("\n")
    .find((line) => line.startsWith("description:"));
  if (!descriptionLine) {
    throw new Error("SKILL.md frontmatter is missing description.");
  }
  const rawValue = descriptionLine.slice("description:".length).trim();
  if (rawValue.startsWith('"')) {
    return JSON.parse(rawValue);
  }
  return rawValue.replace(/^['"]|['"]$/g, "");
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`Tar header field is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeTarText(header, offset, length, encoded);
}

function createTarHeader(relativePath, size) {
  const name = relativePath.replaceAll("\\", "/");
  if (Buffer.byteLength(name, "utf8") > 100) {
    throw new Error(`Skill path is too long for the archive: ${name}`);
  }

  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createTarArchive(files) {
  const chunks = [];
  for (const file of files) {
    chunks.push(createTarHeader(file.relativePath, file.bytes.length));
    chunks.push(file.bytes);
    const padding = (512 - (file.bytes.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function assertSafeOutputDirectory(outputDirectory) {
  const resolved = path.resolve(outputDirectory);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new Error(
      "Refusing to use a filesystem root as the output directory.",
    );
  }
  return resolved;
}

export async function buildSkillDistribution(outputDirectory) {
  const output = assertSafeOutputDirectory(outputDirectory);
  const files = await collectSkillFiles();
  const skillMarkdown = files
    .find((file) => file.relativePath === "SKILL.md")
    .bytes.toString("utf8");
  const description = parseSkillDescription(skillMarkdown);
  const skillOutputDirectory = path.join(output, skillName);
  const archivePath = path.join(output, archiveFileName);
  const indexPath = path.join(output, "index.json");

  await mkdir(output, { recursive: true });
  await rm(skillOutputDirectory, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await rm(indexPath, { force: true });
  await mkdir(skillOutputDirectory, { recursive: true });

  for (const file of files) {
    const target = path.join(
      skillOutputDirectory,
      ...file.relativePath.split("/"),
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }

  const tarBytes = createTarArchive(files);
  const archiveBytes = gzipSync(tarBytes, { level: 9, mtime: 0 });
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  await writeFile(archivePath, archiveBytes);

  const index = {
    $schema: discoverySchema,
    skills: [
      {
        name: skillName,
        type: "archive",
        description,
        url: archiveFileName,
        digest: `sha256:${digest}`,
      },
    ],
  };
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  return {
    output,
    files: files.map((file) => file.relativePath),
    archivePath,
    indexPath,
    digest: index.skills[0].digest,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error(
      "Usage: node scripts/build-skill-distribution.mjs <output-directory>",
    );
  }
  const result = await buildSkillDistribution(outputDirectory);
  console.log(
    `Built ${result.files.length} Skill files at ${result.output} (${result.digest}).`,
  );
}
