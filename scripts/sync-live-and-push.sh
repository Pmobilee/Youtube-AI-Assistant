#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${1:-/root/.openclaw/nora-writer}"

"$SCRIPT_DIR/sync-from-live.sh" --source "$SOURCE_DIR" --message "chore(sync): mirror publish-safe live updates"

# Push even if there was no new commit (safe no-op when up to date)
if git -C "$(cd "$SCRIPT_DIR/.." && pwd)" push github main; then
  echo "Pushed with current git auth (SSH/app token)."
else
  echo "Direct git push failed; falling back to Vault PAT helper..."
  "$SCRIPT_DIR/push-github-with-vault.sh" github main
fi
