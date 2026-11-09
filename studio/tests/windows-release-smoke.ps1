param(
    [Parameter(Mandatory = $true)][string]$Package,
    [Parameter(Mandatory = $true)][string]$PreviousPackage,
    [string]$PhotoId
)

$ErrorActionPreference = 'Stop'
function Get-VerifiedZip([string]$File) {
    $studioResolved = (Resolve-Path -LiteralPath $File).Path
    $studioExpected = ((Get-Content -LiteralPath ($studioResolved + '.sha256') -Raw).Trim() -split '\s+')[0]
    if ($studioExpected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $studioResolved -Algorithm SHA256).Hash -ne $studioExpected) { throw 'Package hash mismatch.' }
    return $studioResolved
}
$studioZip = Get-VerifiedZip $Package
$studioPreviousZip = Get-VerifiedZip $PreviousPackage
$studioRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$studioTest = Join-Path $studioRepo ('.studio/release-checks/run ' + [Guid]::NewGuid().ToString('N'))
$studioInstall = Join-Path $studioTest 'clean install'
$studioNew = Join-Path $studioTest 'new package'
$studioOld = Join-Path $studioTest 'previous version fixture'
[void](New-Item -ItemType Directory -Path $studioTest)
Expand-Archive -LiteralPath $studioZip -DestinationPath $studioNew
$studioRelease = Get-Content -LiteralPath (Join-Path $studioNew 'app/release.json') -Raw | ConvertFrom-Json
if (Get-ChildItem -LiteralPath $studioNew -Recurse -Force | Where-Object Name -in @('.studio','host.json','settings.json','job.json','.env','.git')) { throw 'Private workspace material found in package.' }

Expand-Archive -LiteralPath $studioPreviousZip -DestinationPath $studioOld
$studioPriorVersion = (Get-Content -LiteralPath (Join-Path $studioOld 'app/release.json') -Raw | ConvertFrom-Json).version
if ([version]$studioPriorVersion -ge [version]$studioRelease.version) { throw 'Use an earlier released version for the upgrade test.' }

$studioSavedEnv = @{}
$studioVariables = @('STUDIO_HOST_FILE','STUDIO_SETTINGS_FILE','STUDIO_DATA_DIR','STUDIO_MCP_ENTRY')
if (-not $PhotoId) { $studioVariables += @('APPDATA','LIGHTROOM_MCP_TOKEN_PATH','LIGHTROOM_MCP_REQUEST_PORT','LIGHTROOM_MCP_RESPONSE_PORT') }
foreach ($studioVariable in $studioVariables) {
    $studioSavedEnv[$studioVariable] = [Environment]::GetEnvironmentVariable($studioVariable,'Process')
    [Environment]::SetEnvironmentVariable($studioVariable,$null,'Process')
}
$env:STUDIO_HOST_FILE = Join-Path $studioTest 'host.json'
if (-not $PhotoId) {
    $env:APPDATA = Join-Path $studioTest 'isolated appdata'
    $env:LIGHTROOM_MCP_TOKEN_PATH = Join-Path $studioTest 'unused-token'
    $listeners = @(0,1 | ForEach-Object {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start(); $listener
    })
    $env:LIGHTROOM_MCP_REQUEST_PORT = [string]$listeners[0].LocalEndpoint.Port
    $env:LIGHTROOM_MCP_RESPONSE_PORT = [string]$listeners[1].LocalEndpoint.Port
    $listeners | ForEach-Object { $_.Stop() }
}
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
    $studioManifestFile = Join-Path $studioNew 'app/studio/package.json'
    $studioBytes = [IO.File]::ReadAllBytes($studioManifestFile)
    [IO.File]::AppendAllText($studioManifestFile, " ")
    $studioTamperRejected = $false
    try { & (Join-Path $studioNew 'Install.ps1') -InstallRoot $studioInstall }
    catch { if ($_.Exception.Message -notmatch 'does not match the manifest') { throw }; $studioTamperRejected = $true }
    finally { [IO.File]::WriteAllBytes($studioManifestFile,$studioBytes) }
    if (-not $studioTamperRejected -or (Get-ChildItem -LiteralPath $studioInstall -Directory -Filter 'staging-*')) { throw 'A tampered package was not safely rejected.' }
    Assert-StudioVersion $studioPriorVersion
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
    Move-Item -LiteralPath $studioCurrent -Destination (Join-Path $studioInstall 'switching')
    & (Join-Path $studioInstall 'Repair.ps1')
    Assert-StudioVersion $studioRelease.version
    & (Join-Path $studioInstall 'Rollback.ps1')
    Assert-StudioVersion $studioPriorVersion
    if ((Get-Content -LiteralPath $studioSettings -Raw) -ne '{"useSystemProxy":false}' -or (Get-Content -LiteralPath (Join-Path $studioData 'persistence-test.txt') -Raw) -ne 'retained') { throw 'Rollback changed persistent state.' }
    & (Join-Path $studioNew 'Install.ps1') -InstallRoot $studioInstall
    Assert-StudioVersion $studioRelease.version
    if (Get-ChildItem -LiteralPath $studioInstall -Directory | Where-Object Name -match '^(staging|retired)-') { throw 'Update left old or staged versions.' }
    & (Join-Path $studioInstall 'Uninstall.ps1') -Confirm:$false
    if ((Test-Path -LiteralPath $studioCurrent) -or -not (Test-Path -LiteralPath $studioSettings) -or -not (Test-Path -LiteralPath (Join-Path $studioData 'persistence-test.txt'))) {
        throw 'Uninstall did not preserve the user data and remove the runtime.'
    }
    Write-Output ('Windows release smoke passed. Installed root: ' + $studioInstall)
} finally {
    if ((Test-Path -LiteralPath (Join-Path $studioScripts 'stop-studio-host.ps1')) -and (Test-Path -LiteralPath $env:STUDIO_HOST_FILE)) {
        try { & (Join-Path $studioScripts 'stop-studio-host.ps1') }
        catch { Write-Warning $_.Exception.Message }
    }
    foreach ($studioVariable in $studioSavedEnv.Keys) { [Environment]::SetEnvironmentVariable($studioVariable,$studioSavedEnv[$studioVariable],'Process') }
}
