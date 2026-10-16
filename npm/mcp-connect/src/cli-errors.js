// Keep argument error formatting available before loading optional CLI dependencies.
function isNetworkError(error) {
  return (
    ["AbortError", "TimeoutError"].includes(error?.name) ||
    /fetch failed|network|timed? out|ECONN|ENOTFOUND|EAI_AGAIN/iu.test(
      `${error?.message || ""} ${error?.cause?.code || ""}`,
    )
  );
}

export function formatCliErrorPayload(error, deviceAuth = false) {
  const code =
    deviceAuth
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

