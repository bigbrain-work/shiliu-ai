import os from "node:os";
import path from "node:path";

import { resolveAuthorization } from "./authorization.js";
import { parseCliArguments } from "./arguments.js";
import { configureAgent, stdioServerDefinition } from "./configurators.js";
import {
  API_KEY_ENV,
  AUTH_URL,
  MCP_URL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SERVER_NAME,
  SUPPORTED_AGENTS,
} from "./constants.js";
import {
  clearPersistedApiKey,
  persistApiKey,
  resolveApiKey,
} from "./credentials.js";
import { detectInstalledAgents } from "./detection.js";
import {
  DeviceAuthClient,
  DeviceAuthError,
  renderQrCode,
  waitForDeviceAuthorization,
} from "./device-auth-client.js";
import { verifyAndPersistLogin } from "./login-flow.js";
import { runProxy } from "./proxy.js";
import { printStatus, printTools, probeMcp } from "./status.js";
import { PendingLoginStore, TokenStore } from "./token-store.js";
import { printUpdateStatus } from "./updater.js";

function printHelp() {
  console.log(`${PACKAGE_NAME} ${PACKAGE_VERSION}

用法：
  shiliu login
  shiliu login --no-wait --json
  shiliu login poll --session <id> [--wait] [--json]
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
      --auth-url <url> 指定设备授权服务地址（主要用于测试）
      --legacy-api-key 使用旧 API Key 兼容登录
      --no-wait       创建登录会话后立即返回
      --wait          等待指定登录会话完成
      --session <id>  指定待继续的登录会话
      --json          以 JSON 输出 status/tools
  -h, --help          显示帮助
  -v, --version       显示版本

安全：
  login 默认显示微信二维码，换取短期访问令牌和可轮换刷新令牌。
  令牌保存在系统凭据库，不会写入 Agent 配置，也不会由 status/tools 输出。
  兼容期可使用 --legacy-api-key；不提供会进入 shell 历史的密钥参数。

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

async function legacyLogin({ home, dryRun, url }) {
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

function buildPendingLogin(start, authUrl) {
  return {
    sessionId: start.user_code,
    deviceCode: start.device_code,
    expiresAt: Date.now() + Number(start.expires_in) * 1000,
    interval: Number(start.interval) || 5,
    authUrl,
  };
}

export function buildLoginInstructions(start) {
  const sessionId = start.user_code;
  return {
    status: "authorization_pending",
    login_session_id: sessionId,
    user_code: start.user_code,
    verification_uri:
      start.verification_uri_complete ||
      start.qr_code_uri ||
      start.verification_uri,
    expires_in: Number(start.expires_in),
    poll_command: `shiliu login poll --session ${sessionId} --wait --json`,
    next_action_hint:
      "请让用户打开 verification_uri 完成微信授权；用户确认后运行 poll_command。",
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function startPendingDeviceLogin({ authUrl, json, pendingLoginStore }) {
  const client = new DeviceAuthClient({ baseUrl: authUrl });
  const start = await client.start();
  await pendingLoginStore.save(buildPendingLogin(start, authUrl));
  const instructions = buildLoginInstructions(start);
  if (json) {
    printJson(instructions);
    return;
  }
  console.log(`请使用微信扫描二维码完成登录（验证码 ${start.user_code}）：`);
  console.log(await renderQrCode(start.qr_code_uri));
  console.log(`也可以打开：${instructions.verification_uri}`);
  console.log(
    `完成后运行：${instructions.poll_command.replace(" --json", "")}`,
  );
}

async function pollPendingDeviceLogin({
  session,
  wait,
  json,
  url,
  tokenStore,
  pendingLoginStore,
}) {
  if (!session) throw new Error("login poll 需要 --session <id>");
  const pending = await pendingLoginStore.load();
  if (!pending || pending.sessionId !== session) {
    throw new Error("未找到对应的待处理登录会话，请重新运行 shiliu login");
  }
  if (pending.expiresAt <= Date.now()) {
    await pendingLoginStore.clear();
    throw new Error("登录会话已过期，请重新运行 shiliu login");
  }

  const client = new DeviceAuthClient({ baseUrl: pending.authUrl });
  let response;
  try {
    if (wait) {
      response = await waitForDeviceAuthorization(
        {
          device_code: pending.deviceCode,
          expires_in: Math.max(
            1,
            Math.ceil((pending.expiresAt - Date.now()) / 1000),
          ),
          interval: pending.interval,
        },
        client,
        { onPending: json ? undefined : () => process.stdout.write(".") },
      );
      if (!json) process.stdout.write("\n");
    } else {
      response = await client.exchange(pending.deviceCode);
    }
  } catch (error) {
    if (
      error instanceof DeviceAuthError &&
      ["authorization_pending", "slow_down"].includes(error.code)
    ) {
      const result = {
        status: "authorization_pending",
        login_session_id: pending.sessionId,
        poll_command: `shiliu login poll --session ${pending.sessionId} --wait --json`,
      };
      if (json) printJson(result);
      else console.log("登录尚未完成，请授权后重新运行并加上 --wait。");
      return;
    }
    if (error instanceof DeviceAuthError && error.code === "expired_token") {
      await pendingLoginStore.clear();
    }
    throw error;
  }

  const remote = await verifyAndPersistLogin({
    response,
    client,
    tokenStore,
    url,
  });
  await pendingLoginStore.clear();
  const result = {
    status: "success",
    message: "登录成功",
    tool_count: remote.toolCount,
  };
  if (json) printJson(result);
  else console.log(`登录成功：${remote.detail}；令牌已保存到系统凭据库。`);
}

async function deviceLogin({
  dryRun,
  authUrl,
  url,
  tokenStore,
  pendingLoginStore,
  noWait,
  json,
}) {
  if (dryRun) {
    console.log(
      `登录演练：将从 ${authUrl} 获取设备码、显示微信二维码，并把令牌保存到系统凭据库；未发起网络请求。`,
    );
    return;
  }

  if (noWait) {
    return startPendingDeviceLogin({ authUrl, json, pendingLoginStore });
  }

  const client = new DeviceAuthClient({ baseUrl: authUrl });
  const start = await client.start();
  console.log(`请使用微信扫描二维码完成登录（验证码 ${start.user_code}）：`);
  console.log(await renderQrCode(start.qr_code_uri));
  console.log(
    `若终端二维码无法识别，请打开：${start.verification_uri_complete}`,
  );
  const response = await waitForDeviceAuthorization(start, client, {
    onPending: () => process.stdout.write("."),
  });
  process.stdout.write("\n");
  const remote = await verifyAndPersistLogin({
    response,
    client,
    tokenStore,
    url,
  });
  console.log(`登录成功：${remote.detail}；短期访问令牌已保存到系统凭据库。`);
}

async function login({
  home,
  dryRun,
  url,
  authUrl,
  legacyApiKey,
  tokenStore,
  pendingLoginStore,
  noWait = false,
  json = false,
}) {
  if (legacyApiKey) return legacyLogin({ home, dryRun, url });
  return deviceLogin({
    dryRun,
    authUrl,
    url,
    tokenStore,
    pendingLoginStore,
    noWait,
    json,
  });
}

async function ensureLogin(options) {
  const authorization = await resolveAuthorization({
    home: options.home,
    authUrl: options.authUrl,
    tokenStore: options.tokenStore,
  });
  if (authorization.token) return;
  await login(options);
}

async function install({
  agent,
  dryRun,
  home,
  url,
  authUrl,
  legacyApiKey,
  tokenStore,
}) {
  await ensureLogin({
    home,
    dryRun,
    url,
    authUrl,
    legacyApiKey,
    tokenStore,
  });
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
  const authUrl = options.authUrl || AUTH_URL;
  const tokenStore = new TokenStore();
  const pendingLoginStore = new PendingLoginStore();
  if (options.command === "mcp" || options.command === "proxy") {
    await runProxy({ home, url, authUrl });
    return;
  }
  if (options.command === "login") {
    if (options.subcommand === "poll") {
      await pollPendingDeviceLogin({
        session: options.session,
        wait: options.wait,
        json: options.json,
        url,
        tokenStore,
        pendingLoginStore,
      });
      return;
    }
    await login({
      home,
      dryRun: options.dryRun,
      url,
      authUrl,
      legacyApiKey: options.legacyApiKey,
      tokenStore,
      pendingLoginStore,
      noWait: options.noWait,
      json: options.json,
    });
    return;
  }
  if (options.command === "logout") {
    const current = await tokenStore.load();
    if (!options.dryRun && current?.refreshToken) {
      const client = new DeviceAuthClient({ baseUrl: authUrl });
      await client.revoke(current.refreshToken).catch(() => undefined);
    }
    if (!options.dryRun) {
      await tokenStore.clear();
      await pendingLoginStore.clear();
    }
    await clearPersistedApiKey({ home, dryRun: options.dryRun });
    console.log(
      options.dryRun
        ? "演练模式：未清除本机凭据。"
        : "已退出登录，并从系统凭据库清除令牌和旧版兼容凭据。",
    );
    return;
  }
  if (options.command === "status") {
    const result = await printStatus({
      home,
      url,
      authUrl,
      json: options.json,
    });
    if (!result.remote.ok) process.exitCode = 1;
    return;
  }
  if (options.command === "tools") {
    await printTools({ home, url, authUrl, json: options.json });
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
    authUrl,
    legacyApiKey: options.legacyApiKey,
    tokenStore,
  });
}
