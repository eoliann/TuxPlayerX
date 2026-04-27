$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot
npm install
npm run sync:version
npm run build
npm run tauri:build -- --bundles nsis
Write-Host ""
Write-Host "Build outputs are under src-tauri\target\release\bundle\nsis"
