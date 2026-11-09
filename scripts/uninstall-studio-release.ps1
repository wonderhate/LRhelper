[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$InstallRoot = $PSScriptRoot, [switch]$PurgeData)

$ErrorActionPreference = 'Stop'
$studioRoot = [IO.Path]::GetFullPath($InstallRoot)
$studioRootItem = Get-Item -LiteralPath $studioRoot -Force
if (-not $studioRootItem.PSIsContainer -or ($studioRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Select the real Studio installation directory.'
}
. (Join-Path $studioRoot 'studio-host-common.ps1')

Invoke-WithStudioHostLock {
    $studioRecord = Get-StudioHostRecord
    if ((Get-StudioHostHealth $studioRecord).ok -or ($studioRecord -and (Get-Process -Id $studioRecord.pid -ErrorAction SilentlyContinue))) {
        throw 'Wait for active tasks and stop the Studio Host before uninstalling.'
    }
    $studioCurrent = Join-Path $studioRoot 'current'
    $studioRelease = Get-Content -LiteralPath (Join-Path $studioCurrent 'release.json') -Raw | ConvertFrom-Json
    if ($studioRelease.product -ne 'LR Codex Studio') { throw 'The installation cannot be verified.' }
    if (Test-Path -LiteralPath (Join-Path $studioRoot 'switching')) { throw 'Run Repair.ps1 to finish the interrupted update first.' }
    $studioManaged = Get-ChildItem -LiteralPath $studioRoot -Directory |
        Where-Object Name -match '^(current|previous|retired-[a-f0-9]{32})$'
    foreach ($studioDirectory in $studioManaged) {
        $null = Get-StudioRegularFiles $studioDirectory.FullName
        $studioManifest = Get-Content -LiteralPath (Join-Path $studioDirectory.FullName 'release.json') -Raw | ConvertFrom-Json
        if ($studioManifest.product -ne 'LR Codex Studio') { throw 'An unrecognized version directory was kept.' }
    }
    if ($PSCmdlet.ShouldProcess($studioRoot, 'Remove installed LRhelper versions')) {
        foreach ($studioDirectory in $studioManaged) {
            Remove-StudioManagedDirectory $studioRoot $studioDirectory.Name '^(current|previous|retired-[a-f0-9]{32})$'
        }
        foreach ($studioName in @('Rollback.ps1','Repair.ps1','Uninstall.ps1','studio-host-common.ps1')) {
            $studioFile = Join-Path $studioRoot $studioName
            if (Test-Path -LiteralPath $studioFile -PathType Leaf) { Remove-Item -LiteralPath $studioFile -Force }
        }
        if ($PurgeData -and $PSCmdlet.ShouldProcess($studioRoot, 'Delete local settings, default Studio data, and logs permanently')) {
            foreach ($studioName in @('data','logs')) {
                if (Test-Path -LiteralPath (Join-Path $studioRoot $studioName)) { Remove-StudioManagedDirectory $studioRoot $studioName '^(data|logs)$' }
            }
            $studioSettings = Join-Path $studioRoot 'settings.json'
            if (Test-Path -LiteralPath $studioSettings -PathType Leaf) { Remove-Item -LiteralPath $studioSettings -Force }
        }
        Write-Output 'LRhelper application files removed.'
    }
}
