[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('workbuddy', 'dsh')][string]$Client,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [switch]$UsePersonalUrl,
    [switch]$SkipEditingCredential
)
$ErrorActionPreference = 'Stop'
$official = 'https://api.bigbrain.work/shiliu/mcp'
$changed = $false
$temporary = $null

function Find-ObjectEnd([string]$Text, [int]$Start) {
    $depth = 0; $quoted = $false; $escaped = $false
    for ($i = $Start; $i -lt $Text.Length; $i++) {
        $char = $Text[$i]
        if ($quoted) {
            if ($escaped) { $escaped = $false }
            elseif ($char -eq '\') { $escaped = $true }
            elseif ($char -eq '"') { $quoted = $false }
        } elseif ($char -eq '"') { $quoted = $true }
        elseif ($char -eq '{') { $depth++ }
        elseif ($char -eq '}') { $depth--; if ($depth -eq 0) { return $i } }
    }
    throw 'unsupported_config'
}
function Assert-Remote($Entry, [string]$TransportField) {
    if ($Entry.command -or $Entry.args -or $Entry.env -or $Entry.disabled -eq $true -or $Entry.enabled -eq $false) { throw 'existing_connection_preserved' }
    if ($Entry.headers -and @($Entry.headers.PSObject.Properties).Count) { throw 'existing_connection_preserved' }
    if ($Entry.url -and $Entry.url -notmatch '^https://api\.bigbrain\.work/shiliu/mcp(?:/k/sk[-A-Za-z0-9]+)?$') { throw 'existing_connection_preserved' }
    if ($Entry.$TransportField -and $Entry.$TransportField -notin @('http', 'streamableHttp', 'streamable-http')) { throw 'existing_connection_preserved' }
}
try {
    if ($ConfigPath -notmatch '^[A-Za-z]:[\\/]' -or $ConfigPath -match '[*?\[\]\x00-\x1f]') { throw 'unsupported_config' }
    $config = [IO.Path]::GetFullPath($ConfigPath)
    $exists = Test-Path -LiteralPath $config
    if ($exists) {
        if (-not (Test-Path -LiteralPath $config -PathType Leaf) -or (Get-Item -LiteralPath $config).Length -gt 1048576) { throw 'unsupported_config' }
    } elseif ($Client -ne 'workbuddy' -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($config)) -PathType Container)) { throw 'unsupported_config' }
    $probe = $config
    while ($probe) {
        if ((Test-Path -LiteralPath $probe) -and ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsupported_config' }
        $probe = [IO.Path]::GetDirectoryName($probe)
    }
    foreach ($directory in @($env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)) {
        if ($directory -and $config.StartsWith([IO.Path]::GetFullPath($directory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'unsupported_config' }
    }
    $bytes = if ($exists) { [IO.File]::ReadAllBytes($config) } else { [Text.Encoding]::UTF8.GetBytes('{}') }
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
    $encoding = [Text.UTF8Encoding]::new([bool]$bom, $true)
    $offset = if ($bom) { 3 } else { 0 }
    $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
    $hash = if ($exists) { (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash } else { $null }
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    if ($Client -eq 'workbuddy') {
        if ([IO.Path]::GetExtension($config) -ne '.json') { throw 'unsupported_config' }
        $document = $text | ConvertFrom-Json
        if ($null -eq $document -or $document -is [array] -or $document -isnot [pscustomobject]) { throw 'unsupported_config' }
        $entry = $document.mcpServers.shiliu_mcp
        if ($entry) {
            Assert-Remote $entry 'type'
            if ($entry.transport -and $entry.transport -notin @('http','streamableHttp','streamable-http')) { throw 'existing_connection_preserved' }
            $entry | Add-Member -Force NoteProperty type 'streamableHttp'
            if (-not $entry.url) { $entry | Add-Member -Force NoteProperty url $official }
            $entry.PSObject.Properties.Remove('transport')
            $matches = [regex]::Matches($text, '"shiliu_mcp"\s*:\s*\{')
            if ($matches.Count -ne 1) { throw 'ambiguous_config' }
            $start = $matches[0].Index + $matches[0].Length - 1
            $end = Find-ObjectEnd $text $start
            $updated = $text.Substring(0, $start) + ($entry | ConvertTo-Json -Depth 40 -Compress) + $text.Substring($end + 1)
        } else {
            $json = '"shiliu_mcp":{"type":"streamableHttp","url":"' + $official + '"}'
            if ($document.PSObject.Properties['mcpServers']) {
                if ($document.mcpServers -isnot [pscustomobject]) { throw 'unsupported_config' }
                $matches = [regex]::Matches($text, '"mcpServers"\s*:\s*\{')
                if ($matches.Count -ne 1) { throw 'ambiguous_config' }
                $end = Find-ObjectEnd $text ($matches[0].Index + $matches[0].Length - 1)
                $comma = if (@($document.mcpServers.PSObject.Properties).Count) { ',' } else { '' }
                $updated = $text.Insert($end, $comma + $json)
            } else {
                $end = Find-ObjectEnd $text ($text.IndexOf('{'))
                $comma = if (@($document.PSObject.Properties).Count) { ',' } else { '' }
                $updated = $text.Insert($end, $comma + '"mcpServers":{' + $json + '}')
            }
        }
        $null = $updated | ConvertFrom-Json
    } else {
        if ([IO.Path]::GetExtension($config) -notin @('.yml','.yaml')) { throw 'unsupported_config' }
        # Only the documented top-level Cordis plugin list. Complex YAML is left for its owning client.
        $rows = [regex]::Matches($text, '(?m)^- (?=id\s*:)')
        if (-not $rows.Count -or $text.Substring(0, $rows[0].Index) -notmatch '\A(?:\s|#[^\r\n]*(?:\r?\n|$))*\z') { throw 'unsupported_config' }
        $names = [regex]::Matches($text, '(?m)^    serverName:\s*["'']?shiliu_mcp["'']?\s*(?:#.*)?$')
        if ($names.Count -gt 1) { throw 'ambiguous_config' }
        if ($names.Count -eq 1) {
            $start = @($rows | Where-Object { $_.Index -lt $names[0].Index })[-1].Index
            $next = @($rows | Where-Object { $_.Index -gt $names[0].Index })
            $end = if ($next.Count) { $next[0].Index } else { $text.Length }
            $block = $text.Substring($start, $end - $start)
            $safetyBlock = [regex]::Replace($block, '(?m)^    headers:\s*(?:\{\}|null)[ \t]*\r?$', '')
            if ($block -notmatch '(?m)^  name:\s*["'']?@deepseek-ai/dsh-mcp-client["'']?\s*$' -or
                $safetyBlock -match '(?m)^\s+(?:headers|command|args|env)\s*:|^  (?:disabled:\s*true|enabled:\s*false)') { throw 'existing_connection_preserved' }
            $urls = [regex]::Matches($block, '(?m)^    url:\s*["'']?(https://api\.bigbrain\.work/shiliu/mcp(?:/k/sk[-A-Za-z0-9]+)?)["'']?\s*$')
            $transports = [regex]::Matches($block, '(?m)^    transport:\s*["'']?(http|streamableHttp|streamable-http)["'']?\s*$')
            if ($urls.Count -ne 1 -or $transports.Count -ne 1) { throw 'existing_connection_preserved' }
            $newBlock = $block.Substring(0, $transports[0].Groups[1].Index) + 'streamable-http' + $block.Substring($transports[0].Groups[1].Index + $transports[0].Groups[1].Length)
            $updated = $text.Substring(0, $start) + $newBlock + $text.Substring($end)
        } else {
            if ($text -match '(?m)^- id:\s*["'']?shiliu_mcp["'']?\s*$' -or $text -match 'api\.bigbrain\.work/shiliu/mcp') { throw 'ambiguous_config' }
            $updated = $text.TrimEnd("`r", "`n") + $newline + "- id: shiliu_mcp${newline}  name: '@deepseek-ai/dsh-mcp-client'${newline}  config:${newline}    serverName: shiliu_mcp${newline}    transport: streamable-http${newline}    url: $official$newline"
        }
    }
    if ($updated -cne $text) {
        $temporary = $config + '.shiliu-tmp-' + [guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText($temporary, $updated, $encoding)
        if ($exists) {
            if ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ne $hash) { throw 'configuration_changed' }
            [IO.File]::Replace($temporary, $config, ($config + '.shiliu-backup-' + [guid]::NewGuid().ToString('N')))
        } else {
            # Move fails if a concurrent writer created the target; never overwrite it.
            [IO.File]::Move($temporary, $config)
        }
        $temporary = $null; $changed = $true
    }
    if ($UsePersonalUrl) {
        $handoff = Join-Path $PSScriptRoot 'connect-personal.ps1'
        if (-not (Test-Path -LiteralPath $handoff)) { throw 'handoff_helper_missing' }
        & $handoff -ClientName $Client -ConfigPath $config -SkipEditingCredential:$SkipEditingCredential
        return
    }
    @{ state = 'client_configured'; client = $Client; config_updated = $changed; native_mcp_verified = $false;
       next_action = 'verify_native_tools_or_client_oauth' } | ConvertTo-Json
} catch {
    $reason = 'configuration_failed'
    if ($_.Exception.Message -in @('unsupported_config','existing_connection_preserved','ambiguous_config','configuration_changed','handoff_helper_missing')) { $reason = $_.Exception.Message }
    @{ state = 'configuration_failed'; client = $Client; reason = $reason; config_updated = $changed; native_mcp_verified = $false } | ConvertTo-Json
    exit 1
} finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
}
