#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="${1:-$REPO_DIR}"

# If source differs from repo, import changes first.
if [[ "$(realpath "$SOURCE_DIR")" != "$(realpath "$REPO_DIR")" ]]; then
  "$SCRIPT_DIR/sync-from-live.sh" --source "$SOURCE_DIR" --message "chore(sync): mirror publish-safe live updates"
fi

# Push even if there was no new commit (safe no-op when up to date)
if git -C "$REPO_DIR" push github main; then
  echo "Pushed with current git auth (SSH/app token)."
else
  echo "Direct git push failed; falling back to Vault PAT helper..."
  "$SCRIPT_DIR/push-github-with-vault.sh" github main
fi
