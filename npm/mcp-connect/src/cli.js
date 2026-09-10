import os from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";

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
  createLoginQrCode,
  removeLoginQrCode,
  renderQrCode,
  waitForDeviceAuthorization,
} from "./device-auth-client.js";
import { verifyAndPersistLogin } from "./login-flow.js";
import { runProxy } from "./proxy.js";
import {
  normalizeDeviceUserCode,
  validateAuthUrl,
  validateMcpUrl,
} from "./security.js";
import { printStatus, printTools, probeMcp } from "./status.js";
import { printSkillRefresh } from "./skill-refresh.js";
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
  shiliu skill refresh [--force] [--json]
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
      --url <url>     指定石榴 AI MCP 地址（诊断或本机测试）
      --auth-url <url> 指定石榴 AI 授权地址（主要用于本机测试）
      --allow-localhost 显式允许连接本机回环测试服务
      --legacy-api-key 使用旧 API Key 兼容登录
      --no-wait       创建登录会话后立即返回
      --wait          等待指定登录会话完成
      --force         忽略24小时冷却并立即检查石榴 Skill
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

function printGenericInstructions(
  agent,
  { dryRun = false, json = false } = {},
) {
  const config = {
    mcpServers: {
      [SERVER_NAME]: stdioServerDefinition(),
    },
  };
  const result = {
    agent,
    configuration_state: "generated_only",
    config_path: null,
    reload_required: false,
    config,
  };
  if (!json) console.log(`暂未内置 ${agent} 的自动配置适配器。请在该 Agent 中添加下面的标准 stdio MCP 配置：

${JSON.stringify(config, null, 2)}

桥接器连接 ${MCP_URL}，并从本机凭据存储读取授权信息。
${dryRun ? "演练模式没有保存凭据。" : "Agent 配置中不包含真实凭据。"} 请勿将凭据写入项目代码或提交到 Git。`);
  return result;
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

function buildPendingLogin(
  start,
  authUrl,
  allowLocalhost,
  qrCodePath,
  qrCodeValue,
) {
  return {
    sessionId: normalizeDeviceUserCode(start.user_code),
    deviceCode: start.device_code,
    expiresAt: Date.now() + Number(start.expires_in) * 1000,
    interval: Number(start.interval) || 5,
    authUrl,
    allowLocalhost,
    qrCodePath,
    qrCodeValue,
  };
}

export function buildLoginInstructions(
  start,
  { allowLocalhost = false, qrCodePath } = {},
) {
  const sessionId = normalizeDeviceUserCode(start.user_code);
  const localhostOption = allowLocalhost ? " --allow-localhost" : "";
  const pollAfterSeconds = Number(start.interval) || 5;
  return {
    status: "authorization_pending",
    login_session_id: sessionId,
    user_code: start.user_code,
    verification_uri:
      start.verification_uri_complete ||
      start.qr_code_uri ||
      start.verification_uri,
    qr_code_path: qrCodePath,
    qr_code_mime_type: "image/png",
    expires_in: Number(start.expires_in),
    poll_after_seconds: pollAfterSeconds,
    latest_qr_only: true,
    mobile_confirmation_required: false,
    poll_command: `shiliu login poll --session ${sessionId} --json${localhostOption}`,
    next_action_hint:
      "二维码已由石榴 CLI 生成。只展示本次 user_code 对应的 qr_code_path 本地图片，旧二维码一律不要再展示或轮询；不要上传图片、不要自行生成二维码、不要把 verification_uri 当作网页打开。展示后立即运行 poll_command；若仍为 authorization_pending，等待 poll_after_seconds 后重复运行，直到 success 或过期。用户只需微信扫码，手机端没有二次确认按钮，不要等待用户再回复已扫码。",
  };
}

export function buildPendingPollResult(
  pending,
  now = Date.now(),
  reason = "authorization_pending",
  details = {},
) {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((pending.expiresAt - now) / 1000),
  );
  const result = {
    status: reason === "slow_down" ? "slow_down" : "authorization_pending",
    login_session_id: pending.sessionId,
    poll_after_seconds: pending.interval,
    expires_in: remainingSeconds,
    poll_command: `shiliu login poll --session ${pending.sessionId} --json${pending.allowLocalhost ? " --allow-localhost" : ""}`,
    next_action_hint:
      reason === "slow_down"
        ? "轮询过快。等待新的 poll_after_seconds 后自动再次运行 poll_command；不要创建新会话。"
        : "等待 poll_after_seconds 后自动再次运行 poll_command；不要等待用户回复。用户只需微信扫码。",
  };
  if (typeof details.authorization_stage === "string") {
    result.authorization_stage = details.authorization_stage;
  }
  return result;
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function printOrReturnLoginInstructions(instructions, json) {
  if (json) {
    printJson(instructions);
    return;
  }
  console.log(`请使用微信扫描二维码完成登录（验证码 ${instructions.user_code}）：`);
  console.log(`二维码图片：${instructions.qr_code_path}`);
  console.log(`请立即运行：${instructions.poll_command.replace(" --json", "")}`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export async function startPendingDeviceLogin({
  authUrl,
  allowLocalhost,
  json,
  pendingLoginStore,
}) {
  const existing = await pendingLoginStore.load();
  if (existing && existing.expiresAt > Date.now()) {
    let qrCodePath = existing.qrCodePath;
    if (!(await fileExists(qrCodePath)) && existing.qrCodeValue) {
      qrCodePath = await createLoginQrCode(
        existing.qrCodeValue,
        existing.sessionId,
      );
      await pendingLoginStore.save({ ...existing, qrCodePath });
    }
    if (await fileExists(qrCodePath)) {
      const instructions = buildLoginInstructions(
        {
          user_code: existing.sessionId,
          verification_uri_complete: existing.qrCodeValue,
          expires_in: Math.max(
            1,
            Math.ceil((existing.expiresAt - Date.now()) / 1000),
          ),
          interval: existing.interval,
        },
        { allowLocalhost: existing.allowLocalhost, qrCodePath },
      );
      instructions.reused_session = true;
      await printOrReturnLoginInstructions(instructions, json);
      return;
    }
    throw new DeviceAuthError(
      "pending_session_unrecoverable",
      "仍有未过期的登录会话，但本地二维码文件无法恢复。请等待该会话过期后重试。",
    );
  } else if (existing) {
    await clearPendingLogin(pendingLoginStore, existing);
  }

  const client = new DeviceAuthClient({ baseUrl: authUrl });
  const start = await client.start();
  const sessionId = normalizeDeviceUserCode(start.user_code);
  const qrCodeValue =
    start.qr_code_uri ||
    start.verification_uri_complete ||
    start.verification_uri;
  const qrCodePath = await createLoginQrCode(qrCodeValue, sessionId);
  try {
    await pendingLoginStore.save(
      buildPendingLogin(
        start,
        authUrl,
        allowLocalhost,
        qrCodePath,
        qrCodeValue,
      ),
    );
  } catch (error) {
    await removeLoginQrCode(qrCodePath);
    throw error;
  }
  const instructions = buildLoginInstructions(start, {
    allowLocalhost,
    qrCodePath,
  });
  if (!json) console.log(await renderQrCode(qrCodeValue));
  await printOrReturnLoginInstructions(instructions, json);
}

async function clearPendingLogin(pendingLoginStore, pending) {
  await pendingLoginStore.clear();
  await removeLoginQrCode(pending?.qrCodePath);
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
    await clearPendingLogin(pendingLoginStore, pending);
    throw new DeviceAuthError(
      "expired_token",
      "登录会话已过期，请重新运行 shiliu login",
      400,
      { authorization_stage: "expired", expires_in: 0 },
    );
  }

  const pendingAuthUrl = validateAuthUrl(pending.authUrl, {
    allowLocalhost: pending.allowLocalhost === true,
  });
  const client = new DeviceAuthClient({ baseUrl: pendingAuthUrl });
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
      let nextPending = pending;
      const serverInterval = Number(error.details?.retry_after_seconds) || 0;
      if (error.code === "slow_down") {
        nextPending = {
          ...pending,
          interval: Math.max(pending.interval + 5, serverInterval),
        };
      } else if (serverInterval > pending.interval) {
        nextPending = { ...pending, interval: serverInterval };
      }
      if (nextPending !== pending) {
        await pendingLoginStore.save(nextPending);
      }
      const result = buildPendingPollResult(
        nextPending,
        Date.now(),
        error.code,
        error.details,
      );
      if (json) printJson(result);
      else if (error.code === "slow_down") {
        console.log(
          `轮询过快，请等待 ${nextPending.interval} 秒后再次运行同一命令。`,
        );
      } else {
        console.log(
          `登录尚未完成，请等待 ${nextPending.interval} 秒后再次运行同一命令。`,
        );
      }
      return;
    }
    if (
      error instanceof DeviceAuthError &&
      ["expired_token", "access_denied", "authorization_declined"].includes(
        error.code,
      )
    ) {
      await clearPendingLogin(pendingLoginStore, pending);
    }
    throw error;
  }

  const remote = await verifyAndPersistLogin({
    response,
    client,
    tokenStore,
    url,
  });
  await clearPendingLogin(pendingLoginStore, pending);
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
  allowLocalhost,
}) {
  if (dryRun) {
    console.log(
      `登录演练：将从 ${authUrl} 获取设备码、显示微信二维码，并把令牌保存到系统凭据库；未发起网络请求。`,
    );
    return;
  }

  if (noWait) {
    return startPendingDeviceLogin({
      authUrl,
      allowLocalhost,
      json,
      pendingLoginStore,
    });
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
  allowLocalhost = false,
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
    allowLocalhost,
  });
}

export async function logout({
  home,
  dryRun,
  authUrl,
  tokenStore,
  pendingLoginStore,
  clearLegacyApiKey = clearPersistedApiKey,
  clientFactory = (baseUrl) => new DeviceAuthClient({ baseUrl }),
}) {
  if (dryRun) {
    console.log("演练模式：未清除本机凭据。");
    return;
  }

  const current = await tokenStore.load();
  if (current?.refreshToken) {
    try {
      await clientFactory(authUrl).revoke(current.refreshToken);
    } catch (error) {
      throw new Error(
        `远端令牌撤销失败，本机凭据已保留，请稍后重试退出：${error.message}`,
      );
    }
  }

  await tokenStore.clear();
  const pending = await pendingLoginStore.load();
  await clearPendingLogin(pendingLoginStore, pending);
  await clearLegacyApiKey({ home, dryRun: false });
  console.log("已退出登录，并从系统凭据库清除令牌和旧版兼容凭据。");
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
  json,
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
    const result = printGenericInstructions(requestedAgent, { dryRun, json });
    if (json) printJson({ status: "configuration_generated", results: [result] });
    return;
  }

  const agents = requestedAgent
    ? [requestedAgent]
    : await detectInstalledAgents({ home });
  if (agents.length === 0) {
    const result = printGenericInstructions("当前客户端", { dryRun, json });
    if (json) printJson({ status: "configuration_generated", results: [result] });
    return;
  }
  const results = [];
  for (const detectedAgent of agents) {
    results.push(await configureAgent(detectedAgent, { dryRun, home }));
  }
  if (json) {
    printJson({
      status: dryRun ? "dry_run" : "configured",
      reload_required: results.some((result) => result.reload_required),
      results,
    });
    return;
  }
  console.log(
    dryRun
      ? `检查完成：将为 ${agents.join("、")} 配置 ${MCP_URL}，未写入文件。`
      : `配置已写入：${agents.join("、")}。请重启或重载客户端后运行 shiliu status。`,
  );
  for (const result of results) {
    console.log(`${result.agent} 配置位置：${result.config_path}`);
  }
}

function isNetworkError(error) {
  return (
    ["AbortError", "TimeoutError"].includes(error?.name) ||
    /fetch failed|network|timed? out|ECONN|ENOTFOUND|EAI_AGAIN/iu.test(
      `${error?.message || ""} ${error?.cause?.code || ""}`,
    )
  );
}

export function formatCliError(error) {
  const code =
    error instanceof DeviceAuthError
      ? error.code
      : isNetworkError(error)
        ? "network_error"
        : "command_failed";
  const status =
    code === "expired_token"
      ? "expired"
      : ["access_denied", "authorization_declined"].includes(code)
        ? "rejected"
        : code === "network_error"
          ? "network_error"
          : "error";
  const result = {
    status,
    error: code,
    message: error?.message || "命令执行失败",
  };
  const details = error instanceof DeviceAuthError ? error.details : {};
  if (typeof details?.authorization_stage === "string") {
    result.authorization_stage = details.authorization_stage;
  }
  if (Number.isFinite(Number(details?.retry_after_seconds))) {
    result.poll_after_seconds = Number(details.retry_after_seconds);
  }
  if (Number.isFinite(Number(details?.expires_in))) {
    result.expires_in = Number(details.expires_in);
  }
  return result;
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) return printHelp();
  if (options.version) {
    console.log(PACKAGE_VERSION);
    return;
  }

  const home = path.resolve(options.home || os.homedir());
  if (options.command === "skill") {
    await printSkillRefresh({
      home,
      force: options.force,
      json: options.json,
    });
    return;
  }
  const url = validateMcpUrl(options.url || MCP_URL, {
    allowLocalhost: options.allowLocalhost,
  });
  const authUrl = validateAuthUrl(options.authUrl || AUTH_URL, {
    allowLocalhost: options.allowLocalhost,
  });
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
      allowLocalhost: options.allowLocalhost,
      tokenStore,
      pendingLoginStore,
      noWait: options.noWait,
      json: options.json,
    });
    return;
  }
  if (options.command === "logout") {
    return logout({
      home,
      dryRun: options.dryRun,
      authUrl,
      tokenStore,
      pendingLoginStore,
    });
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
    allowLocalhost: options.allowLocalhost,
    tokenStore,
    json: options.json,
  });
}
