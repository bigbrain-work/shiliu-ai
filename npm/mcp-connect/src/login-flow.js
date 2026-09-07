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
    const validationError = new Error(`登录令牌验证失败：${remote.detail}`);
    try {
      await client.revoke(tokenSet.refreshToken);
    } catch (revokeError) {
      throw new AggregateError(
        [validationError, revokeError],
        `登录令牌验证失败，且远端令牌撤销失败：${remote.detail}`,
      );
    }
    throw validationError;
  }
  try {
    await tokenStore.save(tokenSet);
  } catch (error) {
    try {
      await client.revoke(tokenSet.refreshToken);
    } catch (revokeError) {
      throw new AggregateError(
        [error, revokeError],
        `本机凭据保存失败，且远端令牌撤销失败：${error.message}`,
      );
    }
    throw error;
  }
  return remote;
}
