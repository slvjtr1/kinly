#!/usr/bin/env bash
# Run cargo inside src-tauri with the Kinly build environment.
set -euo pipefail
. "$(dirname "$0")/env.sh"
cd "$KINLY_ROOT/src-tauri"
exec cargo "$@"
