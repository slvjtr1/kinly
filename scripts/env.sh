# Source this file to get a build environment for Kinly.
# - Rust from rustup (~/.cargo) if not already on PATH.
# - libmpv link library: uses the system libmpv-dev when installed, otherwise a
#   local sysroot prepared by scripts/setup-libmpv-sysroot.sh (no root needed).
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi
KINLY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KINLY_SYSROOT="${KINLY_SYSROOT:-$KINLY_ROOT/.sysroot}"
if [ ! -e /usr/lib/x86_64-linux-gnu/libmpv.so ] && [ -e "$KINLY_SYSROOT/usr/lib/x86_64-linux-gnu/libmpv.so" ]; then
  export LIBRARY_PATH="$KINLY_SYSROOT/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
  export C_INCLUDE_PATH="$KINLY_SYSROOT/usr/include${C_INCLUDE_PATH:+:$C_INCLUDE_PATH}"
fi
export KINLY_ROOT
