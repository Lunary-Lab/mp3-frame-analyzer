#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 1 || $# == 2 ]] || fail 'Expected reviewed Node version and optional offline archive'
version="$1"
case "$version" in 24.22.1|26.12.1) ;; *) fail 'Unsupported Node version' ;; esac
system="$(uname -s)"
machine="$(uname -m)"
[[ "$system/$machine" == Linux/x86_64 ]] || fail 'Node archive requires Linux x86_64'
name="node-v${version}-linux-x64"
archive="$name.tar.gz"
repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
pin="$repository/.github/security/node-archives.sha256"
[[ -f "$pin" && ! -L "$pin" ]] || fail 'Missing regular Node archive checksum file'
mapfile -t records < "$pin"
[[ ${#records[@]} == 2 ]] || fail 'Expected exactly two Node archive checksums'
declare -A checksums
for record in "${records[@]}"; do
  read -r digest filename extra <<< "$record"
  case "$filename" in node-v24.22.1-linux-x64.tar.gz|node-v26.12.1-linux-x64.tar.gz) ;; *) fail 'Invalid Node version/hash binding' ;; esac
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -z "$extra" && ! -v checksums[$filename] ]] || fail 'Invalid or duplicate Node archive checksum'
  checksums["$filename"]="$digest"
done
digest="${checksums[$archive]}"
temporary="${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ "$temporary" == /* && "$temporary" != / && "$temporary" != *:* && "$temporary" != *$'\n'* && "$temporary" != *$'\r'* ]] || fail 'Unsafe runner temporary path'
resolved="$(realpath -- "$temporary")"
[[ -d "$temporary" && "$resolved" == "${temporary%/}" ]] || fail 'Runner temporary path must be a real directory'
directory="${temporary%/}/mp3-verified-node-${version}-${digest}"
mkdir -m 700 -- "$directory"
download="$directory/$archive"
maximum=134217728
if [[ $# == 2 ]]; then
  head -c "$((maximum + 1))" -- "$2" > "$download"
else
  status="$(curl --disable --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 180 --max-filesize "$maximum" --output "$download" --write-out '%{http_code}' "https://nodejs.org/dist/v${version}/$archive")"
  [[ "$status" == 200 ]] || fail 'Node download must return HTTP 200 without redirects'
fi
bytes="$(stat -c %s -- "$download")"
[[ "$bytes" =~ ^[0-9]+$ && "$bytes" -le "$maximum" ]] || fail 'Node archive exceeds the size limit'
(
  cd -- "$directory"
  printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --strict >&2
)
env -i PATH=/usr/bin:/bin tar --extract --gzip --file "$download" --directory "$directory" --no-same-owner --no-same-permissions "$name"
root="$directory/$name"
actual_version="$(env -i PATH="$root/bin:/usr/bin:/bin" HOME="$directory/home" "$root/bin/node" --version)"
[[ "$actual_version" == "v$version" ]] || fail 'Unexpected Node version'
printf '%s\n' "$root"
