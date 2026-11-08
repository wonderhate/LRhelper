function Get-StudioHostFile {
    if ($env:STUDIO_HOST_FILE) { return [IO.Path]::GetFullPath($env:STUDIO_HOST_FILE) }
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config/lr-codex-studio/host.json'
}

function Invoke-WithStudioHostLock([scriptblock]$Action) {
    $studioHostPath = (Get-StudioHostFile).ToLowerInvariant()
    $studioSha = [Security.Cryptography.SHA256]::Create()
    try { $studioHash = [BitConverter]::ToString($studioSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($studioHostPath))).Replace('-', '') }
    finally { $studioSha.Dispose() }
    $studioMutex = [Threading.Mutex]::new($false, ('Local\LR-Codex-Studio-' + $studioHash))
    $studioLocked = $false
    try {
        try { $studioLocked = $studioMutex.WaitOne(20000) }
        catch [Threading.AbandonedMutexException] { $studioLocked = $true }
        if (-not $studioLocked) { throw 'Another Studio start, stop or installation is in progress.' }
        & $Action
    } finally {
        if ($studioLocked) { $studioMutex.ReleaseMutex() }
        $studioMutex.Dispose()
    }
}

function Get-StudioHostRecord {
    try {
        $studioRecord = Get-Content -LiteralPath (Get-StudioHostFile) -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($studioRecord.version -eq 1 -and $studioRecord.url -match '^http://127\.0\.0\.1:\d{1,5}$' -and $studioRecord.token -match '^[a-f0-9]{64}$' -and $studioRecord.pid -is [ValueType] -and $studioRecord.pid -gt 0) {
            return $studioRecord
        }
    } catch { }
}

function Get-StudioHostHealth($Record) {
    if ($Record) {
        try { return Invoke-RestMethod -Uri ($Record.url + '/health') -Headers @{'X-Studio-Token' = $Record.token} -TimeoutSec 2 -ErrorAction Stop }
        catch { }
    }
}

function Get-StudioLogDirectory([string]$Root) {
    if (Test-Path -LiteralPath (Join-Path $Root 'release.json') -PathType Leaf) {
        return Join-Path (Split-Path -Parent $Root) 'logs'
    }
    return Join-Path $Root '.studio/logs'
}
