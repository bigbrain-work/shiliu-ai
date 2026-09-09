$ErrorActionPreference = 'Stop'

function Stop-Install([string] $Message) {
  throw "Shiliu AI CLI installation failed: $Message"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-Install 'Node.js 18 or newer is required.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Stop-Install 'npm was not found. Install Node.js 22 LTS from https://nodejs.org/en/download (the official installer includes npm), reopen the terminal, and rerun this command.'
}

$nodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($nodeMajor -lt 18) {
  Stop-Install 'Node.js 18 or newer is required. Install Node.js 22 LTS from https://nodejs.org/en/download and rerun this command.'
}

$npmVersion = ((& npm --version) | Out-String).Trim()
$npmMajor = 0
if (-not [int]::TryParse($npmVersion.Split('.')[0], [ref]$npmMajor)) {
  Stop-Install "Unable to parse npm version: $npmVersion"
}
if ($npmMajor -lt 8) {
  Write-Host "npm $npmVersion is too old; upgrading npm to the supported compatibility release..."
  & npm install --global 'npm@9.9.4'
  if ($LASTEXITCODE -ne 0) {
    Stop-Install 'npm compatibility upgrade returned a non-zero exit code.'
  }
  $npmVersion = ((& npm --version) | Out-String).Trim()
  $npmMajor = 0
  if (
    -not [int]::TryParse($npmVersion.Split('.')[0], [ref]$npmMajor) -or
    $npmMajor -lt 8
  ) {
    Stop-Install "npm upgrade did not produce a supported version: $npmVersion"
  }
}

Write-Host 'Installing @bigbrain-work/mcp-connect...'
& npm install --global '@bigbrain-work/mcp-connect@latest' --prefer-online
if ($LASTEXITCODE -ne 0) {
  Stop-Install 'npm installation returned a non-zero exit code.'
}

if (-not (Get-Command shiliu -ErrorAction SilentlyContinue)) {
  Stop-Install 'The shiliu command is not on PATH. Open a new terminal and retry.'
}
& shiliu --version

Write-Host 'CLI installed. Next run:'
Write-Host '  shiliu login'
Write-Host '  shiliu install'
Write-Host '  shiliu status'
