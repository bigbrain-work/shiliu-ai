import { isUnauthorizedError, connectRecoveringRemote } from "./recovering-remote.js";
import { diagnosticSummary } from "./mcp-diagnostics.js";

export const LOGIN_TOOL_NAMES = new Set(["shiliu_login", "shiliu_login_poll", "shiliu_connection_status"]);

export function connectionFailure(status, code = status === "login_required" ? "LOGIN_REQUIRED"
  : status === "credential_unavailable" ? "CREDENTIAL_UNAVAILABLE"
    : status === "checking_login" ? "LOGIN_CHECKING" : "REMOTE_UNAVAILABLE", stage = "credential_resolution") {
  return {
    status, code, stage,
    action: diagnosticSummary(code, stage).action,
    message: diagnosticSummary(code, stage).message,
  };
}

async function readCatalog(remote) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const result = await remote.invoke("listTools", cursor ? { cursor } : undefined);
    tools.push(...(result.tools || []).filter((tool) => !LOGIN_TOOL_NAMES.has(tool.name)));
    if (!result.nextCursor) return tools;
    if (cursors.has(result.nextCursor)) throw new Error("Repeated tool cursor");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Too many tool catalog pages");
}

// Credentials and remote I/O are deferred until after local initialize.
export function createProxySession({ resolveAuth, connectRemote, url, onToolsChanged = () => {}, reportDiagnostic = () => {} }) {
  let remote;
  let token;
  let tools = [];
  let status = "checking_login";
  let diagnosticCode = "LOGIN_CHECKING";
  let diagnosticStage = "credential_resolution";
  let refreshing;
  let closed = false;

  function replace(nextRemote, nextToken, nextTools, nextStatus, nextCode, nextStage) {
    const oldRemote = remote;
    const changed = JSON.stringify(tools) !== JSON.stringify(nextTools);
    const reportChanged = status !== nextStatus || diagnosticCode !== nextCode;
    remote = nextRemote;
    token = nextToken;
    tools = nextTools;
    status = nextStatus;
    diagnosticCode = nextCode;
    diagnosticStage = nextStage;
    if (reportChanged) reportDiagnostic(nextCode, { stage: nextStage });
    if (oldRemote && oldRemote !== nextRemote) void oldRemote.close().catch(() => {});
    if (changed && !closed) onToolsChanged();
  }

  async function refreshOnce() {
    let authorization;
    try { authorization = await resolveAuth(); }
    catch (error) {
      const expired = isUnauthorizedError(error) || error.code === "invalid_grant";
      const network = /fetch failed/iu.test(error.message || "") || ["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNREFUSED"].includes(error.cause?.code);
      if (!closed) replace(undefined, undefined, [], expired ? "login_required" : network ? "remote_unavailable" : "credential_unavailable",
        expired ? "AUTH_EXPIRED" : network ? "REMOTE_UNAVAILABLE" : "CREDENTIAL_UNAVAILABLE", "credential_resolution");
      return;
    }
    if (closed) return;
    if (!authorization.token) { replace(undefined, undefined, [], "login_required", "LOGIN_REQUIRED", "credential_resolution"); return; }
    if (remote && token === authorization.token) return;
    let candidate;
    let stage = "remote_initialize";
    try {
      let firstResolve = true;
      candidate = await connectRecoveringRemote({
        resolveAuthorization: async () => {
          if (firstResolve) { firstResolve = false; return authorization; }
          return resolveAuth();
        },
        connectRemote, url,
      });
      stage = "remote_catalog";
      const catalog = await readCatalog(candidate);
      if (closed) { await candidate.close(); return; }
      replace(candidate, authorization.token, catalog, "ready", "CONNECTION_READY", "remote_catalog");
    } catch (error) {
      await candidate?.close().catch(() => {});
      const expired = isUnauthorizedError(error);
      if (!closed) replace(undefined, undefined, [], expired ? "login_required" : "remote_unavailable", expired ? "AUTH_EXPIRED" : "REMOTE_UNAVAILABLE", stage);
    }
  }

  function refresh() {
    if (closed) return Promise.resolve();
    if (!refreshing) refreshing = refreshOnce().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  return {
    refresh,
    tools: () => tools,
    supports: (method) => Boolean(remote?.getServerCapabilities()?.[
      method.toLowerCase().includes("prompt") ? "prompts" : "resources"
    ]),
    snapshot: () => ({
      status, mcp_connected: !closed, remote_connected: Boolean(remote), business_tool_count: tools.length,
      ...(status === "ready" ? { code: "CONNECTION_READY" } : connectionFailure(status, diagnosticCode, diagnosticStage)),
    }),
    async invoke(method, params) {
      await refresh();
      if (!remote) return { unavailable: connectionFailure(status, diagnosticCode, diagnosticStage) };
      const attemptedRemote = remote;
      try { return { result: await attemptedRemote.invoke(method, params) }; }
      catch (error) {
        if (error.code === -32601 || error.code === -32602) throw error;
        const nextStatus = isUnauthorizedError(error) || /登录凭据已失效/u.test(error.message || "")
          ? "login_required" : "remote_unavailable";
        const nextCode = nextStatus === "login_required" ? "AUTH_EXPIRED" : "REMOTE_UNAVAILABLE";
        if (remote === attemptedRemote) replace(undefined, undefined, [], nextStatus, nextCode, "business_call");
        return { unavailable: connectionFailure(nextStatus, nextCode, "business_call") };
      }
    },
    async close() {
      closed = true;
      const current = remote;
      remote = undefined;
      await current?.close();
      // An in-flight connection closes itself when it completes.
    },
  };
}

export async function refreshBriefly(session, milliseconds = 1500) {
  let timer;
  try {
    await Promise.race([session.refresh(), new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); })]);
  } finally { clearTimeout(timer); }
}
