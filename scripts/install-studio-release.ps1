param(
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'LR Codex Studio'),
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$studioPayload = Join-Path $PSScriptRoot 'app'
. (Join-Path $studioPayload 'scripts/studio-host-common.ps1')
$studioInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$studioCurrent = Join-Path $studioInstallRoot 'current'
$studioPrevious = Join-Path $studioInstallRoot 'previous'
$studioSwitching = Join-Path $studioInstallRoot 'switching'

function Read-StudioRelease([string]$Directory) {
    $studioItem = Get-Item -LiteralPath $Directory -ErrorAction Stop
    if (-not $studioItem.PSIsContainer -or ($studioItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Invalid release directory: $Directory" }
    $studioRelease = Get-Content -LiteralPath (Join-Path $Directory 'release.json') -Raw | ConvertFrom-Json
    if ($studioRelease.product -ne 'LR Codex Studio' -or $studioRelease.version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid release manifest: $Directory" }
    return $studioRelease
}

function Complete-StudioSwitch {
    if (-not (Test-Path -LiteralPath $studioSwitching)) { return }
    $null = Read-StudioRelease $studioSwitching
    if (-not (Test-Path -LiteralPath $studioCurrent)) {
        Move-Item -LiteralPath $studioSwitching -Destination $studioCurrent
        return
    }
    $null = Read-StudioRelease $studioCurrent
    if (Test-Path -LiteralPath $studioPrevious) {
        $null = Read-StudioRelease $studioPrevious
        $studioArchive = Join-Path $studioInstallRoot ('retired-' + [Guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $studioPrevious -Destination $studioArchive
    }
    Move-Item -LiteralPath $studioSwitching -Destination $studioPrevious
}

Invoke-WithStudioHostLock {
    $studioHostRecord = Get-StudioHostRecord
    if ((Get-StudioHostHealth $studioHostRecord).ok -or ($studioHostRecord -and (Get-Process -Id $studioHostRecord.pid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq node))) {
        throw 'Stop the active Studio Host and close the Lightroom workbench before installing, updating, or rolling back.'
    }
    $studioNodeVersion = & node.exe --version
    if ($LASTEXITCODE -ne 0 -or $studioNodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or later for Windows is required.' }
    $studioArch = & node.exe -p process.arch
    [void](New-Item -ItemType Directory -Path $studioInstallRoot -Force)
    if ((Get-Item -LiteralPath $studioInstallRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Choose an installation directory that is not a directory link.' }
    Complete-StudioSwitch
    $studioSource = if ($Rollback) { $studioPrevious } else { $studioPayload }
    $studioRelease = Read-StudioRelease $studioSource
    if ($studioRelease.arch -ne $studioArch) { throw "Package requires Windows Node.js $($studioRelease.arch)." }
    $studioOld = if (Test-Path -LiteralPath $studioCurrent) { Read-StudioRelease $studioCurrent }
    if ($Rollback -and -not $studioOld) { throw 'No current release to roll back.' }
    if (-not $Rollback -and $studioOld -and $studioOld.version -eq $studioRelease.version) {
        Write-Output ('Already installed: ' + $studioRelease.version)
        Write-Output ('Lightroom plug-in: ' + (Join-Path $studioCurrent 'plugin/LRCodexStudio.lrplugin'))
        return
    }
    $studioCandidate = $studioSource
    if (-not $Rollback) {
        $studioCandidate = Join-Path $studioInstallRoot ('staging-' + [Guid]::NewGuid().ToString('N'))
        & robocopy.exe $studioSource $studioCandidate /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Could not stage the Windows release at $studioCandidate (Robocopy exit $LASTEXITCODE)." }
    }
    $studioVersion = & node.exe (Join-Path $studioCandidate 'studio/dist/cli.js') --version
    if ($LASTEXITCODE -ne 0 -or $studioVersion -ne $studioRelease.version) { throw "Package validation failed at $studioCandidate" }
    $studioSettings = Join-Path $studioInstallRoot 'settings.json'
    if (-not (Test-Path -LiteralPath $studioSettings)) { [IO.File]::WriteAllText($studioSettings, "{}`n") }
    if ($studioOld) { Move-Item -LiteralPath $studioCurrent -Destination $studioSwitching }
    try { Move-Item -LiteralPath $studioCandidate -Destination $studioCurrent }
    catch { Complete-StudioSwitch; throw }
    Complete-StudioSwitch
    Write-Output ('Active Studio version: ' + $studioRelease.version)
    Write-Output ('Lightroom plug-in: ' + (Join-Path $studioCurrent 'plugin/LRCodexStudio.lrplugin'))
    Write-Output ('Start Host: ' + (Join-Path $studioCurrent 'scripts/start-studio-host.ps1'))
}
