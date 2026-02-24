<p align="center">
  <img src="public/assets/yaa-logo.png" alt="YAA logo" width="160" />
</p>

<h1 align="center">YAA — YouTube AI Assistant</h1>
<p align="center">Your personal video scripting + thumbnail studio. Fast, focused, and built for creators who want momentum.</p>

---

## What is YAA?
YAA is a creator workspace that keeps your script, description, voiceover notes, and thumbnail experiments in one clean flow — with an AI copilot that stays in context. It’s opinionated, quick, and built to reduce the “where was I?” friction when editing videos.

## Core capabilities
- **Multi-channel AI chat** (Script / Description / Thumbnail)
- **Thumbnail versioning** with analysis + improvements per version
- **Long‑Term Findings** (global creative rules that always apply)
- **Editor Tips & Tricks** + **Editor Chat** with dynamic docs context
  - DaVinci Resolve, Premiere Pro, Final Cut Pro, After Effects, CapCut
- **Templates** for repeatable video structures
- **Version history** snapshots + restore
- **Voiceover preview (TTS)** and timing widget
- **Reference board** for links, images, and notes

## Quick start (local)
```bash
npm install
cp .env.example .env
npm start
```
Open: **http://localhost:3000**

## Settings (first run)
Open **⚙️ Settings** and:
1. Pick your **editing app** (DaVinci / Premiere / Final Cut / After Effects / CapCut)
2. Add the **API keys** you want to use (Claude / OpenAI / Grok / Gemini / OpenRouter / optional Ollama key)
3. Choose the **text model** + **image analysis provider**
4. (Optional) set **Ollama base URL** to use local models

Keys are stored only in your local `.env` and never shown in full.

## Ollama (local models)
Want fully local text inference? YAA supports Ollama as a text provider.

1. Install + run Ollama locally
2. Pull models you want (example: `ollama pull llama3.1:8b`)
3. In YAA Settings, pick **Ollama (Local)** as provider
4. Set base URL (default: `http://127.0.0.1:11434`)

YAA will auto-fetch available Ollama models into the model dropdown.

## Editor context (RAG)
When you switch editors, YAA pulls relevant docs context and injects it into the Tips + Editor Chat prompts. If docs aren’t reachable, it falls back to best‑practice context so you’re never blocked.

## Releases
Current status: auto-publishing GitHub Releases is paused while we move to proper installer formats (`.deb`, `.exe`, `.dmg`).

For now, use source + quick start above, or trigger build workflow manually when needed.

## Support
If something feels off or you want a feature, open an issue or just fork and ship it. YAA is meant to be personal and adaptable.
