[CmdletBinding()]
param(
    [ValidateLength(1, 100)][string]$ClientName = 'Agent',
    [string]$ConfigPath,
    [switch]$CopyToClipboard,
    [switch]$SkipEditingCredential
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$api = 'https://api.bigbrain.work/shiliu'
$phase = 'configuration_check'
$key = $null; $claim = $null; $verifier = $null; $personalUrl = $null
$changed = $false; $copied = $false; $stored = $false; $temporary = $null
$lastHttp = @{ Status = $null; Error = $null }

function Get-HttpErrorInfo($Record) {
    $status = $null; $body = $null; $response = $Record.Exception.Response
    try {
        if ($response) { try { $status = [int]$response.StatusCode } catch { } }
        if ($Record.ErrorDetails -and $Record.ErrorDetails.Message) { $body = $Record.ErrorDetails.Message }
        elseif ($response -and $response.PSObject.Methods['GetResponseStream']) {
            try {
                $stream = $response.GetResponseStream()
                if ($stream.CanSeek) { $stream.Position = 0 }
                $body = (New-Object IO.StreamReader($stream)).ReadToEnd()
            } catch { }
        }
    } finally { if ($response -is [IDisposable]) { try { $response.Dispose() } catch { } } }
    $errorCode = $null
    if ($body) { try { $errorCode = [string]($body | ConvertFrom-Json).error } catch { } }
    if ($errorCode -notmatch '^[a-z_]{1,64}$') { $errorCode = $null }
    return @{ Status = $status; Error = $errorCode }
}

try {
    # The Agent must establish the actual config path and permission before invoking this helper.
    if ($PSBoundParameters.ContainsKey('ConfigPath') -eq [bool]$CopyToClipboard) { throw 'choose_config_or_clipboard' }
    if ($CopyToClipboard) {
        if (-not (Get-Command Set-Clipboard -ErrorAction SilentlyContinue)) { throw 'clipboard_unavailable' }
    } else {
        if ($ConfigPath -notmatch '^[A-Za-z]:[\\/]' -or $ConfigPath -match '[*?\[\]\x00-\x1f]' -or
            [IO.Path]::GetExtension($ConfigPath) -notin @('.json', '.jsonc', '.yml', '.yaml', '.toml')) { throw 'unsupported_config' }
        $config = [IO.Path]::GetFullPath($ConfigPath)
        foreach ($directory in @($env:WINDIR, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)) {
            if ($directory -and $config.StartsWith([IO.Path]::GetFullPath($directory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'unsupported_config' }
        }
        if (-not (Test-Path -LiteralPath $config -PathType Leaf) -or (Get-Item -LiteralPath $config).Length -gt 1048576) { throw 'unsupported_config' }
        $probe = $config
        while ($probe) {
            if ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsupported_config' }
            $probe = [IO.Path]::GetDirectoryName($probe)
        }
        $before = [IO.File]::ReadAllBytes($config)
        $bom = $before.Length -ge 3 -and $before[0] -eq 239 -and $before[1] -eq 187 -and $before[2] -eq 191
        $encoding = [Text.UTF8Encoding]::new([bool]$bom, $true)
        $offset = if ($bom) { 3 } else { 0 }
        $text = $encoding.GetString($before, $offset, $before.Length - $offset)
        # Replace only one exact Shiliu URL value; no YAML reserialization or broad config rewrite.
        $pattern = '(?m)(?<prefix>"url"\s*:\s*"|^[ \t]*url[ \t]*[:=][ \t]*["\x27]?)(?<url>https://api\.bigbrain\.work/shiliu/mcp(?:/k/sk[-A-Za-z0-9]+)?)(?=["\x27]|[ \t]*(?:#.*)?\r?$)'
        $matches = [regex]::Matches($text, $pattern)
        if ($matches.Count -ne 1) { throw 'ambiguous_or_missing_shiliu_url' }
        $urlMatch = $matches[0].Groups['url']
        $beforeHash = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
    }
    $phase = 'authorization'
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $bytes = New-Object byte[] 48; $random.GetBytes($bytes) } finally { $random.Dispose() }
    $verifier = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $challenge = [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_') } finally { $sha.Dispose() }
    $start = Invoke-RestMethod -Method Post -Uri "$api/oauth/http-fallback" -ContentType 'application/json' -TimeoutSec 20 -Body (@{
        client_name = $ClientName; code_challenge = $challenge; mcp_failure = 'oauth_failed'
    } | ConvertTo-Json -Compress)
    $authorize = [Uri]$start.authorization_url
    if ($authorize.Scheme -ne 'https' -or $authorize.Host -notin @('bigbrain.work', 'www.bigbrain.work') -or $authorize.AbsolutePath -ne '/shiliuai/agent-authorize') { throw 'invalid_authorization_url' }
    Start-Process -FilePath $authorize.AbsoluteUri | Out-Null
    Write-Host '已打开石榴网页，请登录并确认本次连接；无需复制 API Key。'
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min(600, [int]$start.expires_in))
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $claim = Invoke-RestMethod -Method Post -Uri "$api/oauth/http-fallback/token" -ContentType 'application/json' -TimeoutSec 20 -Body (@{
                request_id = $start.request_id; code_verifier = $verifier
            } | ConvertTo-Json -Compress)
            $key = [string]$claim.api_key
            break
        } catch {
            $lastHttp = Get-HttpErrorInfo $_
            if ($lastHttp.Error -ne 'authorization_pending') { throw 'authorization_not_completed' }
        }
    }
    if ($key -notmatch '^sk[-A-Za-z0-9]+$') { throw 'authorization_not_completed' }
    $lastHttp = @{ Status = $null; Error = $null }
    $phase = 'verification'
    $personalUrl = "$api/mcp/k/$key"
    $headers = @{ Accept = 'application/json, text/event-stream' }
    $list = Invoke-RestMethod -Method Post -Uri $personalUrl -Headers $headers -ContentType 'application/json' -TimeoutSec 30 -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    if (-not (@($list.result.tools | Where-Object { $_.name -eq 'get_account_balance' }).Count)) { throw 'balance_verification_failed' }
    $balance = Invoke-RestMethod -Method Post -Uri $personalUrl -Headers $headers -ContentType 'application/json' -TimeoutSec 30 -Body '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_account_balance","arguments":{}}}'
    $result = $balance.result.structuredContent
    if ($null -eq $result -and $balance.result.content) { $result = ($balance.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text | ConvertFrom-Json }
    if ($balance.error -or $balance.result.isError -or $result.billing.charged -ne $false -or $result.billing.consumed_credits -ne 0) { throw 'balance_verification_failed' }
    $phase = 'configuration'
    if ($CopyToClipboard) {
        Set-Clipboard -Value $personalUrl
        $copied = $true
    } else {
        if ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ne $beforeHash) { throw 'configuration_changed_during_consent' }
        $updated = $text.Substring(0, $urlMatch.Index) + $personalUrl + $text.Substring($urlMatch.Index + $urlMatch.Length)
        $temporary = $config + '.shiliu-tmp-' + [guid]::NewGuid().ToString('N')
        $backup = $config + '.shiliu-backup-' + [guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText($temporary, $updated, $encoding)
        # Atomic replacement keeps all unrelated config and retains the original as a local backup.
        [IO.File]::Replace($temporary, $config, $backup)
        $temporary = $null
        $changed = $true
    }
    $phase = 'credential_storage'
    if (-not $SkipEditingCredential) {
        [Environment]::SetEnvironmentVariable('SHILIU_AI_API_KEY', $key, 'User')
        [Environment]::SetEnvironmentVariable('SHILIU_AI_API_KEY', $key, 'Process')
        $stored = $true
    }
    @{ state = 'personal_url_prepared'; config_updated = $changed; url_copied = $copied; credential_stored = $stored;
       charged = $false; native_mcp_verified = $false;
       next_action = $(if ($copied) { 'paste_clipboard_into_existing_connector_then_verify_native' } else { 'reload_client_then_verify_native' });
       message = '网页确认与本机交接已完成。配置已更新或专属地址已放入本机剪贴板；不要输出地址，仍须验证客户端原生免费余额。' } | ConvertTo-Json
} catch {
    if (-not $lastHttp.Status -and $_.Exception.Response) { $lastHttp = Get-HttpErrorInfo $_ }
    $reason = 'operation_failed'
    if ($_.Exception.Message -in @('choose_config_or_clipboard','clipboard_unavailable','unsupported_config','ambiguous_or_missing_shiliu_url','invalid_authorization_url','authorization_not_completed','balance_verification_failed','configuration_changed_during_consent')) { $reason = $_.Exception.Message }
    @{ state = 'personal_url_incomplete'; phase = $phase; reason = $reason; http_status = $lastHttp.Status; oauth_error = $lastHttp.Error;
       config_updated = $changed; url_copied = $copied; credential_stored = $stored;
       message = '本机交接未完成；保留现状并按失败阶段检查，不要让用户手动获取 API Key，不要重置或重复授权。' } | ConvertTo-Json
    exit 1
} finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
    $key = $null; $claim = $null; $verifier = $null; $personalUrl = $null; $updated = $null; $text = $null
}
