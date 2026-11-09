param([string]$OutputDirectory = 'build/studio', [string]$PreviousPackage = '')

$ErrorActionPreference = 'Stop'
$studioOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$studioArchives = @(Get-ChildItem -LiteralPath $studioOutput -File -Filter 'LR-Codex-Studio-*-Windows-x64.zip')
if ($studioArchives.Count -ne 1) { throw 'Select a directory with one candidate Windows x64 installer.' }
if (-not $PreviousPackage) {
    $studioBaseline = Join-Path $studioOutput 'baseline'
    [void](New-Item -ItemType Directory -Path $studioBaseline -Force)
    & gh release download v1.0.0 --repo wonderhate/LRhelper --pattern 'LR-Codex-Studio-1.0.0-Windows-x64.zip*' --dir $studioBaseline --skip-existing
    if ($LASTEXITCODE -ne 0) { throw 'Could not retrieve the 1.0.0 Windows release.' }
    $PreviousPackage = Join-Path $studioBaseline 'LR-Codex-Studio-1.0.0-Windows-x64.zip'
    if ((Get-FileHash -LiteralPath $PreviousPackage).Hash -ne 'e5d8344d8f1ac0d3ffea3ce43af401f7b7bc2f113974a264fb8fd42ce6d232e1') {
        throw 'The downloaded baseline does not match the published installer.'
    }
}
$studioTests = Join-Path (Split-Path -Parent $PSScriptRoot) 'studio/tests/windows-release-smoke.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $studioTests -Package $studioArchives[0].FullName -PreviousPackage $PreviousPackage
if ($LASTEXITCODE -ne 0) { throw 'Windows release smoke failed.' }
