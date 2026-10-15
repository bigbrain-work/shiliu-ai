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
      assertOwned();
      const beforeSave = await tokenStore.load();
      if (!beforeSave) return { token: "", source: "none" };
      if (beforeSave.refreshToken !== latest.refreshToken) {
        if (beforeSave.accessToken && beforeSave.expiresAt > now())
          return result(beforeSave, false);
        throw new Error("本机登录已变化，请重试；没有覆盖新凭据");
      }
      await tokenStore.save(refreshed);
      return result(refreshed, true);
    });
  }

  const legacyApiKey = readPersistedApiKey({ home, platform, env })?.trim();
  if (legacyApiKey) return { token: legacyApiKey, source: "legacy_api_key" };
  return { token: "", source: "none" };
}
