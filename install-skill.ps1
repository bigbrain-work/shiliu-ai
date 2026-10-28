[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('codex', 'claude', 'cursor')][string]$Client,
    [ValidateSet('user', 'project')][string]$Scope = 'user',
    [string]$ProjectPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = $null
try {
    $base = 'https://bigbrain.work/shiliuAI'
    $root = [Environment]::GetFolderPath('UserProfile')
    if ($Scope -eq 'project') {
        if (-not $ProjectPath) { throw 'project_path_required' }
        $root = (Resolve-Path -LiteralPath $ProjectPath).Path
    }
    $parent = if ($Client -eq 'claude') { Join-Path $root '.claude\skills' } else { Join-Path $root '.agents\skills' }
    $target = Join-Path $parent 'shiliu-ai-mcp'
    if (Test-Path -LiteralPath $target) {
        @{ state = 'already_present'; path = $target; message = '已有 Skill 已保留，不影响 MCP 使用。' } | ConvertTo-Json
        return
    }
    $manifest = Invoke-RestMethod -Uri "$base/skill-files.json" -TimeoutSec 20
    if ($manifest.name -ne 'shiliu-ai-mcp' -or @($manifest.files).Count -lt 1 -or @($manifest.files).Count -gt 100) { throw 'invalid_manifest' }
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $stage = Join-Path $parent ('.shiliu-install-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    foreach ($file in $manifest.files) {
        $relative = [string]$file.path
        if ($relative -notmatch '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$' -or $relative -match '(^|/)\.\.?(/|$)' -or $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'invalid_manifest' }
        $destination = Join-Path $stage $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri "$base/.well-known/agent-skills/shiliu-ai-mcp/$relative" -OutFile $destination -TimeoutSec 20 | Out-Null
        if ((Get-Item -LiteralPath $destination).Length -gt 1048576 -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'integrity_failed' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'SKILL.md'))) { throw 'missing_skill' }
    Move-Item -LiteralPath $stage -Destination $target
    $stage = $null
    @{ state = 'installed'; path = $target; message = 'Skill 已安装；由客户端发现后生效。' } | ConvertTo-Json
} catch {
    @{ state = 'optional_failed'; component = 'Skill'; message = 'Skill 安装未成功，但不影响正常使用。' } | ConvertTo-Json
    exit 1
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        $resolved = [IO.Path]::GetFullPath($stage)
        $expectedParent = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
        if ($resolved.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('.shiliu-install-')) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
