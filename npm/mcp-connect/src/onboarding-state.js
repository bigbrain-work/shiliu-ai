// Public, deterministic orchestration contract. Observations must come from actual
// native MCP calls, not CLI success, generated configuration, or a tool count guess.
export function onboardingState({ mcp = "not_configured", nativeBalance = false,
  toolList = false, charged = null, consumedCredits = null, cli = "pending", skill = "pending", failure = null,
  apiKeyConsent = false, httpBalance = false } = {}) {
  const optionalFailures = [skill === "failed" ? "Skill" : null, cli === "failed" ? "CLI" : null].filter(Boolean);
  const optionalNotice = optionalFailures.length ? `${optionalFailures.join(" / ")} 安装未成功，但不影响正常使用。` : null;
  const nativeReady = mcp === "connected" && nativeBalance && toolList && charged === false && consumedCredits === 0;
  if (nativeReady) return { state: "mcp_ready", installed: true, next: "finish", api_key_allowed: false,
    message: "安装已完成，可以正常使用。", optional_notice: optionalNotice };
  if (["awaiting_reload", "authorizing", "cancelled"].includes(mcp)) return { state: mcp, installed: false,
    next: mcp === "awaiting_reload" ? "reconnect_mcp" : mcp === "cancelled" ? "await_user_authorization" : "complete_browser_authorization",
    api_key_allowed: false };
  if (mcp === "failed" && ["client_unsupported", "configuration_failed", "connection_failed"].includes(failure)) {
    if (!apiKeyConsent) return { state: "http_consent_required", installed: false, next: "open_http_consent_page", api_key_allowed: false };
    if (httpBalance && charged === false && consumedCredits === 0) return { state: "http_ready", installed: true, next: "finish", api_key_allowed: true,
      message: "安装已完成，可以通过 HTTP 正常使用；当前客户端的 MCP 连接尚未完成。", optional_notice: optionalNotice };
    return { state: "http_verification_required", installed: false, next: "store_credential_and_verify_http_balance", api_key_allowed: true };
  }
  return { state: mcp === "connected" ? "native_verification_required" : "mcp_setup_required",
    installed: false, next: mcp === "connected" ? "list_tools_and_query_native_balance" : "configure_remote_mcp",
    api_key_allowed: false };
}
