# YouTube AI Assistant

Collaborative workspace for YouTube scripting, descriptions, and thumbnail iteration with AI chat + versioning.

## What it does
- Split-pane workflow (editor + AI chat)
- Channel-specific chats (script / description / thumbnail)
- Thumbnail versioning with subversions (`2.3`, `2.4`)
- Auto thumbnail analysis + improvement generation
- Context usage + manual compaction controls
- Dedicated **Settings page** for provider keys + model selection
- Dynamic text-model dropdowns (Anthropic/OpenAI/xAI/Gemini/OpenRouter)
- Image analysis provider switch (Claude Vision / Nanobanana)

## Safe open-source setup
This repo is structured to be publish-safe:
- `.env` is ignored
- runtime DBs and uploads are ignored
- backup/scratch files are ignored

### 1) Install
```bash
npm install
```

### 2) Configure env
```bash
cp .env.example .env
# then fill your real keys in .env (do not commit)
```

Recommended secrets (set whichever providers you want to use):
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `XAI_API_KEY`
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY` (also used for Nanobanana image generation)

### 3) Run
```bash
npm start
```

Open: `http://localhost:3000`

## Project layout
- `server.js` — API + streaming chat backend
- `public/` — frontend UI
- `data/thumbnail_research_bible.md` — optional research context for thumbnail guidance
- `uploads/` — user-uploaded assets (ignored)

## Notes
- Thumbnail chat can auto-attach/analyze selected versions.
- Use **⚙️ Settings** to manage API keys and provider/model selection.
- Keys are written to local `.env` (ignored by git) and only masked hints are shown in UI.
- Image generation stays on Nanobanana route.

## Live deploy model (canonical)
The live service now runs directly from this repo path:

- `/root/.openclaw/workspace/projects/youtube-ai-assistant`

That means normal flow is just: edit → commit → push from this same folder.

```bash
cd /root/.openclaw/workspace/projects/youtube-ai-assistant
git add -A
git commit -m "feat: ..."
git push github main
```

## Legacy import helper (publish-safe)
If you ever need a one-time import from another folder, use:

```bash
./scripts/sync-from-live.sh --source <legacy-path>
```

This sync excludes secrets/runtime files using `.syncignore` (`.env`, DB files, uploads, backups, etc.) and is non-destructive by default (keeps repo-only automation files).

## Push helper fallback
If direct SSH/app auth fails, use Vault PAT fallback:

```bash
./scripts/push-github-with-vault.sh github main
```

Expected Vault entry name (fallback mode): `GitHub PAT` (password field = token).

## Cross-platform release artifacts (Linux / Windows / macOS)
A GitHub Actions workflow is included at `.github/workflows/release.yml`.

- Push a tag like `v1.0.1` to trigger packaging on Linux/Windows/macOS.
- Each run uploads OS-specific `.zip` artifacts.
- Tag runs also publish a GitHub Release with all artifacts attached.
