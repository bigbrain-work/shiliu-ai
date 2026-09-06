import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_NAME, SERVER_NAME } from "./constants.js";

export function stdioServerDefinition(platform = process.platform) {
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/d", "/s", "/c", "npx", "-y", PACKAGE_NAME, "mcp"],
    };
  }
  return {
    command: "npx",
    args: ["-y", PACKAGE_NAME, "mcp"],
  };
}

export function codexArguments(platform = process.platform) {
  const proxy = stdioServerDefinition(platform);
  return ["mcp", "add", SERVER_NAME, "--", proxy.command, ...proxy.args];
}

export function claudeServerDefinition(platform = process.platform) {
  return {
    type: "stdio",
    ...stdioServerDefinition(platform),
  };
}

export const cursorServerDefinition = stdioServerDefinition;

function commandText(command, args) {
  return [command, ...args]
    .map((value) => (/\s|"/u.test(value) ? JSON.stringify(value) : value))
    .join(" ");
}

export function commandInvocation(
  command,
  args,
  {
    platform = process.platform,
    env = process.env,
    fileExists = existsSync,
    nodeExecutable = process.execPath,
  } = {},
) {
  if (platform !== "win32") return { command, args };

  const searchPath = env.PATH || env.Path || "";
  const npmDirectory = searchPath
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .find((entry) => fileExists(path.join(entry, `${command}.cmd`)));

  if (!npmDirectory) return { command, args };
  if (command === "claude") {
    const executable = path.join(
      npmDirectory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    if (fileExists(executable)) return { command: executable, args };
  }
  if (command === "codex") {
    const script = path.join(
      npmDirectory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (fileExists(script))
      return { command: nodeExecutable, args: [script, ...args] };
  }
  return { command, args };
}

function execute(command, args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`[dry-run] ${commandText(command, args)}`);
    return;
  }

  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    if (result.error.code === "ENOENT")
      throw new Error(`未找到 ${command}，请先安装对应客户端`);
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    const error = new Error(detail || `${command} 返回退出码 ${result.status}`);
    error.commandOutput = detail;
    throw error;
  }
}

function isDuplicateError(error) {
  return /already|exist|duplicate|已存在/iu.test(
    error.commandOutput || error.message,
  );
}

export function configureCodex(options = {}) {
  try {
    execute("codex", codexArguments(), options);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    execute("codex", ["mcp", "remove", SERVER_NAME], options);
    execute("codex", codexArguments(), options);
  }
}

export function configureClaude(options = {}) {
  const addArgs = [
    "mcp",
    "add-json",
    "--scope",
    "user",
    SERVER_NAME,
    JSON.stringify(claudeServerDefinition()),
  ];
  try {
    execute("claude", addArgs, options);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    execute(
      "claude",
      ["mcp", "remove", "--scope", "user", SERVER_NAME],
      options,
    );
    execute("claude", addArgs, options);
  }
}

export async function configureCursor({ home, dryRun = false } = {}) {
  const configPath = path.join(home, ".cursor", "mcp.json");
  if (dryRun) {
    console.log(
      `[dry-run] 更新 ${configPath} 中的 ${SERVER_NAME}，使用本地 stdio 桥接`,
    );
    return configPath;
  }

  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof SyntaxError)
        throw new Error(`${configPath} 不是有效 JSON，未做任何修改`);
      throw error;
    }
  }

  config.mcpServers = {
    ...(config.mcpServers || {}),
    [SERVER_NAME]: cursorServerDefinition(),
  };
  await mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
  return configPath;
}

export async function configureAgent(agent, options) {
  if (agent === "codex") return configureCodex(options);
  if (agent === "claude") return configureClaude(options);
  if (agent === "cursor") return configureCursor(options);
  throw new Error(`不支持的客户端：${agent}`);
}
