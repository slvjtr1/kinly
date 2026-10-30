#!/usr/bin/env bash
# Build, test and collect Kinly release packages into release/<version>/.
#   bash scripts/release.sh            # tests + build + verify
#   SKIP_TESTS=1 bash scripts/release.sh
set -euo pipefail
. "$(dirname "$0")/env.sh"
cd "$KINLY_ROOT"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
OUT="release/$VERSION"
BUNDLE=src-tauri/target/release/bundle

if [ -z "${SKIP_TESTS:-}" ]; then
  echo "== tests"
  npx tsc --noEmit -p tsconfig.json
  npx vitest run
  bash scripts/cargo.sh test --lib
fi

echo "== build"
# A leftover AppDir from an interrupted build makes linuxdeploy fail.
rm -rf "$BUNDLE/appimage"
npx tauri build

echo "== collect"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$BUNDLE/deb/Kinly_${VERSION}_amd64.deb" "$OUT/"
cp "$BUNDLE/appimage/Kinly_${VERSION}_amd64.AppImage" "$OUT/"
chmod +x "$OUT/Kinly_${VERSION}_amd64.AppImage"
(cd "$OUT" && sha256sum Kinly_* > SHA256SUMS)

echo "== verify"
dpkg-deb --info "$OUT/Kinly_${VERSION}_amd64.deb" | grep -E "Package|Version|Architecture|Depends"
dpkg-deb --contents "$OUT/Kinly_${VERSION}_amd64.deb" | grep -E "usr/bin/kinly|fonts/NotoNaskhArabic-Bold|applications/Kinly.desktop" >/dev/null
file "$OUT/Kinly_${VERSION}_amd64.AppImage" | grep -q "ELF 64-bit"
ls -la "$OUT"
cat "$OUT/SHA256SUMS"
echo "Release ready in $OUT"
