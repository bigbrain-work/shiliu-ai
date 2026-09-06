import { normalizeTokenResponse } from "./device-auth-client.js";
import { probeMcp } from "./status.js";

export async function verifyAndPersistLogin({
  response,
  client,
  tokenStore,
  url,
  probe = probeMcp,
}) {
  const tokenSet = normalizeTokenResponse(response);
  const remote = await probe(tokenSet.accessToken, { url });
  if (!remote.ok) {
    await client.revoke(tokenSet.refreshToken).catch(() => undefined);
    throw new Error(`登录令牌验证失败：${remote.detail}`);
  }
  try {
    await tokenStore.save(tokenSet);
  } catch (error) {
    await client.revoke(tokenSet.refreshToken).catch(() => undefined);
    throw error;
  }
  return remote;
}
