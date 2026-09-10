import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSkillDistribution } from "./build-skill-distribution.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const installFiles = ["install.txt", "install.sh", "install.ps1"];

function assertSafeOutputDirectory(outputDirectory) {
  const resolved = path.resolve(outputDirectory);
  if (resolved === path.parse(resolved).root) {
    throw new Error(
      "Refusing to use a filesystem root as the output directory.",
    );
  }
  return resolved;
}

export async function buildPublicSiteAssets(outputDirectory) {
  const output = assertSafeOutputDirectory(outputDirectory);
  await mkdir(output, { recursive: true });
  for (const fileName of installFiles) {
    await copyFile(
      path.join(repositoryRoot, fileName),
      path.join(output, fileName),
    );
  }
  const skillDistribution = await buildSkillDistribution(
    path.join(output, ".well-known", "agent-skills"),
  );
  return { output, installFiles, skillDistribution };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error(
      "Usage: node scripts/build-public-site-assets.mjs <website-public-directory>",
    );
  }
  const result = await buildPublicSiteAssets(outputDirectory);
  console.log(
    `Built Shiliu website assets at ${result.output}: ${result.installFiles.join(", ")} and ${result.skillDistribution.digest}.`,
  );
}
