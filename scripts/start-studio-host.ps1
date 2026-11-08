$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'studio-host-common.ps1')
$studioRoot = Split-Path -Parent $PSScriptRoot

Invoke-WithStudioHostLock {
    $studioRecord = Get-StudioHostRecord
    $studioHealth = Get-StudioHostHealth $studioRecord
    if ($studioHealth.ok) {
        if ($studioHealth.root -and $studioHealth.root -ne $studioRoot) { throw 'Another Studio installation owns the Lightroom connection. Stop its Host first.' }
        Write-Output ('Studio Host already running. PID: ' + $studioRecord.pid)
        return
    }
    if ($studioRecord -and (Get-Process -Id $studioRecord.pid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq node)) {
        throw 'The recorded Studio Host process is still running but did not answer. Check its logs before retrying.'
    }
    $studioNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $studioEntry = Join-Path $studioRoot 'studio/dist/cli.js'
    if (-not (Test-Path -LiteralPath $studioEntry -PathType Leaf)) { throw 'Studio build is missing. Install the package or run scripts/setup-studio.ps1.' }
    $studioLogs = Get-StudioLogDirectory $studioRoot
    [void](New-Item -ItemType Directory -Path $studioLogs -Force)
    foreach ($studioKind in @('stdout','stderr')) {
        Get-ChildItem -LiteralPath $studioLogs -Filter ('*.' + $studioKind + '.log') -File |
            Where-Object { $_.Name -match '^\d{8}-\d{6}-\d{3}-[a-f0-9]{8}\.' } |
            Sort-Object Name -Descending | Select-Object -Skip 4 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
    }
    $studioRun = (Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $studioStdout = Join-Path $studioLogs ($studioRun + '.stdout.log')
    $studioStderr = Join-Path $studioLogs ($studioRun + '.stderr.log')
    $studioHost = Start-Process -FilePath $studioNode -ArgumentList @(('"' + $studioEntry + '"'), 'serve') -WorkingDirectory $studioRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $studioStdout -RedirectStandardError $studioStderr
    for ($studioAttempt = 0; $studioAttempt -lt 40; $studioAttempt++) {
        Start-Sleep -Milliseconds 250
        $studioHost.Refresh()
        if ($studioHost.HasExited) { break }
        $studioRecord = Get-StudioHostRecord
        if ($studioRecord.pid -eq $studioHost.Id -and (Get-StudioHostHealth $studioRecord).ok) {
            Write-Output ('Studio Host is ready. PID: ' + $studioHost.Id)
            Write-Output ('Log: ' + $studioStderr)
            return
        }
    }
    throw ('Studio Host did not become ready. See ' + $studioStderr)
}
