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
  npm install --global npm@9.9.4 || fail "npm compatibility upgrade returned a non-zero exit code."
  npm_version=$(npm --version) || fail "Unable to read the npm version after upgrade."
  npm_major=${npm_version%%.*}
  case "$npm_major" in
    ''|*[!0-9]*) fail "Unable to parse npm version after upgrade: $npm_version" ;;
  esac
  [ "$npm_major" -ge 8 ] || fail "npm upgrade did not produce a supported version: $npm_version"
fi

printf '%s\n' "Installing @bigbrain-work/mcp-connect..."
npm install --global @bigbrain-work/mcp-connect@latest --prefer-online || fail "npm installation returned a non-zero exit code."

command -v shiliu >/dev/null 2>&1 || fail "The shiliu command is not on PATH. Open a new terminal and retry."
shiliu_version=$(shiliu --version) || fail "shiliu --version returned a non-zero exit code. CLI installation could not be verified."
require_minimum_version "$shiliu_version" 1 3 7 "Shiliu AI CLI"

printf '%s\n' "CLI installed. Version: $shiliu_version"
printf '%s\n' "Continue with Step 3 (Install Skill) in https://bigbrain.work/shiliuAI/install.txt"
printf '%s\n' "This completes only the CLI installation; follow the guide for authorization, Agent configuration, and verification."
