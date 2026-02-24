#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${1:-/root/.openclaw/nora-writer}"

"$SCRIPT_DIR/sync-from-live.sh" --source "$SOURCE_DIR" --message "chore(sync): mirror publish-safe live updates"

# Push even if there was no new commit (safe no-op when up to date)
"$SCRIPT_DIR/push-github-with-vault.sh" github main
