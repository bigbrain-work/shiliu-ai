import { spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { accessSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

function expandWindowsEnvironment(value, env) {
  return value.replace(/%([^%]+)%/gu, (match, name) => {
    const key = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key ? env[key] : match;
  });
}

export function pathEntries(searchPath, platform = process.platform, env = process.env) {
  if (!searchPath) return [];
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  return searchPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .map((entry) =>
      platform === "win32" ? expandWindowsEnvironment(entry, env) : entry,
    );
}

function executableExists(candidate, platform, fileExists = existsSync) {
  if (!fileExists(candidate)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(
  command,
  {
    platform = process.platform,
    env = process.env,
    searchPath = env.PATH || env.Path || "",
    fileExists = existsSync,
  } = {},
) {
  const hasSeparator = command.includes("/") || command.includes("\\");
  if (path.isAbsolute(command) || hasSeparator) {
    const candidate = path.resolve(command);
    return executableExists(candidate, platform, fileExists) ? candidate : null;
  }

  const extensions =
    platform === "win32"
      ? (env.PATHEXT || WINDOWS_EXECUTABLE_EXTENSIONS.join(";"))
          .split(";")
          .filter(Boolean)
      : [""];
  const commandHasExtension = Boolean(path.extname(command));
  for (const directory of pathEntries(searchPath, platform, env)) {
    const candidates =
      platform === "win32" && !commandHasExtension
        ? extensions.map((extension) => path.join(directory, `${command}${extension}`))
        : [path.join(directory, command)];
    for (const candidate of candidates) {
      if (executableExists(candidate, platform, fileExists)) {
        return path.resolve(candidate);
      }
    }
  }
  return null;
}

function runResolved(
  executable,
  args,
  { platform = process.platform, env = process.env, spawnImpl = spawnSync } = {},
) {
  if (!executable) return { ok: false, output: null, error: "command_not_found" };
  const isWindowsScript =
    platform === "win32" && /\.(?:cmd|bat)$/iu.test(executable);
  const command = isWindowsScript ? env.ComSpec || "cmd.exe" : executable;
  const commandArgs = isWindowsScript
    ? ["/d", "/s", "/c", "call", executable, ...args]
    : args;
  const result = spawnImpl(command, commandArgs, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env,
    timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      output: null,
      error:
        result.error?.message ||
        String(result.stderr || result.stdout || `exit_${result.status}`).trim(),
    };
  }
  return { ok: true, output: String(result.stdout || "").trim(), error: null };
}

function parseRegistryPath(output) {
  for (const line of String(output || "").split(/\r?\n/u)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/iu);
    if (match) return match[1].trim();
  }
  return "";
}

export function readWindowsPersistentPath({ env = process.env, spawnImpl = spawnSync } = {}) {
  const queries = [
    ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", "Path"],
    ["HKCU\\Environment", "/v", "Path"],
  ];
  const values = [];
  const errors = [];
  for (const query of queries) {
    const result = spawnImpl("reg.exe", ["query", ...query], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 5000,
    });
    if (result.error || result.status !== 0) {
      errors.push(result.error?.message || `reg_exit_${result.status}`);
      continue;
    }
    const value = parseRegistryPath(result.stdout);
    if (value) values.push(expandWindowsEnvironment(value, env));
  }
  if (values.length === 0) {
    return {
      available: false,
      value: "",
      source: "windows_registry",
      detail: errors.join("; ") || "persistent_path_unavailable",
    };
  }
  return {
    available: true,
    value: values.join(";"),
    source: "windows_registry",
    detail: errors.length > 0 ? `partial: ${errors.join("; ")}` : null,
  };
}

export function assessPathRisk(targetPath, { platform = process.platform } = {}) {
  if (!targetPath) return [];
  const normalized = path.resolve(targetPath);
  const risks = [];
  const temporaryDirectory = path.resolve(os.tmpdir());
  const comparable = platform === "win32" ? normalized.toLowerCase() : normalized;
  const comparableTemporary =
    platform === "win32" ? temporaryDirectory.toLowerCase() : temporaryDirectory;
  if (
    comparable === comparableTemporary ||
    comparable.startsWith(`${comparableTemporary}${path.sep}`)
  ) {
    risks.push("temporary_directory");
  }
  if (/[/\\]sandbox_runtime[/\\]bases[/\\]/iu.test(normalized)) {
    risks.push("application_managed_sandbox");
  }
  if (/[/\\][0-9a-f]{32,64}(?=[/\\]|$)/iu.test(normalized)) {
    risks.push("content_addressed_path_hint");
  }
  return risks;
}

function inspectCommand(name, options) {
  const executable = resolveExecutable(name, options);
  const version = runResolved(executable, ["--version"], options);
  return {
    available: Boolean(executable) && version.ok,
    path: executable,
    version: version.output,
    error: version.error,
    path_risks: assessPathRisk(executable, options),
  };
}

export function collectRuntimeDiagnostics({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  argv = process.argv,
  spawnImpl = spawnSync,
  fileExists = existsSync,
} = {}) {
  const currentOptions = { platform, env, spawnImpl, fileExists };
  const persistentPath =
    platform === "win32"
      ? readWindowsPersistentPath({ env, spawnImpl })
      : {
          available: true,
          value: env.PATH || "",
          source: "process_path",
          detail: null,
        };
  const persistentEnv = {
    ...env,
    PATH: persistentPath.value,
    Path: persistentPath.value,
  };
  const persistentOptions = {
    platform,
    env: persistentEnv,
    searchPath: persistentPath.value,
    spawnImpl,
    fileExists,
  };
  const npm = inspectCommand("npm", currentOptions);
  const prefix = npm.path
    ? runResolved(npm.path, ["prefix", "--global"], currentOptions)
    : { ok: false, output: null, error: "command_not_found" };
  const current = {
    process_node: {
      available: Boolean(execPath),
      path: execPath ? path.resolve(execPath) : null,
      version: process.versions.node,
      path_risks: assessPathRisk(execPath, { platform }),
    },
    path_node: inspectCommand("node", currentOptions),
    npm,
    npx: inspectCommand("npx", currentOptions),
    npm_global_prefix: prefix.ok ? prefix.output : null,
    npm_global_prefix_risks: assessPathRisk(prefix.output, { platform }),
    shiliu_entry: argv[1] ? path.resolve(argv[1]) : null,
    shiliu_entry_risks: assessPathRisk(argv[1], { platform }),
  };
  const persistent = {
    available: persistentPath.available,
    source: persistentPath.source,
    detail: persistentPath.detail,
    node: inspectCommand("node", persistentOptions),
    npm: inspectCommand("npm", persistentOptions),
    npx: inspectCommand("npx", persistentOptions),
  };
  const runtimeHealthy =
    current.process_node.available && current.npm.available && current.npx.available;
  return {
    state: runtimeHealthy ? "runtime_healthy" : "runtime_attention_required",
    current,
    persistent_path_baseline: persistent,
    environment_difference:
      current.npx.path !== persistent.npx.path ||
      current.path_node.path !== persistent.node.path,
    boundary:
      "persistent_path_baseline 是诊断基线，不代表目标 Agent 启动 MCP 时使用的真实环境。",
  };
}
