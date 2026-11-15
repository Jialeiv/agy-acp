#!/usr/bin/env bash
# Print the only release archive in a directory, or fail.
#
# Release jobs download or create a package archive in a dedicated directory.
# Selecting through a checkout-root glob can pick up stale archives left in the
# repository, so callers use this helper to require exactly one .tgz file.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: release-artifact.sh <directory>" >&2
  exit 2
fi

directory="$1"
if [ ! -d "$directory" ]; then
  echo "release artifact directory does not exist: $directory" >&2
  exit 1
fi

files=()
while IFS= read -r file; do
  files+=("$file")
done < <(find "$directory" -maxdepth 1 -type f -name '*.tgz' -print)

if [ "${#files[@]}" -ne 1 ]; then
  echo "expected exactly one .tgz release artifact in $directory, found ${#files[@]}" >&2
  if [ "${#files[@]}" -gt 0 ]; then
    printf '  %s\n' "${files[@]}" >&2
  fi
  exit 1
fi

archive="${files[0]}"
if [ ! -s "$archive" ]; then
  echo "release artifact is empty: $archive" >&2
  exit 1
fi

printf '%s\n' "$archive"
