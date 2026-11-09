$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'studio-host-common.ps1')
$studioRoot = Split-Path -Parent $PSScriptRoot
$studioRecord = Get-StudioHostRecord
$studioHealth = Get-StudioHostHealth $studioRecord
$studioBridge = if ($studioHealth.ok) {
    try { Invoke-RestMethod -Uri ($studioRecord.url + '/bridge') -Headers @{'X-Studio-Token' = $studioRecord.token} -TimeoutSec 12 -ErrorAction Stop }
    catch { }
}
$studioLogs = Get-StudioLogDirectory $studioRoot
$studioLastLog = Get-ChildItem -LiteralPath $studioLogs -Filter '*.stderr.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
[pscustomobject]@{
    running = $studioHealth.ok -eq $true
    busy = $studioHealth.busy -eq $true
    version = $studioHealth.version
    bridgeVersion = $studioBridge.server_version
    lightroomMcpPluginVersion = $studioBridge.plugin_version
    codexVersion = $studioBridge.codex_version
    bridgeProtocol = $studioBridge.plugin_protocol
    bridgeCompatible = $studioBridge.compatible
    bridgeMessage = $studioBridge.message
    activeRoot = $studioHealth.root
    logDirectory = $studioLogs
    lastErrorLog = $studioLastLog.FullName
} | ConvertTo-Json
