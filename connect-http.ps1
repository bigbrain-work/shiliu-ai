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
$lastHttp = @{ Status = $null; Error = $null }

# Windows PowerShell 5.1 often leaves ErrorDetails empty for HTTP errors; the JSON body is then only
# in the WebException response stream. PowerShell 7 fills ErrorDetails. Only a fixed OAuth error
# token and the HTTP status are kept, never the raw body.
function Get-HttpErrorInfo($ErrorRecord) {
    $status = $null; $body = $null
    $response = $ErrorRecord.Exception.Response
    try {
        if ($response) { try { $status = [int]$response.StatusCode } catch { } }
        if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { $body = $ErrorRecord.ErrorDetails.Message }
        elseif ($response -and $response.PSObject.Methods['GetResponseStream']) {
            try {
                $stream = $response.GetResponseStream()
                if ($stream.CanSeek) { $stream.Position = 0 }
                $body = (New-Object IO.StreamReader($stream)).ReadToEnd()
            } catch { }
        }
    } finally {
        # Release the pooled connection: Windows PowerShell allows only two per host, so an unclosed
        # error response stalls the next poll.
        if ($response -is [IDisposable]) { try { $response.Dispose() } catch { } }
    }
    $code = $null
    if ($body) { try { $code = [string]($body | ConvertFrom-Json).error } catch { } }
    if ($code -notmatch '^[a-z_]{1,64}$') { $code = $null }
    return @{ Status = $status; Error = $code }
}

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
    if ($authorize.Scheme -ne 'https' -or $authorize.Host -notin @('bigbrain.work', 'www.bigbrain.work') -or $authorize.AbsolutePath -ne '/shiliuai/agent-authorize') { throw 'invalid_authorization_url' }
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
            $lastHttp = Get-HttpErrorInfo $_
            if ($lastHttp.Error -ne 'authorization_pending') { throw 'authorization_not_completed' }
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
    if (-not $lastHttp.Status -and $_.Exception.Response) { $lastHttp = Get-HttpErrorInfo $_ }
    @{ state = 'http_setup_incomplete'; phase = $phase;
       credential_stored = ($phase -eq 'verification');
       http_status = $lastHttp.Status; oauth_error = $lastHttp.Error;
       message = 'HTTP 备用接入未完成。请按当前阶段及 http_status/oauth_error 检查（access_denied 为用户拒绝，expired_request 为确认页超时），不要重置 API Key，也不要重复安装。' } | ConvertTo-Json
    exit 1
} finally {
    $key = $null; $claim = $null; $headers = $null; $verifier = $null
}
