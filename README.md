# YouTube AI Assistant

Collaborative workspace for YouTube scripting, descriptions, and thumbnail iteration with AI chat + versioning.

## What it does
- Split-pane workflow (editor + AI chat)
- Channel-specific chats (script / description / thumbnail)
- Thumbnail versioning with subversions (`2.3`, `2.4`)
- Auto thumbnail analysis + improvement generation
- Context usage + manual compaction controls
- Model switching for text models (Claude)
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

Required secrets:
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY` (for Nanobanana image generation)

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
- Text model dropdown switches text responses globally.
- Image generation stays on Nanobanana route.
- Image analysis provider can be switched from top-bar dropdown.
