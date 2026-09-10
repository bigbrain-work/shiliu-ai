$ErrorActionPreference = 'Stop'

function Stop-Install([string] $Message) {
  throw "Shiliu AI CLI installation failed: $Message"
}

function Resolve-NativeCommand([string[]] $Names, [string] $MissingMessage) {
  foreach ($name in $Names) {
    $commands = @(Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue)
    if ($commands.Count -gt 0) {
      return $commands[0].Source
    }
  }
  Stop-Install $MissingMessage
}

function Invoke-NativeVersion([string] $Command, [string[]] $Arguments, [string] $FailureMessage) {
  $output = @(& $Command @Arguments)
  $exitCode = $LASTEXITCODE
  if ($null -eq $exitCode -or $exitCode -ne 0) {
    Stop-Install $FailureMessage
  }
  return (($output | Out-String).Trim())
}

function Install-ShiliuPackage([string] $NpmCommand) {
  # Windows PowerShell 5.1 can treat redirected native stderr as an error.
  # Capture npm output and decide success from the native exit code.
  $previousErrorActionPreference = $ErrorActionPreference
  $exitCode = $null
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $NpmCommand install --global '@bigbrain-work/mcp-connect@latest' --prefer-online 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -eq $exitCode) {
    Stop-Install 'npm did not return an exit code. Check that npm can run in this terminal.'
  }
  $output | ForEach-Object { Write-Host $_ }
  return @{
    ExitCode = $exitCode
    Output = ($output | Out-String)
  }
}

function Stop-RunningShiliuMcp {
  $processes = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -match '(?i)@bigbrain-work[\\/]mcp-connect' -and
        $_.CommandLine.TrimEnd() -match '(?i)\smcp$'
      }
  )
  if ($processes.Count -eq 0) {
    return
  }
  Write-Host "Temporarily stopping $($processes.Count) running Shiliu MCP process(es) so Windows can replace the credential-store module..."
  $processes |
    Sort-Object ProcessId -Descending |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$nodeCommand = Resolve-NativeCommand @('node.exe', 'node') 'Node.js 18 or newer is required.'
$npmCommand = Resolve-NativeCommand @('npm.cmd', 'npm') 'npm was not found. Install Node.js 22 LTS from https://nodejs.org/en/download (the official installer includes npm), reopen the terminal, and rerun this command.'

$nodeMajorText = Invoke-NativeVersion $nodeCommand @('-p', "Number(process.versions.node.split('.')[0])") 'Unable to read the Node.js version.'
$nodeMajor = 0
if (-not [int]::TryParse($nodeMajorText, [ref] $nodeMajor) -or $nodeMajor -lt 18) {
  Stop-Install 'Node.js 18 or newer is required. Install Node.js 22 LTS from https://nodejs.org/en/download and rerun this command.'
}

$npmVersion = Invoke-NativeVersion $npmCommand @('--version') 'Unable to read the npm version.'
$npmMajor = 0
if (-not [int]::TryParse($npmVersion.Split('.')[0], [ref] $npmMajor)) {
  Stop-Install "Unable to parse npm version: $npmVersion"
}
if ($npmMajor -lt 8) {
  Write-Host "npm $npmVersion is too old; upgrading npm to the supported compatibility release..."
  & $npmCommand install --global 'npm@9.9.4'
  $npmUpgradeExitCode = $LASTEXITCODE
  if ($null -eq $npmUpgradeExitCode -or $npmUpgradeExitCode -ne 0) {
    Stop-Install 'npm compatibility upgrade returned a non-zero exit code.'
  }
  $npmVersion = Invoke-NativeVersion $npmCommand @('--version') 'Unable to read the npm version after upgrade.'
  $npmMajor = 0
  if (
    -not [int]::TryParse($npmVersion.Split('.')[0], [ref] $npmMajor) -or
    $npmMajor -lt 8
  ) {
    Stop-Install "npm upgrade did not produce a supported version: $npmVersion"
  }
}

Write-Host 'Installing @bigbrain-work/mcp-connect...'
$install = Install-ShiliuPackage $npmCommand
if ($install.ExitCode -ne 0 -and $install.Output -match '(?i)\b(EBUSY|EPERM)\b') {
  Stop-RunningShiliuMcp
  Start-Sleep -Seconds 1
  Write-Host 'Retrying the Shiliu AI CLI installation once after releasing Windows file locks...'
  $install = Install-ShiliuPackage $npmCommand
}
if ($install.ExitCode -ne 0) {
  Stop-Install 'npm installation returned a non-zero exit code.'
}

$shiliuCommand = Resolve-NativeCommand @('shiliu.cmd', 'shiliu') 'The shiliu command is not on PATH. Open a new terminal and retry.'
$shiliuVersion = Invoke-NativeVersion $shiliuCommand @('--version') 'shiliu --version returned a non-zero exit code. CLI installation could not be verified.'

Write-Host "CLI installed. Version: $shiliuVersion"
Write-Host 'Continue with Step 3 (Install Skill) in https://bigbrain.work/shiliuAI/install.txt'
Write-Host 'This completes only the CLI installation; follow the guide for authorization, Agent configuration, and verification.'
