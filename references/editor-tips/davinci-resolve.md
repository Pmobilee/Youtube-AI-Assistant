# DaVinci Resolve Tips & Tricks

> **Last updated:** February 2026 · Covers Resolve 19 (stable) and Resolve 20 (public beta)

---

## Core Concepts

- **Page-based architecture is your superpower.** Resolve splits editing (Cut/Edit), color grading (Color), VFX (Fusion), audio (Fairlight), and delivery into dedicated pages. Master the mindset of switching pages, not panels.
- **Free vs Studio.** The free version caps at 4K/60 fps. Studio ($295 one-time) unlocks 32K/120 fps, HDR10+, the DaVinci Neural Engine AI suite (IntelliTrack, UltraNR, Magic Mask, Speed Warp), multi-GPU rendering, and theatrical DCP output.
- **Node-based color grading.** Unlike layer-based editors, Resolve uses a node graph on the Color page. Think of nodes as modular processing blocks — serial for chained corrections, parallel for blended looks, layer for composited mattes.
- **DaVinci Neural Engine.** The AI backbone behind Magic Mask, IntelliTrack, UltraNR noise reduction, Speed Warp retiming, and (in Resolve 20) IntelliScript, Multicam SmartSwitch, Animated Subtitles, and AI Audio Assistant.
- **Fusion is built in.** Full node-based compositing lives inside Resolve — no round-trip to a separate VFX app. Particle systems, 3D workspace, spline-based animation, and deep image compositing are all native.
- **Fairlight is a full DAW.** Bus routing, ADR tools, immersive audio (Atmos, Auro 3D), loudness metering, and the new AI Audio Assistant in Resolve 20 mean you can skip Pro Tools for many projects.
- **Blackmagic Cloud collaboration.** Host project libraries in the cloud. Editors, colorists, VFX artists, and audio engineers work on the same project simultaneously from anywhere in the world.
- **Database-driven project management.** Resolve stores projects in PostgreSQL (multi-user) or local disk databases — not file-based project files. Understand database backup, cloning, and migration early.
- **ColorSlice six-vector grading (v19+).** A new grading tool that offers intuitive hue-vs-hue, hue-vs-sat, and hue-vs-lum adjustments with a six-vector interface. Faster than fiddling with traditional curves for targeted hue shifts.
- **Resolve 20's Chroma Warp.** An upgrade to the Color Warper that lets you reshape hue and saturation in context — more precise than the original Warper for nuanced color manipulation.

---

## Workflow Wins

- **Proxy workflow for heavy footage.** Right-click clips in the Media Pool → *Generate Proxy Media*. Edit on lightweight proxies; Resolve auto-switches back to full-res at export. The standalone Blackmagic Proxy Generator App can auto-create proxies from watch folders.
- **Text-based editing (v19+).** Transcribe clips on the Edit page, then select and rearrange dialogue from the transcript panel. Resolve 20's **IntelliScript** goes further — import a script file (TXT, SRT, VTT) and the AI builds a timeline from spoken words, distributing multiple takes across layers.
- **Color-match shots instantly.** On the Color page, place a reference still in the viewer, right-click your target node, and select *Shot Match*. The Neural Engine analyzes and balances the grade across shots in one click.
- **Smart Reframe for social crops.** In Studio, apply the *Smart Reframe* Resolve FX to auto-reframe horizontal footage to 9:16 or 1:1. It tracks subjects and keeps them centered. Combine with Resolve 20's automatic vertical timeline layout for a clean social-first workflow.
- **Scene Cut Detection.** Got a flat exported video and need to recover edit points? On the Color page, right-click the clip and select *Scene Cut Detection*. Resolve creates cut points at every detected scene change.
- **Object Removal on the Color page.** Track an unwanted element with a power window, then apply the Object Removal plugin. Run a Scene Analysis — Resolve generates a clean plate and paints the object out across frames.
- **Multicam editing in seconds.** Select synced clips in the Media Pool → right-click → *Create Multicam Clip Using…* (timecode, audio waveform, or In point). Switch angles live during playback on the Edit page.
- **AI Multicam SmartSwitch (Resolve 20).** For multicam timelines, the AI detects who is speaking and auto-cuts to the correct camera angle. Outstanding first pass for interviews and panel discussions.
- **Compound clips for organization.** Select multiple timeline clips → right-click → *New Compound Clip*. Nests them cleanly, keeps the timeline tidy, and lets you apply effects to the group as a whole.
- **Safe Trimming mode (Resolve 20).** On the Cut page, enable Safe Trimming to prevent accidentally overwriting adjacent edits. Drag trim points freely — Resolve pauses at cut boundaries until you intentionally push past.
- **Film Look Creator.** A dedicated Resolve FX that emulates photochemical film processes — halation, bloom, gate weave, and film response curves. Introduced in v19, refined in v20. Instant analog texture without plugins.
- **UltraNR noise reduction (Studio).** On the Color page, open the Spatial NR pane → switch to UltraNR → click *Analyze*. The Neural Engine auto-detects noise levels and sets Luma/Chroma sliders. Far cleaner than manual denoising.
- **Voiceover palette (Resolve 20).** Record voice-over directly in the timeline on the Cut or Edit page with cue, record, and stop controls. It auto-creates a dedicated track, supports prompter scripts and countdowns.
- **Full audio mixer on the Cut page (Resolve 20).** Professional loudness metering, per-channel pan sliders, faders, solo, mute, EQ, dynamics, and FX — mix and monitor audio while you edit on the same page.
- **Magic Mask 2 (Resolve 20).** Brush-based masking with improved detail isolation for faces, arms, and clothing. Combine with secondary color corrections for instant selective grading.
- **Animated Subtitles (Resolve 20).** AI-generated subtitles that animate word-by-word as they're spoken — useful for accessibility and TikTok/Reels-style social content.
- **Speed Warp retiming.** Apply retiming to a clip and switch the Motion Estimation mode to *Speed Warp* (Studio). The Neural Engine generates fewer artifacts and higher visual quality than standard optical flow. *Speed Warp Better* provides the highest quality; *Speed Warp Faster* is quicker to render.
- **Multi-source viewer (Cut page, v19+).** View time-synced footage from multiple cameras simultaneously on the Cut page for faster review and selection.
- **180° VR and spatial video (Resolve 20).** Edit and preview immersive video directly inside Resolve. Includes deep image compositing for 3D passes with embedded Z-depth and alpha.
- **Media Management for archival.** *File → Media Management* lets you consolidate, trim, or transcode project media. Use it to create lean archives of finished projects — just test on small batches first.

---

## Gotchas + Watchouts

- **Don't upgrade mid-project.** Resolve 20 can open v19 projects, but you cannot go back. Always finish or archive a project in the current version before migrating.
- **GPU memory matters.** Fusion and Color page operations are GPU-heavy. 8 GB VRAM is the practical minimum for 4K; 16 GB+ is recommended for Fusion-heavy or 6K+ workflows.
- **Database backups are your safety net.** Resolve doesn't use auto-save project files like Premiere. Manually back up your database regularly: *File → Project Manager → (⋮) → Back Up Database*.
- **Fusion can be RAM-hungry.** Complex node trees with 3D systems and particle effects eat RAM fast. Close unused Fusion comps and purge the cache periodically.
- **Audio sync drift with mixed frame rates.** Mixing 23.98, 25, and 29.97 fps clips on the same timeline can cause subtle audio drift. Transcode to a uniform frame rate or use auto-conform carefully.
- **Optimized Media vs Proxy — know the difference.** Optimized Media transcodes to a higher-quality intermediate (e.g., DNxHR HQ); Proxy is smaller and faster. Use Proxy for rough cuts, Optimized for grading sessions.
- **Free version limitations beyond resolution.** No multi-GPU, no Neural Engine AI tools, no HDR Dolby Vision, no 10-bit H.265 encoding. Know when you need Studio.
- **Rendering RED R3D or BRAW on CPU is slow.** Ensure GPU acceleration is enabled in *Preferences → System → Decode Options* for camera RAW formats.
- **Media Management Tool can be finicky.** It works, but test on small batches before consolidating an entire project. Folder hierarchy preservation sometimes behaves unexpectedly.
- **Resolve 20 Studio pricing may change.** Blackmagic's CEO has hinted free lifetime upgrades may eventually end. For now, the $295 one-time purchase still includes all updates — enjoy it while it lasts.
- **Loading large timelines shows a progress bar (v19+).** Big projects may take a moment to open. Don't panic — it's a feature, not a hang.

---

## Command Palette Cheats

1. **Switch pages fast:** `Shift + 2` (Media), `Shift + 3` (Cut), `Shift + 4` (Edit), `Shift + 5` (Fusion), `Shift + 6` (Color), `Shift + 7` (Fairlight), `Shift + 8` (Deliver).
2. **Full-screen viewer:** `Shift + F` toggles Cinema Viewer on the current page.
3. **Split clip at playhead:** `Ctrl/Cmd + B` (Edit page) or `Ctrl/Cmd + \` (Cut page).
4. **Ripple delete:** Select a clip and press `Backspace/Delete` — the gap closes automatically on the Cut page.
5. **Add Serial node in Color:** `Alt/Option + S`. Parallel: `Alt/Option + P`. Layer: `Alt/Option + L`.
6. **Reset a grade node:** Select the node → right-click → *Reset Node Grade*. `Ctrl/Cmd + D` toggles the node on/off.
7. **Toggle Source/Timeline viewers:** `Q` on the Edit page.
8. **Match frame:** Press `F` with the playhead on a timeline clip to find its source frame in the Media Pool.
9. **Render Cache a clip:** Right-click a timeline clip → *Render Cache Clip* → select quality. Saves real-time re-rendering on playback.
10. **Quick export:** `Ctrl/Cmd + Shift + E` opens the Quick Export dialog from any page — bypass the Deliver page for simple outputs.
11. **Bypass all Color grades:** `Shift + D` toggles all grade nodes on/off for instant before/after comparison.
12. **Select all clips forward:** `Y` on the Edit page selects the clip under the playhead and everything after it.
13. **Power Window shortcuts (Color page):** `Alt/Option + B` (circle), `Alt/Option + C` (curve/pen), `Alt/Option + Q` (linear gradient).
14. **Dynamic Project Switching:** `Ctrl/Cmd + Shift + O` switches between projects in the same database without relaunching Resolve.
15. **Keyframe editor (Resolve 20):** Open the dedicated keyframe editor on Cut or Edit pages to animate parameters with curve control — no need to enter Fusion for simple ramps.
16. **Enable/Disable clip:** `D` toggles the selected clip on/off in the timeline.
17. **Grab a still (Color page):** Right-click the viewer → *Grab Still*. Use stills for shot matching or as grade references.
