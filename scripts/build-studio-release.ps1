param([string]$OutputDirectory = '')

$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $studioRoot 'build/studio' }
$studioOutput = [IO.Path]::GetFullPath($OutputDirectory)
$studioVersion = (Get-Content -LiteralPath (Join-Path $studioRoot 'studio/package.json') -Raw | ConvertFrom-Json).version
if ($studioVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected Studio version.' }
$studioArch = & node.exe -p process.arch
if ($LASTEXITCODE -ne 0 -or $studioArch -notin @('x64','arm64')) { throw 'A Windows Node.js x64 or arm64 runtime is required.' }
$studioVersionParts = $studioVersion.Split('.')
$studioInfo = Get-Content -LiteralPath (Join-Path $studioRoot 'plugin/LRCodexStudio.lrplugin/Info.lua') -Raw
if ($studioInfo -notmatch "major = $($studioVersionParts[0]), minor = $($studioVersionParts[1]), revision = $($studioVersionParts[2]),") { throw 'Studio package and plug-in versions differ.' }

[void](New-Item -ItemType Directory -Path $studioOutput -Force)
$studioZipName = "LR-Codex-Studio-$studioVersion-Windows-$studioArch.zip"
$studioZip = Join-Path $studioOutput $studioZipName
if ((Test-Path -LiteralPath $studioZip) -or (Test-Path -LiteralPath ($studioZip + '.sha256'))) { throw 'The release already exists. Choose a fresh output directory.' }
$studioStage = Join-Path $studioOutput ('stage-' + [Guid]::NewGuid().ToString('N'))
$studioApp = Join-Path $studioStage 'app'
[void](New-Item -ItemType Directory -Path $studioApp)
$studioTempZip = $studioStage + '.zip'
try {
    foreach ($studioComponent in @('server','studio')) {
        $studioSource = Join-Path $studioRoot $studioComponent
        $studioDestination = Join-Path $studioApp $studioComponent
        & npm.cmd --prefix $studioSource run build
        if ($LASTEXITCODE -ne 0) { throw "Build failed: $studioComponent" }
        [void](New-Item -ItemType Directory -Path $studioDestination)
        foreach ($studioEntry in @('dist','package.json','package-lock.json')) {
            Copy-Item -LiteralPath (Join-Path $studioSource $studioEntry) -Destination $studioDestination -Recurse
        }
        & npm.cmd --prefix $studioDestination ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "Runtime dependency staging failed: $studioComponent" }
    }
    $studioPluginDestination = Join-Path $studioApp 'plugin'
    $studioScriptDestination = Join-Path $studioApp 'scripts'
    [void](New-Item -ItemType Directory -Path $studioPluginDestination,$studioScriptDestination)
    foreach ($studioBundle in @('LRCodexStudio.lrplugin','LightroomMCP.lrplugin')) {
        Copy-Item -LiteralPath (Join-Path $studioRoot ("plugin/" + $studioBundle)) -Destination $studioPluginDestination -Recurse
    }
    foreach ($studioScript in @('studio-host-common.ps1','start-studio-host.ps1','stop-studio-host.ps1','studio-status.ps1','studio.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $studioScript) -Destination $studioScriptDestination
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-studio-release.ps1') -Destination (Join-Path $studioStage 'Install.ps1')
    Copy-Item -LiteralPath (Join-Path $studioRoot 'docs/studio/RELEASE-WINDOWS.zh-CN.md') -Destination (Join-Path $studioStage 'README.zh-CN.md')
    Copy-Item -LiteralPath (Join-Path $studioRoot 'LICENSE') -Destination $studioStage
    $studioManifest = @{ product = 'LR Codex Studio'; version = $studioVersion; platform = 'win32'; arch = $studioArch } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $studioApp 'release.json'), $studioManifest)
    $studioPackedVersion = & node.exe (Join-Path $studioApp 'studio/dist/cli.js') --version
    if ($LASTEXITCODE -ne 0 -or $studioPackedVersion -ne $studioVersion) { throw 'Staged Studio runtime did not start.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($studioStage,$studioTempZip,[IO.Compression.CompressionLevel]::Optimal,$false)
    Move-Item -LiteralPath $studioTempZip -Destination $studioZip
    $studioHash = (Get-FileHash -LiteralPath $studioZip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(($studioZip + '.sha256'), "$studioHash  $studioZipName`n")
    Write-Output $studioZip
    Write-Output ($studioZip + '.sha256')
} finally {
    $studioResolvedStage = (Resolve-Path -LiteralPath $studioStage).Path
    $studioResolvedOutput = (Resolve-Path -LiteralPath $studioOutput).Path.TrimEnd('\') + '\'
    if ($studioResolvedStage.StartsWith($studioResolvedOutput,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $studioResolvedStage) -match '^stage-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $studioResolvedStage -Recurse -Force
    }
    if (Test-Path -LiteralPath $studioTempZip -PathType Leaf) { Remove-Item -LiteralPath $studioTempZip }
}
