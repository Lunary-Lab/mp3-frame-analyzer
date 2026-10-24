#!/usr/bin/env bash
set -euo pipefail

if ! command -v betterleaks >/dev/null 2>&1; then
  echo 'Betterleaks is required for the pre-commit secrets check.' >&2
  echo 'Install the pinned v1.9.0 CLI or run npm run hooks:install after provisioning it.' >&2
  exit 1
fi

# The diff is the staged content, not the potentially different worktree.
git diff --cached --binary | betterleaks stdin --git-diff --no-banner
