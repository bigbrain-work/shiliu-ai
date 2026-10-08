import {
  stdioConfigurationCandidates,
  stdioServerDefinition,
} from "./configurators.js";
import { collectRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { launchContext, runNpm } from "./launch-context.js";
import { PACKAGE_NAME } from "./constants.js";
import { verifyStdioLaunch as probe } from "./stdio-probe.js";

export function verifyStdioLaunch(options = {}) {
  return probe({ definition: stdioServerDefinition(), ...options });
}

export async function getDoctorReport({
  dryRun = false,
  platform = process.platform,
  env = process.env,
  collectRuntime = collectRuntimeDiagnostics,
  verifyLaunch = verifyStdioLaunch,
  nodePath, npmCli, npmCache, launchFile, standardOnly = false,
  prepare = false, prepareNpm = runNpm,
} = {}) {
  const context = await launchContext({ nodePath, npmCli, npmCache, launchFile }, env);
  env = context.env;
  const runtime = collectRuntime({ platform, env });
  const { candidates: baseCandidates } = stdioConfigurationCandidates({
    platform,
    env,
    diagnostics: runtime,
  });
  const launchCandidates = context.definition
    ? [{ kind: "specified_launch", preferred: true, definition: context.definition, warnings: [], tradeoffs: [] }]
    : standardOnly ? baseCandidates.filter((candidate) => candidate.kind === "standard_npx") : baseCandidates;
  let preparation = { attempted: false, ok: null };
  if (prepare && !dryRun && (!context.definition || context.definition.args.includes(PACKAGE_NAME))) {
    // Download/extract before the MCP handshake deadline, not inside initialize.
    // The version check only warms npm; the subsequent handshake checks dependencies.
    try {
      prepareNpm(context, ["exec", "--yes", "--prefer-online", "--", PACKAGE_NAME, "--version"]);
      preparation = { attempted: true, ok: true };
    } catch {
      preparation = { attempted: true, ok: false, reason: "NPM_PREPARE_FAILED" };
    }
  }
  const candidates = [];
  for (const candidate of launchCandidates) {
    const verification = dryRun
      ? {
          state: "not_attempted",
          attempted: false,
          ok: null,
          tool_count: null,
          detail: "演练模式未启动此候选配置。",
        }
      : preparation.ok === false
        ? { state: "stdio_launch_failed", attempted: true, ok: false, tool_count: 0,
            error_code: "RUNTIME_UNAVAILABLE", error_stage: "runtime_load", process_exit_code: 3,
            error_reason: preparation.reason, detail: "npm 预热失败，未进入 MCP 握手；核对目标客户端的 Node/npm/cache 和网络。" }
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
          ...(candidates[0]?.verification || {}),
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
    validation_scope: context.scope,
    preparation,
    installation: { node_path: context.node, npm_cli: context.npmCli || null, npm_cache: context.env.npm_config_cache || null },
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
  console.log(`验证范围          ${report.validation_scope}；目标 Agent 仍需实际重连确认`);
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
    const child = candidate.verification.child_runtime;
    if (child) {
      console.log(`  实际子进程：Node ${child.node_version}；${child.node_path}；安装=${child.install_root}`);
      if (child.reason !== "RUNTIME_READY") console.log(`  原因：${child.reason}${child.missing_module ? `；缺失=${child.missing_module}` : ""}`);
    }
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
