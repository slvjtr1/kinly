#!/usr/bin/env bash
# Release metadata for .github/workflows/release.yml (also runnable locally).
#   - checks that tauri.conf.json, package.json and Cargo.toml carry the same
#     plain MAJOR.MINOR.PATCH version (the MSI rejects pre-release labels);
#   - takes the tag from the pushed ref or $INPUT_TAG and checks it is
#     v<version> or v<version>-<label> (v1.0.0-beta, v1.0.0-beta.2, v1.0.0-rc1);
#   - prerelease=true when the tag has a label (v1.1.0-beta, v1.1.0-rc1), and
#     then requires RELEASE_CHANNEL "beta" in src/lib/channel.ts; a plain
#     v<version> tag requires "stable". So the label inside the app matches the release.
# Writes version, tag and prerelease to $GITHUB_OUTPUT (or stdout).
#   INPUT_TAG=v1.0.0-beta bash scripts/release-meta.sh
set -euo pipefail
cd "$(dirname "$0")/.."
err() { echo "::error::$*" >&2; exit 1; }

version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' src-tauri/tauri.conf.json | head -1)
pkg=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -1)
cargo=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
[ -n "$version" ] || err "no version in src-tauri/tauri.conf.json"
if [ "$version" != "$pkg" ] || [ "$version" != "$cargo" ]; then
  err "version mismatch: tauri.conf.json=$version package.json=$pkg Cargo.toml=$cargo"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "version $version must be plain MAJOR.MINOR.PATCH (MSI); put the beta label in the tag"

if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then tag="$GITHUB_REF_NAME"; else tag="${INPUT_TAG:-}"; fi
prerelease=false
if [ -n "$tag" ]; then
  [[ "$tag" == "v$version" || "$tag" =~ ^v${version//./\\.}-[0-9A-Za-z.]+$ ]] \
    || err "tag $tag does not match version $version (expected v$version or v$version-<label>)"
  [ "$tag" = "v$version" ] || prerelease=true
  channel=$(sed -n 's/^export const RELEASE_CHANNEL[^=]*= "\([a-z]*\)";.*/\1/p' src/lib/channel.ts)
  want=$([ "$prerelease" = true ] && echo beta || echo stable)
  [ "$channel" = "$want" ] || err "tag $tag needs RELEASE_CHANNEL \"$want\" in src/lib/channel.ts (found \"$channel\")"
fi

out="${GITHUB_OUTPUT:-/dev/stdout}"
{
  echo "version=$version"
  echo "tag=$tag"
  echo "prerelease=$prerelease"
} >> "$out"
