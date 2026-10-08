import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { PACKAGE_NAME, SERVER_NAME } from "./constants.js";
import { resolveExecutable } from "./runtime-diagnostics.js";
import { McpDiagnosticError } from "./mcp-diagnostics.js";

const invalid = () => new McpDiagnosticError("CONFIG_INVALID", "argument_parse");

function isShiliuDefinition(server) {
  const name = path.basename(server.command).toLowerCase();
  const args = server.args;
  if (["cmd", "cmd.exe"].includes(name)) {
    return JSON.stringify(args) === JSON.stringify(["/d", "/s", "/c", "npx", "-y", PACKAGE_NAME, "mcp"]);
  }
  if (name === "npx") return JSON.stringify(args) === JSON.stringify(["-y", PACKAGE_NAME, "mcp"]);
  if (!["node", "node.exe"].includes(name)) return false;
  if (args.length === 2 && ["shiliu.js", "mcp-connect.js"].includes(path.basename(args[0])) && args[1] === "mcp") return path.isAbsolute(args[0]);
  return args.length === 6 && path.isAbsolute(args[0]) && path.basename(args[0]) === "npm-cli.js" &&
    JSON.stringify(args.slice(1)) === JSON.stringify(["exec", "--yes", "--", PACKAGE_NAME, "mcp"]);
}

export async function launchContext(options = {}, env = process.env) {
  const environment = { ...env };
  if (options.nodePath) {
    if (!path.isAbsolute(options.nodePath) || !existsSync(options.nodePath)) throw invalid();
    // Normalize casing on Windows rather than keeping two different PATH entries.
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") || "PATH";
    environment[pathKey] = `${path.dirname(options.nodePath)}${path.delimiter}${environment[pathKey] || ""}`;
  }
  if (options.npmCache) {
    if (!path.isAbsolute(options.npmCache)) throw invalid();
    for (const key of Object.keys(environment)) if (key.toLowerCase() === "npm_config_cache") delete environment[key];
    environment.npm_config_cache = options.npmCache;
  }
  const node = options.nodePath || process.execPath;
  let npmCli = options.npmCli;
  if (npmCli) {
    if (!path.isAbsolute(npmCli) || !existsSync(npmCli)) throw invalid();
  } else {
    const npm = resolveExecutable("npm", { env: environment });
    const directories = [path.dirname(node), npm && path.dirname(npm)].filter(Boolean);
    npmCli = directories.map((directory) => path.join(directory, "node_modules/npm/bin/npm-cli.js")).find(existsSync);
    if (!npmCli && npm) {
      const resolved = await realpath(npm).catch(() => "");
      if (resolved.endsWith("npm-cli.js")) npmCli = resolved;
    }
  }
  let definition;
  if (options.launchFile) {
    // Read the documented JSON configuration, never opaque application storage.
    const text = await readFile(options.launchFile, "utf8");
    if (text.length > 1024 * 1024) throw invalid();
    let config;
    try { config = JSON.parse(text.replace(/^\uFEFF/u, "")); } catch { throw invalid(); }
    const server = config.mcpServers?.[SERVER_NAME] || config;
    if (typeof server.command !== "string" || !Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")) throw invalid();
    // This flow is only for credential-free Shiliu stdio configurations.
    if (Object.keys(server.env || {}).length || server.url || server.headers || !isShiliuDefinition(server)) throw invalid();
    definition = { command: server.command, args: server.args };
  } else if (options.nodePath || options.npmCli) {
    if (!npmCli) throw invalid();
    definition = { command: node, args: [npmCli, "exec", "--yes", "--", PACKAGE_NAME, "mcp"] };
  }
  return { env: environment, node, npmCli, definition,
    scope: options.nodePath || options.npmCli || options.npmCache || options.launchFile ? "specified_launch_context" : "current_terminal" };
}

export function runNpm(context, args, timeout = 120000) {
  if (!context.npmCli) throw invalid();
  const result = spawnSync(context.node, [context.npmCli, ...args], {
    env: context.env, encoding: "utf8", windowsHide: true, shell: false, timeout,
    maxBuffer: 1024 * 1024,
  });
  // npm output may contain user registry credentials: never attach it to an error/report.
  if (result.error || result.status !== 0) throw new McpDiagnosticError("RUNTIME_UNAVAILABLE", "runtime_load");
  return result.stdout.trim();
}
