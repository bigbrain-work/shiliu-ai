$ErrorActionPreference = 'Stop'
$helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../connect-mcp.ps1'))
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('shiliu-connect-test-' + [guid]::NewGuid().ToString('N'))
$savedCodexHome = $env:CODEX_HOME
$official = 'https://api.bigbrain.work/shiliu/mcp'
$fixtureKey = 'sk-fixture-key-123'
$fixture = @{}
function Get-Command {
    param($Name, $ErrorAction)
    # Resolve only the mock functions. No real client executable can run in this harness.
    if (@($Name) -contains 'codex.exe') { return [pscustomobject]@{ Source = 'Invoke-FakeCodex' } }
    if (@($Name) -contains 'claude.exe' -and $fixture.claudeCli) { return [pscustomobject]@{ Source = 'Invoke-FakeClaude' } }
}
function Invoke-FakeCodex {
    $command = $args -join ' '
    $fixture.calls.Add($command) | Out-Null
    $global:LASTEXITCODE = 0
    if ($args[1] -eq 'get') {
        if (-not $fixture.exists) { $global:LASTEXITCODE = 1; return }
        @{ enabled = $true; transport = @{ type = $fixture.transport; url = $fixture.url; http_headers = $fixture.headers } } | ConvertTo-Json -Depth 5 -Compress
    } elseif ($args[1] -eq 'add') {
        $fixture.exists = $true
        $fixture.url = $args[4]
        $global:LASTEXITCODE = $fixture.addExit
        'fixture-private-output'
    } elseif ($args[1] -eq 'list') {
        @(@{ name = 'shiliu_mcp'; auth_status = $fixture.auth }) | ConvertTo-Json -Compress
    } elseif ($args[1] -eq 'login') {
        $global:LASTEXITCODE = $fixture.loginExit
        'fixture-private-output'
    } else { throw 'unexpected_client_command' }
}
function Invoke-FakeClaude {
    $fixture.calls.Add('claude ' + ($args -join ' ')) | Out-Null
    $global:LASTEXITCODE = 0
    if ($args[1] -eq 'get') {
        if (-not $fixture.exists) { $global:LASTEXITCODE = 1; return }
        "shiliu_mcp:`n  Scope: User config (available in all your projects)`n  Type: $($fixture.claudeType)`n  URL: $($fixture.url)"
    } elseif ($args[1] -in @('add', 'remove')) { 'fixture-private-output' } else { throw 'unexpected_client_command' }
}
# Network, browser and sleep are mocked; the helper's consented handoff runs against these fixtures.
function Invoke-RestMethod {
    param($Method, $Uri, $ContentType, $TimeoutSec, $Body, $Headers)
    $fixture.http.Add([string]$Uri) | Out-Null
    if ($Uri -like '*/oauth/http-fallback') {
        if (($Body | ConvertFrom-Json).mcp_failure -ne 'oauth_failed') { throw 'wrong_mcp_failure' }
        return [pscustomobject]@{ request_id = 'r'; authorization_url = $fixture.consentUrl; expires_in = 600 }
    }
    if ($Uri -like '*/oauth/http-fallback/token') { return [pscustomobject]@{ api_key = $fixtureKey } }
    if ($Uri -ne "$official/k/$fixtureKey") { throw 'unexpected_url' }
    if ($Body -like '*tools/list*') {
        return [pscustomobject]@{ result = [pscustomobject]@{ tools = @([pscustomobject]@{ name = $fixture.balanceTool }) } }
    }
    return [pscustomobject]@{ result = [pscustomobject]@{ isError = $false; structuredContent = [pscustomobject]@{
        billing = [pscustomobject]@{ charged = $false; consumed_credits = 0 } } } }
}
function Start-Process { param($FilePath) $fixture.browser.Add([string]$FilePath) | Out-Null }
function Start-Sleep { param($Seconds) }
function Run-Case([string]$Name, [hashtable]$Options, [string]$Client = 'codex', [switch]$Authorize, [switch]$Personal) {
    $script:fixture = @{ exists = $false; transport = 'streamable_http'; url = $official; headers = $null;
        auth = 'not_logged_in'; addExit = 0; loginExit = 0; claudeCli = $false; claudeType = 'http';
        consentUrl = 'https://bigbrain.work/shiliuai/agent-authorize?request=r'; balanceTool = 'get_account_balance';
        calls = [Collections.Generic.List[string]]::new(); http = [Collections.Generic.List[string]]::new();
        browser = [Collections.Generic.List[string]]::new() }
    foreach ($key in $Options.Keys) { $fixture[$key] = $Options[$key] }
    $text = (& $helper -Client $Client -AuthorizeExistingRemote:$Authorize -UsePersonalUrl:$Personal -SkipEditingCredential 2>$null) -join "`n"
    if ($text -match 'fixture-private-output') { throw "client output leaked: $Name" }
    if ($text -match [regex]::Escape($fixtureKey)) { throw "credential leaked to the report: $Name" }
    $report = $text | ConvertFrom-Json
    return @{ Report = $report; Calls = @($fixture.calls.ToArray()); Http = @($fixture.http.ToArray());
              Browser = @($fixture.browser.ToArray()); Url = $fixture.url; Name = $Name }
}
function Assert-Case($Case, [string]$State, [int]$LoginCount, [int]$AddCount) {
    if ($Case.Report.state -ne $State -or @($Case.Calls | Where-Object { $_ -eq 'mcp login shiliu_mcp' }).Count -ne $LoginCount -or
        @($Case.Calls | Where-Object { $_ -like 'mcp add *' -or $_ -like 'claude mcp add *' }).Count -ne $AddCount) {
        throw "failed case: $($Case.Name) / $($Case.Report.state) / $($Case.Calls -join ',')"
    }
    return $Case
}
function Assert-True([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "failed check: $Name" } }
$count = 0
try {
    New-Item -ItemType Directory -Path $sandbox | Out-Null
    $env:CODEX_HOME = $sandbox
    # OAuth path. Codex reports a stored OAuth login as "o_auth".
    Assert-Case (Run-Case 'new remote opens login' @{}) 'awaiting_reload' 1 1 | Out-Null
    Assert-Case (Run-Case 'add already authorized' @{ auth = 'o_auth' }) 'awaiting_reload' 0 1 | Out-Null
    Assert-Case (Run-Case 'existing preserved' @{ exists = $true }) 'existing_installation' 0 0 | Out-Null
    Assert-Case (Run-Case 'existing stdio refuses OAuth' @{ exists = $true; transport = 'stdio' } -Authorize) 'existing_installation' 0 0 | Out-Null
    Assert-Case (Run-Case 'existing remote reauth' @{ exists = $true } -Authorize) 'awaiting_reload' 1 0 | Out-Null
    Assert-Case (Run-Case 'valid existing login reused' @{ exists = $true; auth = 'o_auth' } -Authorize) 'awaiting_reload' 0 0 | Out-Null
    Assert-Case (Run-Case 'other endpoint preserved' @{ exists = $true; url = 'https://example.com/mcp' } -Authorize) 'existing_installation' 0 0 | Out-Null
    Assert-Case (Run-Case 'API key entry preserved' @{ exists = $true; headers = @{ Authorization = 'fixture' } } -Authorize) 'existing_installation' 0 0 | Out-Null
    Assert-Case (Run-Case 'unknown auth no blind login' @{ auth = 'surprise' }) 'authorization_required' 0 1 | Out-Null
    $case = Assert-Case (Run-Case 'discovery failure goes to personal URL' @{ auth = 'unsupported' }) 'oauth_failed' 0 1
    Assert-True ($case.Report.next_action -eq 'use_personal_url' -and $case.Report.stage -eq 'oauth_discovery') 'discovery failure next action'
    Assert-Case (Run-Case 'login error no retry' @{ loginExit = 1 }) 'oauth_failed' 1 1 | Out-Null
    Assert-Case (Run-Case 'add error after save no repeat' @{ addExit = 1 }) 'oauth_failed' 0 1 | Out-Null
    foreach ($client in @('workbuddy', 'doubao')) {
        $case = Assert-Case (Run-Case $client @{} -Client $client) 'configuration_generated' 0 0
        Assert-True ($case.Report.fallback_url_template -like "$official/k/*") "$client fallback template"
    }
    $count = 14

    # Personal URL path.
    $case = Assert-Case (Run-Case 'personal URL for new Codex entry' @{} -Personal) 'awaiting_reload' 0 1
    Assert-True ($case.Url -eq "$official/k/$fixtureKey" -and $case.Browser.Count -eq 1 -and $case.Report.connection -eq 'personal_url') 'new personal URL written after consent'
    $case = Assert-Case (Run-Case 'personal URL replaces failed OAuth entry' @{ exists = $true } -Personal) 'awaiting_reload' 0 1
    Assert-True ($case.Report.replaced_entry -eq $true) 'official entry replaced'
    Assert-Case (Run-Case 'personal URL replaces reset personal URL' @{ exists = $true; url = "$official/k/sk-old" } -Personal) 'awaiting_reload' 0 1 | Out-Null
    $case = Assert-Case (Run-Case 'personal URL keeps stdio bridge' @{ exists = $true; transport = 'stdio' } -Personal) 'existing_installation' 0 0
    Assert-True ($case.Http.Count -eq 0 -and $case.Browser.Count -eq 0) 'stdio bridge untouched without consent'
    Assert-Case (Run-Case 'personal URL keeps custom entry' @{ exists = $true; url = 'https://example.com/mcp' } -Personal) 'existing_installation' 0 0 | Out-Null
    $case = Assert-Case (Run-Case 'personal URL not written when verification fails' @{ balanceTool = 'other' } -Personal) 'personal_url_incomplete' 0 0
    Assert-True ($case.Report.phase -eq 'verification' -and $case.Report.configuration_changed -eq $false) 'verification failure leaves config unchanged'
    $case = Assert-Case (Run-Case 'personal URL rejects foreign consent page' @{ consentUrl = 'https://evil.example/shiliuai/agent-authorize' } -Personal) 'personal_url_incomplete' 0 0
    Assert-True ($case.Browser.Count -eq 0) 'foreign consent page never opened'
    $case = Assert-Case (Run-Case 'personal URL for Claude Code replaces user entry' @{ claudeCli = $true; exists = $true } -Client 'claude' -Personal) 'awaiting_reload' 0 1
    Assert-True (@($case.Calls | Where-Object { $_ -like 'claude mcp remove shiliu_mcp --scope user' }).Count -eq 1) 'claude user entry removed before add'
    Assert-Case (Run-Case 'personal URL keeps Claude stdio' @{ claudeCli = $true; exists = $true; claudeType = 'stdio' } -Client 'claude' -Personal) 'existing_installation' 0 0 | Out-Null
    $case = Assert-Case (Run-Case 'personal URL without CLI is user-filled' @{} -Client 'workbuddy' -Personal) 'configuration_generated' 0 0
    Assert-True ($case.Http.Count -eq 0 -and $case.Report.url_template -like "$official/k/*") 'GUI client gets template, no key handoff'
    $count += 10
    Write-Output "PASS: $count mocked onboarding cases; no real client, network, credentials or browser used."
} finally {
    $env:CODEX_HOME = $savedCodexHome
    # Only the empty, unique fixture directory is removed; no recursive cleanup.
    Remove-Item -LiteralPath $sandbox
}
