$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '../connect-personal.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('shiliu-personal-test-' + [guid]::NewGuid().ToString('N'))
$fixtureKey = 'sk-fixture-personal-handoff'
$fixture = @{}
$count = 0
Add-Type @'
public class PersonalFixtureResponse : System.IDisposable {
  public int StatusCode { get { return 400; } }
  private string body; public bool Disposed;
  public PersonalFixtureResponse(string value) { body = value; }
  public System.IO.Stream GetResponseStream() { return new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(body)); }
  public void Dispose() { Disposed = true; }
}
public class PersonalFixtureException : System.Exception {
  public PersonalFixtureResponse Response { get; private set; }
  public PersonalFixtureException(string body) : base("fixture error") { Response = new PersonalFixtureResponse(body); }
}
'@
function Assert-Case($Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:count++; Write-Output "PASS: $Name"
}
function Throw-FixtureError([string]$Code) {
    $json = @{ error = $Code } | ConvertTo-Json -Compress
    $errorRecord = [Management.Automation.ErrorRecord]::new([PersonalFixtureException]::new($json), 'fixture_http', 'InvalidOperation', $null)
    if (-not $fixture.stream) { $errorRecord.ErrorDetails = [Management.Automation.ErrorDetails]::new($json) }
    throw $errorRecord
}
function Invoke-RestMethod {
    param($Method, $Uri, $ContentType, $TimeoutSec, $Body, $Headers)
    $fixture.requests++
    if ($Uri -like '*/oauth/http-fallback') {
        if (($Body | ConvertFrom-Json).mcp_failure -ne 'oauth_failed') { throw 'fixture_wrong_reason' }
        return @{ request_id = 'r'; authorization_url = $fixture.consent; expires_in = 600 }
    }
    if ($Uri -like '*/oauth/http-fallback/token') {
        $fixture.polls++
        if ($fixture.polls -le $fixture.pending) { Throw-FixtureError 'authorization_pending' }
        if ($fixture.denied) { Throw-FixtureError 'access_denied' }
        if ($fixture.changeConfig) { [IO.File]::AppendAllText($fixture.config, "`n# concurrent edit") }
        return @{ api_key = $fixtureKey }
    }
    if ($Uri -ne "https://api.bigbrain.work/shiliu/mcp/k/$fixtureKey") { throw 'fixture_wrong_url' }
    if ($Body -like '*tools/list*') { return @{ result = @{ tools = @(@{ name = 'get_account_balance' }) } } }
    return @{ result = @{ structuredContent = @{ billing = @{ charged = [bool]$fixture.charged; consumed_credits = 0 } } } }
}
function Start-Process { param($FilePath) $fixture.opened++ }
function Start-Sleep { param($Seconds) $fixture.slept++ }
function Set-Clipboard { param($Value) $fixture.clipboard = $Value }
function Run-Case([string]$Text, [hashtable]$Options = @{}, [switch]$Clipboard) {
    $script:fixture = @{ requests = 0; polls = 0; pending = 2; stream = $false; denied = $false; charged = $false;
        opened = 0; slept = 0; clipboard = $null; changeConfig = $false; consent = 'https://bigbrain.work/shiliuai/agent-authorize?request=r' }
    foreach ($key in $Options.Keys) { $fixture[$key] = $Options[$key] }
    $fixture.config = Join-Path $sandbox ([guid]::NewGuid().ToString('N') + '.yml')
    [IO.File]::WriteAllText($fixture.config, $Text, [Text.UTF8Encoding]::new($true))
    $global:LASTEXITCODE = 0
    $parameters = @{ ClientName = 'DeepSeek Harness'; SkipEditingCredential = $true }
    if ($Clipboard) { $parameters.CopyToClipboard = $true } else { $parameters.ConfigPath = $fixture.config }
    $output = (& $helper @parameters) -join "`n"
    if ($output.Contains($fixtureKey)) { throw 'fixture_credential_echoed' }
    return ($output | ConvertFrom-Json)
}
try {
    [IO.Directory]::CreateDirectory($sandbox) | Out-Null
    $yaml = "serverName: shiliu_mcp`r`ntransport: streamable-http`r`nurl: https://api.bigbrain.work/shiliu/mcp`r`nother: keep`r`n"
    foreach ($stream in @($false, $true)) {
        $result = Run-Case $yaml @{ stream = $stream }
        $expected = $yaml.Replace('https://api.bigbrain.work/shiliu/mcp', "https://api.bigbrain.work/shiliu/mcp/k/$fixtureKey")
        Assert-Case ($result.config_updated -and [IO.File]::ReadAllText($fixture.config) -eq $expected -and $fixture.polls -eq 3) "pending consent and narrow YAML replacement, stream=$stream"
        $bytes = [IO.File]::ReadAllBytes($fixture.config)
        Assert-Case ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'preserve existing UTF8 BOM'
        $backup = @(Get-ChildItem -LiteralPath $sandbox -Filter ([IO.Path]::GetFileName($fixture.config) + '.shiliu-backup-*'))
        Assert-Case ($backup.Count -eq 1 -and [IO.File]::ReadAllText($backup[0].FullName) -eq $yaml) 'retain original config backup'
        Assert-Case (-not $result.native_mcp_verified -and $result.charged -eq $false -and -not $result.credential_stored) 'handoff is not native MCP proof; editing credential can be skipped'
    }
    $json = '{"mcpServers":{"other":{"url":"https://example.com"},"shiliu_mcp":{"type":"streamableHttp","url":"https://api.bigbrain.work/shiliu/mcp"}}}'
    $result = Run-Case $json
    Assert-Case ($result.config_updated -and [IO.File]::ReadAllText($fixture.config) -eq $json.Replace('https://api.bigbrain.work/shiliu/mcp', "https://api.bigbrain.work/shiliu/mcp/k/$fixtureKey")) 'minified JSON preserves unrelated server'
    $old = $yaml.Replace('/shiliu/mcp', '/shiliu/mcp/k/sk-old-fixture')
    $result = Run-Case $old
    Assert-Case ($result.config_updated -and [IO.File]::ReadAllText($fixture.config).Contains('/k/' + $fixtureKey)) 'replace reset personal URL in the same entry'
    foreach ($text in @('url: https://example.com', ($yaml + $yaml))) {
        $result = Run-Case $text
        Assert-Case ($result.reason -eq 'ambiguous_or_missing_shiliu_url' -and $fixture.requests -eq 0 -and [IO.File]::ReadAllText($fixture.config) -eq $text) 'reject missing or ambiguous URL before consent'
    }
    $result = Run-Case $yaml @{ denied = $true; pending = 0; stream = $true }
    Assert-Case ($result.oauth_error -eq 'access_denied' -and -not $result.config_updated -and [IO.File]::ReadAllText($fixture.config) -eq $yaml) 'denial never writes configuration'
    $result = Run-Case $yaml @{ consent = 'https://example.com/shiliuai/agent-authorize?request=r' }
    Assert-Case ($result.reason -eq 'invalid_authorization_url' -and $fixture.opened -eq 0) 'reject foreign consent page'
    $result = Run-Case $yaml @{ charged = $true }
    Assert-Case ($result.reason -eq 'balance_verification_failed' -and -not $result.config_updated) 'verification failure never changes config'
    $result = Run-Case $yaml @{ changeConfig = $true }
    Assert-Case ($result.reason -eq 'configuration_changed_during_consent' -and -not $result.config_updated -and [IO.File]::ReadAllText($fixture.config).EndsWith('# concurrent edit')) 'preserve concurrent edits'
    $result = Run-Case $yaml -Clipboard
    Assert-Case ($result.url_copied -and -not $result.config_updated -and $fixture.clipboard -eq "https://api.bigbrain.work/shiliu/mcp/k/$fixtureKey") 'UI-only client receives local clipboard, not chat output'
    Write-Output "PASS: $count personal handoff checks"
    $global:LASTEXITCODE = 0
} finally {
    $resolved = [IO.Path]::GetFullPath($sandbox)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('shiliu-personal-test-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
