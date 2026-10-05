#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "Cleaning Tauri/Rust/Vite build cache..."
rm -rf src-tauri/target
rm -rf target
rm -rf node_modules/.vite
rm -rf dist
rm -rf .vite
echo "Done. Now run: npm run tauri:dev"
