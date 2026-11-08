$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'studio-host-common.ps1')
$studioRoot = Split-Path -Parent $PSScriptRoot

Invoke-WithStudioHostLock {
    $studioRecord = Get-StudioHostRecord
    $studioHealth = Get-StudioHostHealth $studioRecord
    if (-not $studioHealth.ok) {
        if ($studioRecord -and (Get-Process -Id $studioRecord.pid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq node)) {
            throw 'The recorded Studio Host is unresponsive. Inspect its logs and task records.'
        }
        Write-Output 'Studio Host is not running.'
        return
    }
    if ($studioHealth.root -and $studioHealth.root -ne $studioRoot) { throw 'Run the stop script from the active Studio installation.' }
    if ($studioHealth.busy) { throw 'A Lightroom task is active. Wait for it to finish before stopping Studio Host.' }
    $studioStop = Invoke-RestMethod -Method Post -Uri ($studioRecord.url + '/shutdown') -Headers @{'X-Studio-Token' = $studioRecord.token} -ContentType 'application/json' -Body '{}' -TimeoutSec 5
    if (-not $studioStop.ok) { throw 'Studio Host declined shutdown.' }
    $studioProcess = Get-Process -Id $studioRecord.pid -ErrorAction SilentlyContinue
    if ($studioProcess -and -not $studioProcess.WaitForExit(10000)) { throw 'Studio Host has not finished shutting down.' }
    Write-Output 'Studio Host stopped.'
}
