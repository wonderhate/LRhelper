param(
    [string]$InstallRoot = '',
    [switch]$Rollback,
    [switch]$Repair,
    [switch]$Preflight
)

$ErrorActionPreference = 'Stop'
$studioEntryName = $MyInvocation.MyCommand.Name
if ($studioEntryName -eq 'Rollback.ps1') { $Rollback = $true }
if ($studioEntryName -eq 'Repair.ps1') { $Repair = $true }
if (-not $InstallRoot) {
    $InstallRoot = if ($studioEntryName -in @('Rollback.ps1','Repair.ps1')) { $PSScriptRoot }
        else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'LR Codex Studio' }
}
$studioPayload = Join-Path $PSScriptRoot 'app'
$studioInstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$studioCurrent = Join-Path $studioInstallRoot 'current'
$studioPrevious = Join-Path $studioInstallRoot 'previous'
$studioSwitching = Join-Path $studioInstallRoot 'switching'
$studioCommon = Join-Path $studioPayload 'scripts/studio-host-common.ps1'
if (-not (Test-Path -LiteralPath $studioCommon -PathType Leaf)) { $studioCommon = Join-Path $studioInstallRoot 'studio-host-common.ps1' }
. $studioCommon

if ($Preflight) {
    if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or later for Windows.' }
    $studioRuntime = if (Test-Path -LiteralPath $studioPayload -PathType Container) { $studioPayload } else { $studioCurrent }
    $studioPreflightManifest = Get-Content -LiteralPath (Join-Path $studioRuntime 'release.json') -Raw | ConvertFrom-Json
    $studioPreflightArch = & node.exe -p process.arch
    $studioPreflightMajor = & node.exe -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0 -or [int]$studioPreflightMajor -lt 22 -or $studioPreflightArch -ne $studioPreflightManifest.arch) {
        throw "Install Node.js 22 or later for Windows $($studioPreflightManifest.arch)."
    }
    $studioSavedSettings = $env:STUDIO_SETTINGS_FILE
    try {
        $studioExistingSettings = Join-Path $studioInstallRoot 'settings.json'
        if (-not $studioSavedSettings -and (Test-Path -LiteralPath $studioExistingSettings -PathType Leaf)) { $env:STUDIO_SETTINGS_FILE = $studioExistingSettings }
        & node.exe (Join-Path $studioRuntime 'studio/dist/cli.js') doctor --preflight
        if ($LASTEXITCODE -ne 0) { throw 'See the preflight report for steps to resolve the remaining checks.' }
    } finally { $env:STUDIO_SETTINGS_FILE = $studioSavedSettings }
    return
}

function Read-StudioRelease([string]$Directory, [switch]$Verify) {
    $studioItem = Get-Item -LiteralPath $Directory -ErrorAction Stop
    if (-not $studioItem.PSIsContainer -or ($studioItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Invalid release directory: $Directory" }
    $studioRelease = Get-Content -LiteralPath (Join-Path $Directory 'release.json') -Raw | ConvertFrom-Json
    if ($studioRelease.product -ne 'LR Codex Studio' -or $studioRelease.version -notmatch '^\d+\.\d+\.\d+$' -or $studioRelease.platform -ne 'win32') { throw "Invalid release manifest: $Directory" }
    if ($Verify) {
        $studioPrefix = $studioItem.FullName.TrimEnd('\') + '\'
        $studioFiles = @(Get-StudioRegularFiles $studioItem.FullName | Where-Object FullName -ne (Join-Path $studioItem.FullName 'release.json'))
        if ($studioRelease.schema -eq 2) {
            if ($studioRelease.source.commit -notmatch '^[a-f0-9]{40}$' -or ($studioRelease.source.tag -and $studioRelease.source.tag -ne ('v' + $studioRelease.version)) -or
                -not $studioRelease.files -or $studioFiles.Count -ne @($studioRelease.files.PSObject.Properties).Count) { throw 'Release file list or source identity is invalid.' }
            foreach ($studioFile in $studioFiles) {
                $studioRelative = $studioFile.FullName.Substring($studioPrefix.Length).Replace('\','/')
                $studioExpected = $studioRelease.files.PSObject.Properties[$studioRelative].Value
                if ($studioExpected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $studioFile.FullName -Algorithm SHA256).Hash -ne $studioExpected) {
                    throw "Release file does not match the manifest: $studioRelative"
                }
            }
        } elseif ($null -ne $studioRelease.schema) { throw 'Unsupported release manifest version.' }
    }
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

function Clear-RetiredStudioVersions {
    foreach ($studioRetired in Get-ChildItem -LiteralPath $studioInstallRoot -Directory -Filter 'retired-*') {
        if ($studioRetired.Name -notmatch '^retired-[a-f0-9]{32}$') { continue }
        try {
            $null = Read-StudioRelease $studioRetired.FullName
            Remove-StudioManagedDirectory $studioInstallRoot $studioRetired.Name '^retired-[a-f0-9]{32}$'
        } catch { Write-Warning 'A retired folder could not be verified or cleaned. It was kept.' }
    }
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
    if ($Repair) {
        $studioRepaired = Read-StudioRelease $studioCurrent -Verify
        Clear-RetiredStudioVersions
        Write-Output ('Verified active Studio version: ' + $studioRepaired.version)
        return
    }
    $studioSource = if ($Rollback) { $studioPrevious } else { $studioPayload }
    $studioRelease = Read-StudioRelease $studioSource
    if (-not $Rollback -and $studioRelease.schema -ne 2) { throw 'This installer requires a release manifest with a file inventory.' }
    if ($studioRelease.arch -ne $studioArch) { throw "Package requires Windows Node.js $($studioRelease.arch)." }
    $studioOld = if (Test-Path -LiteralPath $studioCurrent) { Read-StudioRelease $studioCurrent }
    if ($Rollback -and -not $studioOld) { throw 'No current release to roll back.' }
    if (-not $Rollback -and $studioOld -and $studioOld.version -eq $studioRelease.version) {
        Write-Output ('Already installed: ' + $studioRelease.version)
        Write-Output ('Lightroom plug-in: ' + (Join-Path $studioCurrent 'plugin/LRCodexStudio.lrplugin'))
        return
    }
    $studioCandidate = $studioSource
    $studioStagingName = ''
    try {
        if (-not $Rollback) {
            $studioStagingName = 'staging-' + [Guid]::NewGuid().ToString('N')
            $studioCandidate = Join-Path $studioInstallRoot $studioStagingName
            & robocopy.exe $studioSource $studioCandidate /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "Could not stage the Windows release (Robocopy exit $LASTEXITCODE)." }
        }
        $null = Read-StudioRelease $studioCandidate -Verify
        $studioVersion = & node.exe (Join-Path $studioCandidate 'studio/dist/cli.js') --version
        if ($LASTEXITCODE -ne 0 -or $studioVersion -ne $studioRelease.version) { throw 'Package validation failed.' }
        $studioSettings = Join-Path $studioInstallRoot 'settings.json'
        if (-not (Test-Path -LiteralPath $studioSettings)) { [IO.File]::WriteAllText($studioSettings, "{}`n") }
        if ($studioOld) { Move-Item -LiteralPath $studioCurrent -Destination $studioSwitching }
        try { Move-Item -LiteralPath $studioCandidate -Destination $studioCurrent }
        catch { Complete-StudioSwitch; throw }
        Complete-StudioSwitch
        if (-not $Rollback) {
            Copy-Item -LiteralPath (Join-Path $studioCurrent 'scripts/studio-host-common.ps1') -Destination (Join-Path $studioInstallRoot 'studio-host-common.ps1') -Force
            foreach ($studioEntry in @('Rollback.ps1','Repair.ps1')) {
                Copy-Item -LiteralPath (Join-Path $studioCurrent 'scripts/install-studio-release.ps1') -Destination (Join-Path $studioInstallRoot $studioEntry) -Force
            }
            Copy-Item -LiteralPath (Join-Path $studioCurrent 'scripts/uninstall-studio-release.ps1') -Destination (Join-Path $studioInstallRoot 'Uninstall.ps1') -Force
        }
        Clear-RetiredStudioVersions
    } finally {
        if ($studioStagingName -and (Test-Path -LiteralPath $studioCandidate)) {
            Remove-StudioManagedDirectory $studioInstallRoot $studioStagingName '^staging-[a-f0-9]{32}$'
        }
    }
    Write-Output ('Active Studio version: ' + $studioRelease.version)
    Write-Output ('Lightroom plug-in: ' + (Join-Path $studioCurrent 'plugin/LRCodexStudio.lrplugin'))
    Write-Output ('Start Host: ' + (Join-Path $studioCurrent 'scripts/start-studio-host.ps1'))
}
