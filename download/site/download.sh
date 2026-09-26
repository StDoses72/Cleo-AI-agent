#!/bin/sh
# Download the matching verified desktop package; do not install or launch it.
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
system=$(uname -s)
architecture=$(uname -m)
case "$system" in
  Darwin)
    # An Intel shell under Rosetta still needs the native Apple Silicon package.
    if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = 1 ]; then architecture=arm64; fi
    case "$architecture" in
      arm64) target=macos-arm64 ;;
      x86_64) target=macos-x64 ;;
      *) fail "Unsupported macOS architecture: $architecture" ;;
    esac
    extension=zip ;;
  Linux)
    [ "$architecture" = x86_64 ] || fail "Only Linux x64 is supported (detected $architecture)."
    target=linux-x64
    extension=tar.gz ;;
  *) fail "Unsupported system: $system. Windows users should run download.ps1." ;;
esac

command -v curl >/dev/null 2>&1 || fail 'curl is required.'
if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_file() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail 'sha256sum or shasum is required.'
fi

repository=https://github.com/StDoses72/Cleo-AI-agent
release_url=$(curl -fsSL --retry 2 --connect-timeout 15 --max-time 60 --proto '=https' --proto-redir '=https' \
  -o /dev/null -w '%{url_effective}' "$repository/releases/latest")
case "$release_url" in
  "$repository/releases/tag/"*) version=${release_url##*/} ;;
  *) fail 'GitHub did not return a matching Cleo release.' ;;
esac
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Invalid stable release version.'
archive="Cleo-$target.$extension"
output=${1:-"$HOME/Downloads"}
mkdir -p "$output"
output=$(cd "$output" && pwd)
temporary=$(mktemp -d "$output/.cleo-download.XXXXXXXX")
trap 'rm -rf "$temporary"' 0
trap 'exit 1' HUP INT TERM
base="$repository/releases/download/$version"
curl -fsSL --retry 2 --connect-timeout 15 --max-time 60 --proto '=https' --proto-redir '=https' \
  -o "$temporary/checksum" "$base/Cleo-$target.sha256"
IFS=' ' read -r expected name extra < "$temporary/checksum" || fail 'Invalid checksum file.'
name=${name#\*}
[ "${#expected}" -eq 64 ] && [ "$name" = "$archive" ] && [ -z "$extra" ] || fail 'Unexpected checksum metadata.'
case "$expected" in *[!a-fA-F0-9]*) fail 'Invalid SHA-256 checksum.' ;; esac
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
destination="$output/$archive"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  if [ -f "$destination" ] && [ ! -L "$destination" ] && [ "$(hash_file "$destination")" = "$expected" ]; then
    printf 'Already verified: %s\n' "$destination"
    exit 0
  fi
  fail "A different file already exists at $destination. Choose another output directory."
fi
printf 'Downloading Cleo %s for %s…\n' "$version" "$target"
curl -fL --retry 2 --connect-timeout 15 --max-time 3600 --proto '=https' --proto-redir '=https' \
  -o "$temporary/package" "$base/$archive"
[ "$(hash_file "$temporary/package")" = "$expected" ] || fail 'SHA-256 mismatch; the download was discarded.'
mv -n "$temporary/package" "$destination"
[ ! -e "$temporary/package" ] || fail 'The destination appeared during download; it was not overwritten.'
printf 'Verified download: %s\n' "$destination"
