import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import { checkPublicDistribution } from "./check-public-distribution.mjs";

const distributionRoot = path.resolve(process.argv[2] || ".tmp/public-site");

function contentType(filePath) {
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".tar.gz")) return "application/gzip";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (filePath.endsWith(".yaml")) return "application/yaml; charset=utf-8";
  return "application/octet-stream";
}

function isInsideRoot(candidate) {
  const relative = path.relative(distributionRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const relativePath = decodeURIComponent(requestUrl.pathname).replace(
      /^\/+/,
      "",
    );
    const filePath = path.resolve(distributionRoot, ...relativePath.split("/"));
    if (!relativePath || !isInsideRoot(filePath)) {
      response.writeHead(404).end();
      return;
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-length": fileStat.size,
      "content-type": contentType(filePath),
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  const sourceUrl = `http://127.0.0.1:${address.port}`;
  const command =
    process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx";
  const argumentsList =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          "npx",
          "-y",
          "skills",
          "add",
          sourceUrl,
          "--list",
          "-a",
          "codex",
        ]
      : ["-y", "skills", "add", sourceUrl, "--list", "-a", "codex"];
  const child = spawn(command, argumentsList, {
    cwd: distributionRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0 || !output.includes("shiliu-ai-mcp")) {
    throw new Error(
      `skills CLI could not discover the generated archive (exit ${exitCode}).\n${output}`,
    );
  }
  console.log(
    "skills CLI discovered shiliu-ai-mcp from the generated v0.2 archive.",
  );
  await checkPublicDistribution({ publicBaseUrl: sourceUrl, checkNpm: false });
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
