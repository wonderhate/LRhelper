param(
    [Parameter(Mandatory = $true)][string]$Package,
    [string]$PhotoId
)

$ErrorActionPreference = 'Stop'
$studioZip = (Resolve-Path -LiteralPath $Package).Path
$studioExpectedHash = ((Get-Content -LiteralPath ($studioZip + '.sha256') -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $studioZip -Algorithm SHA256).Hash -ne $studioExpectedHash) { throw 'Package hash mismatch.' }
$studioRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$studioTest = Join-Path $studioRepo ('.studio/release-checks/run ' + [Guid]::NewGuid().ToString('N'))
$studioInstall = Join-Path $studioTest 'clean install'
$studioNew = Join-Path $studioTest 'new package'
$studioOld = Join-Path $studioTest 'previous version fixture'
[void](New-Item -ItemType Directory -Path $studioTest)
Expand-Archive -LiteralPath $studioZip -DestinationPath $studioNew
$studioRelease = Get-Content -LiteralPath (Join-Path $studioNew 'app/release.json') -Raw | ConvertFrom-Json
if (Get-ChildItem -LiteralPath $studioNew -Recurse -Force | Where-Object Name -in @('.studio','host.json','settings.json','job.json','.env','.git')) { throw 'Private workspace material found in package.' }

Copy-Item -LiteralPath $studioNew -Destination $studioOld -Recurse
# Give the previous fixture distinct metadata so the update and rollback are observable.
$studioPriorVersion = '0.9.9'
foreach ($studioRelative in @('app/release.json','app/studio/package.json','app/studio/package-lock.json')) {
    $studioFile = Join-Path $studioOld $studioRelative
    $studioJson = Get-Content -LiteralPath $studioFile -Raw
    [IO.File]::WriteAllText($studioFile, $studioJson.Replace('"' + $studioRelease.version + '"', '"' + $studioPriorVersion + '"'))
}

$studioSavedEnv = @{}
foreach ($studioVariable in @('STUDIO_HOST_FILE','STUDIO_SETTINGS_FILE','STUDIO_DATA_DIR','STUDIO_MCP_ENTRY')) {
    $studioSavedEnv[$studioVariable] = [Environment]::GetEnvironmentVariable($studioVariable,'Process')
    [Environment]::SetEnvironmentVariable($studioVariable,$null,'Process')
}
$env:STUDIO_HOST_FILE = Join-Path $studioTest 'host.json'
$studioCurrent = Join-Path $studioInstall 'current'
$studioScripts = Join-Path $studioCurrent 'scripts'
$studioCli = Join-Path $studioCurrent 'studio/dist/cli.js'

function Assert-StudioVersion([string]$Version) {
    $studioActive = & node.exe $studioCli --version
    if ($LASTEXITCODE -ne 0 -or $studioActive -ne $Version) { throw "Expected $Version, got $studioActive" }
}

try {
    & (Join-Path $studioOld 'Install.ps1') -InstallRoot $studioInstall
    Assert-StudioVersion $studioPriorVersion
    $studioSettings = Join-Path $studioInstall 'settings.json'
    [IO.File]::WriteAllText($studioSettings, '{"useSystemProxy":false}')
    $studioData = Join-Path $studioInstall 'data/jobs'
    [void](New-Item -ItemType Directory -Path $studioData)
    [IO.File]::WriteAllText((Join-Path $studioData 'persistence-test.txt'), 'retained')
    & (Join-Path $studioNew 'Install.ps1') -InstallRoot $studioInstall
    & (Join-Path $studioNew 'Install.ps1') -InstallRoot $studioInstall
    Assert-StudioVersion $studioRelease.version
    $studioConfig = & node.exe $studioCli config | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $studioConfig.useSystemProxy -ne $false -or $studioConfig.jobsDirectory -ne $studioData) { throw 'Installed settings did not persist.' }

    & (Join-Path $studioScripts 'start-studio-host.ps1')
    & (Join-Path $studioScripts 'start-studio-host.ps1')
    $studioStatus = & (Join-Path $studioScripts 'studio-status.ps1') | ConvertFrom-Json
    if (-not $studioStatus.running -or $studioStatus.version -ne $studioRelease.version -or -not (Test-Path -LiteralPath $studioStatus.lastErrorLog)) { throw 'Installed Host did not report readiness or log output.' }
    $studioRefused = $false
    try { & (Join-Path $studioNew 'Install.ps1') -InstallRoot $studioInstall -Rollback }
    catch { if ($_.Exception.Message -notmatch 'Stop the active Studio Host') { throw }; $studioRefused = $true }
    if (-not $studioRefused) { throw 'Installer switched a running Host.' }

    if ($PhotoId) {
        $studioCapture = & node.exe $studioCli doctor --photo $PhotoId | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or -not $studioCapture.ok -or -not (Test-Path -LiteralPath $studioCapture.baseline)) { throw 'Installed Lightroom render check failed.' }
        Write-Output ('Packaged Lightroom read and render succeeded, settings discovered: ' + $studioCapture.capabilities)
    }
    & (Join-Path $studioScripts 'stop-studio-host.ps1')
    & (Join-Path $studioNew 'Install.ps1') -InstallRoot $studioInstall -Rollback
    Assert-StudioVersion $studioPriorVersion
    if ((Get-Content -LiteralPath $studioSettings -Raw) -ne '{"useSystemProxy":false}' -or (Get-Content -LiteralPath (Join-Path $studioData 'persistence-test.txt') -Raw) -ne 'retained') { throw 'Rollback changed persistent state.' }
    & (Join-Path $studioNew 'Install.ps1') -InstallRoot $studioInstall
    Assert-StudioVersion $studioRelease.version
    Write-Output ('Windows release smoke passed. Installed root: ' + $studioInstall)
} finally {
    if ((Test-Path -LiteralPath (Join-Path $studioScripts 'stop-studio-host.ps1')) -and (Test-Path -LiteralPath $env:STUDIO_HOST_FILE)) {
        try { & (Join-Path $studioScripts 'stop-studio-host.ps1') }
        catch { Write-Warning $_.Exception.Message }
    }
    foreach ($studioVariable in $studioSavedEnv.Keys) { [Environment]::SetEnvironmentVariable($studioVariable,$studioSavedEnv[$studioVariable],'Process') }
}
