$ErrorActionPreference = 'Stop'
$studioProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $studioProjectRoot
try {
    & npm.cmd --prefix server ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'MCP dependency installation failed' }
    & npm.cmd --prefix server run build
    if ($LASTEXITCODE -ne 0) { throw 'MCP build failed' }
    & npm.cmd --prefix studio ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Studio dependency installation failed' }
    & npm.cmd --prefix studio run build
    if ($LASTEXITCODE -ne 0) { throw 'Studio build failed' }
} finally {
    Pop-Location
}
