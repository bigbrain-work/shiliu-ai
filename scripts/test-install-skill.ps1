$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../install-skill.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('shiliu-skill-test-' + [guid]::NewGuid().ToString('N'))
$fixture = @{ downloads = 0; tamper = $false; noSkill = $false; invalidPath = $false; failDownload = $false }
$count = 0
function Assert-Case($Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:count++
    Write-Output "PASS: $Name"
}
function Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    $fixture.downloads++
    $relative = if ($fixture.invalidPath) { '../escape.md' } elseif ($fixture.noSkill) { 'references/info.md' } else { 'SKILL.md' }
    @{ name = 'shiliu-ai-mcp'; files = @(@{ path = $relative; sha256 = $fixture.hash }) }
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
    $fixture.downloads++
    if ($fixture.failDownload) { throw 'fixture_download_failure' }
    $text = if ($fixture.tamper) { 'wrong bytes' } else { $fixture.text }
    [IO.File]::WriteAllText($OutFile, $text, [Text.UTF8Encoding]::new($false))
}
function Install-Case([string]$Name, [hashtable]$Parameters) {
    $global:LASTEXITCODE = 0
    $result = (& $script:fixtureScript @Parameters) -join "`n"
    if (-not $result) { throw "No JSON: $Name" }
    return ($result | ConvertFrom-Json)
}
try {
    [IO.Directory]::CreateDirectory($sandbox) | Out-Null
    $fixtureText = "---`nname: shiliu-ai-mcp`ndescription: fixture`n---`n"
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $fixtureHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($fixtureText))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
    $fixture.hash = $fixtureHash
    $fixture.text = $fixtureText
    # Isolate the legacy Client path without adding production-only test switches.
    $fixtureScript = Join-Path $sandbox 'installer.ps1'
    $homeFixture = Join-Path $sandbox 'user'
    $sourceText = [IO.File]::ReadAllText($source).Replace("[Environment]::GetFolderPath('UserProfile')", "'$($homeFixture.Replace("'", "''"))'")
    [IO.File]::WriteAllText($fixtureScript, $sourceText, [Text.UTF8Encoding]::new($true))
    foreach ($directory in @('WorkBuddy 中文 space/.workbuddy/skills', 'DSH/.agents/skills', 'Doubao/User Data/workspace/.user_skills')) {
        $parent = Join-Path $sandbox $directory
        $result = Install-Case $directory @{ TargetDir = $parent; Scope = 'user' }
        if ($result.state -ne 'installed') { throw ('Fixture install failed: ' + ($result | ConvertTo-Json -Compress)) }
        Assert-Case ($result.state -eq 'installed' -and [IO.File]::ReadAllText((Join-Path $parent 'shiliu-ai-mcp/SKILL.md')) -eq $fixtureText) "custom parent $directory"
    }
    foreach ($client in @('codex', 'claude', 'cursor')) {
        $result = Install-Case $client @{ Client = $client; Scope = 'user' }
        $expected = if ($client -eq 'claude') { '.claude/skills/shiliu-ai-mcp' } else { '.agents/skills/shiliu-ai-mcp' }
        Assert-Case ($result.state -in @('installed', 'already_present') -and (Test-Path -LiteralPath (Join-Path $homeFixture $expected))) "legacy $client"
    }
    $existing = Join-Path $sandbox 'WorkBuddy 中文 space/.workbuddy/skills'
    $original = [IO.File]::ReadAllText((Join-Path $existing 'shiliu-ai-mcp/SKILL.md'))
    $fixture.downloads = 0
    $result = Install-Case 'existing' @{ TargetDir = $existing }
    Assert-Case ($result.state -eq 'already_present' -and $fixture.downloads -eq 0 -and [IO.File]::ReadAllText((Join-Path $existing 'shiliu-ai-mcp/SKILL.md')) -eq $original) 'preserve existing without network'
    $fileParent = Join-Path $sandbox 'not-a-directory'
    [IO.File]::WriteAllText($fileParent, 'keep')
    foreach ($parameters in @(@{}, @{ Client = 'codex'; TargetDir = $existing }, @{ TargetDir = 'relative/skills' }, @{ TargetDir = 'C:drive-relative' }, @{ TargetDir = '\\server\share\skills' }, @{ TargetDir = $fileParent }, @{ TargetDir = [IO.Path]::GetPathRoot($sandbox) }, @{ TargetDir = (Join-Path $env:WINDIR 'shiliu-fixture') }, @{ TargetDir = $existing; Scope = 'project' })) {
        $fixture.downloads = 0
        $result = Install-Case 'invalid' $parameters
        Assert-Case ($result.state -eq 'optional_failed' -and $fixture.downloads -eq 0) 'reject invalid selection/path before network'
    }
    $project = Join-Path $sandbox 'project'
    [IO.Directory]::CreateDirectory($project) | Out-Null
    $result = Install-Case 'project scope' @{ TargetDir = (Join-Path $project '.client/skills'); Scope = 'project'; ProjectPath = $project }
    Assert-Case ($result.state -eq 'installed') 'explicit project scope with absolute destination'
    foreach ($case in @('tamper', 'noSkill', 'invalidPath', 'failDownload')) {
        $fixture[$case] = $true
        $parent = Join-Path $sandbox $case
        $result = Install-Case $case @{ TargetDir = $parent }
        Assert-Case ($result.state -eq 'optional_failed' -and -not (Test-Path -LiteralPath (Join-Path $parent 'shiliu-ai-mcp'))) "reject $case without partial target"
        Assert-Case (@(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue).Count -eq 0) "clean only staging after $case"
        $fixture[$case] = $false
    }
    Write-Output "PASS: $count custom Skill installer checks"
} finally {
    $resolved = [IO.Path]::GetFullPath($sandbox)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('shiliu-skill-test-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
