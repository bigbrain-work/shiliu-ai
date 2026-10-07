import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../bin/shiliu.js", import.meta.url));
const SESSION_PATTERN = /^[A-Z0-9-]{4,64}$/u;
const SAFE_FIELDS = [
  "status", "login_session_id", "user_code", "qr_code_path", "qr_code_mime_type",
  "expires_in", "poll_after_seconds", "latest_qr_only", "mobile_confirmation_required",
  "reused_session", "tool_count", "authorization_stage",
];

export function loginCommandArguments(action, { session, home, url, authUrl, allowLocalhost = false } = {}) {
  if (action !== "start" && action !== "poll") throw new Error("Unknown login action");
  if (action === "poll" && !SESSION_PATTERN.test(session || "")) throw new Error("登录会话编号格式无效");
  const args = action === "start" ? ["login", "--no-wait"] : ["login", "poll", "--session", session];
  args.push("--json");
  if (home) args.push("--home", home);
  if (url) args.push("--url", url);
  if (authUrl) args.push("--auth-url", authUrl);
  if (allowLocalhost) args.push("--allow-localhost");
  return args;
}

export function safeLoginResult(payload, ok) {
  const result = Object.fromEntries(SAFE_FIELDS
    .filter((key) => ["string", "number", "boolean"].includes(typeof payload?.[key]))
    .map((key) => [key, payload[key]]));
  if (!ok || !["success", "authorization_pending", "slow_down"].includes(result.status)) {
    return { status: "error", message: "登录操作未完成，请在本机运行 shiliu login 检查授权服务或系统凭据库；不要发送任何凭据。" };
  }
  result.next_action_hint = result.status === "success"
    ? "登录成功。重新请求 tools/list 获取远程业务工具；客户端若没有自动刷新工具，请刷新 MCP 或重新连接。"
    : "展示本次二维码后立即按 poll_after_seconds 的间隔调用 shiliu_login_poll，传入 login_session_id；不要等待用户回复已扫码，不要反复创建会话。";
  return result;
}

// Reuse CLI login in a child process so console output never enters MCP stdout.
export function runProxyLogin(action, options = {}) {
  const args = loginCommandArguments(action, options);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: options.env || process.env, windowsHide: true, shell: false,
      stdio: ["ignore", "pipe", "pipe"], signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); }, 30000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const capture = (target) => (chunk) => {
      if (stdout.length + stderr.length + chunk.length > 65536) child.kill();
      else if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.on("error", () => { clearTimeout(timer); resolve(safeLoginResult({}, false)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try { resolve(safeLoginResult(JSON.parse(code === 0 ? stdout : stderr), code === 0)); }
      catch { resolve(safeLoginResult({}, false)); }
    });
  });
}

export async function loginToolResult(payload) {
  const content = [{ type: "text", text: JSON.stringify(payload) }];
  const directory = path.resolve(os.tmpdir(), "shiliu-ai");
  if (payload.qr_code_path && SESSION_PATTERN.test(payload.login_session_id || "")) {
    const expected = path.join(directory, `shiliu-login-${payload.login_session_id}.png`);
    if (path.resolve(payload.qr_code_path) === expected) {
      const png = await readFile(expected).catch(() => null);
      if (png && png.length <= 1024 * 1024) content.push({ type: "image", mimeType: "image/png", data: png.toString("base64"), annotations: { audience: ["user"] } });
    }
  }
  return { content, structuredContent: payload, isError: payload.status === "error" };
}
