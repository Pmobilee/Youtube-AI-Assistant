# Feature 5: Git-Diff Style Suggestions — Testing Guide

## Status: ✅ IMPLEMENTED

Feature 5 is fully implemented as of this verification run. All components are in place and working.

## How It Works

### 1. Kona outputs structured suggestions
When Kona wants to suggest changes to script content, she uses this format:

```
<<<SUGGEST tab="script" section="Opening Hook">>>
---OLD---
Welcome to my channel
---NEW---
Hey everyone! Welcome back to the channel
<<<END_SUGGEST>>>
```

### 2. Frontend automatically renders as diff UI
The suggestion appears as an inline diff with:
- 📝 Tab indicator (script/description/voiceover/thumbnails)
- Section context (optional)
- Red "Remove" block showing old text
- Green "Add" block showing new text
- ✓ Accept button (applies the change)
- ✕ Reject button (dismisses the suggestion)

### 3. Accept/Reject actions
- **Accept:** Finds the exact OLD text in the editor and replaces it with NEW text
- **Reject:** Marks the suggestion as dismissed (grayed out)
- **Status feedback:** Shows "✓ Applied", "✗ Dismissed", or "⚠ Text not found"

## Implementation Details

### server.js
- System prompt includes SUGGEST format instructions in `buildSystemPrompt()`
- Instructions inherited by `buildChannelSystemPrompt()` for all chat channels
- Kona knows to use this format for specific text changes

### app.js
- `processSuggestions()` parses SUGGEST blocks using regex
- `acceptSuggestion()` applies changes to CodeMirror editors
- `rejectSuggestion()` dismisses suggestions
- Called automatically in `processMessageContent()` for assistant messages

### style.css
- Complete diff UI styling (green/red backgrounds, button styles, status indicators)
- Dark theme support
- Fade effects for accepted/rejected states

## Testing Scenarios

### Test 1: Basic Script Edit
**Ask Kona:** "Can you suggest a better opening line for the script?"
**Expected:** Kona outputs SUGGEST block → Renders as diff → Accept button works

### Test 2: Multi-tab Suggestions
**Ask Kona:** "Improve the description and thumbnail text"
**Expected:** Multiple SUGGEST blocks, each targeting correct tab

### Test 3: Section Context
**Ask Kona:** "Make the 'Call to Action' section more compelling"
**Expected:** SUGGEST block includes `section="Call to Action"` in header

### Test 4: Edge Cases
- Text already changed → "⚠ Text not found" status
- Multiple suggestions in one message → All render correctly
- Rejected then re-suggested → Works independently

## Access

- **URL:** http://100.84.166.42:3000 (Tailscale)
- **Service:** `systemctl status nora-writer`
- **Logs:** `journalctl -u nora-writer -f`

## Notes

- OLD text must match EXACTLY (including whitespace) for Accept to work
- Suggestions work across all 4 tabs: script, description, voiceover, thumbnails
- Multiple SUGGEST blocks in one message are fully supported
- The feature is channel-aware (works in all 3 chat channels)

---

**Verified:** 2026-02-08 03:17 JST  
**Status:** Production ready ✅
