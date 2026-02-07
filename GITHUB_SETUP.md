# GitHub Setup Required

## Current Status
- ✅ Repository initialized locally
- ✅ All changes committed
- ✅ .gitignore configured (node_modules, data, uploads, .env)
- ✅ README.md created with full documentation
- ✅ Remote configured: `https://github.com/damionwoods/nora-writer.git`
- ✅ Branch renamed to `main`
- ❌ Push failed: No GitHub authentication

## What's Needed

### Option 1: Personal Access Token (Recommended)
1. Go to GitHub → Settings → Developer settings → Personal access tokens
2. Generate new token (classic) with `repo` scope
3. Store token in `/root/.openclaw/.secrets.env`:
   ```bash
   GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
   ```
4. Configure git to use token:
   ```bash
   cd /root/.openclaw/nora-writer/
   git remote set-url origin https://damionwoods:${GITHUB_TOKEN}@github.com/damionwoods/nora-writer.git
   git push -u origin main
   ```

### Option 2: SSH Key
1. Generate SSH key: `ssh-keygen -t ed25519 -C "your_email@example.com"`
2. Add to GitHub: Settings → SSH and GPG keys
3. Change remote to SSH:
   ```bash
   cd /root/.openclaw/nora-writer/
   git remote set-url origin git@github.com:damionwoods/nora-writer.git
   git push -u origin main
   ```

### Option 3: gh CLI
1. Install gh: `apt install gh` or download from GitHub
2. Authenticate: `gh auth login`
3. Push: `gh repo create nora-writer --public --source=. --push`

## Repository Details
- **Name**: nora-writer
- **Owner**: damionwoods (assumed — verify correct username)
- **URL**: https://github.com/damionwoods/nora-writer
- **Branch**: main
- **Commits ready**: 3 commits (initial setup, checkpoint, README)

## Next Steps
Once authenticated, simply run:
```bash
cd /root/.openclaw/nora-writer/
git push -u origin main
```

## Note
The repository must be created on GitHub first (either via web UI or gh CLI) before the push will succeed.
