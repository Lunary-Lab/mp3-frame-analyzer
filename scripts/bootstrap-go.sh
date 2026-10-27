#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# -le 1 ]] || fail 'Expected at most one offline archive path'
system="$(uname -s)"
machine="$(uname -m)"
[[ "$system/$machine" == Linux/x86_64 ]] || fail 'Go archive requires Linux x86_64'
version=1.27.3
archive="go${version}.linux-amd64.tar.gz"
repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
pin="$repository/.github/security/go-archive.sha256"
[[ -f "$pin" && ! -L "$pin" ]] || fail 'Missing regular Go archive checksum file'
mapfile -t records < "$pin"
[[ ${#records[@]} == 1 ]] || fail 'Expected exactly one Go archive checksum'
read -r digest filename extra <<< "${records[0]}"
[[ "$digest" =~ ^[a-f0-9]{64}$ && "$filename" == "$archive" && -z "$extra" ]] || fail 'Invalid Go version/hash binding'
temporary="${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ "$temporary" == /* && "$temporary" != / && "$temporary" != *:* && "$temporary" != *$'\n'* && "$temporary" != *$'\r'* ]] || fail 'Unsafe runner temporary path'
resolved="$(realpath -- "$temporary")"
[[ -d "$temporary" && "$resolved" == "${temporary%/}" ]] || fail 'Runner temporary path must be a real directory'
directory="${temporary%/}/mp3-verified-go-${version}-${digest}"
mkdir -m 700 -- "$directory"
download="$directory/$archive"
maximum=134217728
if [[ $# == 1 ]]; then
  head -c "$((maximum + 1))" -- "$1" > "$download"
else
  status="$(curl --disable --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 180 --max-filesize "$maximum" --output "$download" --write-out '%{http_code}' "https://dl.google.com/go/$archive")"
  [[ "$status" == 200 ]] || fail 'Go download must return HTTP 200 without redirects'
fi
bytes="$(stat -c %s -- "$download")"
[[ "$bytes" =~ ^[0-9]+$ && "$bytes" -le "$maximum" ]] || fail 'Go archive exceeds the size limit'
(
  cd -- "$directory"
  printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --strict >&2
)
env -i PATH=/usr/bin:/bin tar --extract --gzip --file "$download" --directory "$directory" --no-same-owner --no-same-permissions go
root="$directory/go"
go_command() {
  env -i PATH="$root/bin:/usr/bin:/bin" HOME="$directory/home" XDG_CONFIG_HOME="$directory/config" GOROOT="$root" GOPATH="$directory/gopath" GOENV=off GOWORK=off GOTOOLCHAIN=local GOCACHEPROG= "$root/bin/go" "$@"
}
go_command telemetry off
actual_version="$(go_command env GOVERSION)"
[[ "$actual_version" == "go$version" ]] || fail 'Unexpected Go compiler version'
actual_root="$(go_command env GOROOT)"
[[ "$actual_root" == "$root" ]] || fail 'Unexpected Go compiler root'
printf '%s\n' "$root"
