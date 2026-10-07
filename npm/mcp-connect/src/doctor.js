import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  stdioConfigurationCandidates,
  stdioServerDefinition,
} from "./configurators.js";
import { PACKAGE_VERSION } from "./constants.js";
import { collectRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { LOGIN_TOOL_NAMES } from "./proxy-session.js";
import { parseDiagnosticOutput, diagnosticSummary } from "./mcp-diagnostics.js";

function sanitizedEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}

export async function verifyStdioLaunch({
  definition = stdioServerDefinition(),
  env = process.env,
  timeoutMs = 30000,
} = {}) {
  const transport = new StdioClientTransport({
    command: definition.command,
    args: definition.args,
    env: sanitizedEnvironment(env),
    stderr: "pipe",
  });
  const client = new Client({
    name: "shiliu-ai-doctor",
    version: PACKAGE_VERSION,
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  let timeout;
  try {
    const operation = (async () => {
      await client.connect(transport);
      const catalog = await client.listTools();
      const tools = catalog.tools || [];
      const bootstrapCount = tools.filter((tool) => LOGIN_TOOL_NAMES.has(tool.name)).length;
      let remoteConnected = bootstrapCount === 0;
      let loginState = bootstrapCount === 0 ? "legacy_bridge" : "checking_login";
      if (tools.some((tool) => tool.name === "shiliu_connection_status")) {
        const result = await client.callTool({ name: "shiliu_connection_status", arguments: {} });
        remoteConnected = result.structuredContent?.remote_connected === true;
        loginState = result.structuredContent?.status || loginState;
      }
      return { tools, bootstrapCount, remoteConnected, loginState };
    })();
    const { tools, bootstrapCount, remoteConnected, loginState } = await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`stdio MCP 验证在 ${timeoutMs}ms 后超时`)),
          timeoutMs,
        );
      }),
    ]);
    return {
      state: "stdio_launch_verified",
      attempted: true,
      ok: true,
      tool_count: tools.length,
      bootstrap_tool_count: bootstrapCount,
      business_tool_count: tools.length - bootstrapCount,
      remote_connected: remoteConnected,
      login_state: loginState,
      detail: `本机 MCP 启动验证成功，${bootstrapCount} 个登录/状态工具、${tools.length - bootstrapCount} 个业务工具；${remoteConnected ? "远程服务已连接" : "远程业务连接尚未完成"}`,
    };
  } catch (error) {
    const diagnostic = parseDiagnosticOutput(stderr) || diagnosticSummary(error.code === "ENOENT" ? "RUNTIME_UNAVAILABLE" : "PROTOCOL_ERROR", "mcp_start");
    return {
      state: "stdio_launch_failed",
      attempted: true,
      ok: false,
      tool_count: 0,
      error_code: diagnostic.code,
      error_stage: diagnostic.stage,
      process_exit_code: diagnostic.fatal ? diagnostic.exit_code : null,
      detail: `${diagnostic.code} (${diagnostic.stage})：${diagnostic.message} ${diagnostic.action}`,
    };
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {});
  }
}

export async function getDoctorReport({
  dryRun = false,
  platform = process.platform,
  env = process.env,
  collectRuntime = collectRuntimeDiagnostics,
  verifyLaunch = verifyStdioLaunch,
} = {}) {
  const runtime = collectRuntime({ platform, env });
  const { candidates: baseCandidates } = stdioConfigurationCandidates({
    platform,
    env,
    diagnostics: runtime,
  });
  const candidates = [];
  for (const candidate of baseCandidates) {
    const verification = dryRun
      ? {
          state: "not_attempted",
          attempted: false,
          ok: null,
          tool_count: null,
          detail: "演练模式未启动此候选配置。",
        }
      : await verifyLaunch({ definition: candidate.definition, env });
    candidates.push({ ...candidate, verification });
  }
  const successfulCandidate = candidates.find(
    (candidate) => candidate.verification.ok,
  );
  const launch = dryRun
    ? {
        state: "not_attempted",
        attempted: false,
        ok: null,
        tool_count: null,
        verified_candidate: null,
        detail: "演练模式未启动 stdio MCP，也未发起 tools/list。",
      }
    : successfulCandidate
      ? {
          ...successfulCandidate.verification,
          verified_candidate: successfulCandidate.kind,
        }
      : {
          state: "stdio_launch_failed",
          attempted: true,
          ok: false,
          tool_count: 0,
          verified_candidate: null,
          detail: "所有候选 stdio 配置的本机启动验证均失败。",
        };
  return {
    status: launch.attempted
      ? launch.ok
        ? "stdio_launch_verified"
        : "stdio_launch_failed"
      : runtime.state,
    transport: "stdio",
    runtime,
    candidates,
    stdio_launch: launch,
    client_connection: {
      state: "unverified",
      detail:
        "doctor 只验证本机启动条件，不能证明目标 Agent 已保存、加载或连接该 MCP。",
    },
  };
}

export async function printDoctor(options = {}) {
  const report = await getDoctorReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const current = report.runtime.current;
  const persistent = report.runtime.persistent_path_baseline;
  console.log(`运行时状态        ${report.runtime.state}`);
  console.log(`当前 Node         ${current.process_node.version} — ${current.process_node.path}`);
  console.log(
    `当前 npm          ${current.npm.available ? current.npm.version : "不可用"}${current.npm.path ? ` — ${current.npm.path}` : ""}`,
  );
  console.log(
    `当前 npx          ${current.npx.available ? current.npx.version : "不可用"}${current.npx.path ? ` — ${current.npx.path}` : ""}`,
  );
  console.log(`npm 全局目录      ${current.npm_global_prefix || "无法读取"}`);
  console.log(
    `持久 PATH 基线   ${persistent.available ? (persistent.npx.available ? "可找到 npx" : "找不到 npx") : "无法读取"}`,
  );
  for (const candidate of report.candidates) {
    console.log(
      `候选 ${candidate.kind}  ${candidate.preferred ? "首选" : "备选"}；${candidate.verification.detail}`,
    );
    if (candidate.warnings.length > 0) {
      console.log(`  提示：${candidate.warnings.join("；")}`);
    }
    if (candidate.tradeoffs.length > 0) {
      console.log(`  代价：${candidate.tradeoffs.join("；")}`);
    }
  }
  console.log(`stdio 本机验证    ${report.stdio_launch.detail}`);
  console.log(`客户端连接状态    ${report.client_connection.detail}`);
  return report;
}
