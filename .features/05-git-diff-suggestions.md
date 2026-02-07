# Feature 5/17: Git-Diff Style Suggestions

**Status:** ✅ COMPLETE (verified 2026-02-08 03:00 JST)

## Overview
When Kona suggests changes to the script, they render as inline diffs with Accept/Reject buttons.

## Implementation

### 1. System Prompt (server.js)
Both `buildSystemPrompt()` and `buildChannelSystemPrompt()` include instructions for Kona to use the suggestion format:

```
## Suggesting Text Changes
When suggesting specific text changes to the script, use this format:
<<<SUGGEST tab="script" section="Section Name">>>
---OLD---
exact text to replace
---NEW---
replacement text
<<<END_SUGGEST>>>

You can include multiple SUGGEST blocks in one message. 
The tab can be: script, description, voiceover, thumbnails.
```

### 2. Frontend Parsing (app.js)

**processSuggestions(html)** - Parses `<<<SUGGEST...>>>` blocks and renders them as diff UI
- Extracts: tab, section (optional), oldText, newText
- Generates unique IDs for each suggestion
- Renders with header, diff-body, and action buttons

**acceptSuggestion(id, tab, oldText, newText)** - Applies the suggestion
- Finds the correct editor based on tab name
- Replaces oldText with newText
- Saves video
- Updates UI to show "✓ Applied" status
- Warns if text not found (already changed)

**rejectSuggestion(id)** - Dismisses the suggestion
- Updates UI to show "✗ Dismissed" status
- Dims the suggestion

### 3. Styling (style.css)

Complete diff styling including:
- `.suggestion-diff` - Container with border and rounded corners
- `.diff-header` - Tab label and action buttons
- `.diff-accept` - Green accept button (#22c55e)
- `.diff-reject` - Red reject button (#ef4444)
- `.diff-body` - Monospace container
- `.diff-old` - Red-tinted removal section
- `.diff-new` - Green-tinted addition section
- `.diff-status` - Status labels (accepted/rejected/warn)
- State classes: `.suggestion-accepted`, `.suggestion-rejected`

## Usage

### For Kona:
When suggesting changes, output:
```
<<<SUGGEST tab="script" section="Introduction">>>
---OLD---
Welcome to my channel!
---NEW---
Hey everyone, welcome back to my channel!
<<<END_SUGGEST>>>
```

### For Nora:
1. Kona suggests changes in chat
2. Review the diff (red = remove, green = add)
3. Click "✓ Accept" to apply or "✕ Reject" to dismiss
4. Accepted changes immediately update the editor and auto-save

## Technical Notes

- Suggestions are parsed in `processMessageContent()` after markdown processing
- OLD text must match EXACTLY (including whitespace) for Accept to work
- Multiple suggestions can be in one message
- Editor mapping: script→script-editor, description→description-editor, voiceover→voiceover-editor, thumbnails→thumbnails-editor
- If text not found on Accept, shows warning instead of error

## Testing

To test, have Kona suggest a change to any tab:
1. Ask "Can you suggest improving the intro line?"
2. Verify diff renders with color coding
3. Click Accept and verify editor updates
4. Check auto-save triggers

## Git History
- Initial implementation: 4455efb (2026-02-08 02:21 JST)
- Validation complete: 86a2cd7 (2026-02-08 02:57 JST)
