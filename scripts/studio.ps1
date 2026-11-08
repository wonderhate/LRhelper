$studioProjectRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $studioProjectRoot 'studio/dist/cli.js') @args
exit $LASTEXITCODE
