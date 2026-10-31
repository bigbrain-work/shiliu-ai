#!/usr/bin/env sh
# Shiliu AI fixed MCP onboarding helper for macOS/Linux. Mirrors connect-mcp.ps1.
# stdout carries only one JSON report; progress and client output go to stderr.
# Requires sh, curl and openssl (for --use-personal-url). Never prints credentials.
set -u

API='https://api.bigbrain.work/shiliu'
ENDPOINT="$API/mcp"
PERSONAL_PREFIX="$ENDPOINT/k/"
PERSONAL_TEMPLATE="$PERSONAL_PREFIX<官网账户页的 API Key>"
CLIENT=''
AUTHORIZE_EXISTING=0
USE_PERSONAL=0

usage() {
  printf '%s\n' 'Usage: connect-mcp.sh --client codex|claude|cursor|workbuddy|doubao [--authorize-existing-remote | --use-personal-url]' >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --client) [ "$#" -ge 2 ] || usage; CLIENT=$2; shift 2 ;;
    --authorize-existing-remote) AUTHORIZE_EXISTING=1; shift ;;
    --use-personal-url) USE_PERSONAL=1; shift ;;
    *) usage ;;
  esac
done
case "$CLIENT" in codex|claude|cursor|workbuddy|doubao) ;; *) usage ;; esac

notice() { printf '%s\n' "$1" >&2; }

# Client-specific configuration in the client's own field names (JSON members, no braces). Report
# fields such as transport describe the connection and must not be copied into a client config
# (WorkBuddy needs type=streamableHttp, verified 2026-10-31).
client_template() { # url
  case "$CLIENT" in
    workbuddy) printf '"client_config":{"mcpServers":{"shiliu_mcp":{"type":"streamableHttp","url":"%s"}}}' "$1" ;;
    cursor) printf '"client_config":{"mcpServers":{"shiliu_mcp":{"url":"%s"}}}' "$1" ;;
    doubao) printf '"ui_form":{"name":"shiliu_mcp","transport":"HTTP","url":"%s","custom_headers":"留空"}' "$1" ;;
    *) printf '"server_name":"shiliu_mcp","transport":"http","url":"%s"' "$1" ;;
  esac
}

# All report values are fixed strings or validated identifiers, so no JSON escaping is needed.
emit() { printf '%s\n' "$1"; }

configuration_failed() {
  emit '{"state":"configuration_failed","next_action":"inspect_existing_entry_or_use_client_settings","message":"自动配置未完成。先检查是否已存在石榴 MCP 条目，不要重装或生成临时脚本。"}'
  exit 1
}

preserved_entry() {
  emit '{"state":"existing_installation","next_action":"verify_existing_connection_or_follow_recovery","message":"已存在的石榴 MCP 条目不是官方远程地址或专属地址（例如 stdio 桥接或自定义配置），已保留，未做修改。按 recovery.txt 处理，不要改为专属地址。"}'
  exit 0
}

oauth_failed() { # stage, message, exit code
  emit "{\"state\":\"oauth_failed\",\"next_action\":\"use_personal_url\",\"stage\":\"$1\",\"request_path_known\":false,\"client_exit_code\":$3,\"fallback_command\":\"connect-mcp.sh --client $CLIENT --use-personal-url\",\"message\":\"$2\"}"
}

PROGRAM=''
if command -v "$CLIENT" >/dev/null 2>&1; then PROGRAM=$(command -v "$CLIENT"); fi

# An existing shiliu_mcp entry (stdio bridge or remote) is a working installation: never replace it.
# codex mcp add silently overwrites a same-name entry, so this check must run before any add.
existing_entry() {
  case "$CLIENT" in workbuddy|doubao) return 1 ;; esac
  if [ -n "$PROGRAM" ] && [ "$CLIENT" != cursor ]; then
    "$PROGRAM" mcp get shiliu_mcp >/dev/null 2>&1 && return 0
  fi
  case "$CLIENT" in
    codex) grep -Eq '^[[:space:]]*\[mcp_servers\.("shiliu_mcp"|shiliu_mcp)\]' "${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null ;;
    claude) grep -Eq '"shiliu_mcp"[[:space:]]*:' "$HOME/.claude.json" 2>/dev/null ;;
    cursor) grep -Eq '"shiliu_mcp"[[:space:]]*:' "$HOME/.cursor/mcp.json" 2>/dev/null ;;
  esac
}

# Codex reports a stored OAuth login as "o_auth". Reads the pretty-printed list JSON.
codex_auth_status() {
  listing=$("$PROGRAM" mcp list --json 2>/dev/null) || { echo unknown; return; }
  status=$(printf '%s\n' "$listing" | awk '
    /^    "name": / { name = $0; sub(/^    "name": "/, "", name); sub(/",?[[:space:]]*$/, "", name) }
    /^    "auth_status": / && name == "shiliu_mcp" { s = $0; sub(/^    "auth_status": "/, "", s); sub(/",?[[:space:]]*$/, "", s); print s; exit }')
  case "$status" in
    o_auth|oauth) echo oauth ;;
    not_logged_in|unsupported) echo "$status" ;;
    *) echo unknown ;;
  esac
}

# Only the official remote entry (and, with "personal", a personal URL) may be re-authorized or
# replaced; a stdio bridge, custom URL or header/API-key entry is the user's own setup.
codex_official_remote() { # [personal]
  entry=$("$PROGRAM" mcp get shiliu_mcp --json 2>/dev/null | tr -d ' \t\r\n') || return 1
  case "$entry" in *'"type":"streamable_http"'*) ;; *) return 1 ;; esac
  case "$entry" in *'"enabled":false'*) return 1 ;; esac
  for field in bearer_token_env_var http_headers env_http_headers; do
    case "$entry" in *"\"$field\":null"*) ;; *) return 1 ;; esac
  done
  case "$entry" in *"\"url\":\"$ENDPOINT\""*) return 0 ;; esac
  if [ "${1:-}" = personal ]; then
    case "$entry" in *"\"url\":\"$PERSONAL_PREFIX"*) return 0 ;; esac
  fi
  return 1
}

start_codex_authorization() {
  auth=$(codex_auth_status)
  case "$auth" in
    unsupported)
      oauth_failed oauth_discovery 'Codex 未能从石榴服务发现 OAuth 授权（客户端判定不支持）。不要反复授权或去设置里点认证；告知用户后改用专属地址：运行 fallback_command，用户只需在石榴网页上确认一次。' null
      return ;;
    unknown)
      emit '{"state":"authorization_required","next_action":"inspect_client_auth_status","stage":"oauth_status","message":"无法确认客户端认证状态，未重复启动授权。请检查当前客户端的登录提示，不要重装或获取 API Key。"}'
      return ;;
    not_logged_in)
      notice '正在通过 Codex 打开石榴 AI 网页授权，请在浏览器中登录并确认。浏览器没有打开时，使用下面 Codex 给出的完整链接。'
      "$PROGRAM" mcp login shiliu_mcp 1>&2
      code=$?
      if [ "$code" -ne 0 ]; then
        oauth_failed client_oauth 'Codex 网页授权未完成。用户主动取消时先询问是否继续，不要自动切换；出现错误或用户已同意仍失败时，不要重复授权，告知用户后改用专属地址（运行 fallback_command）。' "$code"
        return
      fi ;;
  esac
  emit '{"state":"awaiting_reload","next_action":"verify_native_tools_or_reconnect","message":"Codex 已有 OAuth 登录或网页授权命令已完成。先验证当前 Agent 的原生工具和免费余额；仅在未加载时重连，无需再去设置里重复认证。"}'
}

# Claude Code: replace only a user-scope HTTP entry that points at the official or a personal URL.
claude_entry_kind() {
  text=$("$PROGRAM" mcp get shiliu_mcp 2>/dev/null) || { echo none; return; }
  if printf '%s\n' "$text" | grep -Eq '^[[:space:]]*Scope:[[:space:]]*User' &&
     printf '%s\n' "$text" | grep -Eq '^[[:space:]]*Type:[[:space:]]*http[[:space:]]*$' &&
     printf '%s\n' "$text" | grep -Fq "URL: $ENDPOINT" &&
     ! printf '%s\n' "$text" | grep -Eq '^[[:space:]]*Headers?:'; then
    echo replaceable
  else
    echo preserve
  fi
}

json_string() { # json, field
  printf '%s' "$1" | tr -d '\r\n' | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# URL (may contain the key) and body (may contain the PKCE verifier) go through a curl config on
# stdin, never through command-line arguments visible to other local processes.
post_json() { # url, body
  escaped=$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf 'url = "%s"\ndata-binary = "%s"\n' "$1" "$escaped" | curl -sS --max-time 30 -K - \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream'
}

# Same consented handoff as connect-http.ps1: the user approves on the Shiliu website and the PKCE
# verifier never leaves this process. The key is kept in a variable and never printed.
request_api_key() { # client name
  verifier=$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')
  challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '=' | tr '+/' '-_')
  [ -n "$verifier" ] && [ -n "$challenge" ] || return 1
  start=$(post_json "$API/oauth/http-fallback" "{\"client_name\":\"$1\",\"code_challenge\":\"$challenge\",\"mcp_failure\":\"oauth_failed\"}") || return 1
  authorize=$(json_string "$start" authorization_url)
  request_id=$(json_string "$start" request_id)
  case "$authorize" in
    https://bigbrain.work/shiliuai/agent-authorize\?*|https://www.bigbrain.work/shiliuai/agent-authorize\?*) ;;
    *) return 1 ;;
  esac
  case "$authorize$request_id" in *[!A-Za-z0-9:/?=._-]*) return 1 ;; esac
  if [ "$(uname -s)" = Darwin ]; then open "$authorize" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$authorize" >/dev/null 2>&1 &
  fi
  notice '已尝试打开石榴 AI 页面。请登录并确认允许本次 Agent 使用专属连接地址。'
  notice "浏览器没有打开时，请手动打开：$authorize"
  attempts=0
  while [ "$attempts" -lt 200 ]; do # 200 x 3 seconds = the 600-second request lifetime
    attempts=$((attempts + 1))
    sleep 3
    claim=$(post_json "$API/oauth/http-fallback/token" "{\"request_id\":\"$request_id\",\"code_verifier\":\"$verifier\"}") || return 1
    API_KEY=$(json_string "$claim" api_key)
    case "$API_KEY" in
      sk*) case "$API_KEY" in *[!A-Za-z0-9-]*) API_KEY=''; return 1 ;; esac; return 0 ;;
    esac
    LAST_OAUTH_ERROR=$(json_string "$claim" error)
    case "$LAST_OAUTH_ERROR" in *[!a-z_]*) LAST_OAUTH_ERROR='' ;; esac
    [ "$LAST_OAUTH_ERROR" = authorization_pending ] || return 1
  done
  return 1
}

# Verify the personal URL itself before writing any client configuration.
verify_personal_url() { # url
  listing=$(post_json "$1" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}') || return 1
  case "$listing" in *'"get_account_balance"'*) ;; *) return 1 ;; esac
  balance=$(post_json "$1" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_account_balance","arguments":{}}}' | tr -d ' \t\r\n') || return 1
  case "$balance" in *'"isError":true'*|*'"error":{'*) return 1 ;; esac
  case "$balance" in *'"charged":false'*) ;; *) return 1 ;; esac
  case "$balance" in *'"consumed_credits":0,'*|*'"consumed_credits":0}'*) return 0 ;; esac
  return 1
}

personal_incomplete() { # phase, configuration_changed
  emit "{\"state\":\"personal_url_incomplete\",\"phase\":\"$1\",\"connection\":\"personal_url\",\"configuration_changed\":$2,\"oauth_error\":\"${LAST_OAUTH_ERROR:-}\",\"message\":\"专属地址接入未完成。authorization 阶段：access_denied 为用户拒绝，expired_request 为确认页超时，其他情况为用户未确认或网络错误；verification 阶段说明地址验证失败，未写入任何配置。不要重置 API Key，也不要反复重试。\"}"
  API_KEY=''
  exit 1
}

personal_url_setup() {
  if [ -z "$PROGRAM" ] || { [ "$CLIENT" != codex ] && [ "$CLIENT" != claude ]; }; then
    # No CLI: the user pastes the address into the client. Never collect the key in chat.
    emit "{\"state\":\"configuration_generated\",\"next_action\":\"user_fills_personal_url\",\"connection\":\"personal_url\",\"url_template\":\"$PERSONAL_TEMPLATE\",$(client_template "$PERSONAL_TEMPLATE"),\"message\":\"请用户本人在石榴官网账户页复制 API Key，把已有石榴条目的地址改为 url_template（把尖括号部分换成 API Key），字段名按 client_config/ui_form，请求头留空，替换原地址而不是再加一条，保存后告诉你已完成。不要让用户把 API Key 发到对话里。完成后用原生工具免费查询余额验证。\"}"
    exit 0
  fi
  command -v curl >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1 || personal_incomplete prerequisites false
  replace=false
  if [ "$CLIENT" = codex ]; then
    if existing_entry; then codex_official_remote personal || preserved_entry; replace=true; fi
    name=Codex
  else
    case "$(claude_entry_kind)" in
      preserve) preserved_entry ;;
      replaceable) replace=true ;;
    esac
    name='Claude Code'
  fi
  API_KEY=''
  request_api_key "$name" || personal_incomplete authorization false
  verify_personal_url "$PERSONAL_PREFIX$API_KEY" || personal_incomplete verification false
  if [ "$CLIENT" = codex ]; then
    # add replaces the same-name entry; its output is not shown because it may echo the URL.
    "$PROGRAM" mcp add shiliu_mcp --url "$PERSONAL_PREFIX$API_KEY" >/dev/null 2>&1 || personal_incomplete configuration false
  else
    if [ "$replace" = true ]; then
      "$PROGRAM" mcp remove shiliu_mcp --scope user >/dev/null 2>&1 || personal_incomplete configuration false
    fi
    "$PROGRAM" mcp add --transport http --scope user shiliu_mcp "$PERSONAL_PREFIX$API_KEY" >/dev/null 2>&1 || personal_incomplete configuration "$replace"
  fi
  API_KEY=''
  # Shell profiles are not edited: GUI apps do not read them. The local editing plugin needs
  # SHILIU_AI_API_KEY separately until it can bill through the MCP connection itself.
  emit "{\"state\":\"awaiting_reload\",\"next_action\":\"reconnect_then_verify_native_tools\",\"connection\":\"personal_url\",\"replaced_entry\":$replace,\"editing_credential\":\"not_configured\",\"charged\":false,\"message\":\"已改用专属地址连接，并已用它免费查询余额验证可用。请让客户端重连石榴连接或新开对话，再用原生工具免费查询余额。专属地址等同密码，不要输出、截图或分享。\"}"
  exit 0
}

if [ "$AUTHORIZE_EXISTING" = 1 ] && [ "$CLIENT" != codex ]; then configuration_failed; fi
if [ "$AUTHORIZE_EXISTING" = 1 ] && [ "$USE_PERSONAL" = 1 ]; then configuration_failed; fi
if [ "$USE_PERSONAL" = 1 ]; then personal_url_setup; fi

if existing_entry; then
  if [ "$AUTHORIZE_EXISTING" = 1 ] && [ -n "$PROGRAM" ] && codex_official_remote; then
    start_codex_authorization
    exit 0
  fi
  emit '{"state":"existing_installation","next_action":"verify_existing_connection_or_follow_recovery","message":"已存在石榴 MCP 配置，已保留，未做修改。请直接用原生 MCP 免费查询余额；连接异常按 recovery.txt 排查，不要重装或改为其他连接方式。"}'
  exit 0
fi
[ "$AUTHORIZE_EXISTING" = 1 ] && configuration_failed

if [ "$CLIENT" = codex ] && [ -n "$PROGRAM" ]; then
  notice '正在添加石榴 MCP。部分 Codex 版本会在添加时直接打开网页授权，请在浏览器中确认。'
  "$PROGRAM" mcp add shiliu_mcp --url "$ENDPOINT" 1>&2
  code=$?
  if [ "$code" -ne 0 ]; then
    # Some Codex versions start OAuth inside add, after saving the entry.
    if existing_entry; then
      oauth_failed client_add '连接配置已保存，但添加命令未完成，通常是添加时的自动授权失败。不要重复添加或授权；用户主动取消时先询问是否继续，否则告知用户后改用专属地址（运行 fallback_command）。' "$code"
      exit 0
    fi
    configuration_failed
  fi
  start_codex_authorization
elif [ "$CLIENT" = claude ] && [ -n "$PROGRAM" ]; then
  "$PROGRAM" mcp add --transport http --scope user shiliu_mcp "$ENDPOINT" 1>&2 || configuration_failed
  emit '{"state":"awaiting_reload","next_action":"reconnect_then_browser_oauth","fallback_command":"connect-mcp.sh --client claude --use-personal-url","message":"重连后在 /mcp 中完成石榴网页授权。授权失败时不要反复尝试，改用 fallback_command。"}'
elif [ "$CLIENT" = workbuddy ] || [ "$CLIENT" = doubao ]; then
  if [ "$CLIENT" = workbuddy ]; then
    instruction='使用 WorkBuddy 的连接器安装/连接操作，或把 client_config 合并进用户级 mcp.json（保留其他条目，字段名以 client_config 为准）。如出现安装确认或“连接”，请用户只确认该提示，随后由客户端打开网页授权。'
  else
    instruction='适用于具备自定义连接器的豆包电脑版：请用户在豆包界面添加自定义连接器并按 ui_form 填写，入口以用户实际看到的为准，不要编造菜单路径。如提示“连接器需要授权”，请用户点击“去授权”。'
  fi
  emit "{\"state\":\"configuration_generated\",\"next_action\":\"use_client_connector_action\",\"authentication\":\"oauth\",\"fallback_url_template\":\"$PERSONAL_TEMPLATE\",$(client_template "$ENDPOINT"),\"message\":\"$instruction 没有授权入口、保存后只显示失败或 401、或网页授权失败时，不要反复尝试，也不要让用户点不存在的按钮：请用户本人在官网账户页复制 API Key，把同一条目的地址改为 fallback_url_template；不要让用户把 Key 发到对话里。\"}"
else
  # Desktop clients do not necessarily ship a CLI on PATH. This is not a runtime failure.
  emit "{\"state\":\"configuration_generated\",\"next_action\":\"use_documented_client_mcp_settings\",\"authentication\":\"oauth\",\"fallback_url_template\":\"$PERSONAL_TEMPLATE\",$(client_template "$ENDPOINT"),\"message\":\"用客户端自己的字段名添加以上远程连接（有 client_config 时照它填写），再按客户端提示授权。无需安装 Node/npm。没有授权入口或授权失败时改用 fallback_url_template，由用户本人填入 API Key。\"}"
fi
