#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="$PROJECT_ROOT/.venv"
ACTIVATE_FILE="$VENV_DIR/bin/activate"

SYSTEM_PACKAGES=(
  python3-venv
  python3-pip
  vlc
  libvlc5
  libxcb-cursor0
  libxkbcommon-x11-0
  libxcb-xinerama0
  libxcb-icccm4
  libxcb-image0
  libxcb-keysyms1
  libxcb-randr0
  libxcb-render-util0
  libxcb-shape0
  libxcb-xfixes0
  libxcb-xkb1
  libgl1
)

check_linux_system_deps() {
  if ! command -v dpkg >/dev/null 2>&1; then
    return 0
  fi

  local missing=()
  for pkg in "${SYSTEM_PACKAGES[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing Linux runtime/development packages:"
    printf '  %s\n' "${missing[@]}"
    echo ""
    echo "Install them with:"
    echo "  sudo apt update && sudo apt install -y ${missing[*]}"
    echo ""
    echo "Or run:"
    echo "  ./scripts/install_linux_dev_deps.sh"
    exit 1
  fi
}

create_venv() {
  echo "Creating virtual environment in .venv..."
  rm -rf "$VENV_DIR"

  if ! "$PYTHON_BIN" -m venv "$VENV_DIR"; then
    echo ""
    echo "Could not create the Python virtual environment."
    echo "On Debian/Ubuntu/Linux Mint, install the required packages first:"
    echo "  sudo apt update"
    echo "  sudo apt install -y python3-venv python3-pip"
    exit 1
  fi

  if [ ! -f "$ACTIVATE_FILE" ]; then
    echo ""
    echo "Virtual environment was created incompletely: $ACTIVATE_FILE is missing."
    echo "Fix on Debian/Ubuntu/Linux Mint:"
    echo "  sudo apt update"
    echo "  sudo apt install -y python3-venv python3-pip"
    echo "Then run:"
    echo "  ./run_dev.sh"
    exit 1
  fi
}

check_linux_system_deps

if [ ! -f "$ACTIVATE_FILE" ]; then
  create_venv
fi

# shellcheck disable=SC1090
source "$ACTIVATE_FILE"

python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m app.main
