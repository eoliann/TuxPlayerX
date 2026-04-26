#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

./scripts/build_deb.sh

cat <<'MSG'

Windows .exe cannot be cross-built reliably from Linux with PyInstaller.
Build it on Windows with:
  powershell -ExecutionPolicy Bypass -File scripts/build_windows.ps1

MSG
