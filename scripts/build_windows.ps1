$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$AppName = "TuxPlayerX"

if (Test-Path build) {
    Remove-Item -Recurse -Force build
}

if (Test-Path dist) {
    Remove-Item -Recurse -Force dist
}

if (!(Test-Path .venv-win)) {
    Write-Host "Creating Windows virtual environment..."
    python -m venv .venv-win
} else {
    Write-Host "Using existing Windows virtual environment..."
}

$PythonExe = ".\.venv-win\Scripts\python.exe"

Write-Host "Installing dependencies..."
& $PythonExe -m pip install --upgrade pip
& $PythonExe -m pip install -r requirements.txt
& $PythonExe -m pip install pyinstaller

$IconArgs = @()
if (Test-Path "app\assets\icon.ico") {
    $IconArgs = @("--icon", "app\assets\icon.ico")
}

Write-Host "Building $AppName.exe..."

& $PythonExe -m PyInstaller `
    --noconfirm `
    --windowed `
    --name $AppName `
    @IconArgs `
    --add-data "app\assets;app\assets" `
    app\main.py

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code $LASTEXITCODE"
}

$ExePath = "dist\$AppName\$AppName.exe"

if (!(Test-Path $ExePath)) {
    throw "Build failed. Executable was not created: $ExePath"
}

Write-Host ""
Write-Host "Build completed successfully:"
Write-Host $ExePath
Write-Host ""
Write-Host "To build an installer, install Inno Setup and compile:"
Write-Host "packaging\windows\tuxplayerx.iss"