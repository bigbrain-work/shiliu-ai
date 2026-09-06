#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "Shiliu AI CLI installation failed: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 18 or newer is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

node_major=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$node_major" -ge 18 ] || fail "Node.js 18 or newer is required."

printf '%s\n' "Installing @bigbrain-work/mcp-connect..."
npm install --global @bigbrain-work/mcp-connect

command -v shiliu >/dev/null 2>&1 || fail "The shiliu command is not on PATH. Open a new terminal and retry."
shiliu --version

printf '%s\n' "CLI installed. Next run:"
printf '%s\n' "  shiliu login"
printf '%s\n' "  shiliu install"
printf '%s\n' "  shiliu status"
