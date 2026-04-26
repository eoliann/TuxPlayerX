#!/usr/bin/env bash
set -euo pipefail

if ! command -v apt >/dev/null 2>&1; then
  echo "This helper currently supports Debian/Ubuntu/Linux Mint systems with apt."
  exit 1
fi

sudo apt update
sudo apt install -y \
  python3 \
  python3-venv \
  python3-pip \
  vlc \
  libvlc5 \
  libxcb-cursor0 \
  libxkbcommon-x11-0 \
  libxcb-xinerama0 \
  libxcb-icccm4 \
  libxcb-image0 \
  libxcb-keysyms1 \
  libxcb-randr0 \
  libxcb-render-util0 \
  libxcb-shape0 \
  libxcb-xfixes0 \
  libxcb-xkb1 \
  libgl1
