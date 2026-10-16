import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isUnauthorizedError, connectRecoveringRemote } from "./recovering-remote.js";
import { diagnosticSummary } from "./mcp-diagnostics.js";
import { closeBriefly, createRequestContext } from "./request-context.js";
import { readAllTools } from "./tool-catalog.js";

export const LOGIN_TOOL_NAMES = new Set(["shiliu_login", "shiliu_login_poll", "shiliu_connection_status"]);

export function connectionFailure(status, code = status === "login_required" ? "LOGIN_REQUIRED"
  : status === "credential_unavailable" ? "CREDENTIAL_UNAVAILABLE"
    : status === "checking_login" ? "LOGIN_CHECKING" : "REMOTE_UNAVAILABLE", stage = "credential_resolution") {
  return { status, code, stage, action: diagnosticSummary(code, stage).action,
    message: diagnosticSummary(code, stage).message };
}

export function createProxySession({ resolveAuth, connectRemote, url, onToolsChanged = () => {},
  reportDiagnostic = () => {}, requestOptions = {}, retryBaseMs = 1000 }) {
  let remote, token, refreshing, closing, retryTimer, catalogRefreshing, catalogRetry;
  let tools = [], status = "checking_login", diagnosticCode = "LOGIN_CHECKING", diagnosticStage = "credential_resolution";
  let closed = false, retryAt = 0, retryDelay = retryBaseMs, catalogDirty = false, catalogRetryDelay = retryBaseMs;
  const shutdown = new AbortController();
  const connections = new Set();

  function setStatus(nextStatus, nextCode, stage) {
    const changed = status !== nextStatus || diagnosticCode !== nextCode;
    status = nextStatus; diagnosticCode = nextCode; diagnosticStage = stage;
    if (changed && !closed) reportDiagnostic(nextCode, { stage });
  }
  function setTools(nextTools) {
    const changed = JSON.stringify(tools) !== JSON.stringify(nextTools);
    tools = nextTools;
    if (changed && !closed) onToolsChanged();
  }
  function retire(connection) {
    if (!connection) return;
    Promise.resolve(connection.drain()).finally(() => connections.delete(connection)).catch(() => {});
  }
  function gate(nextStatus, code, stage) {
    const previous = remote;
    remote = undefined; token = undefined;
    retire(previous);
    setStatus(nextStatus, code, stage);
    // Last successful catalog remains visible, with explicit unavailable status.
  }
  function scheduleRetry() {
    retryAt = Date.now() + retryDelay;
    retryDelay = Math.min(30000, retryDelay * 2);
    clearTimeout(retryTimer);
    if (!closed) {
      retryTimer = setTimeout(() => { void refresh({ force: false }); }, Math.max(1, retryAt - Date.now()));
      retryTimer.unref?.();
    }
  }
  function failure(error, stage, { keepHealthy = false } = {}) {
    const expired = isUnauthorizedError(error) || error?.code === "invalid_grant";
    const network = stage !== "credential_resolution" || /fetch failed/iu.test(error?.message || "") ||
      ["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNREFUSED"].includes(error?.cause?.code);
    const nextStatus = expired ? "login_required" : network ? "remote_unavailable" : "credential_unavailable";
    const code = expired ? "AUTH_EXPIRED" : network ? "REMOTE_UNAVAILABLE" : "CREDENTIAL_UNAVAILABLE";
    if (keepHealthy && !expired && remote?.healthy()) setStatus(nextStatus, code, stage);
    else gate(nextStatus, code, stage);
    scheduleRetry();
  }
  async function catalog(connection) {
    const found = await readAllTools(connection.invoke.bind(connection),
      { ...requestOptions, signal: shutdown.signal }, connection.revision);
    connection.cacheToolMetadata(found);
    return found.filter((tool) => !LOGIN_TOOL_NAMES.has(tool.name));
  }
  function refreshCatalog(connection) {
    catalogDirty = true;
    if (!catalogRefreshing) catalogRefreshing = (async () => {
      while (catalogDirty && !closed && remote === connection) {
        catalogDirty = false;
        try {
          const found = await catalog(connection);
          if (!closed && remote === connection) {
            setTools(found); catalogRetryDelay = retryBaseMs; clearTimeout(catalogRetry);
            if (diagnosticStage === "remote_catalog") setStatus("ready", "CONNECTION_READY", "remote_catalog");
          }
        } catch {
          if (!closed && remote === connection) {
            setStatus("remote_unavailable", "REMOTE_UNAVAILABLE", "remote_catalog");
            clearTimeout(catalogRetry);
            catalogRetry = setTimeout(() => { if (!closed && remote === connection) void refreshCatalog(connection); }, catalogRetryDelay);
            catalogRetry.unref?.(); catalogRetryDelay = Math.min(30000, catalogRetryDelay * 2);
          }
          break;
        }
      }
    })().finally(() => {
      catalogRefreshing = undefined;
      if (catalogDirty && !closed && remote) void refreshCatalog(remote);
    });
    return catalogRefreshing;
  }
  async function refreshOnce() {
    let authorization;
    try { authorization = await resolveAuth(); }
    catch (error) { if (!closed) failure(error, "credential_resolution"); return; }
    if (closed) return;
    if (!authorization.token) {
      gate("login_required", "LOGIN_REQUIRED", "credential_resolution");
      setTools([]); // Explicit local logout/no credentials retains the existing behavior.
      return;
    }
    if (remote?.healthy() && token === authorization.token) return;
    let candidate, firstResolve = true, stage = "remote_initialize";
    try {
      candidate = await connectRecoveringRemote({
        resolveAuthorization: async () => {
          if (firstResolve) { firstResolve = false; return authorization; }
          return resolveAuth();
        },
        connectRemote, url, requestOptions: { ...requestOptions, signal: shutdown.signal },
        onToolsChanged: () => { if (remote === candidate) void refreshCatalog(candidate); },
        onDisconnected: () => {
          if (!closed && remote === candidate) {
            gate("remote_unavailable", "REMOTE_UNAVAILABLE", "mcp_transport"); scheduleRetry();
          }
        },
      });
      connections.add(candidate);
      stage = "remote_catalog";
      const found = await catalog(candidate);
      if (closed) { await candidate.close(); connections.delete(candidate); return; }
      const previous = remote;
      remote = candidate; token = authorization.token;
      setTools(found); setStatus("ready", "CONNECTION_READY", "remote_catalog");
      retryDelay = retryBaseMs; retryAt = 0; clearTimeout(retryTimer);
      retire(previous);
    } catch (error) {
      if (candidate) { await candidate.close(); connections.delete(candidate); }
      if (!closed) failure(error, stage, { keepHealthy: true });
    }
  }
  function refresh({ force = true, afterPending = false } = {}) {
    if (closed || (!force && Date.now() < retryAt)) return Promise.resolve();
    // An explicit client check must observe credentials changed while an older
    // reconnect was pending; background polling still only joins that attempt.
    if (refreshing && afterPending) return refreshing.then(() => refresh({ force }));
    if (!refreshing) refreshing = refreshOnce().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  return {
    refresh,
    tools: () => tools,
    supports: (method) => Boolean(remote?.getServerCapabilities()?.[
      method.toLowerCase().includes("prompt") ? "prompts" : "resources"
    ]),
    snapshot: () => ({ status, mcp_connected: !closed, remote_connected: Boolean(remote?.healthy()), business_tool_count: tools.length,
      ...(status === "ready" ? { code: "CONNECTION_READY" } : connectionFailure(status, diagnosticCode, diagnosticStage)) }),
    async invoke(method, params, options = {}) {
      const context = createRequestContext({ ...requestOptions, ...options, signals: [shutdown.signal] });
      try {
        await context.run(() => refresh({ force: false }));
        if (!remote) return { unavailable: connectionFailure(status, diagnosticCode, diagnosticStage) };
        const attemptedRemote = remote;
        try {
          const result = await attemptedRemote.invoke(method, params, { ...requestOptions, ...options,
            signal: context.signal, deadline: context.deadline });
          return { result };
        } catch (error) {
          if (isUnauthorizedError(error)) {
            if (remote === attemptedRemote) {
              gate("checking_login", "LOGIN_CHECKING", "business_call");
              // Refresh for subsequent requests only. Never replay this call.
              void refresh();
            }
            return { unavailable: { ...connectionFailure("checking_login", "LOGIN_CHECKING", "business_call"),
              outcome: "unknown", message: "平台认证失败，正在重读凭据；本次远端执行结果未知，未自动重试。" } };
          }
          if (error instanceof McpError && ![ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(error.code)) throw error;
          if (error?.code === "REQUEST_CANCELLED" || error?.code === ErrorCode.RequestTimeout || context.signal.aborted) {
            return { unavailable: { ...connectionFailure("remote_unavailable", "REMOTE_UNAVAILABLE", "business_call"),
              code: error?.code === ErrorCode.RequestTimeout ? "REQUEST_TIMEOUT" : "REQUEST_CANCELLED",
              message: "请求已超时或取消，远端执行结果未知；请勿自动重试。", outcome: "unknown" } };
          }
          if (remote === attemptedRemote && !attemptedRemote.healthy()) {
            gate("remote_unavailable", "REMOTE_UNAVAILABLE", "business_call"); scheduleRetry();
          }
          return { unavailable: { ...connectionFailure("remote_unavailable", "REMOTE_UNAVAILABLE", "business_call"),
            outcome: "unknown", message: "请求未取得结果，远端执行状态未知；请勿自动重试。" } };
        }
      } finally { context.dispose(); }
    },
    async close() {
      if (closing) return closing;
      closed = true; clearTimeout(retryTimer); clearTimeout(catalogRetry); shutdown.abort();
      remote = undefined;
      closing = closeBriefly(() => Promise.allSettled([...connections].map((connection) => connection.close())));
      return closing;
    },
  };
}

export async function refreshBriefly(session, milliseconds = 1500) {
  let timer;
  try { await Promise.race([session.refresh({ afterPending: true }), new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
