import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { cancelledRequest, closeBriefly, createRequestContext } from "./request-context.js";
import { readAllTools } from "./tool-catalog.js";

export function isUnauthorizedError(error) {
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    // A downstream failure inside a JSON-RPC error is not platform auth.
    if (
      current instanceof McpError ||
      (Number.isInteger(current.code) && current.code < 0)
    ) return false;
    if (current instanceof UnauthorizedError) return true;
    if (current instanceof StreamableHTTPError) return current.code === 401;
    const status = current.status ?? current.statusCode ?? current.response?.status;
    if (status !== undefined) return status === 401;
    current = current.cause;
  }
  return false;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expiredPlatformCredentialError(cause) {
  return Object.assign(new Error(
    "石榴 AI 平台登录凭据已失效，请运行 shiliu login 重新微信扫码；这不是抖音 Cookie 失效",
    { cause },
  ), { status: 401 });
}

export async function connectRecoveringRemote({
  resolveAuthorization,
  connectRemote,
  url,
  retryDelayMs = 300,
  sleep = defaultSleep,
  onToolsChanged = () => {},
  onDisconnected = () => {},
  requestOptions = {},
}) {
  const generations = new Set();
  let remote;
  let reconnectPromise;
  let closed = false;
  let retiring = false;
  let closing;
  const reads = new Set(["listTools", "listResources", "listResourceTemplates", "listPrompts", "ping"]);

  async function closeGeneration(generation) {
    if (generation.closing) return generation.closing;
    generation.alive = false;
    generation.closing = closeBriefly(() => generation.client.close()).finally(() => {
      generations.delete(generation); generation.resolveDrained();
    });
    return generation.closing;
  }
  function drainGeneration(generation) {
    generation.draining = true;
    if (!generation.requests.size) void closeGeneration(generation);
  }

  async function connectWithCurrentAuthorization({ retryResolve = false, context } = {}) {
    let authorization;
    try {
      authorization = await context.run(resolveAuthorization);
    } catch (error) {
      if (!retryResolve) throw error;
      await context.run(() => sleep(retryDelayMs));
      authorization = await context.run(resolveAuthorization);
    }
    if (!authorization.token) {
      throw new Error("未找到登录凭据，请重新运行 shiliu login");
    }
    context.signal.throwIfAborted();
    const pending = Promise.resolve().then(() => connectRemote({ token: authorization.token, url, signal: context.signal }))
      .then(async (client) => {
        if (closed || retiring || context.signal.aborted) {
          await closeBriefly(() => client.close());
          throw cancelledRequest();
        }
        return client;
      });
    const client = await context.run(() => pending);
    const generation = { client, requests: new Set(), alive: true, draining: false };
    generation.drained = new Promise((resolve) => { generation.resolveDrained = resolve; });
    generations.add(generation);
    const previousClose = client.onclose;
    client.onclose = () => {
      try { previousClose?.(); } catch { /* Preserve transport cleanup if an observer fails. */ }
      generation.alive = false;
      if (!closed && !retiring && !generation.draining && remote === generation) onDisconnected();
    };
    client.setNotificationHandler?.(ToolListChangedNotificationSchema, () => {
      if (!closed && !retiring && !generation.draining && remote === generation) onToolsChanged();
    });
    return generation;
  }

  const initial = createRequestContext(requestOptions);
  try { remote = await connectWithCurrentAuthorization({ retryResolve: true, context: initial }); }
  finally { initial.dispose(); }

  async function reconnect(failedRemote, context) {
    if (remote !== failedRemote) return;
    if (!reconnectPromise) {
      reconnectPromise = (async () => {
        const replacement = await connectWithCurrentAuthorization({
          retryResolve: true, context,
        });
        try {
          if (replacement.client.getServerCapabilities()?.tools) {
            const tools = await readAllTools((method, params) => invokeOn(replacement, method, params, context),
              { deadline: context.deadline });
            replacement.client.cacheToolMetadata?.(tools);
          }
        } catch (error) { await closeGeneration(replacement); throw error; }
        if (closed || retiring) {
          await closeGeneration(replacement);
          throw new Error("石榴 AI MCP 连接已关闭");
        }
        remote = replacement;
        drainGeneration(failedRemote);
        onToolsChanged();
      })().finally(() => {
        reconnectPromise = undefined;
      });
    }
    await context.run(() => reconnectPromise);
  }

  async function invokeOn(generation, method, params, context) {
    context.signal.throwIfAborted();
    generation.requests.add(context);
    try {
      return await context.run(() => method === "callTool"
        ? generation.client.callTool(params, undefined, context.options())
        : generation.client[method](params, context.options()));
    } finally {
      generation.requests.delete(context);
      if (generation.draining && !generation.requests.size) void closeGeneration(generation);
    }
  }

  return {
    getServerCapabilities() {
      return remote.client.getServerCapabilities();
    },
    healthy: () => !closed && !retiring && remote.alive,
    revision: () => remote,
    cacheToolMetadata: (tools) => remote.client.cacheToolMetadata?.(tools),
    async invoke(method, params, options = {}) {
      if (closed || retiring) throw cancelledRequest();
      const context = createRequestContext({ ...requestOptions, ...options });
      const attemptedRemote = remote;
      try {
        return await invokeOn(attemptedRemote, method, params, context);
      } catch (error) {
        // A tool may already have executed, even when HTTP401 is returned.
        if (!reads.has(method) || !isUnauthorizedError(error) || context.signal.aborted) throw error;
        try {
          await reconnect(attemptedRemote, context);
          return await invokeOn(remote, method, params, context);
        } catch (retryError) {
          if (isUnauthorizedError(retryError)) {
            throw expiredPlatformCredentialError(retryError);
          }
          throw retryError;
        }
      } finally { context.dispose(); }
    },
    drain() {
      retiring = true;
      for (const generation of generations) drainGeneration(generation);
      return Promise.allSettled([...generations].map((generation) => generation.drained));
    },
    async close() {
      if (closing) return closing;
      closed = true;
      for (const generation of generations) {
        for (const context of generation.requests) context.abort();
      }
      closing = Promise.allSettled([...generations].map(closeGeneration));
      return closing;
    },
  };
}
