import os from "node:os";
import path from "node:path";

import { parseCliArguments } from "./arguments.js";
import { configureAgent, stdioServerDefinition } from "./configurators.js";
import {
  API_KEY_ENV,
  MCP_URL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SERVER_NAME,
  SUPPORTED_AGENTS,
} from "./constants.js";
import {
  clearPersistedApiKey,
  persistApiKey,
  readPersistedApiKey,
  resolveApiKey,
} from "./credentials.js";
import { detectInstalledAgents } from "./detection.js";
import { runProxy } from "./proxy.js";
import { printStatus, printTools, probeMcp } from "./status.js";
import { printUpdateStatus } from "./updater.js";

function printHelp() {
  console.log(`${PACKAGE_NAME} ${PACKAGE_VERSION}

用法：
  shiliu login
  shiliu install [--agent <name>]
  shiliu status [--json]
  shiliu tools [--json]
  shiliu update
  shiliu logout
  shiliu mcp

兼容命令：
  mcp-connect ...
  mcp-connect proxy

选项：
  -a, --agent <name>  配置指定客户端
      --dry-run       只显示将执行的操作
      --home <path>   指定用户目录（主要用于测试）
      --url <url>     指定远程 MCP 地址（诊断或桥接）
      --json          以 JSON 输出 status/tools
  -h, --help          显示帮助
  -v, --version       显示版本

安全：
  不提供 --api-key 参数。login 优先读取 ${API_KEY_ENV}，否则隐藏提示输入。
  真实凭据不会写入生成的 MCP 配置，也不会由 status/tools 输出。

智能配置：
  未指定 --agent 时自动检测 ${SUPPORTED_AGENTS.join("、")}。
  任意安全的 Agent 名称均可传入；未内置适配器时输出标准 stdio MCP 配置。`);
}

function printGenericInstructions(agent, { dryRun = false } = {}) {
  const config = {
    mcpServers: {
      [SERVER_NAME]: stdioServerDefinition(),
    },
  };
  console.log(`暂未内置 ${agent} 的自动配置适配器。请在该 Agent 中添加下面的标准 stdio MCP 配置：

${JSON.stringify(config, null, 2)}

桥接器连接 ${MCP_URL}，并从本机凭据存储读取授权信息。
${dryRun ? "演练模式没有保存凭据。" : "Agent 配置中不包含真实凭据。"} 请勿将凭据写入项目代码或提交到 Git。`);
}

async function login({ home, dryRun, url }) {
  const apiKey = await resolveApiKey();
  if (!dryRun) {
    const remote = await probeMcp(apiKey, { url });
    if (!remote.ok) throw new Error(`凭据验证失败：${remote.detail}`);
  }
  await persistApiKey(apiKey, { dryRun, home });
  console.log(
    dryRun
      ? "登录演练通过：凭据格式有效，未连接服务、未写入本机。"
      : "登录成功：凭据已验证并保存到本机；未写入 Agent 配置或项目文件。",
  );
}

async function ensureLogin({ home, dryRun, url }) {
  const persisted = readPersistedApiKey({ home })?.trim();
  if (persisted) return;
  await login({ home, dryRun, url });
}

async function install({ agent, dryRun, home, url }) {
  await ensureLogin({ home, dryRun, url });
  const requestedAgent = agent === "auto" ? undefined : agent;
  if (requestedAgent && !SUPPORTED_AGENTS.includes(requestedAgent)) {
    printGenericInstructions(requestedAgent, { dryRun });
    return;
  }

  const agents = requestedAgent
    ? [requestedAgent]
    : await detectInstalledAgents({ home });
  if (agents.length === 0) {
    printGenericInstructions("当前客户端", { dryRun });
    return;
  }
  for (const detectedAgent of agents) {
    await configureAgent(detectedAgent, { dryRun, home });
  }
  console.log(
    dryRun
      ? `检查完成：将为 ${agents.join("、")} 配置 ${MCP_URL}，未写入文件。`
      : `配置完成：${agents.join("、")} 已接入石榴 AI MCP。请重启客户端后运行 shiliu status。`,
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) return printHelp();
  if (options.version) {
    console.log(PACKAGE_VERSION);
    return;
  }

  const home = path.resolve(options.home || os.homedir());
  const url = options.url || MCP_URL;
  if (options.command === "mcp" || options.command === "proxy") {
    await runProxy({ home, url });
    return;
  }
  if (options.command === "login") {
    await login({ home, dryRun: options.dryRun, url });
    return;
  }
  if (options.command === "logout") {
    await clearPersistedApiKey({ home, dryRun: options.dryRun });
    console.log(
      options.dryRun
        ? "演练模式：未清除本机凭据。"
        : "已退出登录并清除本机兼容凭据。",
    );
    return;
  }
  if (options.command === "status") {
    const result = await printStatus({ home, url, json: options.json });
    if (!result.remote.ok) process.exitCode = 1;
    return;
  }
  if (options.command === "tools") {
    await printTools({ home, url, json: options.json });
    return;
  }
  if (options.command === "update") {
    await printUpdateStatus();
    return;
  }
  await install({
    agent: options.agent,
    dryRun: options.dryRun,
    home,
    url,
  });
}
