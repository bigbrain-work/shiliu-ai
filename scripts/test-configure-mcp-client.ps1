$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '../configure-mcp-client.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('shiliu-client-test-' + [guid]::NewGuid().ToString('N'))
$count = 0
$fixture = @{}
function Invoke-RestMethod {
    param($Method, $Uri, $ContentType, $TimeoutSec, $Body, $Headers)
    $fixture.calls++
    if ($Uri -like '*/oauth/http-fallback') { return @{ request_id = 'test'; authorization_url = 'https://www.bigbrain.work/shiliuai/agent-authorize?request=test'; expires_in = 600 } }
    if ($Uri -like '*/oauth/http-fallback/token') { return @{ api_key = 'sk-fixture' } }
    if ($Uri -ne 'https://api.bigbrain.work/shiliu/mcp/k/sk-fixture') { throw 'unexpected_url' }
    if ($Body -like '*tools/list*') { return @{ result = @{ tools = @(@{ name = 'get_account_balance' }) } } }
    return @{ result = @{ structuredContent = @{ billing = @{ charged = $false; consumed_credits = 0 } } } }
}
function Start-Process { param($FilePath) $fixture.browser++ }
function Start-Sleep { param($Seconds) }
function Assert-Case($Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:count++; Write-Output "PASS: $Name"
}
function Run-Case([string]$Client, [string]$Text) {
    $suffix = if ($Client -eq 'workbuddy') { '.json' } else { '.yml' }
    $script:config = Join-Path $sandbox ([guid]::NewGuid().ToString('N') + $suffix)
    [IO.File]::WriteAllText($config, $Text, [Text.UTF8Encoding]::new($true))
    $global:LASTEXITCODE = 0
    $output = (& $helper -Client $Client -ConfigPath $config) -join "`n"
    if ($output -match 'sk-fixture') { throw 'credential_echoed' }
    return $output | ConvertFrom-Json
}
try {
    [IO.Directory]::CreateDirectory($sandbox) | Out-Null
    $missing = Join-Path $sandbox 'new-workbuddy.json'
    $report = (& $helper -Client workbuddy -ConfigPath $missing) -join "`n" | ConvertFrom-Json
    Assert-Case ($report.state -eq 'client_configured' -and (Test-Path -LiteralPath $missing)) 'create first WorkBuddy config without overwriting another file'
    $other = '"other":{"command":"node","args":["keep.js"],"env":{"x":"keep"}}'
    $wrong = '{"mcpServers":{' + $other + ',"shiliu_mcp":{"transport":"http","url":"https://api.bigbrain.work/shiliu/mcp"}},"setting":true}'
    $result = Run-Case workbuddy $wrong
    $updated = [IO.File]::ReadAllText($config)
    $entry = ($updated | ConvertFrom-Json).mcpServers.shiliu_mcp
    Assert-Case ($result.state -eq 'client_configured' -and $entry.type -eq 'streamableHttp' -and -not $entry.transport -and $updated.Contains($other)) 'repair WorkBuddy transport and preserve unrelated bytes'
    Assert-Case (@(Get-ChildItem -LiteralPath $sandbox -Filter ([IO.Path]::GetFileName($config) + '.shiliu-backup-*')).Count -eq 1) 'backup existing config'
    $bytes = [IO.File]::ReadAllBytes($config)
    Assert-Case ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'preserve UTF8 BOM'
    foreach ($text in @('{}', '{"setting":true}', ('{"mcpServers":{' + $other + '}}'))) {
        $result = Run-Case workbuddy $text
        $parsed = [IO.File]::ReadAllText($config) | ConvertFrom-Json
        Assert-Case ($result.state -eq 'client_configured' -and $parsed.mcpServers.shiliu_mcp.type -eq 'streamableHttp') 'create missing WorkBuddy entry'
    }
    foreach ($entry in @(
        '{"type":"stdio","command":"node"}',
        '{"type":"streamableHttp","url":"https://example.com/mcp"}',
        '{"url":"https://api.bigbrain.work/shiliu/mcp","headers":{"Authorization":"fixture"}}',
        '{"url":"https://api.bigbrain.work/shiliu/mcp","disabled":true}'
    )) {
        $text = '{"mcpServers":{"shiliu_mcp":' + $entry + '}}'
        $result = Run-Case workbuddy $text
        Assert-Case ($result.reason -eq 'existing_connection_preserved' -and [IO.File]::ReadAllText($config) -ceq $text) 'preserve explicit existing connection'
    }
    $result = Run-Case workbuddy '{"mcpServers":{"shiliu_mcp":{"url":"https://api.bigbrain.work/shiliu/mcp/k/sk-fixture"}}}'
    Assert-Case (([IO.File]::ReadAllText($config) | ConvertFrom-Json).mcpServers.shiliu_mcp.url.EndsWith('/sk-fixture')) 'keep existing personal credential'
    $yaml = "- id: github`r`n  name: '@deepseek-ai/dsh-mcp-client'`r`n  config:`r`n    serverName: github`r`n    transport: stdio`r`n    command: keep`r`n"
    $result = Run-Case dsh $yaml
    $updated = [IO.File]::ReadAllText($config)
    Assert-Case ($result.state -eq 'client_configured' -and $updated.StartsWith($yaml) -and $updated.Contains('transport: streamable-http')) 'append DSH plugin while preserving other plugins'
    $result = Run-Case dsh ($updated.Replace('transport: streamable-http','transport: http'))
    Assert-Case ($result.state -eq 'client_configured' -and [IO.File]::ReadAllText($config).Contains('transport: streamable-http')) 'repair DSH transport'
    $result = Run-Case dsh "plugins:`n  - id: unknown`n"
    Assert-Case ($result.reason -eq 'unsupported_config') 'refuse unrecognized YAML layout'
    $duplicate = $updated + $updated.Substring($yaml.Length)
    $result = Run-Case dsh $duplicate
    Assert-Case ($result.reason -eq 'ambiguous_config') 'refuse duplicate DSH entries'
    $result = Run-Case dsh ($updated.Replace('transport: streamable-http','transport: stdio'))
    Assert-Case ($result.reason -eq 'existing_connection_preserved') 'preserve DSH stdio entry'
    $result = Run-Case dsh ($updated.Replace('    url: https://api.bigbrain.work/shiliu/mcp', "    headers: { Authorization: fixture }`r`n    url: https://api.bigbrain.work/shiliu/mcp"))
    Assert-Case ($result.reason -eq 'existing_connection_preserved') 'preserve DSH custom headers'
    $result = Run-Case dsh ($updated.Replace('    url:', "    headers: {}`r`n    url:"))
    Assert-Case ($result.state -eq 'client_configured') 'allow DSH empty headers without treating them as credentials'
    foreach ($client in @('workbuddy','dsh')) {
        $initial = if ($client -eq 'workbuddy') { '{}' } else { $yaml }
        $null = Run-Case $client $initial
        $fixture.calls = 0; $fixture.browser = 0
        $entrypoint = Join-Path $PSScriptRoot '../connect-mcp.ps1'
        $output = (& $entrypoint -Client $client -ConfigPath $config -UsePersonalUrl -SkipEditingCredential) -join "`n"
        $report = $output | ConvertFrom-Json
        Assert-Case ($report.state -eq 'personal_url_prepared' -and $fixture.browser -eq 1 -and $fixture.calls -eq 4 -and $output -notmatch 'sk-fixture') "$client connects configuration to consented handoff without credential output"
        Assert-Case ([IO.File]::ReadAllText($config).Contains('/mcp/k/sk-fixture') -and -not $report.native_mcp_verified) "$client personal URL saved but native verification remains pending"
    }
    Write-Output "PASS: $count client configuration checks"
    $global:LASTEXITCODE = 0
} finally {
    $resolved = [IO.Path]::GetFullPath($sandbox)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('shiliu-client-test-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
