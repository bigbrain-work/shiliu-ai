import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  archiveFileName,
  collectSkillFiles,
  discoverySchema,
  skillName,
} from "./build-skill-distribution.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function tarText(block, offset, length) {
  const end = block.indexOf(0, offset);
  return block
    .subarray(
      offset,
      end >= offset && end < offset + length ? end : offset + length,
    )
    .toString("utf8")
    .trim();
}

function readTarFiles(archiveBytes) {
  const tar = gunzipSync(archiveBytes);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = tarText(header, 0, 100);
    const sizeText = tarText(header, 124, 12);
    const size = Number.parseInt(sizeText || "0", 8);
    if (!name || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Invalid tar entry in Skill archive.");
    }
    if (
      name.startsWith("/") ||
      /^[A-Za-z]:/.test(name) ||
      name.split("/").includes("..")
    ) {
      throw new Error(`Unsafe archive path: ${name}`);
    }
    const type = String.fromCharCode(header[156] || 48);
    if (type !== "0") {
      throw new Error(`Unexpected non-file archive entry: ${name}`);
    }
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    files.set(name, tar.subarray(bodyStart, bodyEnd));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function assertEqualBytes(actual, expected, label) {
  if (!actual.equals(expected)) {
    throw new Error(`${label} does not match the canonical Skill source.`);
  }
}

export async function verifySkillDistribution(distributionDirectory) {
  const root = path.resolve(distributionDirectory);
  const index = JSON.parse(
    await readFile(path.join(root, "index.json"), "utf8"),
  );
  if (index.$schema !== discoverySchema || index.skills?.length !== 1) {
    throw new Error(
      "Skill discovery index does not use the expected v0.2 schema.",
    );
  }
  const entry = index.skills[0];
  if (
    entry.name !== skillName ||
    entry.type !== "archive" ||
    entry.url !== archiveFileName ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.digest)
  ) {
    throw new Error("Skill discovery entry is incomplete or invalid.");
  }

  const archiveBytes = await readFile(path.join(root, archiveFileName));
  const actualDigest = `sha256:${createHash("sha256")
    .update(archiveBytes)
    .digest("hex")}`;
  if (entry.digest !== actualDigest) {
    throw new Error("Skill archive digest does not match index.json.");
  }

  const sourceFiles = await collectSkillFiles();
  const archiveFiles = readTarFiles(archiveBytes);
  const expectedNames = sourceFiles.map((file) => file.relativePath).sort();
  const actualNames = [...archiveFiles.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Skill archive file list mismatch. Expected ${expectedNames.join(", ")}; received ${actualNames.join(", ")}.`,
    );
  }

  for (const file of sourceFiles) {
    assertEqualBytes(
      archiveFiles.get(file.relativePath),
      file.bytes,
      `Archive file ${file.relativePath}`,
    );
    const publishedCopy = await readFile(
      path.join(root, skillName, ...file.relativePath.split("/")),
    );
    assertEqualBytes(
      publishedCopy,
      file.bytes,
      `Published file ${file.relativePath}`,
    );
  }

  return {
    files: expectedNames,
    digest: actualDigest,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const distributionDirectory = process.argv[2];
  if (!distributionDirectory) {
    throw new Error(
      "Usage: node scripts/verify-skill-distribution.mjs <distribution-directory>",
    );
  }
  const result = await verifySkillDistribution(distributionDirectory);
  console.log(
    `Verified ${result.files.length} Skill files and ${result.digest}.`,
  );
}
