// Keep argument error formatting available before loading optional CLI dependencies.
export function isNetworkError(error) {
  const seen = new Set();
  for (let depth = 0; error && depth < 8 && !seen.has(error); depth++, error = error.cause) {
    seen.add(error);
    if (["AbortError", "TimeoutError", "NetworkError"].includes(error.name) ||
        /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/u.test(error.code || "")) return true;
  }
  return false;
}

export function formatCliErrorPayload(error, deviceAuth = false, argumentError = false) {
  const code =
    argumentError ? "command_failed" : deviceAuth
      ? error.code
      : isNetworkError(error)
        ? "network_error"
        : "command_failed";
  const status =
    code === "expired_token"
      ? "expired"
      : ["access_denied", "authorization_declined"].includes(code)
        ? "rejected"
        : code === "network_error"
          ? "network_error"
          : "error";
  const result = {
    status,
    error: code,
    message: error?.message || "命令执行失败",
  };
  const details = deviceAuth ? error.details : {};
  if (typeof details?.authorization_stage === "string") {
    result.authorization_stage = details.authorization_stage;
  }
  if (Number.isFinite(Number(details?.retry_after_seconds))) {
    result.poll_after_seconds = Number(details.retry_after_seconds);
  }
  if (Number.isFinite(Number(details?.expires_in))) {
    result.expires_in = Number(details.expires_in);
  }
  return result;
}

