#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "Shiliu AI CLI installation failed: $1" >&2
  exit 1
}

require_minimum_version() {
  actual_version=$1
  minimum_major=$2
  minimum_minor=$3
  minimum_patch=$4
  product_name=$5

  version_core=${actual_version#v}
  version_core=${version_core%%[-+]*}
  previous_ifs=$IFS
  IFS=.
  set -- $version_core
  IFS=$previous_ifs
  [ "$#" -eq 3 ] || fail "Unable to parse $product_name version: $actual_version"
  case "$1:$2:$3" in
    *[!0-9:]*) fail "Unable to parse $product_name version: $actual_version" ;;
  esac
  if [ "$1" -lt "$minimum_major" ] ||
    { [ "$1" -eq "$minimum_major" ] && [ "$2" -lt "$minimum_minor" ]; } ||
    { [ "$1" -eq "$minimum_major" ] && [ "$2" -eq "$minimum_minor" ] && [ "$3" -lt "$minimum_patch" ]; }; then
    fail "$product_name $minimum_major.$minimum_minor.$minimum_patch or newer is required, but $actual_version was found."
  fi
}

npm_global_install() {
  npm_log=$(mktemp) || fail "Unable to create an installation log."
  if npm install --global "$@" >"$npm_log" 2>&1; then
    cat "$npm_log"
    rm -f "$npm_log"
  else
    cat "$npm_log" >&2
    if grep -q EACCES "$npm_log"; then
      printf '%s\n' 'Permission denied. Set a user-owned npm prefix: npm config set prefix "$HOME/.local"' 'Add "$HOME/.local/bin" to PATH in your shell profile, open a new terminal, and rerun the installer.' >&2
    fi
    rm -f "$npm_log"
    fail "npm installation returned a non-zero exit code."
  fi
}

main() {
command -v node >/dev/null 2>&1 || fail "Node.js 18.14.1 or newer is required for the CLI."
command -v npm >/dev/null 2>&1 || fail "npm was not found. Install Node.js 24 LTS from https://nodejs.org/en/download (the official installer includes npm), reopen the terminal, and rerun this command."

node_version=$(node -p "process.versions.node") || fail "Unable to read the Node.js version."
require_minimum_version "$node_version" 18 14 1 "Node.js"

npm_version=$(npm --version) || fail "Unable to read the npm version."
npm_major=${npm_version%%.*}
case "$npm_major" in
  ''|*[!0-9]*) fail "Unable to parse npm version: $npm_version" ;;
esac
if [ "$npm_major" -lt 8 ]; then
  printf '%s\n' "npm $npm_version is too old; upgrading npm to the supported compatibility release..."
  npm_global_install npm@9.9.4
  npm_version=$(npm --version) || fail "Unable to read the npm version after upgrade."
  npm_major=${npm_version%%.*}
  case "$npm_major" in
    ''|*[!0-9]*) fail "Unable to parse npm version after upgrade: $npm_version" ;;
  esac
  [ "$npm_major" -ge 8 ] || fail "npm upgrade did not produce a supported version: $npm_version"
fi

printf '%s\n' "Installing @bigbrain-work/mcp-connect..."
npm_global_install @bigbrain-work/mcp-connect@latest --prefer-online

command -v shiliu >/dev/null 2>&1 || fail "The shiliu command is not on PATH. Open a new terminal and retry."
shiliu_version=$(shiliu --version) || fail "shiliu --version returned a non-zero exit code. CLI installation could not be verified."
require_minimum_version "$shiliu_version" 1 4 1 "Shiliu AI CLI"

# Existing stdio bridge users keep their original update verification; nothing is reconfigured.
if shiliu install --dry-run --json 2>/dev/null | grep -q '"legacy_stdio_present": *true'; then
  printf '%s\n' "Existing stdio bridge detected and preserved. Verifying the actual npx MCP launch (initialize + tools/list)..."
  shiliu doctor --transport stdio --standard-only --prepare --json || fail "CLI launch verification failed. Repair the identified Shiliu npx entry before reconnecting; do not clear credentials."
  printf '%s\n' "CLI installed. Version: $shiliu_version"
  printf '%s\n' "Verified only this terminal runtime. If the Agent bundles another Node/npm, verify its launch configuration with doctor --launch-file and --node-path before enabling MCP."
  printf '%s\n' "Your existing connection and login are unchanged. Continue with https://bigbrain.work/shiliuAI/install-stdio.txt; for failures use https://bigbrain.work/shiliuAI/recovery.txt"
  return 0
fi

printf '%s\n' "Verifying optional CLI remote configuration without login or keyring access..."
shiliu install --agent codex --transport http --dry-run --json || fail "Optional CLI verification failed. Existing remote MCP use is unaffected; do not clear credentials."
printf '%s\n' "CLI installed. Version: $shiliu_version"
printf '%s\n' "Only the optional developer CLI was installed; remote MCP uses independent client OAuth."
printf '%s\n' "Follow https://bigbrain.work/shiliuAI/install.txt; never repeat login after native MCP balance succeeds."
}

main "$@"
