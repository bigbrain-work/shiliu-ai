import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_NAME, SERVER_NAME } from "./constants.js";
import { collectRuntimeDiagnostics } from "./runtime-diagnostics.js";

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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function stdioConfigurationCandidates({
  platform = process.platform,
  env = process.env,
  diagnostics,
} = {}) {
  const runtime =
    diagnostics || collectRuntimeDiagnostics({ platform, env });
  const currentNpxReady = Boolean(runtime.current.npx.available);
  const persistentNpx = runtime.persistent_path_baseline.npx;
  const persistentNpxReady =
    Boolean(persistentNpx.available) &&
    (persistentNpx.path_risks || []).length === 0;
  const warnings = [];
  if (!currentNpxReady) {
    warnings.push("当前 CLI 环境无法执行 npx；目标客户端仍需单独验证。");
  }
  if (!persistentNpxReady) {
    warnings.push(
      platform === "win32"
        ? "Windows 持久 PATH 基线中的 npx 不可用或路径不稳定；这不等于目标客户端一定无法启动。"
        : "当前 PATH 基线中的 npx 不可用或路径不稳定；这不等于目标客户端一定无法启动。",
    );
  }
  const candidates = [
    {
      kind: "standard_npx",
      preferred: true,
      definition: stdioServerDefinition(platform),
      current_environment_ready: currentNpxReady,
      persistent_path_baseline_ready: persistentNpxReady,
      path_risks: unique([
        ...(runtime.current.npx.path_risks || []),
        ...(persistentNpx.path_risks || []),
      ]),
      warnings,
      tradeoffs: [],
    },
  ];

  if (
    (!currentNpxReady || !persistentNpxReady) &&
    runtime.current.process_node.path &&
    runtime.current.shiliu_entry
  ) {
    candidates.push({
      kind: "absolute_current_install",
      preferred: false,
      definition: {
        command: runtime.current.process_node.path,
        args: [runtime.current.shiliu_entry, "mcp"],
      },
      current_environment_ready: true,
      persistent_path_baseline_ready: false,
      path_risks: unique([
        ...(runtime.current.process_node.path_risks || []),
        ...(runtime.current.shiliu_entry_risks || []),
      ]),
      warnings: [
        "仅在客户端无法使用标准 npx 配置时，才考虑此备选。",
      ],
      tradeoffs: [
        "运行时或应用升级后绝对路径可能失效。",
        "配置会固定到当前已安装的 CLI 版本，不会随 npx 自动选择新版。",
        "运行时目录变化后可能需要重新安装 CLI 并更新配置。",
      ],
    });
  }
  return { runtime, candidates };
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

function execute(command, args, options = {}) {
  const { dryRun = false } = options;
  if (dryRun) {
    console.log(`[dry-run] ${commandText(command, args)}`);
    return { stdout: "", stderr: "" };
  }

  const invocation = commandInvocation(command, args, options);
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
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

function isDuplicateError(error) {
  return /already|exist|duplicate|已存在/iu.test(
    error.commandOutput || error.message,
  );
}

export function configureCodex(options = {}) {
  const home = options.home || process.env.USERPROFILE || process.env.HOME;
  const environment = options.env || process.env;
  const configPath = path.join(
    environment.CODEX_HOME || path.join(home, ".codex"),
    "config.toml",
  );
  try {
    execute("codex", codexArguments(), options);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    execute("codex", ["mcp", "remove", SERVER_NAME], options);
    execute("codex", codexArguments(), options);
  }
  return {
    agent: "codex",
    configuration_state: options.dryRun ? "dry_run" : "written",
    config_path: configPath,
    reload_required: !options.dryRun,
  };
}

export function configureClaude(options = {}) {
  const home = options.home || process.env.USERPROFILE || process.env.HOME;
  const configPath = path.join(home, ".claude.json");
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
  return {
    agent: "claude",
    configuration_state: options.dryRun ? "dry_run" : "written",
    config_path: configPath,
    reload_required: !options.dryRun,
  };
}

export async function configureCursor({ home, dryRun = false } = {}) {
  const configPath = path.join(home, ".cursor", "mcp.json");
  if (dryRun) {
    console.log(
      `[dry-run] 更新 ${configPath} 中的 ${SERVER_NAME}，使用本地 stdio 桥接`,
    );
    return {
      agent: "cursor",
      configuration_state: "dry_run",
      config_path: configPath,
      reload_required: false,
    };
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
  return {
    agent: "cursor",
    configuration_state: "written",
    config_path: configPath,
    reload_required: true,
  };
}

export async function configureAgent(agent, options) {
  if (agent === "codex") return configureCodex(options);
  if (agent === "claude") return configureClaude(options);
  if (agent === "cursor") return configureCursor(options);
  throw new Error(`不支持的客户端：${agent}`);
}
