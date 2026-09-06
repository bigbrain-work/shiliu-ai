import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { API_KEY_ENV } from "./constants.js";

export function validateApiKey(value) {
  const apiKey = value?.trim();
  if (!apiKey) throw new Error("API Key 不能为空");
  if (/\s/u.test(apiKey)) throw new Error("API Key 不能包含空白字符");
  if (apiKey.length < 12) throw new Error("API Key 长度异常，请确认复制完整");
  return apiKey;
}

export async function readHiddenInput(
  promptText,
  input = process.stdin,
  output = process.stdout,
) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      `当前终端不支持隐藏输入，请先设置 ${API_KEY_ENV} 环境变量后重试`,
    );
  }

  output.write(promptText);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("操作已取消"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    input.on("data", onData);
  });
}

export async function resolveApiKey({
  env = process.env,
  prompt = readHiddenInput,
} = {}) {
  if (env[API_KEY_ENV]) return validateApiKey(env[API_KEY_ENV]);
  return validateApiKey(
    await prompt("请输入石榴 AI API Key（输入内容不会显示）："),
  );
}

function runPowerShellWithInput(script, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `PowerShell 返回退出码 ${code}`));
    });
    child.stdin.end(input);
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function posixPaths(home, env) {
  const configDir = path.join(home, ".config", "shiliu-ai");
  const envFile = path.join(configDir, "env");
  const shellName = path.basename(env.SHELL || "");
  const profileName =
    shellName === "zsh"
      ? ".zprofile"
      : shellName === "bash"
        ? ".bash_profile"
        : ".profile";
  return { configDir, envFile, profilePath: path.join(home, profileName) };
}

async function persistPosixApiKey(apiKey, home, env) {
  const { configDir, envFile, profilePath } = posixPaths(home, env);
  await mkdir(configDir, { recursive: true });
  await writeFile(envFile, `export ${API_KEY_ENV}=${shellQuote(apiKey)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(envFile, 0o600);

  const sourceLine = `. ${shellQuote(envFile)} # shiliu-ai\n`;
  let profile = "";
  try {
    profile = await readFile(profilePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!profile.includes("# shiliu-ai")) {
    const separator = profile && !profile.endsWith("\n") ? "\n" : "";
    await writeFile(profilePath, `${profile}${separator}${sourceLine}`, "utf8");
  }
}

export async function persistApiKey(
  apiKey,
  { dryRun = false, home, platform = process.platform, env = process.env } = {},
) {
  if (dryRun) return;
  if (platform === "win32") {
    const script = `$value = [Console]::In.ReadToEnd(); [Environment]::SetEnvironmentVariable('${API_KEY_ENV}', $value, 'User')`;
    await runPowerShellWithInput(script, apiKey);
  } else {
    await persistPosixApiKey(apiKey, home, env);
  }
  process.env[API_KEY_ENV] = apiKey;
}

export function readPersistedApiKey({
  platform = process.platform,
  env = process.env,
  home,
} = {}) {
  if (env[API_KEY_ENV]) return env[API_KEY_ENV];
  if (platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::Out.Write([Environment]::GetEnvironmentVariable('${API_KEY_ENV}', 'User'))`,
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    return result.status === 0 ? result.stdout.trim() : "";
  }

  try {
    const { envFile } = posixPaths(home, env);
    const content = readFileSync(envFile, "utf8");
    const prefix = `export ${API_KEY_ENV}=`;
    const line = content
      .split(/\r?\n/u)
      .find((item) => item.startsWith(prefix));
    if (!line) return "";
    const encodedValue = line.slice(prefix.length);
    if (encodedValue.startsWith("'") && encodedValue.endsWith("'")) {
      return encodedValue.slice(1, -1).replaceAll("'\\''", "'");
    }
    return encodedValue;
  } catch {
    return "";
  }
}

export async function clearPersistedApiKey({
  home,
  platform = process.platform,
  env = process.env,
  dryRun = false,
} = {}) {
  if (dryRun) return;
  if (platform === "win32") {
    await runPowerShellWithInput(
      `[Environment]::SetEnvironmentVariable('${API_KEY_ENV}', $null, 'User')`,
    );
  } else {
    const { envFile, profilePath } = posixPaths(home, env);
    await rm(envFile, { force: true });
    try {
      const profile = await readFile(profilePath, "utf8");
      const next = profile
        .split(/(?<=\n)/u)
        .filter((line) => !line.includes("# shiliu-ai"))
        .join("");
      if (next !== profile) await writeFile(profilePath, next, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  delete process.env[API_KEY_ENV];
}
