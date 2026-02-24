# GitHub Setup (Current)

## Current Status
- ✅ Canonical repo path: `/root/.openclaw/workspace/projects/youtube-ai-assistant`
- ✅ Remote `github` configured: `git@github.com:Pmobilee/Youtube-AI-Assistant.git`
- ✅ SSH auth works from Kona VM
- ✅ Main branch is pushable directly from this folder

## Daily Flow (live == git repo)
```bash
cd /root/.openclaw/workspace/projects/youtube-ai-assistant
# make changes
npm test   # optional

git add -A
git commit -m "feat: ..."
git push github main
```

## If push auth ever breaks

### Option A — SSH (preferred)
1. Ensure VM SSH key is in GitHub account SSH keys.
2. Verify:
   ```bash
   ssh -T git@github.com
   ```
3. Push again:
   ```bash
   git push github main
   ```

### Option B — Vault PAT fallback
Store PAT in Vault entry named `GitHub PAT` (password field = token):
```bash
./skills/vaultwarden/scripts/vault_secret.sh set "GitHub PAT" "Pmobilee" "<token>" --url "https://github.com"
```
Then push with helper:
```bash
cd /root/.openclaw/workspace/projects/youtube-ai-assistant
./scripts/push-github-with-vault.sh github main
```

## Repository Details
- **Name**: `Youtube-AI-Assistant`
- **Owner**: `Pmobilee`
- **URL**: `https://github.com/Pmobilee/Youtube-AI-Assistant`
- **Primary branch**: `main`
