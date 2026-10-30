#!/usr/bin/env bash
# Provide libmpv link files without root: downloads the distro's libmpv-dev
# .deb (headers + pkg-config only, ~40 KB) via apt and extracts it into .sysroot.
# The runtime library itself is the system libmpv2 package.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$ROOT/.sysroot"
if [ -e /usr/lib/x86_64-linux-gnu/libmpv.so ]; then
  echo "[sysroot] system libmpv-dev present; nothing to do"; exit 0
fi
if [ ! -e /usr/lib/x86_64-linux-gnu/libmpv.so.2 ]; then
  echo "[sysroot] libmpv2 runtime missing: sudo apt install libmpv2" >&2; exit 1
fi
mkdir -p "$SYSROOT/debs"
( cd "$SYSROOT/debs" && apt-get download libmpv-dev )
dpkg-deb -x "$SYSROOT"/debs/libmpv-dev_*.deb "$SYSROOT"
ln -sf /usr/lib/x86_64-linux-gnu/libmpv.so.2 "$SYSROOT/usr/lib/x86_64-linux-gnu/libmpv.so"
echo "[sysroot] ready at $SYSROOT"
