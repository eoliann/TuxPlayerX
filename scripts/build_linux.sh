#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm install
npm run sync:version
npm run build

echo "Building Linux bundles: DEB and RPM only..."
npm run tauri:build -- --bundles deb,rpm

echo ""
echo "Build outputs:"
find src-tauri/target/release/bundle -maxdepth 3 -type f 2>/dev/null || true
