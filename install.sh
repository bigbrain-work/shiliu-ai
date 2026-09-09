#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "Shiliu AI CLI installation failed: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 18 or newer is required."
command -v npm >/dev/null 2>&1 || fail "npm was not found. Install Node.js 22 LTS from https://nodejs.org/en/download (the official installer includes npm), reopen the terminal, and rerun this command."

node_major=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$node_major" -ge 18 ] || fail "Node.js 18 or newer is required. Install Node.js 22 LTS from https://nodejs.org/en/download and rerun this command."

npm_version=$(npm --version)
npm_major=${npm_version%%.*}
case "$npm_major" in
  ''|*[!0-9]*) fail "Unable to parse npm version: $npm_version" ;;
esac
if [ "$npm_major" -lt 8 ]; then
  printf '%s\n' "npm $npm_version is too old; upgrading npm to the supported compatibility release..."
  npm install --global npm@9.9.4 || fail "npm compatibility upgrade returned a non-zero exit code."
  npm_version=$(npm --version)
  npm_major=${npm_version%%.*}
  case "$npm_major" in
    ''|*[!0-9]*) fail "Unable to parse npm version after upgrade: $npm_version" ;;
  esac
  [ "$npm_major" -ge 8 ] || fail "npm upgrade did not produce a supported version: $npm_version"
fi

printf '%s\n' "Installing @bigbrain-work/mcp-connect..."
npm install --global @bigbrain-work/mcp-connect@latest --prefer-online

command -v shiliu >/dev/null 2>&1 || fail "The shiliu command is not on PATH. Open a new terminal and retry."
shiliu --version

printf '%s\n' "CLI installed. Next run:"
printf '%s\n' "  shiliu login"
printf '%s\n' "  shiliu install"
printf '%s\n' "  shiliu status"
