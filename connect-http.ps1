[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('client_unsupported', 'configuration_failed', 'connection_failed')]
    [string]$McpFailure,
    [ValidateLength(1, 100)][string]$ClientName = 'Agent',
    [ValidateSet('Environment')][string]$CredentialTarget = 'Environment'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$api = 'https://api.bigbrain.work/shiliu'
$key = $null
$phase = 'authorization'
try {
    # This verifier stays in this process; it is never a command argument or output.
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 48
    $random.GetBytes($bytes)
    $random.Dispose()
    $verifier = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $sha = [Security.Cryptography.SHA256]::Create()
    $challenge = [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $sha.Dispose()
    $start = Invoke-RestMethod -Method Post -Uri "$api/oauth/http-fallback" -ContentType 'application/json' -TimeoutSec 20 -Body (@{
        client_name = $ClientName; code_challenge = $challenge; mcp_failure = $McpFailure
    } | ConvertTo-Json -Compress)
    $authorize = [Uri]$start.authorization_url
    if ($authorize.Scheme -ne 'https' -or $authorize.Host -ne 'bigbrain.work' -or $authorize.AbsolutePath -ne '/shiliuai/agent-authorize') { throw 'invalid_authorization_url' }
    # An interactive browser is intentional: the user must see and approve consent.
    Start-Process -FilePath $authorize.AbsoluteUri | Out-Null
    Write-Host '已打开石榴 AI 页面。请登录并确认是否允许本次 Agent 配置已有 API Key。'
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min(600, [int]$start.expires_in))
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $claim = Invoke-RestMethod -Method Post -Uri "$api/oauth/http-fallback/token" -ContentType 'application/json' -TimeoutSec 20 -Body (@{
                request_id = $start.request_id; code_verifier = $verifier
            } | ConvertTo-Json -Compress)
            $key = $claim.api_key
            break
        } catch {
            # Never emit the raw exception, response, request body, or credential.
            $oauthError = $null
            try { $oauthError = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { }
            if ($oauthError -ne 'authorization_pending') { throw 'authorization_not_completed' }
        }
    }
    if ([string]::IsNullOrWhiteSpace($key) -or $key -notmatch '^sk[-A-Za-z0-9]+$') { throw 'authorization_not_completed' }
    $phase = 'credential_storage'
    # User scope only. Do not replace PATH or write a credential into project files.
    [Environment]::SetEnvironmentVariable('SHILIU_AI_API_KEY', $key, 'User')
    [Environment]::SetEnvironmentVariable('SHILIU_AI_API_KEY', $key, 'Process')
    $phase = 'verification'
    $headers = @{ Authorization = "Bearer $key"; Accept = 'application/json, text/event-stream' }
    $list = Invoke-RestMethod -Method Post -Uri "$api/mcp" -Headers $headers -ContentType 'application/json' -TimeoutSec 30 -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    if (-not (@($list.result.tools | Where-Object { $_.name -eq 'get_account_balance' }).Count)) { throw 'balance_tool_unavailable' }
    $balance = Invoke-RestMethod -Method Post -Uri "$api/mcp" -Headers $headers -ContentType 'application/json' -TimeoutSec 30 -Body '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_account_balance","arguments":{}}}'
    $result = $balance.result.structuredContent
    if ($null -eq $result -and $balance.result.content) {
        $result = ($balance.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text | ConvertFrom-Json
    }
    if ($balance.error -or $balance.result.isError -or $result.billing.charged -ne $false -or $result.billing.consumed_credits -ne 0) { throw 'balance_verification_failed' }
    @{ state = 'http_ready'; credential_stored = $true; charged = $false;
       message = '安装已完成，可以通过 HTTP 正常使用；当前客户端的 MCP 连接尚未完成。';
       restart_hint = '本次验证进程已可读取凭据。已有客户端进程可能需要重启；先检查变量可见性，不要输出其值。' } | ConvertTo-Json
} catch {
    @{ state = 'http_setup_incomplete'; phase = $phase;
       credential_stored = ($phase -eq 'verification');
       message = 'HTTP 备用接入未完成。请按当前阶段检查，不要重置 API Key，也不要重复安装。' } | ConvertTo-Json
    exit 1
} finally {
    $key = $null; $claim = $null; $headers = $null; $verifier = $null
}
