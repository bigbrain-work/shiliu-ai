import { AUTH_URL } from "./constants.js";
import { readPersistedApiKey } from "./credentials.js";
import {
  DeviceAuthClient,
  normalizeTokenResponse,
} from "./device-auth-client.js";
import { TokenStore } from "./token-store.js";

const REFRESH_WINDOW_MS = 60_000;

export async function resolveAuthorization({
  home,
  platform = process.platform,
  env = process.env,
  authUrl = AUTH_URL,
  tokenStore = new TokenStore(),
  authClient = new DeviceAuthClient({ baseUrl: authUrl }),
  now = Date.now,
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
    const refreshed = normalizeTokenResponse(
      await authClient.refresh(tokenSet.refreshToken),
      now(),
    );
    await tokenStore.save(refreshed);
    return {
      token: refreshed.accessToken,
      source: "device",
      expiresAt: refreshed.expiresAt,
      refreshed: true,
    };
  }

  const legacyApiKey = readPersistedApiKey({ home, platform, env })?.trim();
  if (legacyApiKey) return { token: legacyApiKey, source: "legacy_api_key" };
  return { token: "", source: "none" };
}
