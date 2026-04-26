#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="tuxplayerx"
VERSION="$(${PYTHON_BIN:-python3} -S -c 'from app.version import APP_VERSION; print(APP_VERSION)')"
ARCH="amd64"
BUILD_ROOT="build/deb"
PKG_DIR="$BUILD_ROOT/${APP_NAME}_${VERSION}_${ARCH}"
DIST_DIR="dist"

rm -rf "$BUILD_ROOT"
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR/usr/share/$APP_NAME"
mkdir -p "$PKG_DIR/usr/bin"
mkdir -p "$PKG_DIR/usr/share/applications"
mkdir -p "$PKG_DIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$DIST_DIR"

cp -a app "$PKG_DIR/usr/share/$APP_NAME/"
cp requirements.txt README.md LICENSE "$PKG_DIR/usr/share/$APP_NAME/"

cat > "$PKG_DIR/DEBIAN/control" <<EOF_CONTROL
Package: $APP_NAME
Version: $VERSION
Section: video
Priority: optional
Architecture: $ARCH
Depends: python3, python3-pip, python3-venv, vlc, libvlc5, libxcb-cursor0, libxkbcommon-x11-0, libxcb-xinerama0, libxcb-icccm4, libxcb-image0, libxcb-keysyms1, libxcb-randr0, libxcb-render-util0, libxcb-shape0, libxcb-xfixes0, libxcb-xkb1, libgl1
Maintainer: eoliann <https://github.com/eoliann>
Description: Desktop IPTV streaming player using VLC/libVLC
 TuxPlayerX is a desktop player for legal user-provided M3U and MAC subscription sources.
EOF_CONTROL

cat > "$PKG_DIR/DEBIAN/postinst" <<'POSTINST'
#!/usr/bin/env bash
set -e
APP_DIR="/usr/share/tuxplayerx"
VENV_DIR="$APP_DIR/.venv"

if command -v python3 >/dev/null 2>&1; then
  python3 -m venv "$VENV_DIR" || true
  if [ -x "$VENV_DIR/bin/python" ]; then
    "$VENV_DIR/bin/python" -m pip install --upgrade pip || true
    "$VENV_DIR/bin/python" -m pip install -r "$APP_DIR/requirements.txt" || true
  fi
fi

exit 0
POSTINST
chmod 0755 "$PKG_DIR/DEBIAN/postinst"

cat > "$PKG_DIR/usr/bin/$APP_NAME" <<'LAUNCHER'
#!/usr/bin/env bash
set -e
APP_DIR="/usr/share/tuxplayerx"
if [ -x "$APP_DIR/.venv/bin/python" ]; then
  cd "$APP_DIR"
  exec "$APP_DIR/.venv/bin/python" -m app.main
fi
cd "$APP_DIR"
exec python3 -m app.main
LAUNCHER
chmod 0755 "$PKG_DIR/usr/bin/$APP_NAME"

cat > "$PKG_DIR/usr/share/applications/$APP_NAME.desktop" <<EOF_DESKTOP
[Desktop Entry]
Name=TuxPlayerX
Comment=Desktop IPTV streaming player
Exec=$APP_NAME
Icon=$APP_NAME
Terminal=false
Type=Application
Categories=AudioVideo;Player;
StartupNotify=true
EOF_DESKTOP

if [ -f app/assets/icon.png ]; then
  cp app/assets/icon.png "$PKG_DIR/usr/share/icons/hicolor/256x256/apps/$APP_NAME.png"
fi

chmod 0755 "$PKG_DIR/DEBIAN"
chmod 0644 "$PKG_DIR/DEBIAN/control"
chmod 0755 "$PKG_DIR/DEBIAN/postinst"

dpkg-deb --build "$PKG_DIR"
mv "$BUILD_ROOT/${APP_NAME}_${VERSION}_${ARCH}.deb" "$DIST_DIR/"

echo "Built: $DIST_DIR/${APP_NAME}_${VERSION}_${ARCH}.deb"
