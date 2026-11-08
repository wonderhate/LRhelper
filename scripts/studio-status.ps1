$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'studio-host-common.ps1')
$studioRoot = Split-Path -Parent $PSScriptRoot
$studioRecord = Get-StudioHostRecord
$studioHealth = Get-StudioHostHealth $studioRecord
$studioLogs = Get-StudioLogDirectory $studioRoot
$studioLastLog = Get-ChildItem -LiteralPath $studioLogs -Filter '*.stderr.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
[pscustomobject]@{
    running = $studioHealth.ok -eq $true
    busy = $studioHealth.busy -eq $true
    version = $studioHealth.version
    activeRoot = $studioHealth.root
    logDirectory = $studioLogs
    lastErrorLog = $studioLastLog.FullName
} | ConvertTo-Json
