import crossSpawn from "cross-spawn";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import TOML from "@iarna/toml";

import { PACKAGE_NAME, SERVER_NAME, MCP_URL } from "./constants.js";
import { collectRuntimeDiagnostics } from "./runtime-diagnostics.js";

export function agentConfigPath(agent, { home, env = process.env } = {}) {
  const root = home || env.USERPROFILE || env.HOME;
  if (agent === "codex") return path.join(env.CODEX_HOME || path.join(root, ".codex"), "config.toml");
  if (agent === "claude") return path.join(root, ".claude.json");
  if (agent === "cursor") return path.join(root, ".cursor", "mcp.json");
  return null;
}

// An existing Shiliu entry belongs to the user's working installation. Without an explicit
// --transport, install reports it and never replaces it. Unreadable files count as existing.
export function existingServerEntry(agent, options = {}) {
  const configPath = agentConfigPath(agent, options);
  if (!configPath) return null;
  let content;
  try { content = readFileSync(configPath, "utf8"); }
  catch (error) { return error.code === "ENOENT" ? null : { config_path: configPath, transport: "unknown" }; }
  let server;
  try {
    const parsed = agent === "codex" ? TOML.parse(content) : JSON.parse(content);
    server = (agent === "codex" ? parsed.mcp_servers : parsed.mcpServers)?.[SERVER_NAME];
  } catch {
    return content.includes(SERVER_NAME) ? { config_path: configPath, transport: "unknown" } : null;
  }
  if (!server) return null;
  const remote = typeof server.url === "string" || ["http", "sse", "streamable-http"].includes(server.type);
  return { config_path: configPath, transport: remote ? "http" : "stdio" };
}

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

export function remoteServerDefinition(url = MCP_URL) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("远程 MCP 地址必须是无凭据、无查询参数的 HTTPS 地址");
  return { url: endpoint.href };
}

export function remoteCodexArguments(url = MCP_URL) {
  return ["mcp", "add", SERVER_NAME, "--url", remoteServerDefinition(url).url];
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
  const result = (options.spawnImpl || crossSpawn.sync)(invocation.command, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env: options.env || process.env,
    timeout: 30000,
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

export function isDuplicateError(error) {
  return /\balready exists\b|\bduplicate (?:server|name|configuration)\b|(?:服务器|配置|名称)已存在/iu.test(
    error.commandOutput || error.message,
  );
}

function replaceExisting(configPath, remove, add) {
  // Capture exact bytes before the destructive remove. Restore on any add failure.
  let snapshot;
  try { snapshot = readFileSync(configPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!snapshot) throw new Error("客户端报告配置已存在，但无法备份原配置；未执行 remove");
  remove();
  try { add(); }
  catch (error) {
    const temporary = `${configPath}.${process.pid}.restore`;
    try { writeFileSync(temporary, snapshot, { mode: 0o600, flag: "wx" }); renameSync(temporary, configPath); }
    catch (restoreError) { throw new AggregateError([error, restoreError], "新增配置失败，恢复原配置也失败；请检查客户端配置备份"); }
    finally { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
    throw error;
  }
}

export function configureCodex(options = {}) {
  const home = options.home || process.env.USERPROFILE || process.env.HOME;
  const environment = options.env || process.env;
  const configPath = path.join(
    environment.CODEX_HOME || path.join(home, ".codex"),
    "config.toml",
  );
  const args = options.transport === "http" ? remoteCodexArguments(options.url) : codexArguments();
  try {
    execute("codex", args, options);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    replaceExisting(configPath, () => execute("codex", ["mcp", "remove", SERVER_NAME], options),
      () => execute("codex", args, options));
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
    JSON.stringify(options.transport === "http" ? { type: "http", ...remoteServerDefinition(options.url) } : claudeServerDefinition()),
  ];
  try {
    execute("claude", addArgs, options);
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    replaceExisting(configPath, () => execute(
      "claude",
      ["mcp", "remove", "--scope", "user", SERVER_NAME],
      options,
    ), () => execute("claude", addArgs, options));
  }
  return {
    agent: "claude",
    configuration_state: options.dryRun ? "dry_run" : "written",
    config_path: configPath,
    reload_required: !options.dryRun,
  };
}

export async function configureCursor({ home, dryRun = false, transport, url } = {}) {
  const configPath = path.join(home, ".cursor", "mcp.json");
  if (dryRun) {
    console.log(
      `[dry-run] 更新 ${configPath} 中的 ${SERVER_NAME}，使用 ${transport === "http" ? "远程 HTTP OAuth" : "本地 stdio 桥接"}`,
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
    [SERVER_NAME]: transport === "http" ? remoteServerDefinition(url) : cursorServerDefinition(),
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
  if (!options.transportExplicit) {
    const existing = existingServerEntry(agent, options);
    if (existing) return { agent, configuration_state: "existing_preserved", existing_transport: existing.transport,
      config_path: existing.config_path, reload_required: false };
  }
  if (agent === "codex") return configureCodex(options);
  if (agent === "claude") return configureClaude(options);
  if (agent === "cursor") return configureCursor(options);
  throw new Error(`不支持的客户端：${agent}`);
}
