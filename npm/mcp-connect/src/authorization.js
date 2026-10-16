import { AUTH_URL } from "./constants.js";
import { readPersistedApiKey } from "./credentials.js";
import {
  DeviceAuthClient,
  normalizeTokenResponse,
} from "./device-auth-client.js";
import { TokenStore } from "./token-store.js";
import { withCredentialRefreshLock } from "./credential-refresh-lock.js";

const REFRESH_WINDOW_MS = 60_000;

export async function resolveAuthorization({
  home,
  platform = process.platform,
  env = process.env,
  authUrl = AUTH_URL,
  tokenStore = new TokenStore(),
  authClient = new DeviceAuthClient({ baseUrl: authUrl }),
  now = Date.now,
  withRefreshLock = withCredentialRefreshLock,
  readOnly = false,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let tokenSet;
  try {
    tokenSet = await tokenStore.load();
  } catch (error) {
    const legacyApiKey = readPersistedApiKey({ home, platform, env })?.trim();
    if (legacyApiKey) {
      return {
        token: legacyApiKey,
        source: "legacy_api_key",
        warning: error.message,
      };
    }
    throw error;
  }
  if (tokenSet) {
    if (readOnly) return { token: tokenSet.accessToken, source: "device", expiresAt: tokenSet.expiresAt, refreshed: false };
    if (tokenStore.pendingSave) {
      return withRefreshLock(async () => {
        await tokenStore.flushPending();
        let current = await tokenStore.load();
        if (current && current.expiresAt <= now() + REFRESH_WINDOW_MS) {
          const expected = tokenStore.pendingSave?.expectedRefreshToken ?? current.refreshToken;
          current = normalizeTokenResponse(await authClient.refresh(current.refreshToken), now());
          tokenStore.retain(current, expected);
          await tokenStore.flushPending();
          current = await tokenStore.load();
        }
        return current ? { token: current.accessToken, source: "device", expiresAt: current.expiresAt, refreshed: false,
          ...(tokenStore.pendingSave ? { warning: "新令牌暂存内存，系统凭据库尚未保存成功" } : {}) } : { token: "", source: "none" };
      });
    }
    if (tokenSet.expiresAt > now() + REFRESH_WINDOW_MS) {
      return {
        token: tokenSet.accessToken,
        source: "device",
        expiresAt: tokenSet.expiresAt,
        refreshed: false,
      };
    }
    return withRefreshLock(async (assertOwned = () => {}) => {
      // Another proxy may have rotated the shared credential while this process waited.
      const latest = await tokenStore.load();
      if (!latest) return { token: "", source: "none" };
      const result = (value, refreshed) => ({
        token: value.accessToken,
        source: "device",
        expiresAt: value.expiresAt,
        refreshed,
      });
      if (latest.expiresAt > now() + REFRESH_WINDOW_MS)
        return result(latest, false);
      assertOwned();
      let refreshed;
      try {
        refreshed = normalizeTokenResponse(
          await authClient.refresh(latest.refreshToken),
          now(),
        );
      } catch (error) {
        if (error.code !== "invalid_grant") throw error;
        // Compatibility with older proxies that do not hold this lock. Never replay the spent token.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt) await sleep(300);
          const recovered = await tokenStore.load();
          if (!recovered) return { token: "", source: "none" };
          if (
            recovered.refreshToken !== latest.refreshToken &&
            recovered.accessToken &&
            recovered.expiresAt > now()
          ) {
            return result(recovered, false);
          }
        }
        throw error;
      }
      // Retain immediately: even the post-refresh read/lock check can fail.
      tokenStore.retain?.(refreshed, latest.refreshToken);
      let beforeSave;
      try {
        assertOwned();
        beforeSave = await (tokenStore.loadPersisted?.() ?? tokenStore.load());
      } catch (error) {
        if (!tokenStore.pendingSave) throw error;
        return { ...result(refreshed, true), warning: "新令牌暂存内存，系统凭据库尚未保存成功" };
      }
      if (!beforeSave) { tokenStore.discardPending?.(); return { token: "", source: "none" }; }
      if (beforeSave.refreshToken !== latest.refreshToken) {
        tokenStore.discardPending?.();
        if (beforeSave.accessToken && beforeSave.expiresAt > now())
          return result(beforeSave, false);
        throw new Error("本机登录已变化，请重试；没有覆盖新凭据");
      }
      const saved = await tokenStore.save(refreshed, { expectedRefreshToken: latest.refreshToken });
      return { ...result(refreshed, true), ...(saved?.warning ? { warning: saved.warning } : {}) };
    });
  }

  const legacyApiKey = readPersistedApiKey({ home, platform, env })?.trim();
  if (legacyApiKey) return { token: legacyApiKey, source: "legacy_api_key" };
  return { token: "", source: "none" };
}
