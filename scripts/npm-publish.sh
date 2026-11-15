#!/usr/bin/env bash
# Publish one already-selected release archive.
#
# Publishing is attempted by default (OIDC Trusted Publishing, or NPM_TOKEN
# when configured), and any npm failure is fatal. Set the repository Actions
# variable SKIP_NPM_PUBLISH=true to keep GitHub releases only.
set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: npm-publish.sh <archive.tgz>" >&2
  exit 2
fi

if [ "${SKIP_NPM_PUBLISH:-}" = "true" ]; then
  echo "npm publishing skipped: repository variable SKIP_NPM_PUBLISH=true."
  exit 0
fi

artifact="$1"
if [ ! -s "$artifact" ]; then
  echo "release artifact is missing or empty: $artifact" >&2
  exit 1
fi

if [ -n "${NPM_TOKEN:-}" ]; then
  export NODE_AUTH_TOKEN="$NPM_TOKEN"
fi

npm publish "$artifact" --access public --provenance
status=$?
if [ "$status" -ne 0 ]; then
  echo "::error::npm publish failed (exit $status)." >&2
  exit "$status"
fi
