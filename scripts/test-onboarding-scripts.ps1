$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
foreach ($name in @('connect-mcp.ps1', 'connect-http.ps1', 'invoke-http.ps1', 'install-skill.ps1')) {
    $tokens = $null; $errors = $null
    [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $name), [ref]$tokens, [ref]$errors) | Out-Null
    if (@($errors).Count) { throw "PowerShell syntax check failed: $name" }
}
$old = [Environment]::GetEnvironmentVariable('SHILIU_AI_API_KEY', 'Process')
$dummy = 'sk-local-only-fixture'
$fixture = @{ requests = 0; failRequest = $false }
function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $ContentType, $Body, $TimeoutSec)
    $fixture.requests++
    if ($Headers.Authorization -ne "Bearer $dummy") { throw 'fixture_credential_wrong' }
    if ($fixture.failRequest) { throw 'fixture_network_failure' }
    $request = $Body | ConvertFrom-Json
    if ($request.method -eq 'tools/list') { return @{ result = @{ tools = @(@{ name = 'get_account_balance' }) } } }
    return @{ result = @{ structuredContent = @{ data = @{ balance = 10 }; billing = @{ charged = $false; consumed_credits = 0 } } } }
}
try {
    [Environment]::SetEnvironmentVariable('SHILIU_AI_API_KEY', $dummy, 'Process')
    $output = (& (Join-Path $root 'invoke-http.ps1') -ListTools -CredentialSource Process) -join "`n"
    if ($output.Contains($dummy) -or $fixture.requests -ne 1 -or $output -notmatch 'get_account_balance') { throw 'list_fixture_failed' }
    $fixture.requests = 0
    $fixture.failRequest = $true
    $output = (& (Join-Path $root 'invoke-http.ps1') -Tool get_account_balance -CredentialSource Process) -join "`n"
    if ($output.Contains($dummy) -or $fixture.requests -ne 1 -or $output -notmatch 'unknown') { throw 'no_retry_fixture_failed' }
    Write-Output 'PASS: four fixed scripts parse; HTTP helper reads process credential without echo and never retries an unknown request.'
} finally {
    [Environment]::SetEnvironmentVariable('SHILIU_AI_API_KEY', $old, 'Process')
}
