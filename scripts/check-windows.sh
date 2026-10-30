#!/usr/bin/env bash
# Type-check Kinly for Windows from Linux: `cargo check --target x86_64-pc-windows-gnu`.
# Nothing is linked, so no libmpv is needed. What it sets up, all outside the repo
# (under ${KINLY_XDEV:-~/.cache/kinly-xdev}):
#   - the rustup target x86_64-pc-windows-gnu;
#   - zig (from PyPI, in a venv) as the target C compiler for ring's build script;
#   - a stand-in for x86_64-w64-mingw32-windres that emits an empty COFF object,
#     because tauri-build compiles the .exe resources even for `cargo check`.
# Placeholders for the bundled Windows files (src-tauri/windows/, git-ignored) are
# created when missing, since tauri-build checks that bundle resources exist.
#   bash scripts/check-windows.sh            # lib + bin
#   bash scripts/check-windows.sh --all-targets
set -euo pipefail
. "$(dirname "$0")/env.sh"
X="${KINLY_XDEV:-$HOME/.cache/kinly-xdev}"
TARGET=x86_64-pc-windows-gnu
mkdir -p "$X/bin"

rustup target list --installed | grep -qx "$TARGET" || rustup target add "$TARGET"

if [ ! -x "$X/zig/bin/python" ]; then
  python3 -m venv "$X/zig"
  "$X/zig/bin/pip" install -q ziglang
fi

cat > "$X/bin/zcc" <<EOF
#!/bin/sh
# zig cc for $TARGET; drops the target flag cc-rs adds in rustc spelling.
skip=0
for a; do
  shift
  if [ \$skip = 1 ]; then skip=0; continue; fi
  case "\$a" in
    --target=*) ;;
    -target) skip=1 ;;
    *) set -- "\$@" "\$a" ;;
  esac
done
exec "$X/zig/bin/python" -I -m ziglang cc -target x86_64-windows-gnu "\$@"
EOF
cat > "$X/bin/zar" <<EOF
#!/bin/sh
exec "$X/zig/bin/python" -I -m ziglang ar "\$@"
EOF
: > "$X/bin/empty.c"
cat > "$X/bin/windres" <<EOF
#!/bin/sh
# cargo-check-only stand-in for windres: an empty COFF object, no resources.
out=""; prev=""
for a; do
  case "\$a" in -V) echo "GNU windres (kinly check stub)"; exit 0 ;; esac
  [ "\$prev" = "--output" ] && out="\$a"
  prev="\$a"
done
exec "$X/bin/zcc" -c "$X/bin/empty.c" -o "\$out"
EOF
chmod +x "$X/bin/zcc" "$X/bin/zar" "$X/bin/windres"

W="$KINLY_ROOT/src-tauri/windows"
mkdir -p "$W"
for f in libmpv-2.dll ffmpeg.exe ffmpeg-LICENSE.txt yt-dlp.exe NOTICE-windows.txt; do
  [ -e "$W/$f" ] || : > "$W/$f"
done

export CC_x86_64_pc_windows_gnu="$X/bin/zcc"
export AR_x86_64_pc_windows_gnu="$X/bin/zar"
export RC_x86_64_pc_windows_gnu="$X/bin/windres"
cd "$KINLY_ROOT/src-tauri"
exec cargo check --target "$TARGET" "$@"
