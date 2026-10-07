import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema,
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveAuthorization } from "./authorization.js";
import { AUTH_URL, PACKAGE_VERSION } from "./constants.js";
import { connectRemote } from "./remote-client.js";
import { createProxySession, refreshBriefly } from "./proxy-session.js";
import { runProxyLogin, loginToolResult, safeLoginResult } from "./proxy-login.js";
import { createDiagnosticReporter } from "./mcp-diagnostics.js";

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
export const LOGIN_TOOLS = [
  {
    name: "shiliu_login", title: "微信扫码登录石榴 AI",
    description: "未登录也可调用。生成或复用微信登录二维码；展示图片后按间隔调用 shiliu_login_poll，不等待用户回复。凭据只保存在本机系统凭据库。",
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "shiliu_login_poll", title: "检查微信扫码登录进度",
    description: "按二维码返回的 poll_after_seconds 间隔短轮询。成功后自动接入远程业务工具；不要提交访问令牌或设备码。",
    inputSchema: { type: "object", properties: { session: { type: "string", pattern: "^[A-Z0-9-]{4,64}$", description: "shiliu_login 返回的 login_session_id" } }, required: ["session"], additionalProperties: false },
  },
  {
    name: "shiliu_connection_status", title: "检查石榴 AI 登录与连接状态",
    description: "检查本机登录状态并尝试连接远程服务。MCP 连接正常不代表已登录；不返回任何凭据。也可在外部 shiliu login 完成后调用以刷新工具。",
    inputSchema: EMPTY_SCHEMA, annotations: { readOnlyHint: true },
  },
];

function textResult(payload, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError };
}

export async function runProxy({
  home, url, authUrl = AUTH_URL, platform = process.platform, env = process.env,
  tokenStore, transport = new StdioServerTransport(),
  resolveAuth = () => resolveAuthorization({ home, platform, env, authUrl, tokenStore }),
  remoteConnector = connectRemote, loginRunner = runProxyLogin,
  pollIntervalMs = 5000, allowLocalhost = false,
  diagnosticReporter = createDiagnosticReporter({ home }),
} = {}) {
  const server = new Server(
    { name: "shiliu-ai-mcp-proxy", version: PACKAGE_VERSION },
    {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      instructions: "MCP 可以先连接再登录。未登录时调用 shiliu_login 展示二维码，再按间隔调用 shiliu_login_poll。登录后刷新 tools/list；业务工具需要登录，凭据只保存在本机，勿索取或输出凭据。",
    },
  );
  let initialized = false;
  let closing = false;
  let interval;
  const session = createProxySession({
    url, resolveAuth, connectRemote: remoteConnector,
    reportDiagnostic: (code, options) => { void diagnosticReporter.record(code, options); },
    onToolsChanged: () => {
      if (initialized && !closing) void server.sendToolListChanged().catch(() => {});
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refreshBriefly(session);
    return { tools: [...LOGIN_TOOLS, ...session.tools()] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    if (LOGIN_TOOLS.some((tool) => tool.name === name)) {
      if (Object.keys(args).some((key) => name !== "shiliu_login_poll" || key !== "session")) {
        throw new McpError(ErrorCode.InvalidParams, "登录工具不接受凭据或额外参数");
      }
      if (name === "shiliu_connection_status") {
        await refreshBriefly(session);
        return textResult({ ...session.snapshot(), diagnostic_path: diagnosticReporter.path, diagnostic_log_available: diagnosticReporter.available() });
      }
      if (name === "shiliu_login_poll" && (typeof args.session !== "string" || !/^[A-Z0-9-]{4,64}$/u.test(args.session))) {
        throw new McpError(ErrorCode.InvalidParams, "登录会话编号格式无效");
      }
      const rawPayload = await loginRunner(name === "shiliu_login" ? "start" : "poll", {
        session: args.session, home, url, authUrl, env, allowLocalhost, signal: extra.signal,
      });
      const payload = safeLoginResult(rawPayload, rawPayload.status !== "error");
      if (payload.status === "success") await refreshBriefly(session);
      return loginToolResult(payload);
    }
    const response = await session.invoke("callTool", request.params);
    return response.unavailable ? textResult(response.unavailable, true) : response.result;
  });

  for (const [schema, method, empty] of [
    [ListResourcesRequestSchema, "listResources", { resources: [] }],
    [ListResourceTemplatesRequestSchema, "listResourceTemplates", { resourceTemplates: [] }],
    [ListPromptsRequestSchema, "listPrompts", { prompts: [] }],
  ]) {
    server.setRequestHandler(schema, async (request) => {
      await refreshBriefly(session);
      const response = session.supports(method) ? await session.invoke(method, request.params) : {};
      return response.result || empty;
    });
  }
  for (const [schema, method] of [[ReadResourceRequestSchema, "readResource"], [GetPromptRequestSchema, "getPrompt"]]) {
    server.setRequestHandler(schema, async (request) => {
      await session.refresh();
      if (session.snapshot().remote_connected && !session.supports(method)) {
        throw new McpError(ErrorCode.MethodNotFound, "远程服务未提供此功能");
      }
      const response = await session.invoke(method, request.params);
      if (response.unavailable) throw new McpError(ErrorCode.InternalError, response.unavailable.message);
      return response.result;
    });
  }

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(interval);
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await Promise.allSettled([server.close(), session.close()]);
    await diagnosticReporter.record("CONNECTION_CLOSED", { stage: "mcp_shutdown" });
  };
  server.onclose = shutdown;
  server.onerror = () => { void diagnosticReporter.record("PROTOCOL_ERROR", { stage: "mcp_transport" }); };
  server.oninitialized = () => {
    initialized = true;
    void session.refresh();
    if (pollIntervalMs > 0) {
      interval = setInterval(() => { void session.refresh(); }, pollIntervalMs);
      interval.unref();
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try { await server.connect(transport); }
  catch (error) { await shutdown(); throw error; }
  return { server, session, close: shutdown };
}
