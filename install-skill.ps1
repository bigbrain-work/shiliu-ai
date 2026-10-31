[CmdletBinding()]
param(
    [ValidateSet('codex', 'claude', 'cursor')][string]$Client,
    [string]$TargetDir,
    [ValidateSet('user', 'project')][string]$Scope = 'user',
    [string]$ProjectPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = $null
function Assert-SkillParent([string]$Path) {
    # Only fully qualified local paths; do not interpret wildcards, shell variables or UNC/device paths.
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[*?\[\]\x00-\x1f]' -or $Path -match '(^|[\\/])\.{1,2}([\\/]|$)') {
        throw 'invalid_target_directory'
    }
    foreach ($part in ($Path.Substring(3) -split '[\\/]')) {
        if ($part -and $part -ne $part.TrimEnd(' ', '.')) { throw 'invalid_target_directory' }
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')) { throw 'invalid_target_directory' }
    $protected = @($env:WINDIR, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData,
        [Environment]::GetFolderPath('Windows'), [Environment]::GetFolderPath('System'))
    foreach ($directory in $protected) {
        if (-not $directory) { continue }
        $prefix = [IO.Path]::GetFullPath($directory).TrimEnd('\', '/')
        if ($full.Equals($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            $full.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'protected_target_directory' }
    }
    $probe = $full
    while ($probe) {
        if (Test-Path -LiteralPath $probe) {
            $item = Get-Item -LiteralPath $probe -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid_target_directory' }
        }
        $probe = [IO.Path]::GetDirectoryName($probe)
    }
    return $full
}
try {
    if ($PSBoundParameters.ContainsKey('Client') -eq $PSBoundParameters.ContainsKey('TargetDir')) { throw 'choose_client_or_target_directory' }
    $base = 'https://bigbrain.work/shiliuAI'
    $root = [Environment]::GetFolderPath('UserProfile')
    if ($Scope -eq 'project') {
        if (-not $ProjectPath) { throw 'project_path_required' }
        $root = (Resolve-Path -LiteralPath $ProjectPath).Path
    }
    $parent = if ($PSBoundParameters.ContainsKey('TargetDir')) { $TargetDir } elseif ($Client -eq 'claude') { Join-Path $root '.claude\skills' } else { Join-Path $root '.agents\skills' }
    $parent = Assert-SkillParent $parent
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
    # Directory.Move fails if another installation appeared meanwhile; never nest or overwrite it.
    [IO.Directory]::Move($stage, $target)
    $stage = $null
    @{ state = 'installed'; path = $target; message = 'Skill 文件已安装；还需确认客户端识别启用，并在新会话中加载。' } | ConvertTo-Json
} catch {
    $reason = 'installation_failed'
    if ($_.Exception.Message -in @('invalid_target_directory', 'protected_target_directory', 'choose_client_or_target_directory', 'project_path_required', 'invalid_manifest', 'integrity_failed', 'missing_skill')) { $reason = $_.Exception.Message }
    @{ state = 'optional_failed'; component = 'Skill'; reason = $reason; message = 'Skill 安装未成功，但不影响正常使用。' } | ConvertTo-Json
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
