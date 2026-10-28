[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateSet('codex', 'claude', 'cursor')][string]$Client)
$ErrorActionPreference = 'Stop'
$endpoint = 'https://api.bigbrain.work/shiliu/mcp'

# An existing shiliu_mcp entry (stdio bridge or remote) is a working installation: never replace it.
# codex mcp add silently overwrites a same-name entry, so this check must run before any add.
function Test-ExistingEntry($program) {
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

try {
    $program = Get-Command "$Client.exe", "$Client.cmd", $Client -ErrorAction SilentlyContinue | Select-Object -First 1
    if (Test-ExistingEntry $program) {
        @{ state = 'existing_installation'; next_action = 'verify_existing_connection_or_follow_recovery';
           message = '已存在石榴 MCP 配置，已保留，未做修改。请直接用原生 MCP 免费查询余额；连接异常按 recovery.txt 排查，不要重装或改为其他连接方式。' } | ConvertTo-Json
        exit 0
    }
    if ($Client -eq 'codex' -and $program) {
        & $program.Source mcp add shiliu_mcp --url $endpoint
        if ($LASTEXITCODE -ne 0) { throw 'configuration_failed' }
        @{ state = 'awaiting_reload'; next_action = 'reconnect_then_browser_oauth';
           message = '请在客户端重连 MCP 并完成石榴 AI 网页授权，再通过原生 MCP 免费查询余额。' } | ConvertTo-Json
    } elseif ($Client -eq 'claude' -and $program) {
        & $program.Source mcp add --transport http --scope user shiliu_mcp $endpoint
        if ($LASTEXITCODE -ne 0) { throw 'configuration_failed' }
        @{ state = 'awaiting_reload'; next_action = 'reconnect_then_browser_oauth' } | ConvertTo-Json
    } else {
        # Desktop clients do not necessarily ship a CLI on PATH. This is not a runtime failure.
        @{ state = 'configuration_generated'; next_action = 'use_documented_client_mcp_settings';
           server_name = 'shiliu_mcp'; transport = 'http'; url = $endpoint; authentication = 'oauth';
           message = '在客户端 MCP 设置中添加以上远程连接，再点击授权。无需安装 Node/npm。' } | ConvertTo-Json
    }
} catch {
    @{ state = 'configuration_failed'; next_action = 'inspect_existing_entry_or_use_client_settings';
       message = '自动配置未完成。先检查是否已存在石榴 MCP 条目，不要重装或生成临时脚本。' } | ConvertTo-Json
    exit 1
}
