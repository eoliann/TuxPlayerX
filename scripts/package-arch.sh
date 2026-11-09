#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

deb=TuxPlayerX_amd64.deb
version=$(dpkg-deb -f "$deb" Version)
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$(dpkg-deb -f "$deb" Architecture)" == amd64 ]]
if [[ -n "${RELEASE_TAG:-}" && "$RELEASE_TAG" != "v$version" ]]; then
  echo "Release tag $RELEASE_TAG does not match DEB version $version" >&2
  exit 1
fi

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cp "$deb" "$stage/tuxplayerx_${version}_amd64.deb"
cp LICENSE "$stage/tuxplayerx_${version}_LICENSE"
deb_hash=$(sha256sum "$deb" | cut -d ' ' -f 1)
license_hash=$(sha256sum LICENSE | cut -d ' ' -f 1)
sed -e "s/@VERSION@/$version/g" \
    -e "s/@DEB_SHA256@/$deb_hash/g" \
    -e "s/@LICENSE_SHA256@/$license_hash/g" \
    packaging/arch/PKGBUILD.in > "$stage/PKGBUILD"

docker run --rm --network none --volume "$stage:/package" \
  archlinux:base-devel bash -euc '
    useradd -m builder
    cp /package/* /home/builder/
    cd /home/builder
    chown builder:builder ./*
    runuser -u builder -- makepkg --nodeps --noconfirm
    pacman -Qip ./*.pkg.tar.zst
    cp ./*.pkg.tar.zst /package/
  '

mkdir -p arch-output
cp "$stage/PKGBUILD" "$stage/tuxplayerx-bin-$version-1-x86_64.pkg.tar.zst" arch-output/
