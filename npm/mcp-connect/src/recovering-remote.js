const UNAUTHORIZED_MESSAGE = /(?:\b401\b|unauthori[sz]ed|token[^\n]*(?:expired|invalid))/iu;

export function isUnauthorizedError(error) {
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (
      current.status === 401 ||
      current.statusCode === 401 ||
      current.response?.status === 401 ||
      current.code === 401 ||
      current.code === "401"
    ) {
      return true;
    }
    if (UNAUTHORIZED_MESSAGE.test(String(current.message || ""))) return true;
    current = current.cause;
  }
  return false;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expiredPlatformCredentialError(cause) {
  return new Error(
    "石榴 AI 平台登录凭据已失效，请运行 shiliu login 重新微信扫码；这不是抖音 Cookie 失效",
    { cause },
  );
}

export async function connectRecoveringRemote({
  resolveAuthorization,
  connectRemote,
  url,
  retryDelayMs = 300,
  sleep = defaultSleep,
}) {
  async function connectWithCurrentAuthorization({ retryResolve = false } = {}) {
    let authorization;
    try {
      authorization = await resolveAuthorization();
    } catch (error) {
      if (!retryResolve) throw error;
      await sleep(retryDelayMs);
      authorization = await resolveAuthorization();
    }
    if (!authorization.token) {
      throw new Error("未找到登录凭据，请重新运行 shiliu login");
    }
    return connectRemote({ token: authorization.token, url });
  }

  let remote = await connectWithCurrentAuthorization({ retryResolve: true });
  let reconnectPromise;
  let closed = false;

  async function reconnect(failedRemote) {
    if (remote !== failedRemote) return;
    if (!reconnectPromise) {
      reconnectPromise = (async () => {
        const replacement = await connectWithCurrentAuthorization({
          retryResolve: true,
        });
        if (closed) {
          await replacement.close();
          throw new Error("石榴 AI MCP 连接已关闭");
        }
        remote = replacement;
        await failedRemote.close().catch(() => {});
      })().finally(() => {
        reconnectPromise = undefined;
      });
    }
    await reconnectPromise;
  }

  return {
    getServerCapabilities() {
      return remote.getServerCapabilities();
    },
    async invoke(method, params) {
      const attemptedRemote = remote;
      try {
        return await attemptedRemote[method](params);
      } catch (error) {
        if (!isUnauthorizedError(error)) throw error;
        try {
          await reconnect(attemptedRemote);
          return await remote[method](params);
        } catch (retryError) {
          if (isUnauthorizedError(retryError)) {
            throw expiredPlatformCredentialError(retryError);
          }
          throw retryError;
        }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await reconnectPromise?.catch(() => {});
      await remote.close();
    },
  };
}
