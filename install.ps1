$ErrorActionPreference = 'Stop'

function Stop-Install([string] $Message) {
  throw "Shiliu AI CLI installation failed: $Message"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-Install 'Node.js 18 or newer is required.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Stop-Install 'npm is required.'
}

$nodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($nodeMajor -lt 18) {
  Stop-Install 'Node.js 18 or newer is required.'
}

Write-Host 'Installing @bigbrain-work/mcp-connect...'
& npm install --global '@bigbrain-work/mcp-connect'
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
