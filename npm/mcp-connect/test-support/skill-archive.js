import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { c as createTar } from "tar";
import { installSkillArchive } from "../src/direct-skill-install.js";

export async function archiveInstaller(root, content = "fixture") {
  const source = path.join(root, "archive-source");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "SKILL.md"),
    `---\nname: shiliu-ai-mcp\ndescription: fixture\n---\n${content}\n`,
  );
  const archive = path.join(root, "fixture.tar.gz");
  await createTar({ cwd: source, file: archive, gzip: true, portable: true }, [
    "SKILL.md",
  ]);
  const bytes = await readFile(archive);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  let calls = 0;
  const install = async (options) => {
    calls += 1;
    return installSkillArchive({
      ...options,
      fetchImpl: async (url) => {
        const data = String(url).endsWith("index.json")
          ? Buffer.from(
              JSON.stringify({
                skills: [
                  {
                    name: "shiliu-ai-mcp",
                    type: "archive",
                    url: "fixture.tar.gz",
                    digest,
                  },
                ],
              }),
            )
          : bytes;
        return new Response(data, { status: 200 });
      },
    });
  };
  return { install, calls: () => calls, digest };
}
