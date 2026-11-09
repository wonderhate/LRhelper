param([string]$OutputDirectory = '', [string]$Tag = '')

$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $studioRoot 'build/studio' }
$studioOutput = [IO.Path]::GetFullPath($OutputDirectory)
if ($Tag -and $Tag -notmatch '^v\d+\.\d+\.\d+$') { throw 'Use a vX.Y.Z release tag.' }
$studioRef = if ($Tag) { "refs/tags/$Tag" } else { 'HEAD' }
$studioCommit = & git.exe -C $studioRoot rev-parse --verify "$studioRef^{commit}"
if ($LASTEXITCODE -ne 0 -or $studioCommit -notmatch '^[a-f0-9]{40}$') { throw 'Cannot resolve the build source.' }
$studioArch = & node.exe -p process.arch
if ($LASTEXITCODE -ne 0 -or $studioArch -notin @('x64','arm64')) { throw 'A Windows Node.js x64 or arm64 runtime is required.' }
$studioNode = & node.exe --version
$studioNpm = & npm.cmd --version
if ($LASTEXITCODE -ne 0) { throw 'npm is required to build the release.' }

[void](New-Item -ItemType Directory -Path $studioOutput -Force)
$studioStage = Join-Path $studioOutput ('stage-' + [Guid]::NewGuid().ToString('N'))
$studioSourceRoot = Join-Path $studioStage 'source'
$studioPackage = Join-Path $studioStage 'package'
$studioApp = Join-Path $studioPackage 'app'
[void](New-Item -ItemType Directory -Path $studioApp)
$studioTempZip = $studioStage + '.zip'
try {
    $studioSourceZip = Join-Path $studioStage 'source.zip'
    & git.exe -C $studioRoot archive --format=zip -o $studioSourceZip $studioCommit
    if ($LASTEXITCODE -ne 0) { throw 'Could not export the committed source.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($studioSourceZip, $studioSourceRoot)
    $studioVersion = (Get-Content -LiteralPath (Join-Path $studioSourceRoot 'studio/package.json') -Raw | ConvertFrom-Json).version
    if ($studioVersion -notmatch '^\d+\.\d+\.\d+$' -or ($Tag -and $Tag -ne "v$studioVersion")) { throw 'Release tag and package version differ.' }
    $studioVersionParts = $studioVersion.Split('.')
    $studioInfo = Get-Content -LiteralPath (Join-Path $studioSourceRoot 'plugin/LRCodexStudio.lrplugin/Info.lua') -Raw
    if ($studioInfo -notmatch "major = $($studioVersionParts[0]), minor = $($studioVersionParts[1]), revision = $($studioVersionParts[2]),") { throw 'Studio package and plug-in versions differ.' }
    $studioZipName = "LR-Codex-Studio-$studioVersion-Windows-$studioArch.zip"
    $studioZip = Join-Path $studioOutput $studioZipName
    if ((Test-Path -LiteralPath $studioZip) -or (Test-Path -LiteralPath ($studioZip + '.sha256'))) { throw 'The release already exists. Choose a fresh output directory.' }
    foreach ($studioComponent in @('server','studio')) {
        $studioSource = Join-Path $studioSourceRoot $studioComponent
        $studioDestination = Join-Path $studioApp $studioComponent
        if (Test-Path -LiteralPath (Join-Path $studioSource 'dist')) { throw 'Compiled files must not be tracked.' }
        & npm.cmd --prefix $studioSource ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "Build dependency installation failed: $studioComponent" }
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
        Copy-Item -LiteralPath (Join-Path $studioSourceRoot ("plugin/" + $studioBundle)) -Destination $studioPluginDestination -Recurse
    }
    foreach ($studioScript in @('studio-host-common.ps1','start-studio-host.ps1','stop-studio-host.ps1','studio-status.ps1','studio.ps1','install-studio-release.ps1','uninstall-studio-release.ps1')) {
        Copy-Item -LiteralPath (Join-Path $studioSourceRoot ("scripts/" + $studioScript)) -Destination $studioScriptDestination
    }
    Copy-Item -LiteralPath (Join-Path $studioSourceRoot 'scripts/install-studio-release.ps1') -Destination (Join-Path $studioPackage 'Install.ps1')
    Copy-Item -LiteralPath (Join-Path $studioSourceRoot 'docs/studio/RELEASE-WINDOWS.zh-CN.md') -Destination (Join-Path $studioPackage 'README.zh-CN.md')
    Copy-Item -LiteralPath (Join-Path $studioSourceRoot 'LICENSE') -Destination $studioPackage
    $studioFiles = [ordered]@{}
    $studioAppPrefix = $studioApp.TrimEnd('\') + '\'
    $studioPaths = @(Get-ChildItem -LiteralPath $studioApp -Recurse -File -Force | ForEach-Object FullName)
    [Array]::Sort($studioPaths,[StringComparer]::Ordinal)
    foreach ($studioFile in $studioPaths) {
        $studioRelative = $studioFile.Substring($studioAppPrefix.Length).Replace('\','/')
        $studioFiles[$studioRelative] = (Get-FileHash -LiteralPath $studioFile -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $studioManifest = [ordered]@{
        schema = 2; product = 'LR Codex Studio'; version = $studioVersion; platform = 'win32'; arch = $studioArch
        source = [ordered]@{ commit = $studioCommit; tag = $Tag }
        build = [ordered]@{ node = $studioNode; npm = $studioNpm; environment = if ($env:GITHUB_ACTIONS -eq 'true') { 'github-actions/windows' } else { 'local/windows' } }
        files = $studioFiles
    } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $studioApp 'release.json'), $studioManifest)
    $studioPackedVersion = & node.exe (Join-Path $studioApp 'studio/dist/cli.js') --version
    if ($LASTEXITCODE -ne 0 -or $studioPackedVersion -ne $studioVersion) { throw 'Staged Studio runtime did not start.' }
    $studioZipStream = [IO.Compression.ZipFile]::Open($studioTempZip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $studioPaths = @(Get-ChildItem -LiteralPath $studioPackage -Recurse -File -Force | ForEach-Object FullName)
        [Array]::Sort($studioPaths,[StringComparer]::Ordinal)
        $studioPackagePrefix = $studioPackage.TrimEnd('\') + '\'
        foreach ($studioFile in $studioPaths) {
            $studioRelative = $studioFile.Substring($studioPackagePrefix.Length).Replace('\','/')
            $studioEntry = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($studioZipStream,$studioFile,$studioRelative,[IO.Compression.CompressionLevel]::Optimal)
            $studioEntry.LastWriteTime = [DateTimeOffset]::new(1980,1,1,0,0,0,[TimeSpan]::Zero)
        }
    } finally { $studioZipStream.Dispose() }
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
