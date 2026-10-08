import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeRuntimeDetails, runtimeIdentity } from "./runtime-preflight.js";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const stderrStreams = new WeakSet();

export const DIAGNOSTIC_CODES = Object.freeze({
  CONFIG_INVALID: { exitCode: 2, message: "MCP 配置或参数无效。", action: "检查 MCP command/args 和服务地址，使用 CLI 生成的配置。" },
  RUNTIME_UNAVAILABLE: { exitCode: 3, message: "MCP 运行环境或依赖不可用。", action: "检查 Node 版本及 CLI 安装，重新安装官方 CLI 后重连。" },
  INTERNAL_ERROR: { exitCode: 4, message: "MCP 连接程序发生内部异常。", action: "重连一次；若仍失败，请提供错误分类、阶段和诊断日志，不要提供凭据。" },
  LOGIN_REQUIRED: { message: "尚未登录，MCP 连接保持可用。", action: "调用 shiliu_login 展示二维码，再按间隔调用 shiliu_login_poll。" },
  LOGIN_CHECKING: { message: "正在检查本机登录状态，MCP 已连接。", action: "稍后调用 shiliu_connection_status 查看进度。" },
  AUTH_EXPIRED: { message: "登录凭据已失效，MCP 连接保持可用。", action: "调用 shiliu_login 重新微信扫码；无需修改 MCP 配置中的凭据。" },
  CREDENTIAL_UNAVAILABLE: { message: "本机系统凭据无法读取或刷新，MCP 连接保持可用。", action: "检查运行用户和系统凭据库，或调用 shiliu_login 重新登录。" },
  REMOTE_UNAVAILABLE: { message: "远程服务暂时不可达，MCP 连接保持可用。", action: "检查网络后调用 shiliu_connection_status 重试；不要因网络错误清除登录凭据。" },
  PROTOCOL_ERROR: { message: "MCP 通信数据或传输发生异常。", action: "检查客户端传输配置，确保使用标准 stdio 启动方式。" },
  CONNECTION_READY: { message: "已连接远程服务并取得业务工具列表。", action: "刷新 tools/list 获取可用业务工具。" },
  CONNECTION_CLOSED: { message: "本地 MCP 连接已正常关闭。", action: "需要继续使用时重新连接。" },
});

const STAGES = new Set([
  "argument_parse", "endpoint_validation", "runtime_load", "mcp_start", "credential_resolution",
  "remote_initialize", "remote_catalog", "business_call", "mcp_transport", "mcp_shutdown", "process",
]);
const RUNTIME_CODES = new Set([
  "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_ESM_URL_SCHEME", "ENOENT", "ENOEXEC",
]);

export class McpDiagnosticError extends Error {
  constructor(code, stage, message, cause) {
    super(message || DIAGNOSTIC_CODES[code]?.message || "MCP error", { cause });
    this.diagnosticCode = code;
    this.diagnosticStage = stage;
  }
}

export function classifyFatalError(error, stage = "process") {
  const code = DIAGNOSTIC_CODES[error?.diagnosticCode]?.exitCode ? error.diagnosticCode
    : RUNTIME_CODES.has(error?.code) ? "RUNTIME_UNAVAILABLE" : "INTERNAL_ERROR";
  return { code, stage: error?.diagnosticStage || stage, exitCode: DIAGNOSTIC_CODES[code].exitCode };
}

export function diagnosticSummary(code, stage = "process", fatal = false) {
  const safeCode = hasOwn(DIAGNOSTIC_CODES, code) ? code : "INTERNAL_ERROR";
  const definition = DIAGNOSTIC_CODES[safeCode];
  return {
    code: safeCode, stage: STAGES.has(stage) ? stage : "process", fatal: Boolean(fatal),
    exit_code: fatal ? definition.exitCode || 4 : code === "CONNECTION_CLOSED" ? 0 : null,
    message: definition.message, action: definition.action,
  };
}

export function createDiagnosticReporter({ home = os.homedir(), stderr = process.stderr, maxBytes = 512 * 1024 } = {}) {
  // A client closing stderr must not turn an ordinary shutdown into a fatal error.
  if (typeof stderr.on === "function" && !stderrStreams.has(stderr)) {
    stderr.on("error", () => {});
    stderrStreams.add(stderr);
  }
  const logPath = path.resolve(home, ".shiliu-ai", "logs", "mcp-diagnostics.jsonl");
  let queue = Promise.resolve();
  let available = false;
  return {
    path: logPath,
    available: () => available,
    record(code, { stage = "process", fatal = false, runtime } = {}) {
      // Never serialize errors, stack traces, arguments, environment, URLs or remote responses.
      const record = {
        schema_version: 1, timestamp: new Date().toISOString(), component: "shiliu_mcp",
        pid: process.pid, ...diagnosticSummary(code, stage, fatal), diagnostic_path: logPath,
        runtime: runtime ? safeRuntimeDetails(runtime) : runtimeIdentity(),
      };
      const line = `${JSON.stringify(record)}\n`;
      try { stderr.write(line); } catch { /* stderr may already be closed */ }
      queue = queue.then(async () => {
        await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
        const current = await stat(logPath).catch(() => null);
        if (current && current.size + Buffer.byteLength(line) > maxBytes) await rename(logPath, `${logPath}.1`);
        await appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
        await chmod(logPath, 0o600).catch(() => {});
        available = true;
      }).catch(() => { available = false; });
      return queue.then(() => record);
    },
  };
}

export function parseDiagnosticOutput(stderr) {
  let latest;
  for (const line of String(stderr).split(/\r?\n/u)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.component !== "shiliu_mcp" || !hasOwn(DIAGNOSTIC_CODES, parsed.code)) continue;
      const summary = diagnosticSummary(parsed.code, parsed.stage, parsed.fatal === true);
      if (parsed.runtime) summary.runtime = safeRuntimeDetails(parsed.runtime);
      if (latest && parsed.code === "CONNECTION_CLOSED") continue;
      if (!latest || summary.fatal || !latest.fatal) latest = summary;
    } catch { /* Third-party output is deliberately not included in reports. */ }
  }
  return latest;
}
