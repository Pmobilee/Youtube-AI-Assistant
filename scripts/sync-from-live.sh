#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_SOURCE="/root/.openclaw/nora-writer"
SOURCE_DIR="$DEFAULT_SOURCE"
PUSH_AFTER_SYNC=0
COMMIT_MSG="chore(sync): mirror safe live changes"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/sync-from-live.sh [--source <path>] [--push] [--message "..."]

Options:
  --source <path>   Source/live project path (default: /root/.openclaw/nora-writer)
  --push            Push commit to current branch after syncing
  --message "..."   Custom commit message

This sync is publish-safe by design:
- Excludes .env, runtime DBs, uploads, backups, and scratch files
- Uses .syncignore from the repo root
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --push)
      PUSH_AFTER_SYNC=1
      shift
      ;;
    --message)
      COMMIT_MSG="${2:-$COMMIT_MSG}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Source directory not found: $SOURCE_DIR" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/.syncignore" ]]; then
  echo ".syncignore not found in $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

# Non-destructive by default: no --delete, so repo-only automation files stay intact.
rsync -a \
  --exclude-from="$REPO_DIR/.syncignore" \
  "$SOURCE_DIR/" "$REPO_DIR/"

# Ensure local .env is never staged even if one appears
if [[ -f "$REPO_DIR/.env" ]]; then
  git restore --staged .env >/dev/null 2>&1 || true
fi

if git diff --quiet && git diff --cached --quiet; then
  echo "No publish-safe changes detected."
  exit 0
fi

git add -A

# Guardrail: never commit .env accidentally
if git diff --cached --name-only | grep -q '^\.env$'; then
  echo "Refusing to commit: .env is staged." >&2
  exit 3
fi

git commit -m "$COMMIT_MSG"
echo "Committed sync: $(git rev-parse --short HEAD)"

if [[ "$PUSH_AFTER_SYNC" -eq 1 ]]; then
  git push
  echo "Pushed to remote."
fi
