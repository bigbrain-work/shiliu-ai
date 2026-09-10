import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { archiveFileName, skillName } from "./build-skill-distribution.mjs";
import { buildPublicSiteAssets } from "./build-public-site-assets.mjs";
import { verifySkillDistribution } from "./verify-skill-distribution.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultPublicBaseUrl = (
  process.env.SHILIU_PUBLIC_BASE_URL || "https://bigbrain.work/shiliuAI"
).replace(/\/$/, "");

async function fetchBytes(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function assertBytesEqual(actual, expected, label) {
  if (!actual.equals(expected)) {
    throw new Error(`${label} differs from the canonical repository source.`);
  }
}

async function verifyPublicFile(
  publicBaseUrl,
  relativeUrl,
  expectedPath,
  label,
) {
  const [actual, expected] = await Promise.all([
    fetchBytes(`${publicBaseUrl}/${relativeUrl}`),
    readFile(expectedPath),
  ]);
  assertBytesEqual(actual, expected, label);
}

export async function checkPublicDistribution({
  publicBaseUrl = defaultPublicBaseUrl,
  checkNpm = true,
} = {}) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "shiliu-public-check-"),
  );
  try {
    const publicDirectory = path.join(temporaryDirectory, "public");
    const distributionDirectory = path.join(
      publicDirectory,
      ".well-known",
      "agent-skills",
    );
    const publicAssets = await buildPublicSiteAssets(publicDirectory);
    const built = publicAssets.skillDistribution;
    const verified = await verifySkillDistribution(distributionDirectory);

    for (const fileName of ["install.txt", "install.sh", "install.ps1"]) {
      await verifyPublicFile(
        publicBaseUrl,
        fileName,
        path.join(publicDirectory, fileName),
        `Public ${fileName}`,
      );
    }

    const discoveryBase = ".well-known/agent-skills";
    await verifyPublicFile(
      publicBaseUrl,
      `${discoveryBase}/index.json`,
      built.indexPath,
      "Public Skill discovery index",
    );
    await verifyPublicFile(
      publicBaseUrl,
      `${discoveryBase}/${archiveFileName}`,
      built.archivePath,
      "Public Skill archive",
    );
    for (const relativePath of verified.files) {
      await verifyPublicFile(
        publicBaseUrl,
        `${discoveryBase}/${skillName}/${relativePath}`,
        path.join(distributionDirectory, skillName, ...relativePath.split("/")),
        `Public Skill file ${relativePath}`,
      );
    }

    const packageMetadata = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "npm", "mcp-connect", "package.json"),
        "utf8",
      ),
    );
    if (checkNpm) {
      const registryMetadata = JSON.parse(
        (
          await fetchBytes(
            "https://registry.npmjs.org/@bigbrain-work%2Fmcp-connect/latest",
          )
        ).toString("utf8"),
      );
      if (registryMetadata.version !== packageMetadata.version) {
        throw new Error(
          `npm latest is ${registryMetadata.version}, but the repository declares ${packageMetadata.version}.`,
        );
      }
    }

    console.log(
      `Public Shiliu distribution is consistent: CLI ${packageMetadata.version}, ${verified.files.length} Skill files, ${verified.digest}.`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await checkPublicDistribution();
}
