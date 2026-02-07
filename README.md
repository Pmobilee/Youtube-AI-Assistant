# Nora Writer

A collaborative AI-powered video script workspace built for creators. Write, refine, and iterate on video scripts with real-time AI assistance.

## Features

### Core Capabilities
- **Split-Pane Interface**: Simultaneous script editing and AI chat
- **Section References**: Chat about specific script sections (`@section-id`)
- **Per-Video Memory**: Contextual memory that persists across sessions
- **Streaming Responses**: Real-time AI feedback using Claude Opus 4.6
- **Git Integration**: Automatic version control for all script changes

### AI Integration
- Direct Anthropic API integration with Claude Max OAuth
- Adaptive thinking for nuanced responses
- Claude Code tools (bash, edit, read, write)
- System-level context awareness

### Video Management
- Multiple video projects
- Section-based organization
- Markdown-based script format
- Auto-save and version tracking

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite3 (per-video context storage)
- **AI**: Anthropic Claude Opus 4.6 via official SDK
- **Frontend**: Vanilla JS + CSS (no framework overhead)
- **Version Control**: Git with automated commits
- **Authentication**: OAuth token-based (Claude Max)

## Setup

### Prerequisites
- Node.js 18+
- Git
- Anthropic API access (Claude Max OAuth token)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/damionwoods/nora-writer.git
cd nora-writer
```

2. Install dependencies:
```bash
npm install
```

3. Configure authentication:
   - The app uses Anthropic OAuth tokens from `auth-profiles.json`
   - Ensure your Claude Max OAuth token is configured

4. Start the server:
```bash
npm start
```

5. Access the app:
   - Local: `http://localhost:3000`
   - Network: `http://<your-ip>:3000`

### Systemd Service (Production)

The app can run as a systemd service:
```bash
sudo systemctl start nora-writer
sudo systemctl enable nora-writer  # Auto-start on boot
```

## Project Structure

```
nora-writer/
├── server.js           # Main Express server
├── public/
│   ├── index.html      # Main UI
│   ├── script.js       # Frontend logic
│   └── styles.css      # UI styling
├── data/               # Per-video databases (gitignored)
├── uploads/            # User uploads (gitignored)
└── README.md
```

## Usage

### Creating a Video Project
1. Enter a video title
2. Click "Create Video"
3. Start writing in the script pane

### Using Section References
- Reference sections in chat: `@intro` or `@section-2`
- AI will focus responses on that specific section
- Improves contextual relevance

### Memory System
- Each video maintains its own conversation memory
- Context persists across sessions
- Memory stored in `data/<video-id>.db`

## API Endpoints

- `GET /` - Main application
- `GET /api/videos` - List all videos
- `POST /api/videos` - Create new video
- `GET /api/videos/:id` - Get video details
- `PUT /api/videos/:id` - Update video script
- `POST /api/chat/:videoId` - Send chat message (streaming)
- `GET /api/memory/:videoId` - Get video memory
- `POST /api/memory/:videoId` - Add memory entry

## Development

### Debug Mode
Set `NODE_ENV=development` for verbose logging.

### Git Integration
Scripts are automatically committed when saved. View history:
```bash
git log --all --oneline public/scripts/<video-id>.md
```

## Architecture Notes

### OAuth Token Requirements
The Anthropic SDK requires specific headers to work with Claude Max:
- Streaming must be enabled
- Adaptive thinking enabled
- Claude Code tools included
- System prompt must start with "You are Claude Code..."

### Why Not OpenRouter?
OpenRouter is used only for image generation (Gemini Flash). All Claude API calls go through direct Anthropic API to ensure:
- Claude Max benefits (higher rate limits)
- Full Claude Code feature set
- Streaming + adaptive thinking support

## License

MIT

## Credits

Built by Kona 🌺 for Nora's video creation workflow.
