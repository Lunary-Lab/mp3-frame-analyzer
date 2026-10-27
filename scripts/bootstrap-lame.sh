#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 0 || $# == 2 ]] || fail 'Expected no arguments or both offline LAME source archives'
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || fail 'LAME source profile requires Linux x86_64'
repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
pin="$repository/.github/security/lame-sources.sha256"
[[ -f "$pin" && ! -L "$pin" ]] || fail 'Missing regular LAME source checksum file'
mapfile -t records < "$pin"
[[ ${#records[@]} == 2 ]] || fail 'Expected exactly two LAME source checksums'
declare -A checksums
for record in "${records[@]}"; do
  read -r digest filename extra <<< "$record"
  case "$filename" in lame_3.100.orig.tar.gz|lame_3.100-6build1.debian.tar.xz) ;; *) fail 'Invalid LAME source/version binding' ;; esac
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -z "$extra" && ! -v checksums[$filename] ]] || fail 'Invalid or duplicate LAME source checksum'
  checksums["$filename"]="$digest"
done
source_archive=lame_3.100.orig.tar.gz
patch_archive=lame_3.100-6build1.debian.tar.xz
temporary="${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ "$temporary" == /* && "$temporary" != / && "$temporary" != *:* && "$temporary" != *$'\n'* && "$temporary" != *$'\r'* ]] || fail 'Unsafe runner temporary path'
resolved="$(realpath -- "$temporary")"
[[ -d "$temporary" && "$resolved" == "${temporary%/}" ]] || fail 'Runner temporary path must be a real directory'
directory="${temporary%/}/mp3-verified-lame-3.100-${checksums[$source_archive]}-${checksums[$patch_archive]}"
mkdir -m 700 -- "$directory"
maximum=4194304
for archive in "$source_archive" "$patch_archive"; do
  download="$directory/$archive"
  if [[ $# == 2 ]]; then
    offline="$1"
    [[ "$archive" != "$patch_archive" ]] || offline="$2"
    head -c "$((maximum + 1))" -- "$offline" > "$download"
  else
    status="$(curl --disable --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 180 --max-filesize "$maximum" --output "$download" --write-out '%{http_code}' "https://archive.ubuntu.com/ubuntu/pool/main/l/lame/$archive")"
    [[ "$status" == 200 ]] || fail 'LAME download must return HTTP 200 without redirects'
  fi
  [[ "$(stat -c %s -- "$download")" -le "$maximum" ]] || fail 'LAME source archive exceeds the size limit'
  ( cd -- "$directory"; printf '%s  %s\n' "${checksums[$archive]}" "$archive" | sha256sum --check --strict >&2 )
done
# Both authoritative hashes must pass before any extraction, patch or build command.
env -i PATH=/usr/bin:/bin tar --extract --gzip --file "$directory/$source_archive" --directory "$directory" --no-same-owner --no-same-permissions lame-3.100
env -i PATH=/usr/bin:/bin tar --extract --xz --file "$directory/$patch_archive" --directory "$directory" --no-same-owner --no-same-permissions debian
source="$directory/lame-3.100"
mkdir -m 700 -- "$directory/home" "$source/build"
native=(env -i PATH=/usr/bin:/bin HOME="$directory/home" LC_ALL=C TZ=UTC CONFIG_SITE=/dev/null CC=/usr/bin/cc CXX=/usr/bin/c++ AR=/usr/bin/ar RANLIB=/usr/bin/ranlib)
"${native[@]}" patch --batch --forward --fuzz=0 -d "$source" -p1 --input "$directory/debian/patches/07-field-width-fix.patch" >&2
(
  cd -- "$source/build"
  "${native[@]}" CFLAGS='-O2 -fstack-protector-strong -fno-omit-frame-pointer -D_FORTIFY_SOURCE=3' LDFLAGS='-Wl,-z,relro,-z,now' ac_cv_lib_termcap_initscr=no ac_cv_lib_curses_initscr=no ac_cv_lib_ncurses_initscr=no ac_cv_lib_ffm_cos=no ../configure --disable-shared --enable-static --disable-dynamic-frontends --disable-cpml --with-fileio=lame --without-libiconv-prefix >&2
  "${native[@]}" make -j2 >&2
)
binary="$source/build/frontend/lame"
dynamic="$(env -i PATH=/usr/bin:/bin readelf -d "$binary")"
while IFS= read -r library; do
  case "$library" in ''|libc.so.6|libm.so.6) ;; *) fail 'Unexpected LAME dynamic dependency' ;; esac
done <<< "$(printf '%s\n' "$dynamic" | sed -n 's/.*(NEEDED).*\[\([^]]*\)\].*/\1/p')"
actual_version="$(env -i PATH=/usr/bin:/bin HOME="$directory/home" "$binary" --version)"
[[ "$actual_version" =~ version\ 3\.100([[:space:]]|$) ]] || fail 'Unexpected LAME version'
printf '%s\n' "$binary"
