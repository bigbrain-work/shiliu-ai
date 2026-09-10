$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $repositoryRoot 'install.ps1'
$windowsPowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$powerShellPath = if (Test-Path -LiteralPath $windowsPowerShellPath) {
  $windowsPowerShellPath
} else {
  (Get-Process -Id $PID).Path
}
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$sandbox = Join-Path $temporaryRoot "shiliu-installer-test-$PID"
$originalPath = $env:PATH
$originalState = $env:SHILIU_INSTALL_TEST_STATE
$originalLog = $env:SHILIU_INSTALL_TEST_LOG

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Write-FakeCommand(
  [string] $Directory,
  [string] $Name,
  [string] $Content
) {
  Set-Content -LiteralPath (Join-Path $Directory "$Name.cmd") -Value $Content -Encoding Ascii
}

function Invoke-InstallerCase(
  [string] $Name,
  [string] $NodeScript,
  [string] $NpmScript,
  [string] $ShiliuScript = ''
) {
  $caseDirectory = Join-Path $sandbox $Name
  [void](New-Item -ItemType Directory -Path $caseDirectory -Force)

  if ($NodeScript) {
    Write-FakeCommand $caseDirectory 'node' $NodeScript
  }
  if ($NpmScript) {
    Write-FakeCommand $caseDirectory 'npm' $NpmScript
  }
  if ($ShiliuScript) {
    Write-FakeCommand $caseDirectory 'shiliu' $ShiliuScript
  }

  $env:PATH = $caseDirectory
  $env:SHILIU_INSTALL_TEST_STATE = Join-Path $caseDirectory 'npm-upgraded.txt'
  $env:SHILIU_INSTALL_TEST_LOG = Join-Path $caseDirectory 'npm.log'
  $runnerPath = Join-Path $caseDirectory 'run-installer.ps1'
  $escapedInstallerPath = $installerPath.Replace("'", "''")
  $runner = @"
`$ErrorActionPreference = 'Stop'
function global:Get-CimInstance { return @() }
try {
  & '$escapedInstallerPath'
  exit 0
} catch {
  Write-Error `$_.Exception.Message
  exit 1
}
"@
  Set-Content -LiteralPath $runnerPath -Value $runner -Encoding UTF8
  # Expected failure cases write to stderr. Do not let the parent PowerShell
  # promote that native stderr stream into a terminating test-harness error.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $powerShellPath -NoLogo -NoProfile -NonInteractive -File $runnerPath 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  return @{
    ExitCode = $exitCode
    Output = $output
    LogPath = $env:SHILIU_INSTALL_TEST_LOG
  }
}

$node22 = @'
@echo off
echo 22.20.0
exit /b 0
'@

$nodeTooOld = @'
@echo off
echo 18.13.0
exit /b 0
'@

$npmCurrent = @'
@echo off
if "%~1"=="--version" (
  echo 11.5.1
  exit /b 0
)
echo %*>>"%SHILIU_INSTALL_TEST_LOG%"
exit /b 0
'@

$npmOldThenUpgraded = @'
@echo off
if "%~1"=="--version" (
  if exist "%SHILIU_INSTALL_TEST_STATE%" (
    echo 9.9.4
  ) else (
    echo 7.24.2
  )
  exit /b 0
)
echo %*>>"%SHILIU_INSTALL_TEST_LOG%"
echo upgraded>"%SHILIU_INSTALL_TEST_STATE%"
exit /b 0
'@

$npmBusyOnce = @'
@echo off
if "%~1"=="--version" (
  echo 11.5.1
  exit /b 0
)
echo %*>>"%SHILIU_INSTALL_TEST_LOG%"
if not exist "%SHILIU_INSTALL_TEST_STATE%" (
  echo attempted>"%SHILIU_INSTALL_TEST_STATE%"
  echo npm error code EBUSY 1>&2
  exit /b 1
)
exit /b 0
'@

$npmEpermWarningOnce = @'
@echo off
if "%~1"=="--version" (
  echo 11.5.1
  exit /b 0
)
echo %*>>"%SHILIU_INSTALL_TEST_LOG%"
if not exist "%SHILIU_INSTALL_TEST_STATE%" (
  echo attempted>"%SHILIU_INSTALL_TEST_STATE%"
  echo npm warn cleanup EPERM
)
exit /b 0
'@

$shiliuSuccess = @'
@echo off
echo 9.9.9-test
exit /b 0
'@

$shiliuFailure = @'
@echo off
echo version failed 1>&2
exit /b 1
'@

$shiliuTooOld = @'
@echo off
echo 1.3.6
exit /b 0
'@

$shiliuUnparseable = @'
@echo off
echo unknown
exit /b 0
'@

try {
  [void](New-Item -ItemType Directory -Path $sandbox -Force)

  $missingNode = Invoke-InstallerCase 'missing-node' '' ''
  Assert-True ($missingNode.ExitCode -ne 0) 'Missing Node.js must fail.'
  Assert-True ($missingNode.Output -match 'Node\.js 18\.14\.1 or newer') "Missing Node.js must return actionable guidance. Output: $($missingNode.Output)"

  $tooOldNode = Invoke-InstallerCase 'old-node' $nodeTooOld $npmCurrent $shiliuSuccess
  Assert-True ($tooOldNode.ExitCode -ne 0) 'Node.js below 18.14.1 must fail.'
  Assert-True ($tooOldNode.Output -match 'Node\.js 18\.14\.1 or newer') "An old Node.js runtime must return actionable version guidance. Output: $($tooOldNode.Output)"

  $missingNpm = Invoke-InstallerCase 'missing-npm' $node22 ''
  Assert-True ($missingNpm.ExitCode -ne 0) 'Missing npm must fail.'
  # Error-record formatting differs between Windows PowerShell 5.1 and pwsh 7
  # and can inject line wrapping or ANSI sequences between surrounding words.
  Assert-True ($missingNpm.Output -match 'includes npm') "Missing npm must explain that the Node.js installer includes npm. Output: $($missingNpm.Output)"

  $oldNpm = Invoke-InstallerCase 'old-npm' $node22 $npmOldThenUpgraded $shiliuSuccess
  Assert-True ($oldNpm.ExitCode -eq 0) "Old npm upgrade path failed: $($oldNpm.Output)"
  $oldNpmLog = Get-Content -LiteralPath $oldNpm.LogPath -Raw
  Assert-True ($oldNpmLog -match 'npm@9\.9\.4') 'Old npm path must install the compatibility release.'
  Assert-True ($oldNpmLog -match '@bigbrain-work/mcp-connect@latest --prefer-online') 'Old npm path must install the online latest CLI after upgrading.'

  $currentNpm = Invoke-InstallerCase 'current-npm' $node22 $npmCurrent $shiliuSuccess
  Assert-True ($currentNpm.ExitCode -eq 0) "Current npm path failed: $($currentNpm.Output)"
  $currentNpmLog = Get-Content -LiteralPath $currentNpm.LogPath -Raw
  Assert-True ($currentNpmLog -notmatch 'npm@9\.9\.4') 'Current npm must not be downgraded to the compatibility release.'
  Assert-True ($currentNpmLog -match '@bigbrain-work/mcp-connect@latest --prefer-online') 'Current npm path must install the online latest CLI.'

  $busyNpm = Invoke-InstallerCase 'busy-npm' $node22 $npmBusyOnce $shiliuSuccess
  Assert-True ($busyNpm.ExitCode -eq 0) "Busy npm retry path failed: $($busyNpm.Output)"
  $busyNpmLog = Get-Content -LiteralPath $busyNpm.LogPath -Raw
  $installAttempts = [regex]::Matches(
    $busyNpmLog,
    '@bigbrain-work/mcp-connect@latest --prefer-online'
  ).Count
  Assert-True ($installAttempts -eq 2) 'EBUSY must trigger exactly one installation retry.'
  Assert-True ($busyNpm.Output -match 'Retrying the Shiliu AI CLI installation once') 'EBUSY retry must be visible to the user.'

  $warningNpm = Invoke-InstallerCase 'eperm-warning' $node22 $npmEpermWarningOnce $shiliuSuccess
  Assert-True ($warningNpm.ExitCode -eq 0) "EPERM warning retry path failed: $($warningNpm.Output)"
  $warningNpmLog = Get-Content -LiteralPath $warningNpm.LogPath -Raw
  $warningAttempts = [regex]::Matches(
    $warningNpmLog,
    '@bigbrain-work/mcp-connect@latest --prefer-online'
  ).Count
  Assert-True ($warningAttempts -eq 1) 'A successful npm install with an EPERM warning must not stop MCP or retry.'

  $versionFailure = Invoke-InstallerCase 'version-failure' $node22 $npmCurrent $shiliuFailure
  Assert-True ($versionFailure.ExitCode -ne 0) 'A failed shiliu --version check must fail installation.'
  Assert-True ($versionFailure.Output -notmatch 'CLI installed') 'A failed version check must not report installation success.'

  $oldCli = Invoke-InstallerCase 'old-cli' $node22 $npmCurrent $shiliuTooOld
  Assert-True ($oldCli.ExitCode -ne 0) 'A Shiliu CLI version below 1.3.7 must fail installation.'
  Assert-True ($oldCli.Output -match '1\.3\.7 or newer') "An old CLI must return actionable version guidance. Output: $($oldCli.Output)"
  Assert-True ($oldCli.Output -notmatch 'CLI installed') 'An old CLI must not report installation success.'

  $unparseableCli = Invoke-InstallerCase 'unparseable-cli' $node22 $npmCurrent $shiliuUnparseable
  Assert-True ($unparseableCli.ExitCode -ne 0) 'An unparseable Shiliu CLI version must fail installation.'
  Assert-True ($unparseableCli.Output -match 'Unable to parse Shiliu AI CLI version') "An unparseable CLI version must report the parsing problem. Output: $($unparseableCli.Output)"

  Write-Output "Windows installer behavior tests passed with $powerShellPath."
}
finally {
  $env:PATH = $originalPath
  $env:SHILIU_INSTALL_TEST_STATE = $originalState
  $env:SHILIU_INSTALL_TEST_LOG = $originalLog

  $resolvedSandbox = [System.IO.Path]::GetFullPath($sandbox)
  Assert-True ($resolvedSandbox.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) 'Refusing to clean a path outside the temporary directory.'
  if (Test-Path -LiteralPath $resolvedSandbox) {
    Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
  }
}

# The suite deliberately executes failing native-command scenarios. GitHub's
# pwsh wrapper exits with the last native exit code even after all assertions
# pass, so explicitly clear it on the successful path.
$global:LASTEXITCODE = 0
