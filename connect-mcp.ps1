[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('codex', 'claude', 'cursor', 'workbuddy', 'doubao')][string]$Client,
    [switch]$AuthorizeExistingRemote,
    # Use only after OAuth failed (state oauth_failed) or a personal URL reports it is no longer valid.
    [switch]$UsePersonalUrl,
    # Do not store SHILIU_AI_API_KEY for the local editing plugin.
    [switch]$SkipEditingCredential
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$api = 'https://api.bigbrain.work/shiliu'
$endpoint = "$api/mcp"
$personalPrefix = "$endpoint/k/"
$personalTemplate = "$personalPrefix<官网账户页的 API Key>"

# Client-specific configuration in the client's own field names. Report fields such as transport
# describe the connection and must not be copied into a client configuration (WorkBuddy needs
# type=streamableHttp, verified 2026-10-31).
function Get-ClientTemplate([string]$Url) {
    switch ($Client) {
        'workbuddy' { return @{ client_config = @{ mcpServers = @{ shiliu_mcp = @{ type = 'streamableHttp'; url = $Url } } } } }
        'cursor' { return @{ client_config = @{ mcpServers = @{ shiliu_mcp = @{ url = $Url } } } } }
        'doubao' { return @{ ui_form = @{ name = 'shiliu_mcp'; transport = 'HTTP'; url = $Url; custom_headers = '留空' } } }
    }
    return @{ server_name = 'shiliu_mcp'; transport = 'http'; url = $Url }
}

# stdout carries only the JSON report; progress and client output go to stderr for the user.
function Write-Notice([string]$Text) { [Console]::Error.WriteLine($Text) }

# An existing shiliu_mcp entry (stdio bridge or remote) is a working installation: never replace it.
# codex mcp add silently overwrites a same-name entry, so this check must run before any add.
function Test-ExistingEntry($program) {
    if ($Client -in @('workbuddy', 'doubao')) { return $false } # Client-managed connector UI; no guessed storage path.
    if ($program -and $Client -ne 'cursor') {
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $program.Source mcp get shiliu_mcp *> $null
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch { } finally { $ErrorActionPreference = $previous }
    }
    $profileDir = [Environment]::GetFolderPath('UserProfile')
    $file = switch ($Client) {
        'codex' { if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'config.toml' } else { Join-Path $profileDir '.codex\config.toml' } }
        'claude' { Join-Path $profileDir '.claude.json' }
        'cursor' { Join-Path $profileDir '.cursor\mcp.json' }
    }
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8
    if ($Client -eq 'codex') { return $text -match '(?m)^\s*\[mcp_servers\.(?:shiliu_mcp|"shiliu_mcp")\]' }
    return $text -match '"shiliu_mcp"\s*:'
}

# -Stream shows client output (browser prompts, authorization links) to the user on stderr.
# Otherwise output stays local. Never guess the failed HTTP request from a generic error.
function Invoke-ClientCommand($program, [string[]]$Arguments, [switch]$Stream) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($Stream) {
            & $program.Source @Arguments 2>&1 | ForEach-Object { Write-Notice ([string]$_) }
            return @{ ExitCode = $LASTEXITCODE; Output = '' }
        }
        $output = @(& $program.Source @Arguments 2>&1)
        return @{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    } finally { $ErrorActionPreference = $previous }
}

function Get-CodexAuthStatus($program) {
    $result = Invoke-ClientCommand $program @('mcp', 'list', '--json')
    if ($result.ExitCode -ne 0) { return 'unknown' }
    try {
        $entry = @($result.Output | ConvertFrom-Json) | Where-Object { $_.name -eq 'shiliu_mcp' } | Select-Object -First 1
        # Codex reports a stored OAuth login as "o_auth".
        switch ($entry.auth_status) {
            { $_ -in @('o_auth', 'oauth') } { return 'oauth' }
            'not_logged_in' { return 'not_logged_in' }
            'unsupported' { return 'unsupported' }
        }
    } catch { }
    return 'unknown'
}

function Get-CodexEntry($program) {
    $result = Invoke-ClientCommand $program @('mcp', 'get', 'shiliu_mcp', '--json')
    if ($result.ExitCode -ne 0) { return $null }
    try { return $result.Output | ConvertFrom-Json } catch { return $null }
}

# Only the official remote entry (and, with -AllowPersonal, a personal URL) may be re-authorized or
# replaced; a stdio bridge, custom URL or header/API-key entry is the user's own setup.
function Test-OfficialRemote($entry, [switch]$AllowPersonal) {
    $url = [string]$entry.transport.url
    return $entry.transport.type -eq 'streamable_http' -and
        ($url -eq $endpoint -or ($AllowPersonal -and $url.StartsWith($personalPrefix))) -and
        -not $entry.transport.bearer_token_env_var -and -not $entry.transport.http_headers -and
        -not $entry.transport.env_http_headers -and $entry.enabled -ne $false
}

function Write-OAuthFailed([string]$Stage, [string]$Message, $ExitCode = $null) {
    $report = @{ state = 'oauth_failed'; next_action = 'use_personal_url'; stage = $Stage; request_path_known = $false;
                 fallback_command = "connect-mcp.ps1 -Client $Client -UsePersonalUrl"; message = $Message }
    if ($null -ne $ExitCode) { $report.client_exit_code = $ExitCode }
    $report | ConvertTo-Json
}

function Start-CodexAuthorization($program) {
    $auth = Get-CodexAuthStatus $program
    if ($auth -eq 'unsupported') {
        Write-OAuthFailed 'oauth_discovery' 'Codex 未能从石榴服务发现 OAuth 授权（客户端判定不支持）。不要反复授权或去设置里点认证；告知用户后改用专属地址：在同一目录运行 fallback_command，用户只需在石榴网页上确认一次。'
        return
    }
    if ($auth -eq 'unknown') {
        @{ state = 'authorization_required'; next_action = 'inspect_client_auth_status'; stage = 'oauth_status';
           message = '无法确认客户端认证状态，未重复启动授权。请检查当前客户端的登录提示，不要重装或获取 API Key。' } | ConvertTo-Json
        return
    }
    if ($auth -eq 'not_logged_in') {
        Write-Notice '正在通过 Codex 打开石榴 AI 网页授权，请在浏览器中登录并确认。浏览器没有打开时，使用下面 Codex 给出的完整链接。'
        $login = Invoke-ClientCommand $program @('mcp', 'login', 'shiliu_mcp') -Stream
        if ($login.ExitCode -ne 0) {
            Write-OAuthFailed 'client_oauth' 'Codex 网页授权未完成。用户主动取消时先询问是否继续，不要自动切换；出现错误或用户已同意仍失败时，不要重复授权，告知用户后改用专属地址（运行 fallback_command）。' $login.ExitCode
            return
        }
    }
    @{ state = 'awaiting_reload'; next_action = 'verify_native_tools_or_reconnect';
       message = 'Codex 已有 OAuth 登录或网页授权命令已完成。先验证当前 Agent 的原生工具和免费余额；仅在未加载时重连，无需再去设置里重复认证。' } | ConvertTo-Json
}

# Claude Code: replace only a user-scope HTTP entry that points at the official or a personal URL.
function Get-ClaudeEntryKind($program) {
    $result = Invoke-ClientCommand $program @('mcp', 'get', 'shiliu_mcp')
    if ($result.ExitCode -ne 0) { return 'none' }
    $text = $result.Output
    $official = $text -match "(?m)^\s*URL:\s*$([regex]::Escape($endpoint))(/k/\S+)?\s*$"
    if ($official -and $text -match '(?m)^\s*Scope:\s*User' -and $text -match '(?m)^\s*Type:\s*http\s*$' -and $text -notmatch '(?m)^\s*Headers?:') {
        return 'replaceable'
    }
    return 'preserve'
}

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

# Same consented handoff as connect-http.ps1: the user approves on the Shiliu website, the
# PKCE verifier never leaves this process, and the key is never printed.
function Request-ApiKey([string]$ClientName) {
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 48
    $random.GetBytes($bytes)
    $random.Dispose()
    $verifier = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $sha = [Security.Cryptography.SHA256]::Create()
    $challenge = [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $sha.Dispose()
    $start = Invoke-RestMethod -Method Post -Uri "$api/oauth/http-fallback" -ContentType 'application/json' -TimeoutSec 20 -Body (@{
        client_name = $ClientName; code_challenge = $challenge; mcp_failure = 'oauth_failed'
    } | ConvertTo-Json -Compress)
    $authorize = [Uri]$start.authorization_url
    if ($authorize.Scheme -ne 'https' -or $authorize.Host -notin @('bigbrain.work', 'www.bigbrain.work') -or $authorize.AbsolutePath -ne '/shiliuai/agent-authorize') { throw 'invalid_authorization_url' }
    Start-Process -FilePath $authorize.AbsoluteUri | Out-Null
    Write-Notice '已打开石榴 AI 页面。请登录并确认允许本次 Agent 使用专属连接地址。'
    Write-Notice "浏览器没有打开时，请手动打开：$($authorize.AbsoluteUri)"
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min(600, [int]$start.expires_in))
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $claim = Invoke-RestMethod -Method Post -Uri "$api/oauth/http-fallback/token" -ContentType 'application/json' -TimeoutSec 20 -Body (@{
                request_id = $start.request_id; code_verifier = $verifier
            } | ConvertTo-Json -Compress)
            if ([string]$claim.api_key -notmatch '^sk[-A-Za-z0-9]+$') { throw 'authorization_not_completed' }
            return [string]$claim.api_key
        } catch {
            # Never emit the raw exception, response, request body, or credential.
            $script:lastHttp = Get-HttpErrorInfo $_
            if ($script:lastHttp.Error -ne 'authorization_pending') { throw 'authorization_not_completed' }
        }
    }
    throw 'authorization_not_completed'
}

# Verify the personal URL itself before writing any client configuration.
function Test-PersonalUrl([string]$Url) {
    $headers = @{ Accept = 'application/json, text/event-stream' }
    $list = Invoke-RestMethod -Method Post -Uri $Url -Headers $headers -ContentType 'application/json' -TimeoutSec 30 -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    if (-not (@($list.result.tools | Where-Object { $_.name -eq 'get_account_balance' }).Count)) { throw 'balance_tool_unavailable' }
    $balance = Invoke-RestMethod -Method Post -Uri $Url -Headers $headers -ContentType 'application/json' -TimeoutSec 30 -Body '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_account_balance","arguments":{}}}'
    $result = $balance.result.structuredContent
    if ($balance.error -or $balance.result.isError -or $result.billing.charged -ne $false -or $result.billing.consumed_credits -ne 0) { throw 'balance_verification_failed' }
}

function Invoke-PersonalUrlSetup($program) {
    if ($Client -notin @('codex', 'claude') -or -not $program) {
        # No CLI: the user pastes the address into the client. Never collect the key in chat.
        $report = @{ state = 'configuration_generated'; next_action = 'user_fills_personal_url'; connection = 'personal_url';
           url_template = $personalTemplate;
           message = '请用户本人在石榴官网账户页复制 API Key，把已有石榴条目的地址改为 url_template（把尖括号部分换成 API Key），字段名按 client_config/ui_form，请求头留空，替换原地址而不是再加一条，保存后告诉你已完成。不要让用户把 API Key 发到对话里。完成后用原生工具免费查询余额验证。' }
        $report += (Get-ClientTemplate $personalTemplate)
        $report | ConvertTo-Json -Depth 6
        return
    }
    $replace = $false
    if ($Client -eq 'codex' -and (Test-ExistingEntry $program)) {
        $entry = Get-CodexEntry $program
        if (-not (Test-OfficialRemote $entry -AllowPersonal)) { Write-PreservedEntry; return }
        $replace = $true
    } elseif ($Client -eq 'claude') {
        $kind = Get-ClaudeEntryKind $program
        if ($kind -eq 'preserve') { Write-PreservedEntry; return }
        $replace = $kind -eq 'replaceable'
    }
    $phase = 'authorization'
    $key = $null
    $configChanged = $false
    $script:lastHttp = @{ Status = $null; Error = $null }
    try {
        $key = Request-ApiKey $(if ($Client -eq 'codex') { 'Codex' } else { 'Claude Code' })
        $url = $personalPrefix + $key
        $phase = 'verification'
        Test-PersonalUrl $url
        $phase = 'configuration'
        if ($Client -eq 'codex') {
            # add replaces the same-name entry; its output is not shown because it may echo the URL.
            $add = Invoke-ClientCommand $program @('mcp', 'add', 'shiliu_mcp', '--url', $url)
            if ($add.ExitCode -ne 0) { throw 'configuration_failed' }
        } else {
            if ($replace) {
                $remove = Invoke-ClientCommand $program @('mcp', 'remove', 'shiliu_mcp', '--scope', 'user')
                if ($remove.ExitCode -ne 0) { throw 'configuration_failed' }
                $configChanged = $true
            }
            $add = Invoke-ClientCommand $program @('mcp', 'add', '--transport', 'http', '--scope', 'user', 'shiliu_mcp', $url)
            if ($add.ExitCode -ne 0) { throw 'configuration_failed' }
        }
        $configChanged = $true
        $editing = 'skipped'
        if (-not $SkipEditingCredential) {
            # The local editing plugin bills through SHILIU_AI_API_KEY. User scope only.
            $phase = 'credential_storage'
            [Environment]::SetEnvironmentVariable('SHILIU_AI_API_KEY', $key, 'User')
            $editing = 'stored'
        }
        @{ state = 'awaiting_reload'; next_action = 'reconnect_then_verify_native_tools'; connection = 'personal_url';
           replaced_entry = $replace; editing_credential = $editing; charged = $false;
           message = '已改用专属地址连接，并已用它免费查询余额验证可用。请让客户端重连石榴连接或新开对话，再用原生工具免费查询余额。专属地址等同密码，不要输出、截图或分享。' } | ConvertTo-Json
    } catch {
        $script:exitCode = 1
        if (-not $script:lastHttp.Status -and $_.Exception.Response) { $script:lastHttp = Get-HttpErrorInfo $_ }
        @{ state = 'personal_url_incomplete'; phase = $phase; connection = 'personal_url'; configuration_changed = $configChanged;
           http_status = $script:lastHttp.Status; oauth_error = $script:lastHttp.Error;
           message = '专属地址接入未完成。authorization 阶段：access_denied 为用户拒绝，expired_request 为确认页超时，其他情况按 http_status 检查；verification 阶段说明地址验证失败，未写入任何配置。不要重置 API Key，也不要反复重试。' } | ConvertTo-Json
    } finally { $key = $null; $url = $null }
}

function Write-PreservedEntry {
    @{ state = 'existing_installation'; next_action = 'verify_existing_connection_or_follow_recovery';
       message = '已存在的石榴 MCP 条目不是官方远程地址或专属地址（例如 stdio 桥接或自定义配置），已保留，未做修改。按 recovery.txt 处理，不要改为专属地址。' } | ConvertTo-Json
}

try {
    if ($AuthorizeExistingRemote -and $Client -ne 'codex') { throw 'unsupported_authorization_option' }
    if ($AuthorizeExistingRemote -and $UsePersonalUrl) { throw 'conflicting_options' }
    $program = Get-Command "$Client.exe", "$Client.cmd", $Client -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($UsePersonalUrl) {
        $script:exitCode = 0
        Invoke-PersonalUrlSetup $program
        exit $script:exitCode
    }
    if (Test-ExistingEntry $program) {
        if ($AuthorizeExistingRemote -and $program) {
            # Authorize only the official remote OAuth entry, never a stdio bridge or API-key entry.
            if (Test-OfficialRemote (Get-CodexEntry $program)) {
                Start-CodexAuthorization $program
                exit 0
            }
        }
        @{ state = 'existing_installation'; next_action = 'verify_existing_connection_or_follow_recovery';
           message = '已存在石榴 MCP 配置，已保留，未做修改。请直接用原生 MCP 免费查询余额；连接异常按 recovery.txt 排查，不要重装或改为其他连接方式。' } | ConvertTo-Json
        exit 0
    }
    if ($AuthorizeExistingRemote) { throw 'existing_remote_entry_required' }
    if ($Client -eq 'codex' -and $program) {
        Write-Notice '正在添加石榴 MCP。部分 Codex 版本会在添加时直接打开网页授权，请在浏览器中确认。'
        $add = Invoke-ClientCommand $program @('mcp', 'add', 'shiliu_mcp', '--url', $endpoint) -Stream
        if ($add.ExitCode -ne 0) {
            # Some Codex versions start OAuth inside add, after saving the entry.
            if (Test-ExistingEntry $program) {
                Write-OAuthFailed 'client_add' '连接配置已保存，但添加命令未完成，通常是添加时的自动授权失败。不要重复添加或授权；用户主动取消时先询问是否继续，否则告知用户后改用专属地址（运行 fallback_command）。' $add.ExitCode
                exit 0
            }
            throw 'configuration_failed'
        }
        Start-CodexAuthorization $program
    } elseif ($Client -eq 'claude' -and $program) {
        & $program.Source mcp add --transport http --scope user shiliu_mcp $endpoint
        if ($LASTEXITCODE -ne 0) { throw 'configuration_failed' }
        @{ state = 'awaiting_reload'; next_action = 'reconnect_then_browser_oauth';
           fallback_command = 'connect-mcp.ps1 -Client claude -UsePersonalUrl';
           message = '重连后在 /mcp 中完成石榴网页授权。授权失败时不要反复尝试，改用 fallback_command。' } | ConvertTo-Json
    } elseif ($Client -in @('workbuddy', 'doubao')) {
        $instruction = if ($Client -eq 'workbuddy') {
            '使用 WorkBuddy 的连接器安装/连接操作，或把 client_config 合并进用户级 mcp.json（保留其他条目，字段名以 client_config 为准）。如出现安装确认或“连接”，请用户只确认该提示，随后由客户端打开网页授权。'
        } else {
            '适用于具备自定义连接器的豆包电脑版：请用户在豆包界面添加自定义连接器并按 ui_form 填写，入口以用户实际看到的为准，不要编造菜单路径。如提示“连接器需要授权”，请用户点击“去授权”。'
        }
        $report = @{ state = 'configuration_generated'; next_action = 'use_client_connector_action'; authentication = 'oauth';
           fallback_url_template = $personalTemplate;
           message = $instruction + ' 没有授权入口、保存后只显示失败或 401、或网页授权失败时，不要反复尝试，也不要让用户点不存在的按钮：请用户本人在官网账户页复制 API Key，把同一条目的地址改为 fallback_url_template；不要让用户把 Key 发到对话里。' }
        $report += (Get-ClientTemplate $endpoint)
        $report | ConvertTo-Json -Depth 6
    } else {
        # Desktop clients do not necessarily ship a CLI on PATH. This is not a runtime failure.
        $report = @{ state = 'configuration_generated'; next_action = 'use_documented_client_mcp_settings'; authentication = 'oauth';
           fallback_url_template = $personalTemplate;
           message = '用客户端自己的字段名添加以上远程连接（有 client_config 时照它填写），再按客户端提示授权。无需安装 Node/npm。没有授权入口或授权失败时改用 fallback_url_template，由用户本人填入 API Key。' }
        $report += (Get-ClientTemplate $endpoint)
        $report | ConvertTo-Json -Depth 6
    }
} catch {
    @{ state = 'configuration_failed'; next_action = 'inspect_existing_entry_or_use_client_settings';
       message = '自动配置未完成。先检查是否已存在石榴 MCP 条目，不要重装或生成临时脚本。' } | ConvertTo-Json
    exit 1
}
