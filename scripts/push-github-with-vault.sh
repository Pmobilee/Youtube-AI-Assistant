#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="/root/.openclaw/workspace"
VAULT_CLI="$WORKSPACE_DIR/skills/vaultwarden/scripts/vault_secret.sh"
REMOTE_NAME="${1:-github}"
BRANCH_NAME="${2:-main}"
ENTRY_NAME="${3:-}"

if [[ ! -x "$VAULT_CLI" ]]; then
  echo "Vault CLI not found: $VAULT_CLI" >&2
  exit 1
fi

cd "$REPO_DIR"

if [[ -n "$ENTRY_NAME" ]]; then
  CANDIDATES=("$ENTRY_NAME")
else
  CANDIDATES=(
    "GitHub PAT"
    "Github PAT"
    "GitHub Token"
    "Github Token"
    "GitHub Personal Access Token"
  )
fi

TOKEN=""
MATCHED_ENTRY=""
for name in "${CANDIDATES[@]}"; do
  if TOKEN="$($VAULT_CLI get "$name" --field password 2>/dev/null)" && [[ -n "$TOKEN" ]]; then
    MATCHED_ENTRY="$name"
    break
  fi
  TOKEN=""
done

if [[ -z "$TOKEN" ]]; then
  echo "No GitHub PAT found in Vaultwarden."
  echo "Add one entry (e.g., 'GitHub PAT') then rerun:"
  echo "  ./skills/vaultwarden/scripts/vault_secret.sh set \"GitHub PAT\" \"Pmobilee\" \"<token>\" --url \"https://github.com\""
  exit 2
fi

ASKPASS_FILE="$(mktemp)"
cat > "$ASKPASS_FILE" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${GITHUB_PAT}" ;;
  *) echo "" ;;
esac
EOF
chmod +x "$ASKPASS_FILE"
trap 'rm -f "$ASKPASS_FILE"' EXIT

GITHUB_PAT="$TOKEN" \
GIT_TERMINAL_PROMPT=0 \
GIT_ASKPASS="$ASKPASS_FILE" \
git push "$REMOTE_NAME" "$BRANCH_NAME"

echo "Push successful via Vault entry: $MATCHED_ENTRY"
