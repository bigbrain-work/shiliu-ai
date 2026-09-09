$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $repositoryRoot 'install.ps1'
$powerShellPath = (Get-Process -Id $PID).Path
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
  [bool] $IncludeShiliu = $false
) {
  $caseDirectory = Join-Path $sandbox $Name
  [void](New-Item -ItemType Directory -Path $caseDirectory -Force)

  if ($NodeScript) {
    Write-FakeCommand $caseDirectory 'node' $NodeScript
  }
  if ($NpmScript) {
    Write-FakeCommand $caseDirectory 'npm' $NpmScript
  }
  if ($IncludeShiliu) {
    Write-FakeCommand $caseDirectory 'shiliu' "@echo off`r`necho 9.9.9-test"
  }

  $env:PATH = $caseDirectory
  $env:SHILIU_INSTALL_TEST_STATE = Join-Path $caseDirectory 'npm-upgraded.txt'
  $env:SHILIU_INSTALL_TEST_LOG = Join-Path $caseDirectory 'npm.log'
  $output = & $powerShellPath -NoLogo -NoProfile -NonInteractive -File $installerPath 2>&1 | Out-String
  $exitCode = $LASTEXITCODE

  return @{
    ExitCode = $exitCode
    Output = $output
    LogPath = $env:SHILIU_INSTALL_TEST_LOG
  }
}

$node22 = @'
@echo off
echo 22
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

try {
  [void](New-Item -ItemType Directory -Path $sandbox -Force)

  $missingNode = Invoke-InstallerCase 'missing-node' '' ''
  Assert-True ($missingNode.ExitCode -ne 0) 'Missing Node.js must fail.'
  Assert-True ($missingNode.Output -match 'Node\.js 18 or newer') 'Missing Node.js must return actionable guidance.'

  $missingNpm = Invoke-InstallerCase 'missing-npm' $node22 ''
  Assert-True ($missingNpm.ExitCode -ne 0) 'Missing npm must fail.'
  Assert-True ($missingNpm.Output -match 'official installer includes npm') 'Missing npm must explain that the Node.js installer includes npm.'

  $oldNpm = Invoke-InstallerCase 'old-npm' $node22 $npmOldThenUpgraded $true
  Assert-True ($oldNpm.ExitCode -eq 0) "Old npm upgrade path failed: $($oldNpm.Output)"
  $oldNpmLog = Get-Content -LiteralPath $oldNpm.LogPath -Raw
  Assert-True ($oldNpmLog -match 'npm@9\.9\.4') 'Old npm path must install the compatibility release.'
  Assert-True ($oldNpmLog -match '@bigbrain-work/mcp-connect@latest --prefer-online') 'Old npm path must install the online latest CLI after upgrading.'

  $currentNpm = Invoke-InstallerCase 'current-npm' $node22 $npmCurrent $true
  Assert-True ($currentNpm.ExitCode -eq 0) "Current npm path failed: $($currentNpm.Output)"
  $currentNpmLog = Get-Content -LiteralPath $currentNpm.LogPath -Raw
  Assert-True ($currentNpmLog -notmatch 'npm@9\.9\.4') 'Current npm must not be downgraded to the compatibility release.'
  Assert-True ($currentNpmLog -match '@bigbrain-work/mcp-connect@latest --prefer-online') 'Current npm path must install the online latest CLI.'

  $busyNpm = Invoke-InstallerCase 'busy-npm' $node22 $npmBusyOnce $true
  Assert-True ($busyNpm.ExitCode -eq 0) "Busy npm retry path failed: $($busyNpm.Output)"
  $busyNpmLog = Get-Content -LiteralPath $busyNpm.LogPath -Raw
  $installAttempts = [regex]::Matches(
    $busyNpmLog,
    '@bigbrain-work/mcp-connect@latest --prefer-online'
  ).Count
  Assert-True ($installAttempts -eq 2) 'EBUSY must trigger exactly one installation retry.'
  Assert-True ($busyNpm.Output -match 'Retrying the Shiliu AI CLI installation once') 'EBUSY retry must be visible to the user.'

  $warningNpm = Invoke-InstallerCase 'eperm-warning' $node22 $npmEpermWarningOnce $true
  Assert-True ($warningNpm.ExitCode -eq 0) "EPERM warning retry path failed: $($warningNpm.Output)"
  $warningNpmLog = Get-Content -LiteralPath $warningNpm.LogPath -Raw
  $warningAttempts = [regex]::Matches(
    $warningNpmLog,
    '@bigbrain-work/mcp-connect@latest --prefer-online'
  ).Count
  Assert-True ($warningAttempts -eq 2) 'A successful npm install with an EPERM cleanup warning must still retry once after releasing the lock.'

  Write-Output 'Windows installer prerequisite tests passed.'
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
