#!/usr/bin/env sh
# Mocked scenarios for connect-mcp.sh. Fake codex/claude/curl/sleep run from a private temp
# directory; no real client, network, credential or browser is used.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/connect-mcp.sh"
SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/shiliu-connect-sh-test.XXXXXX")
FIX="$SANDBOX/fixture"
BIN="$SANDBOX/bin"
OFFICIAL='https://api.bigbrain.work/shiliu/mcp'
KEY='sk-fixture-key-123'
mkdir -p "$FIX" "$BIN"

cat > "$BIN/codex" <<'EOF'
#!/usr/bin/env sh
F=$SHILIU_TEST_FIX
echo "$*" >> "$F/calls"
case "$2" in
  get)
    [ "$(cat "$F/exists")" = 1 ] || exit 1
    printf '{\n  "name": "shiliu_mcp",\n  "enabled": true,\n  "transport": {\n    "type": "%s",\n    "url": "%s",\n    "bearer_token_env_var": null,\n    "http_headers": %s,\n    "env_http_headers": null\n  }\n}\n' \
      "$(cat "$F/transport")" "$(cat "$F/url")" "$(cat "$F/headers")" ;;
  list)
    printf '[\n  {\n    "name": "other",\n    "auth_status": "o_auth"\n  },\n  {\n    "name": "shiliu_mcp",\n    "auth_status": "%s"\n  }\n]\n' "$(cat "$F/auth")" ;;
  add) echo 1 > "$F/exists"; printf '%s' "$5" > "$F/url"; echo fixture-private-output; exit "$(cat "$F/add_exit")" ;;
  login) echo fixture-private-output; exit "$(cat "$F/login_exit")" ;;
  *) exit 99 ;;
esac
EOF

cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env sh
F=$SHILIU_TEST_FIX
echo "claude $*" >> "$F/calls"
case "$2" in
  get)
    [ "$(cat "$F/exists")" = 1 ] || exit 1
    printf 'shiliu_mcp:\n  Scope: User config (available in all your projects)\n  Type: %s\n  URL: %s\n' "$(cat "$F/claude_type")" "$(cat "$F/url")" ;;
  add|remove) echo fixture-private-output ;;
  *) exit 99 ;;
esac
EOF

cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env sh
F=$SHILIU_TEST_FIX
config=$(cat)
url=$(printf '%s\n' "$config" | sed -n 's/^url = "\(.*\)"$/\1/p')
data=$(printf '%s\n' "$config" | sed -n 's/^data-binary = "\(.*\)"$/\1/p' | sed 's/\\"/"/g')
echo "$url" >> "$F/http"
case "$url" in
  */oauth/http-fallback)
    case "$data" in *'"mcp_failure":"oauth_failed"'*) ;; *) exit 22 ;; esac
    printf '{"request_id":"rid_fixture","authorization_url":"%s","expires_in":600}' "$(cat "$F/consent")" ;;
  */oauth/http-fallback/token)
    polls=$(($(cat "$F/polls") + 1)); echo "$polls" > "$F/polls"
    if [ "$polls" -le 2 ]; then printf '{"error":"authorization_pending"}'
    elif [ -s "$F/token_error" ]; then printf '{"error":"%s"}' "$(cat "$F/token_error")"
    else printf '{"api_key":"%s"}' "$SHILIU_TEST_KEY"; fi ;;
  "https://api.bigbrain.work/shiliu/mcp/k/$SHILIU_TEST_KEY")
    case "$data" in
      *tools/list*) printf '{"result":{"tools":[{"name":"%s"}]}}' "$(cat "$F/balance_tool")" ;;
      *) printf '{"result":{"isError":false,"structuredContent":{"billing":{"charged":false,"consumed_credits":0}}}}' ;;
    esac ;;
  *) exit 22 ;;
esac
EOF

printf '#!/usr/bin/env sh\nexit 0\n' > "$BIN/sleep"
chmod +x "$BIN/codex" "$BIN/claude" "$BIN/curl" "$BIN/sleep"

PASSED=0
FAILED=0
REPORT=''
run_case() { # client, options...
  for name in calls http; do : > "$FIX/$name"; done
  echo 0 > "$FIX/exists"; printf '%s' "$OFFICIAL" > "$FIX/url"; echo streamable_http > "$FIX/transport"
  echo null > "$FIX/headers"; echo not_logged_in > "$FIX/auth"; echo 0 > "$FIX/add_exit"; echo 0 > "$FIX/login_exit"
  echo http > "$FIX/claude_type"; echo get_account_balance > "$FIX/balance_tool"
  echo 'https://bigbrain.work/shiliuai/agent-authorize?request=rid_fixture' > "$FIX/consent"
  echo 0 > "$FIX/polls"; : > "$FIX/token_error"
  client=$1; shift
  args=''
  for option in "$@"; do
    case "$option" in
      --*) args="$args $option" ;;
      *=*) printf '%s' "${option#*=}" > "$FIX/${option%%=*}" ;;
    esac
  done
  path="$BIN:$PATH"
  [ "$client" = claude-no-cli ] && client=claude && path="$BIN-none:$PATH"
  # shellcheck disable=SC2086
  REPORT=$(PATH="$path" SHILIU_TEST_FIX="$FIX" SHILIU_TEST_KEY="$KEY" CODEX_HOME="$SANDBOX/codex-home" HOME="$SANDBOX" \
    sh "$HELPER" --client "$client" $args 2>/dev/null)
}
check() { # name, condition
  if eval "$2"; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); echo "FAIL: $1 | $REPORT" >&2; fi
}
state_is() { case "$REPORT" in *"\"state\":\"$1\""*) return 0 ;; esac; return 1; }
count() { grep -c "$1" "$FIX/$2" 2>/dev/null || true; }
clean() { case "$REPORT" in *fixture-private-output*|*"$KEY"*) return 1 ;; esac; return 0; }

# OAuth path. Codex reports a stored OAuth login as "o_auth".
run_case codex
check 'new remote opens login' 'state_is awaiting_reload && [ "$(count "mcp login" calls)" = 1 ] && clean'
run_case codex auth=o_auth
check 'add already authorized' 'state_is awaiting_reload && [ "$(count "mcp login" calls)" = 0 ]'
run_case codex exists=1
check 'existing preserved' 'state_is existing_installation && [ "$(count "mcp add" calls)" = 0 ]'
run_case codex exists=1 transport=stdio --authorize-existing-remote
check 'existing stdio refuses OAuth' 'state_is existing_installation && [ "$(count "mcp login" calls)" = 0 ]'
run_case codex exists=1 --authorize-existing-remote
check 'existing remote reauth' 'state_is awaiting_reload && [ "$(count "mcp login" calls)" = 1 ]'
run_case codex exists=1 url=https://example.com/mcp --authorize-existing-remote
check 'other endpoint preserved' 'state_is existing_installation'
run_case codex exists=1 'headers={"Authorization":"fixture"}' --authorize-existing-remote
check 'API key entry preserved' 'state_is existing_installation'
run_case codex auth=surprise
check 'unknown auth no blind login' 'state_is authorization_required && [ "$(count "mcp login" calls)" = 0 ]'
run_case codex auth=unsupported
check 'discovery failure goes to personal URL' 'state_is oauth_failed && case "$REPORT" in *oauth_discovery*use_personal_url*|*use_personal_url*oauth_discovery*) true ;; *) false ;; esac'
run_case codex login_exit=1
check 'login error no retry' 'state_is oauth_failed && [ "$(count "mcp login" calls)" = 1 ] && clean'
run_case codex add_exit=1
check 'add error after save no repeat' 'state_is oauth_failed && [ "$(count "mcp add" calls)" = 1 ]'
for client in workbuddy doubao; do
  run_case "$client"
  check "$client connector guidance" 'state_is configuration_generated && case "$REPORT" in *"fallback_url_template\":\"$OFFICIAL/k/"*) true ;; *) false ;; esac && case "$REPORT" in *"\"transport\":\"http\""*) false ;; *) true ;; esac'
done
run_case workbuddy
check 'WorkBuddy client_config uses streamableHttp' 'case "$REPORT" in *"\"shiliu_mcp\":{\"type\":\"streamableHttp\",\"url\":\"$OFFICIAL\"}"*) true ;; *) false ;; esac'
run_case doubao
check 'Doubao ui_form fields' 'case "$REPORT" in *"\"ui_form\":{\"name\":\"shiliu_mcp\",\"transport\":\"HTTP\",\"url\":\"$OFFICIAL\""*) true ;; *) false ;; esac'

# Personal URL path.
# Every personal-URL case first receives two authorization_pending polls.
run_case codex --use-personal-url
check 'personal URL for new Codex entry' 'state_is awaiting_reload && [ "$(cat "$FIX/url")" = "$OFFICIAL/k/$KEY" ] && clean && [ "$(grep -c token "$FIX/http")" = 3 ]'
run_case codex token_error=access_denied --use-personal-url
check 'personal URL denied on website' 'state_is personal_url_incomplete && case "$REPORT" in *"\"oauth_error\":\"access_denied\""*) true ;; *) false ;; esac && [ "$(count "mcp add" calls)" = 0 ]'
run_case codex exists=1 --use-personal-url
check 'personal URL replaces failed OAuth entry' 'state_is awaiting_reload && case "$REPORT" in *"\"replaced_entry\":true"*) true ;; *) false ;; esac'
run_case codex exists=1 "url=$OFFICIAL/k/sk-old" --use-personal-url
check 'personal URL replaces reset personal URL' 'state_is awaiting_reload && [ "$(cat "$FIX/url")" = "$OFFICIAL/k/$KEY" ]'
run_case codex exists=1 transport=stdio --use-personal-url
check 'personal URL keeps stdio bridge' 'state_is existing_installation && [ ! -s "$FIX/http" ]'
run_case codex exists=1 url=https://example.com/mcp --use-personal-url
check 'personal URL keeps custom entry' 'state_is existing_installation && [ "$(count "mcp add" calls)" = 0 ]'
run_case codex balance_tool=other --use-personal-url
check 'personal URL not written when verification fails' 'state_is personal_url_incomplete && [ "$(count "mcp add" calls)" = 0 ]'
run_case codex consent=https://evil.example/shiliuai/agent-authorize?request=x --use-personal-url
check 'personal URL rejects foreign consent page' 'state_is personal_url_incomplete && [ "$(grep -c token "$FIX/http")" = 0 ]'
run_case claude exists=1 --use-personal-url
check 'personal URL for Claude Code replaces user entry' 'state_is awaiting_reload && [ "$(count "mcp remove shiliu_mcp --scope user" calls)" = 1 ] && clean'
run_case claude exists=1 claude_type=stdio --use-personal-url
check 'personal URL keeps Claude stdio' 'state_is existing_installation && [ "$(count "mcp add" calls)" = 0 ]'
run_case workbuddy --use-personal-url
check 'personal URL without CLI is user-filled' 'state_is configuration_generated && [ ! -s "$FIX/http" ] && case "$REPORT" in *"\"client_config\":{\"mcpServers\":{\"shiliu_mcp\":{\"type\":\"streamableHttp\",\"url\":\"$OFFICIAL/k/"*) true ;; *) false ;; esac'

# Only files this harness created inside its own mktemp directory are removed.
case "$SANDBOX" in */shiliu-connect-sh-test.*) rm -rf -- "$SANDBOX" ;; esac
if [ "$FAILED" -ne 0 ]; then echo "FAILED: $FAILED of $((PASSED + FAILED)) mocked cases" >&2; exit 1; fi
echo "PASS: $PASSED mocked onboarding cases; no real client, network, credentials or browser used."
