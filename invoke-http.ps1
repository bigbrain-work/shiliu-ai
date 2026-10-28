[CmdletBinding(DefaultParameterSetName = 'Call')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'List')][switch]$ListTools,
    [Parameter(Mandatory = $true, ParameterSetName = 'Call')][ValidatePattern('^[a-z][a-z0-9_]{0,100}$')][string]$Tool,
    [Parameter(ParameterSetName = 'Call')][string]$ArgumentsFile,
    [ValidateSet('UserThenProcess', 'Process')][string]$CredentialSource = 'UserThenProcess'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$key = $null
if ($CredentialSource -eq 'UserThenProcess') { $key = [Environment]::GetEnvironmentVariable('SHILIU_AI_API_KEY', 'User') }
if (-not $key) { $key = [Environment]::GetEnvironmentVariable('SHILIU_AI_API_KEY', 'Process') }
if (-not $key) { Write-Output '{"state":"credential_unavailable","message":"请先完成官方 HTTP 备用授权，不要把 API Key 发到聊天。"}'; exit 1 }
try {
    $headers = @{ Authorization = "Bearer $key"; Accept = 'application/json, text/event-stream' }
    if ($ListTools) { $method = 'tools/list'; $params = @{} }
    else {
        $arguments = @{}
        if ($ArgumentsFile) {
            if ((Get-Item -LiteralPath $ArgumentsFile).Length -gt 4194304) { throw 'input_too_large' }
            $arguments = Get-Content -LiteralPath $ArgumentsFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -eq $arguments -or $arguments -is [Array] -or $arguments -is [string] -or $arguments -is [ValueType]) { throw 'input_not_object' }
        }
        $method = 'tools/call'; $params = @{ name = $Tool; arguments = $arguments }
    }
    $body = @{ jsonrpc = '2.0'; id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 50 -Compress
    # Exactly one submission; never auto-repeat a paid tool after a lost response.
    $response = Invoke-RestMethod -Method Post -Uri 'https://api.bigbrain.work/shiliu/mcp' -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 300
    $response | ConvertTo-Json -Depth 100
    if ($response.error -or $response.result.isError) { exit 1 }
} catch {
    Write-Output '{"state":"request_incomplete","outcome":"unknown","message":"调用未完成或结果未知。请检查输入与网络；收费请求不要自动重试。"}'
    exit 1
} finally { $key = $null; $headers = $null }
