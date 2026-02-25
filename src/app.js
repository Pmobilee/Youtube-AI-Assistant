const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const dotenv = require('dotenv');
const { envFilePath, dataDir, uploadsDir, publicDir } = require('./config/paths');
const { buildModelState: buildModelStateService } = require('./services/modelStateService');
const { createFindingsRouter } = require('./routes/findingsRoutes');
// Native fetch for Node 18+ (fallback for older versions)
const fetch = globalThis.fetch || require('node-fetch');
// child_process kept intentionally unused

dotenv.config({ path: envFilePath });

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// --- Database Setup ---
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const db = new Database(path.join(dataDir, 'nora-writer.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    thumbnail TEXT,
    script_content TEXT DEFAULT '',
    description TEXT DEFAULT '',
    voiceover_notes TEXT DEFAULT '',
    thumbnail_ideas TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS video_memory (
    video_id INTEGER PRIMARY KEY,
    summary TEXT DEFAULT '',
    key_decisions TEXT DEFAULT '[]',
    style_notes TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    channel_type TEXT NOT NULL DEFAULT 'script',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    channel_type TEXT NOT NULL DEFAULT 'script',
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS thumbnail_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    notes TEXT DEFAULT '',
    version_number INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS script_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    label TEXT DEFAULT '',
    script_content TEXT,
    description TEXT,
    voiceover_notes TEXT,
    thumbnail_ideas TEXT,
    created_by TEXT DEFAULT 'auto',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    script_structure TEXT DEFAULT '',
    description_structure TEXT DEFAULT '',
    voiceover_structure TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action_type TEXT NOT NULL,
    details TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS long_term_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL UNIQUE,
    source TEXT DEFAULT 'nora',
    is_archived INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reference_board (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    url TEXT,
    filename TEXT,
    title TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );
`);

// Add token_count column to video_memory (ALTER doesn't support IF NOT EXISTS, so wrap in try/catch)
try {
  db.exec('ALTER TABLE video_memory ADD COLUMN token_count INTEGER DEFAULT 0');
} catch (e) {
  // Column already exists, that's fine
}

// Thumbnail versions schema upgrades
const thumbnailVersionMigrations = [
  'ALTER TABLE thumbnail_versions ADD COLUMN major_version INTEGER DEFAULT 1',
  'ALTER TABLE thumbnail_versions ADD COLUMN minor_version INTEGER DEFAULT 0',
  'ALTER TABLE thumbnail_versions ADD COLUMN parent_version_id INTEGER',
  'ALTER TABLE thumbnail_versions ADD COLUMN source TEXT DEFAULT "upload"',
  'ALTER TABLE thumbnail_versions ADD COLUMN analysis TEXT DEFAULT ""',
  'ALTER TABLE thumbnail_versions ADD COLUMN analysis_provider TEXT DEFAULT ""',
  'ALTER TABLE thumbnail_versions ADD COLUMN analysis_requested_at DATETIME',
  'ALTER TABLE thumbnail_versions ADD COLUMN analysis_updated_at DATETIME',
  'ALTER TABLE thumbnail_versions ADD COLUMN generation_prompt TEXT DEFAULT ""',
];

for (const migration of thumbnailVersionMigrations) {
  try {
    db.exec(migration);
  } catch (e) {
    // already exists
  }
}

// Backfill major/minor for legacy rows
try {
  db.exec('UPDATE thumbnail_versions SET major_version = COALESCE(NULLIF(major_version, 0), version_number), minor_version = COALESCE(minor_version, 0)');
} catch (e) {
  // best effort
}

// Editor assistant tables (legacy table names preserved for compatibility)
db.exec(`
  CREATE TABLE IF NOT EXISTS davinci_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    level INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES davinci_tips(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS davinci_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS davinci_chat_memory (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    summary TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS editor_chat_memory (
    editor_id TEXT PRIMARY KEY,
    summary TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const editorSchemaMigrations = [
  'ALTER TABLE davinci_tips ADD COLUMN editor_id TEXT DEFAULT "davinci-resolve"',
  'ALTER TABLE davinci_chat_messages ADD COLUMN editor_id TEXT DEFAULT "davinci-resolve"',
  'CREATE INDEX IF NOT EXISTS idx_davinci_tips_editor ON davinci_tips(editor_id)',
  'CREATE INDEX IF NOT EXISTS idx_davinci_chat_editor ON davinci_chat_messages(editor_id)',
];

for (const migration of editorSchemaMigrations) {
  try {
    db.exec(migration);
  } catch (e) {
    // already exists
  }
}

try {
  db.exec("UPDATE davinci_tips SET editor_id = 'davinci-resolve' WHERE editor_id IS NULL OR editor_id = ''");
  db.exec("UPDATE davinci_chat_messages SET editor_id = 'davinci-resolve' WHERE editor_id IS NULL OR editor_id = ''");
} catch (e) {
  console.warn('editor_id backfill warning:', e.message);
}

try {
  db.prepare('INSERT OR IGNORE INTO davinci_chat_memory (id, summary) VALUES (1, ?)').run('');
} catch (e) {
  console.warn('davinci_chat_memory init warning:', e.message);
}

function ensureEditorMemory(editorId) {
  try {
    db.prepare('INSERT OR IGNORE INTO editor_chat_memory (editor_id, summary) VALUES (?, ?)').run(editorId, '');
  } catch (e) {
    console.warn('editor_chat_memory ensure warning:', e.message);
  }
}

try {
  ensureEditorMemory('davinci-resolve');
  const legacy = db.prepare('SELECT summary FROM davinci_chat_memory WHERE id = 1').get();
  if (legacy?.summary) {
    db.prepare('UPDATE editor_chat_memory SET summary = COALESCE(NULLIF(summary, ""), ?) WHERE editor_id = ?')
      .run(legacy.summary, 'davinci-resolve');
  }
} catch (e) {
  console.warn('editor_chat_memory init warning:', e.message);
}

// Seed default long-term findings (shared, always-injected guidance)
try {
  db.prepare(`INSERT OR IGNORE INTO long_term_findings (content, source, is_archived, updated_at)
    VALUES (?, 'nora', 0, CURRENT_TIMESTAMP)`).run(
    'Less footage of me just talking in the beginning, quick shots to me are fine, but mostly footage that people want to see and why they clicked.'
  );
} catch (e) {
  console.warn('long_term_findings seed warning:', e.message);
}

// Seed default templates if none exist
const templateCount = db.prepare('SELECT COUNT(*) as c FROM templates').get().c;
if (templateCount === 0) {
  const defaults = [
    { 
      name: 'Vlog', 
      desc: 'Personal vlog format', 
      script: '# Intro\n\nHey everyone!\n\n# Main Content\n\n\n# Outro\n\nThanks for watching!' 
    },
    { 
      name: 'Tutorial', 
      desc: 'Step-by-step tutorial', 
      script: '# Introduction\n\nWhat we\'re building today\n\n# Prerequisites\n\n\n# Step 1\n\n\n# Step 2\n\n\n# Step 3\n\n\n# Conclusion\n\n' 
    },
    { 
      name: 'Documentary', 
      desc: 'Documentary/essay style', 
      script: '# Opening Hook\n\n\n# Context\n\n\n# Investigation\n\n\n# Discovery\n\n\n# Reflection\n\n\n# Closing\n\n' 
    }
  ];
  const ins = db.prepare('INSERT INTO templates (name, description, script_structure) VALUES (?, ?, ?)');
  defaults.forEach(t => ins.run(t.name, t.desc, t.script));
  console.log('✅ Seeded 3 default templates: Vlog, Tutorial, Documentary');
}

// --- Migrate existing messages to channel_messages (one-time) ---
try {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM channel_messages').get().c;
  if (existingCount === 0) {
    const oldMessages = db.prepare('SELECT video_id, role, content, created_at FROM messages').all();
    if (oldMessages.length > 0) {
      const insert = db.prepare('INSERT INTO channel_messages (video_id, channel_type, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
      const migrate = db.transaction(() => {
        for (const m of oldMessages) {
          insert.run(m.video_id, 'script', m.role, m.content, m.created_at);
        }
      });
      migrate();
      console.log(`🔄 Migrated ${oldMessages.length} messages to channel_messages (script)`);
    }
  }
} catch (e) {
  console.error('Migration error (non-fatal):', e.message);
}

// Global memory
const globalMemoryPath = path.join(dataDir, 'global_memory.json');
if (!fs.existsSync(globalMemoryPath)) {
  fs.writeFileSync(globalMemoryPath, JSON.stringify({
    preferences: [],
    common_patterns: [],
    style_notes: []
  }, null, 2));
}

// --- Model clients, runtime settings, and secure local env updates ---
const runtimeSettingsPath = path.join(dataDir, 'runtime_settings.json');
const editorContextCachePath = path.join(dataDir, 'editor_context_cache.json');

const editorCatalog = [
  {
    id: 'davinci-resolve',
    name: 'DaVinci Resolve',
    shortName: 'DaVinci',
    tipsTitle: 'DaVinci Resolve Tips & Tricks',
    chatTitle: 'DaVinci Chat',
    docs: [
      { title: 'DaVinci Resolve Documentation', url: 'https://www.blackmagicdesign.com/products/davinciresolve/training' },
      { title: 'DaVinci Resolve 20 New Features', url: 'https://www.blackmagicdesign.com/products/davinciresolve/whatsnew' },
    ],
    fallbackContext: [
      'Core pages: Cut, Edit, Fusion, Color, Fairlight, Deliver.',
      'Most workflow wins come from timeline organization, proxies/optimized media, and keyboard shortcuts.',
      'Use scoped color workflow with node-based grading and maintain legal levels for delivery.',
    ],
  },
  {
    id: 'premiere-pro',
    name: 'Adobe Premiere Pro',
    shortName: 'Premiere',
    tipsTitle: 'Premiere Pro Tips & Tricks',
    chatTitle: 'Premiere Pro Chat',
    docs: [
      { title: 'Premiere Pro User Guide', url: 'https://helpx.adobe.com/premiere-pro/user-guide.html' },
      { title: 'Premiere Pro Tutorials', url: 'https://helpx.adobe.com/premiere-pro/tutorials.html' },
    ],
    fallbackContext: [
      'Core workflow: Project panel, Source Monitor, Program Monitor, Timeline, Effects Controls.',
      'Use proxies, sequence presets, and adjustment layers for repeatable grading/effects.',
      'Master multicam, nested sequences, and audio essential sound panel for speed.',
    ],
  },
  {
    id: 'final-cut-pro',
    name: 'Final Cut Pro',
    shortName: 'Final Cut',
    tipsTitle: 'Final Cut Pro Tips & Tricks',
    chatTitle: 'Final Cut Pro Chat',
    docs: [
      { title: 'Final Cut Pro User Guide', url: 'https://support.apple.com/guide/final-cut-pro/welcome/mac' },
      { title: 'Final Cut Pro Resources', url: 'https://www.apple.com/final-cut-pro/resources/' },
    ],
    fallbackContext: [
      'Magnetic timeline, libraries/events/projects structure, and roles-based audio are core concepts.',
      'Use keywords and smart collections for fast media retrieval.',
      'Leverage compound clips and adjustment layers for reusable edits.',
    ],
  },
  {
    id: 'after-effects',
    name: 'After Effects',
    shortName: 'After Effects',
    tipsTitle: 'After Effects Tips & Tricks',
    chatTitle: 'After Effects Chat',
    docs: [
      { title: 'After Effects User Guide', url: 'https://helpx.adobe.com/after-effects/user-guide.html' },
      { title: 'After Effects Tutorials', url: 'https://helpx.adobe.com/after-effects/tutorials.html' },
    ],
    fallbackContext: [
      'Composition hierarchy, precomps, and timing/keyframes are foundational.',
      'Use graph editor, easy ease, and motion blur for polished animation.',
      'Optimize renders with proxies/pre-renders and organized project panels.',
    ],
  },
  {
    id: 'capcut',
    name: 'CapCut',
    shortName: 'CapCut',
    tipsTitle: 'CapCut Tips & Tricks',
    chatTitle: 'CapCut Chat',
    docs: [
      { title: 'CapCut Help Center', url: 'https://www.capcut.com/resource' },
      { title: 'CapCut Editing Guides', url: 'https://www.capcut.com/tools' },
    ],
    fallbackContext: [
      'Prioritize quick template flows, auto captions, and fast social exports.',
      'Use effect stacks conservatively to preserve clarity on mobile viewers.',
      'Keep hook pacing tight in the first 2–3 seconds for short-form platforms.',
    ],
  },
];

const editorById = Object.fromEntries(editorCatalog.map(editor => [editor.id, editor]));
const defaultEditorId = editorCatalog[0].id;

const textProviderCatalog = [
  { id: 'anthropic', label: 'Claude (Anthropic)', envKey: 'ANTHROPIC_API_KEY', requiresKey: true },
  { id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY', requiresKey: true },
  { id: 'xai', label: 'Grok (xAI)', envKey: 'XAI_API_KEY', requiresKey: true },
  { id: 'gemini', label: 'Gemini (Google AI Studio)', envKey: 'GEMINI_API_KEY', requiresKey: true },
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', requiresKey: true },
  { id: 'ollama', label: 'Ollama (Local)', envKey: 'OLLAMA_API_KEY', requiresKey: false, baseUrlKey: 'OLLAMA_BASE_URL' },
];

const textProviderIds = textProviderCatalog.map(p => p.id);

const defaultProviderModels = {
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
  openai: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'],
  xai: ['grok-4-0709', 'grok-3-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  openrouter: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'openai/gpt-5-mini'],
  ollama: ['llama3.1:8b', 'qwen2.5:7b', 'mistral:7b'],
};

function uniqStrings(items) {
  return [...new Set((items || []).filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
}

function parseCsv(value, fallback = []) {
  const parsed = String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

const staticAnthropicModelOptions = parseCsv(
  process.env.NORA_WRITER_MODEL_OPTIONS,
  defaultProviderModels.anthropic
);

const pinnedAnthropicModels = parseCsv(
  process.env.NORA_WRITER_MODEL_PINNED,
  defaultProviderModels.anthropic
);

const providerFallbackModels = {
  anthropic: uniqStrings([...pinnedAnthropicModels, ...staticAnthropicModelOptions, ...defaultProviderModels.anthropic]),
  openai: parseCsv(process.env.NORA_WRITER_OPENAI_MODEL_OPTIONS, defaultProviderModels.openai),
  xai: parseCsv(process.env.NORA_WRITER_XAI_MODEL_OPTIONS, defaultProviderModels.xai),
  gemini: parseCsv(process.env.NORA_WRITER_GEMINI_MODEL_OPTIONS, defaultProviderModels.gemini),
  openrouter: parseCsv(process.env.NORA_WRITER_OPENROUTER_TEXT_MODELS, defaultProviderModels.openrouter),
  ollama: parseCsv(process.env.NORA_WRITER_OLLAMA_MODEL_OPTIONS, defaultProviderModels.ollama),
};

function loadRuntimeSettings() {
  try {
    if (fs.existsSync(runtimeSettingsPath)) {
      return JSON.parse(fs.readFileSync(runtimeSettingsPath, 'utf-8')) || {};
    }
  } catch (err) {
    console.warn('Could not load runtime settings:', err.message);
  }
  return {};
}

function saveRuntimeSettings(next) {
  try {
    fs.writeFileSync(runtimeSettingsPath, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('Could not save runtime settings:', err.message);
  }
}

function parseEnvLine(line) {
  const match = String(line || '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) return null;
  let value = match[2] ?? '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key: match[1], value };
}

function formatEnvValue(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (/\s|#|"|'/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function applyEnvValue(key, value) {
  if (!key) return;
  if (value === '' || value === null || value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = String(value);
}

function updateEnvFile(updates = {}) {
  const keys = Object.keys(updates || {});
  if (!keys.length) return;

  const existing = fs.existsSync(envFilePath)
    ? fs.readFileSync(envFilePath, 'utf-8').split(/\r?\n/)
    : [];

  const updateSet = new Set(keys);
  const retained = existing.filter(line => {
    const parsed = parseEnvLine(line);
    if (!parsed) return true;
    return !updateSet.has(parsed.key);
  });

  for (const key of keys) {
    const nextValue = updates[key];
    if (nextValue === undefined) continue;
    if (nextValue === '' || nextValue === null) {
      applyEnvValue(key, '');
      continue;
    }
    retained.push(`${key}=${formatEnvValue(nextValue)}`);
    applyEnvValue(key, String(nextValue).trim());
  }

  const out = retained.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  fs.writeFileSync(envFilePath, out ? `${out}\n` : '');
}

function maskSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 4) return '••••';
  return `••••${raw.slice(-4)}`;
}

const runtimeSettings = loadRuntimeSettings();

const defaultUserName = String(process.env.NORA_WRITER_USER_NAME || 'Nora').trim() || 'Nora';
let profileName = String(runtimeSettings.profileName || defaultUserName).trim() || defaultUserName;

function getProfileName() {
  return profileName;
}

runtimeSettings.profileName = profileName;

let selectedEditorId = runtimeSettings.selectedEditorId || process.env.NORA_WRITER_EDITOR || defaultEditorId;
if (!editorById[selectedEditorId]) {
  selectedEditorId = defaultEditorId;
}

function getEditorById(editorId) {
  const normalized = String(editorId || '').trim();
  return editorById[normalized] || editorById[defaultEditorId];
}

function getSelectedEditor() {
  return getEditorById(selectedEditorId);
}

function listEditors() {
  return editorCatalog.map(editor => ({
    id: editor.id,
    name: editor.name,
    shortName: editor.shortName,
    chatTitle: editor.chatTitle,
    tipsTitle: editor.tipsTitle,
    docsCount: editor.docs.length,
  }));
}

function normalizeEditorId(editorId) {
  const editor = getEditorById(editorId);
  return editor.id;
}

function loadEditorContextCache() {
  try {
    if (fs.existsSync(editorContextCachePath)) {
      const parsed = JSON.parse(fs.readFileSync(editorContextCachePath, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.warn('Could not load editor context cache:', err.message);
  }
  return {};
}

function saveEditorContextCache(cache) {
  try {
    fs.writeFileSync(editorContextCachePath, JSON.stringify(cache || {}, null, 2));
  } catch (err) {
    console.warn('Could not save editor context cache:', err.message);
  }
}

function stripHtmlToText(input) {
  const html = String(input || '');
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkText(text, maxLen = 1200, overlap = 180) {
  const src = String(text || '').trim();
  if (!src) return [];

  const chunks = [];
  let idx = 0;
  while (idx < src.length) {
    const end = Math.min(src.length, idx + maxLen);
    const slice = src.slice(idx, end).trim();
    if (slice) chunks.push(slice);
    if (end >= src.length) break;
    idx = Math.max(0, end - overlap);
  }
  return chunks;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => token.length > 2);
}

function scoreChunk(chunk, terms) {
  const hay = String(chunk || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const hits = hay.split(term).length - 1;
    if (hits > 0) score += hits * Math.min(term.length, 10);
  }
  return score;
}

let editorContextCache = loadEditorContextCache();

function getEditorContextMeta(editorId) {
  const normalized = normalizeEditorId(editorId);
  const row = editorContextCache[normalized] || {};
  return {
    editorId: normalized,
    fetchedAt: row.fetchedAt || null,
    chunks: Array.isArray(row.chunks) ? row.chunks.length : 0,
    sourceCount: Array.isArray(row.sources) ? row.sources.length : 0,
    fallbackUsed: Boolean(row.fallbackUsed),
  };
}

async function refreshEditorContext(editorId, { force = false } = {}) {
  const editor = getEditorById(editorId);
  const normalized = editor.id;
  const now = Date.now();
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  const existing = editorContextCache[normalized];

  if (!force && existing?.fetchedAt && (now - existing.fetchedAt) < ttlMs && Array.isArray(existing.chunks) && existing.chunks.length > 0) {
    return getEditorContextMeta(normalized);
  }

  const sources = [];
  const chunks = [];

  for (const source of editor.docs) {
    try {
      const response = await fetch(source.url, {
        headers: {
          'User-Agent': 'YAA-Docs-Fetcher/1.0 (+https://github.com/Pmobilee/Youtube-AI-Assistant)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        sources.push({ title: source.title, url: source.url, ok: false, status: response.status, chars: 0 });
        continue;
      }

      const text = stripHtmlToText(await response.text());
      const textChunks = chunkText(text, 1200, 180)
        .slice(0, 40)
        .map(chunk => ({ source: source.url, text: chunk }));

      if (textChunks.length > 0) {
        chunks.push(...textChunks);
      }

      sources.push({ title: source.title, url: source.url, ok: true, status: response.status, chars: text.length });
    } catch (err) {
      sources.push({ title: source.title, url: source.url, ok: false, status: 0, chars: 0, error: err.message });
    }
  }

  let fallbackUsed = false;
  if (chunks.length === 0) {
    fallbackUsed = true;
    editor.fallbackContext.forEach((line, idx) => {
      chunks.push({ source: `fallback:${idx + 1}`, text: line });
    });
  }

  editorContextCache[normalized] = {
    fetchedAt: now,
    fallbackUsed,
    sources,
    chunks,
  };
  saveEditorContextCache(editorContextCache);
  return getEditorContextMeta(normalized);
}

function selectEditorContext(editorId, query, limit = 6) {
  const normalized = normalizeEditorId(editorId);
  const row = editorContextCache[normalized];
  const chunks = Array.isArray(row?.chunks) ? row.chunks : [];
  if (!chunks.length) return '';

  const terms = uniqStrings(tokenize(query)).slice(0, 16);
  const ranked = chunks
    .map(chunk => ({
      chunk,
      score: terms.length ? scoreChunk(chunk.text, terms) : 1,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter(item => item.score > 0 || terms.length === 0);

  const selected = ranked.length ? ranked : chunks.slice(0, limit).map(chunk => ({ chunk, score: 1 }));

  return selected
    .map((item, idx) => `- [${idx + 1}] (${item.chunk.source}) ${item.chunk.text}`)
    .join('\n');
}

let selectedTextProvider = runtimeSettings.selectedTextProvider || process.env.NORA_WRITER_TEXT_PROVIDER || 'anthropic';
if (!textProviderIds.includes(selectedTextProvider)) {
  selectedTextProvider = 'anthropic';
}

let selectedProviderModels = (runtimeSettings.selectedProviderModels && typeof runtimeSettings.selectedProviderModels === 'object')
  ? { ...runtimeSettings.selectedProviderModels }
  : {};

let selectedTextModel = runtimeSettings.selectedTextModel
  || selectedProviderModels[selectedTextProvider]
  || process.env.NORA_WRITER_MODEL
  || providerFallbackModels[selectedTextProvider]?.[0]
  || 'claude-sonnet-4-6';

function setSelectedModelForProvider(provider, model, { persist = true } = {}) {
  if (!provider || !model) return;
  selectedProviderModels[provider] = model;
  if (provider === selectedTextProvider) {
    selectedTextModel = model;
  }
  runtimeSettings.selectedProviderModels = selectedProviderModels;
  runtimeSettings.selectedTextProvider = selectedTextProvider;
  runtimeSettings.selectedTextModel = selectedTextModel;
  if (persist) saveRuntimeSettings(runtimeSettings);
}

let anthropicClient = null;
let openAiClient = null;
let xaiClient = null;
let openRouterClient = null;
let geminiApiKey = '';
let xaiApiKey = '';
let openRouterApiKey = '';
let ollamaApiKey = '';
let openRouterBaseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
let openAiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
let xaiBaseUrl = process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
let ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

function refreshApiClients() {
  const anthropicApiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const openAiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
  xaiApiKey = String(process.env.XAI_API_KEY || '').trim();
  geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();

  openRouterApiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  ollamaApiKey = String(process.env.OLLAMA_API_KEY || '').trim();
  openRouterBaseUrl = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').trim();
  openAiBaseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim();
  xaiBaseUrl = String(process.env.XAI_BASE_URL || 'https://api.x.ai/v1').trim();
  ollamaBaseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim();

  anthropicClient = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null;
  openAiClient = openAiApiKey ? new OpenAI({ apiKey: openAiApiKey, baseURL: openAiBaseUrl }) : null;
  xaiClient = xaiApiKey ? new OpenAI({ apiKey: xaiApiKey, baseURL: xaiBaseUrl }) : null;
  openRouterClient = openRouterApiKey ? new OpenAI({ apiKey: openRouterApiKey, baseURL: openRouterBaseUrl }) : null;
}

refreshApiClients();

const openRouterImageModelCandidates = parseCsv(
  process.env.NORA_WRITER_OPENROUTER_IMAGE_MODELS
    || process.env.NORA_WRITER_IMAGE_MODELS
    || process.env.NORA_WRITER_VISION_MODEL,
  ['google/gemini-3.1-pro-preview', 'google/gemini-2.5-flash', 'x-ai/grok-2-vision-1212']
);

const openRouterGenerationFallbackCandidates = parseCsv(
  process.env.NORA_WRITER_OPENROUTER_IMAGE_GENERATION_MODELS,
  ['openai/gpt-5-image-mini', 'openai/gpt-5-image', 'openrouter/auto']
);

const geminiImageModelCandidates = parseCsv(
  process.env.NORA_WRITER_GEMINI_IMAGE_MODELS,
  ['gemini-2.5-flash-image-preview', 'gemini-2.5-pro']
);

const xaiImageModelCandidates = parseCsv(
  process.env.NORA_WRITER_XAI_IMAGE_MODELS,
  ['grok-2-vision-1212']
);

const claudeImageModelCandidates = parseCsv(
  process.env.NORA_WRITER_CLAUDE_IMAGE_MODELS,
  providerFallbackModels.anthropic
);

const imageModelCandidates = openRouterImageModelCandidates;

const imageAnalysisProviderCatalog = [
  { id: 'claude', label: 'Claude Vision', requiresProvider: 'anthropic' },
  { id: 'nanobanana', label: 'Nanobanana Vision (OpenRouter)', requiresProvider: 'openrouter' },
  { id: 'grok-vision', label: 'Grok Vision (xAI)', requiresProvider: 'xai' },
  { id: 'gemini', label: 'Gemini Vision', requiresProvider: 'gemini' },
  { id: 'openrouter', label: 'OpenRouter Vision', requiresProvider: 'openrouter' },
];

const imageGenerationProviderCatalog = [
  { id: 'nanobanana', label: 'Nanobanana (OpenRouter Images API · stable)', requiresProvider: 'openrouter' },
  { id: 'grok-vision', label: 'Grok Vision (xAI)', requiresProvider: 'xai' },
  { id: 'gemini', label: 'Gemini Image', requiresProvider: 'gemini' },
  { id: 'openrouter', label: 'OpenRouter Image (all output-image models · experimental)', requiresProvider: 'openrouter' },
];

let openRouterAnalysisModels = [...openRouterImageModelCandidates];
let openRouterGenerationModelsStrict = [...openRouterGenerationFallbackCandidates];
let openRouterGenerationModelsAll = [...openRouterGenerationFallbackCandidates];

function imageProviderLabel(providerId) {
  const all = [...imageAnalysisProviderCatalog, ...imageGenerationProviderCatalog];
  const row = all.find(entry => entry.id === providerId);
  return row?.label || providerId;
}

function imageProviderRequires(providerId, mode = 'analysis') {
  const source = mode === 'generation' ? imageGenerationProviderCatalog : imageAnalysisProviderCatalog;
  return source.find(entry => entry.id === providerId)?.requiresProvider || null;
}

function isImageProviderConfigured(providerId, mode = 'analysis') {
  const requires = imageProviderRequires(providerId, mode);
  if (!requires) return false;
  return providerIsConfigured(requires);
}

function getImageAnalysisModels(provider = 'claude') {
  const normalized = String(provider || '').trim();
  if (!normalized) return [];
  if (normalized === 'claude') return alphaSortStrings(claudeImageModelCandidates);
  if (normalized === 'grok-vision') return alphaSortStrings(xaiImageModelCandidates);
  if (normalized === 'gemini') return alphaSortStrings(geminiImageModelCandidates);
  return alphaSortStrings(openRouterAnalysisModels.length ? openRouterAnalysisModels : openRouterImageModelCandidates);
}

function getImageGenerationModels(provider = 'nanobanana') {
  const normalized = String(provider || '').trim();
  if (!normalized) return [];
  if (normalized === 'grok-vision') return alphaSortStrings(xaiImageModelCandidates);
  if (normalized === 'gemini') return alphaSortStrings(geminiImageModelCandidates);
  if (normalized === 'openrouter') {
    return alphaSortStrings(openRouterGenerationModelsAll.length ? openRouterGenerationModelsAll : openRouterGenerationFallbackCandidates);
  }
  return alphaSortStrings(openRouterGenerationModelsStrict.length ? openRouterGenerationModelsStrict : openRouterGenerationFallbackCandidates);
}

function getAvailableImageAnalysisProviders() {
  return imageAnalysisProviderCatalog
    .filter(entry => isImageProviderConfigured(entry.id, 'analysis'))
    .map(entry => entry.id);
}

function getAvailableImageGenerationProviders() {
  return imageGenerationProviderCatalog
    .filter(entry => isImageProviderConfigured(entry.id, 'generation'))
    .map(entry => entry.id);
}

let imageAnalysisProviderOptions = getAvailableImageAnalysisProviders();
let imageGenerationProviderOptions = getAvailableImageGenerationProviders();

let selectedImageAnalysisProvider = runtimeSettings.selectedImageAnalysisProvider || process.env.NORA_WRITER_IMAGE_ANALYSIS_PROVIDER || imageAnalysisProviderOptions[0] || '';
if (!imageAnalysisProviderOptions.includes(selectedImageAnalysisProvider)) {
  selectedImageAnalysisProvider = imageAnalysisProviderOptions[0] || '';
}

let selectedImageAnalysisModel = runtimeSettings.selectedImageAnalysisModel
  || process.env.NORA_WRITER_IMAGE_ANALYSIS_MODEL
  || getImageAnalysisModels(selectedImageAnalysisProvider)[0]
  || '';

let selectedImageGenerationProvider = runtimeSettings.selectedImageGenerationProvider
  || process.env.NORA_WRITER_IMAGE_GENERATION_PROVIDER
  || imageGenerationProviderOptions[0]
  || '';
if (!imageGenerationProviderOptions.includes(selectedImageGenerationProvider)) {
  selectedImageGenerationProvider = imageGenerationProviderOptions[0] || '';
}

let selectedImageGenerationModel = runtimeSettings.selectedImageGenerationModel
  || process.env.NORA_WRITER_IMAGE_GENERATION_MODEL
  || process.env.NORA_WRITER_NANOBANANA_MODEL
  || getImageGenerationModels(selectedImageGenerationProvider)[0]
  || '';

let imageGenerationModel = selectedImageGenerationModel || openRouterImageModelCandidates[0] || 'google/gemini-2.5-flash-image-preview';

function normalizeImageProviderSelections({ persist = true } = {}) {
  imageAnalysisProviderOptions = getAvailableImageAnalysisProviders();
  imageGenerationProviderOptions = getAvailableImageGenerationProviders();

  if (!imageAnalysisProviderOptions.includes(selectedImageAnalysisProvider)) {
    selectedImageAnalysisProvider = imageAnalysisProviderOptions[0] || '';
  }

  const analysisModels = getImageAnalysisModels(selectedImageAnalysisProvider);
  if (!analysisModels.includes(selectedImageAnalysisModel)) {
    selectedImageAnalysisModel = analysisModels[0] || '';
  }

  if (!imageGenerationProviderOptions.includes(selectedImageGenerationProvider)) {
    selectedImageGenerationProvider = imageGenerationProviderOptions[0] || '';
  }

  const generationModels = getImageGenerationModels(selectedImageGenerationProvider);
  if (!generationModels.includes(selectedImageGenerationModel)) {
    selectedImageGenerationModel = generationModels[0] || '';
  }

  imageGenerationModel = selectedImageGenerationModel || generationModels[0] || imageGenerationModel;

  runtimeSettings.selectedImageAnalysisProvider = selectedImageAnalysisProvider;
  runtimeSettings.selectedImageAnalysisModel = selectedImageAnalysisModel;
  runtimeSettings.selectedImageGenerationProvider = selectedImageGenerationProvider;
  runtimeSettings.selectedImageGenerationModel = selectedImageGenerationModel;
  if (persist) saveRuntimeSettings(runtimeSettings);
}

normalizeImageProviderSelections({ persist: false });

const thumbnailResearchPath = process.env.NORA_WRITER_THUMBNAIL_RESEARCH_PATH || path.join(dataDir, 'thumbnail_research_bible.md');
const thumbnailResearchCache = { text: '', loadedAt: 0 };

function loadThumbnailResearchContext() {
  const cacheTtlMs = 5 * 60 * 1000;
  const now = Date.now();
  if (thumbnailResearchCache.text && (now - thumbnailResearchCache.loadedAt) < cacheTtlMs) {
    return thumbnailResearchCache.text;
  }

  try {
    if (fs.existsSync(thumbnailResearchPath)) {
      const text = fs.readFileSync(thumbnailResearchPath, 'utf-8');
      thumbnailResearchCache.text = text.slice(0, 50000);
      thumbnailResearchCache.loadedAt = now;
      return thumbnailResearchCache.text;
    }
  } catch (err) {
    console.warn('Could not read thumbnail research context:', err.message);
  }

  return '';
}

const modelCache = {
  anthropic: { models: [], fetchedAt: 0 },
  openai: { models: [], fetchedAt: 0 },
  xai: { models: [], fetchedAt: 0 },
  gemini: { models: [], fetchedAt: 0 },
  openrouter: { models: [], fetchedAt: 0 },
  ollama: { models: [], fetchedAt: 0 },
};

const imageModelCache = {
  openrouter: { analysisModels: [], generationModelsStrict: [], generationModelsAll: [], fetchedAt: 0 },
};

function extractRowModalities(row) {
  const arch = row?.architecture || {};
  const input = new Set((arch.input_modalities || []).map(v => String(v || '').toLowerCase()));
  const output = new Set((arch.output_modalities || []).map(v => String(v || '').toLowerCase()));
  const all = new Set();

  for (const v of input) all.add(v);
  for (const v of output) all.add(v);
  for (const v of (row?.modalities || [])) all.add(String(v || '').toLowerCase());
  if (typeof arch.modality === 'string') all.add(String(arch.modality).toLowerCase());

  const id = String(row?.id || '').toLowerCase();
  const name = String(row?.name || '').toLowerCase();
  const hay = `${id} ${name}`;
  return { input, output, all, hay, id, name };
}

function isOpenRouterAnalysisModelRow(row) {
  const { input, all, hay } = extractRowModalities(row);
  if (input.has('image')) return true;
  if (all.has('vision') || all.has('image')) return true;
  return /vision|image/.test(hay);
}

function isOpenRouterGenerationModelRow(row) {
  const { output, id, hay } = extractRowModalities(row);
  if (!output.has('image')) return false;

  // OpenRouter /images/generations compatibility is not universal.
  // Keep this list strict to models known/expected to work with that endpoint.
  if (id === 'openrouter/auto') return true;
  if (id.startsWith('openai/gpt-5-image')) return true;

  // Additional image-generation families that typically support image endpoints.
  return /(gpt-image|dall|flux|sdxl|ideogram|recraft|seedream|imagen)/.test(hay);
}

function isOpenRouterGenerationCandidateRow(row) {
  const { output, hay, id } = extractRowModalities(row);
  if (output.has('image')) return true;
  if (id === 'openrouter/auto') return true;
  return /(image|gpt-image|dall|flux|sdxl|ideogram|recraft|seedream|imagen|nanobanana)/.test(hay);
}

function alphaSortStrings(items) {
  return uniqStrings(items).sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
}

async function fetchOpenRouterImageModelRows() {
  if (!openRouterApiKey) return [];
  const url = `${openRouterBaseUrl.replace(/\/$/, '')}/models`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter model list failed (${response.status})`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function refreshOpenRouterImageModels({ force = false } = {}) {
  const cache = imageModelCache.openrouter || { analysisModels: [], generationModelsStrict: [], generationModelsAll: [], fetchedAt: 0 };
  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;

  if (!force && (cache.analysisModels.length || cache.generationModelsStrict.length || cache.generationModelsAll.length) && (now - cache.fetchedAt) < ttlMs) {
    openRouterAnalysisModels = cache.analysisModels.length ? cache.analysisModels : openRouterImageModelCandidates;
    openRouterGenerationModelsStrict = cache.generationModelsStrict.length ? cache.generationModelsStrict : openRouterGenerationFallbackCandidates;
    openRouterGenerationModelsAll = cache.generationModelsAll.length ? cache.generationModelsAll : openRouterGenerationFallbackCandidates;
    return {
      analysisModels: openRouterAnalysisModels,
      generationModelsStrict: openRouterGenerationModelsStrict,
      generationModelsAll: openRouterGenerationModelsAll,
    };
  }

  try {
    const rows = await fetchOpenRouterImageModelRows();
    const discoveredAnalysis = rows.filter(isOpenRouterAnalysisModelRow).map(row => row?.id).filter(Boolean);
    const discoveredGenerationStrict = rows.filter(isOpenRouterGenerationModelRow).map(row => row?.id).filter(Boolean);
    const discoveredGenerationAll = rows
      .filter(isOpenRouterGenerationCandidateRow)
      .map(row => row?.id)
      .filter(Boolean);

    const mergedAnalysis = alphaSortStrings([...(discoveredAnalysis || []), ...openRouterImageModelCandidates]);
    const mergedGenerationStrict = alphaSortStrings([...(discoveredGenerationStrict || []), ...openRouterGenerationFallbackCandidates]);
    const mergedGenerationAll = alphaSortStrings([...(discoveredGenerationAll || []), ...openRouterGenerationFallbackCandidates]);

    cache.analysisModels = mergedAnalysis;
    cache.generationModelsStrict = mergedGenerationStrict;
    cache.generationModelsAll = mergedGenerationAll;
    cache.fetchedAt = now;
    imageModelCache.openrouter = cache;

    openRouterAnalysisModels = mergedAnalysis.length ? mergedAnalysis : openRouterImageModelCandidates;
    openRouterGenerationModelsStrict = mergedGenerationStrict.length ? mergedGenerationStrict : openRouterGenerationFallbackCandidates;
    openRouterGenerationModelsAll = mergedGenerationAll.length ? mergedGenerationAll : openRouterGenerationFallbackCandidates;

    return {
      analysisModels: openRouterAnalysisModels,
      generationModelsStrict: openRouterGenerationModelsStrict,
      generationModelsAll: openRouterGenerationModelsAll,
    };
  } catch (err) {
    console.warn('OpenRouter image model scan failed:', err.message);
    if (!cache.analysisModels.length) cache.analysisModels = openRouterImageModelCandidates;
    if (!cache.generationModelsStrict.length) cache.generationModelsStrict = openRouterGenerationFallbackCandidates;
    if (!cache.generationModelsAll.length) cache.generationModelsAll = openRouterGenerationFallbackCandidates;
    cache.fetchedAt = now;
    imageModelCache.openrouter = cache;

    openRouterAnalysisModels = cache.analysisModels;
    openRouterGenerationModelsStrict = cache.generationModelsStrict;
    openRouterGenerationModelsAll = cache.generationModelsAll;
    return {
      analysisModels: openRouterAnalysisModels,
      generationModelsStrict: openRouterGenerationModelsStrict,
      generationModelsAll: openRouterGenerationModelsAll,
    };
  }
}

refreshOpenRouterImageModels().catch(err => console.warn('OpenRouter image model refresh skipped:', err.message));

function clearModelCache(provider = null) {
  if (!provider) {
    Object.keys(modelCache).forEach(key => {
      modelCache[key].models = [];
      modelCache[key].fetchedAt = 0;
    });
    imageModelCache.openrouter = { analysisModels: [], generationModelsStrict: [], generationModelsAll: [], fetchedAt: 0 };
    return;
  }

  if (modelCache[provider]) {
    modelCache[provider].models = [];
    modelCache[provider].fetchedAt = 0;
  }

  if (provider === 'openrouter') {
    imageModelCache.openrouter = { analysisModels: [], generationModelsStrict: [], generationModelsAll: [], fetchedAt: 0 };
    openRouterAnalysisModels = [...openRouterImageModelCandidates];
    openRouterGenerationModelsStrict = [...openRouterGenerationFallbackCandidates];
    openRouterGenerationModelsAll = [...openRouterGenerationFallbackCandidates];
  }
}

function scoreModelForOrdering(modelId) {
  const id = String(modelId || '').toLowerCase();
  let score = 0;

  if (id.includes('sonnet') && (id.includes('4-6') || id.includes('4.6'))) score += 1000;
  if (id.includes('opus') && (id.includes('4-6') || id.includes('4.6'))) score += 950;
  if (id.includes('sonnet') && (id.includes('4-5') || id.includes('4.5'))) score += 900;

  if (id.includes('gpt-5')) score += 890;
  if (id.includes('gpt-4.1')) score += 860;
  if (id.includes('gpt-4o')) score += 840;
  if (id.includes('grok-4')) score += 870;
  if (id.includes('grok-3')) score += 830;
  if (id.includes('gemini-2.5-pro')) score += 880;
  if (id.includes('gemini-2.5-flash')) score += 850;

  if (id.includes('sonnet')) score += 120;
  if (id.includes('opus')) score += 110;
  if (id.includes('haiku')) score += 90;

  const dateMatch = id.match(/(20\d{6})$/);
  if (dateMatch) score += Number(dateMatch[1]) / 1000000;

  return score;
}

function sortTextModels(models) {
  return uniqStrings(models)
    .sort((a, b) => {
      const diff = scoreModelForOrdering(b) - scoreModelForOrdering(a);
      if (diff !== 0) return diff;
      return a.localeCompare(b);
    });
}

function providerIsConfigured(provider) {
  const entry = textProviderCatalog.find(p => p.id === provider);
  if (!entry) return false;

  if (entry.requiresKey === false) {
    if (entry.id === 'ollama') {
      return Boolean(String(ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim());
    }
    return true;
  }

  return Boolean(String(process.env[entry.envKey] || '').trim());
}

function providerStatus() {
  return textProviderCatalog.map(entry => {
    const raw = String(process.env[entry.envKey] || '').trim();
    let configured = Boolean(raw);
    let keyHint = maskSecret(raw);

    if (entry.requiresKey === false && entry.id === 'ollama') {
      configured = Boolean(String(ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim());
      keyHint = `base: ${ollamaBaseUrl || 'http://127.0.0.1:11434'}`;
    }

    return {
      id: entry.id,
      label: entry.label,
      configured,
      keyHint,
    };
  });
}

function getProviderFallbackModels(provider) {
  return uniqStrings(providerFallbackModels[provider] || defaultProviderModels[provider] || []);
}

async function fetchAnthropicModelIds() {
  if (!anthropicClient) return [];

  const ids = [];
  let page = await anthropicClient.models.list({ limit: 100 });
  while (page) {
    const data = Array.isArray(page.data) ? page.data : [];
    data.forEach(m => {
      if (m?.id) ids.push(m.id);
    });

    if (typeof page.hasNextPage === 'function' && page.hasNextPage()) {
      page = await page.getNextPage();
    } else {
      break;
    }
  }

  return uniqStrings(ids);
}

async function fetchOpenAIStyleModelIds(client) {
  if (!client) return [];
  const result = await client.models.list();
  const data = Array.isArray(result?.data) ? result.data : [];
  return uniqStrings(data.map(m => m?.id).filter(Boolean));
}

async function fetchOpenRouterModelIds() {
  if (!openRouterApiKey) return [];
  const url = `${openRouterBaseUrl.replace(/\/$/, '')}/models`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter model list failed (${response.status})`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return uniqStrings(rows.map(row => row?.id).filter(Boolean));
}

async function fetchGeminiModelIds() {
  if (!geminiApiKey) return [];
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiApiKey)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Gemini model list failed (${response.status})`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.models) ? payload.models : [];

  return uniqStrings(
    rows
      .filter(row => {
        const methods = Array.isArray(row?.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
        return methods.includes('generateContent') || methods.includes('streamGenerateContent');
      })
      .map(row => String(row?.name || '').replace(/^models\//, '').trim())
      .filter(Boolean)
  );
}

async function fetchOllamaModelIds() {
  const base = String(ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const response = await fetch(`${base}/api/tags`, {
    headers: {
      'Content-Type': 'application/json',
      ...(ollamaApiKey ? { Authorization: `Bearer ${ollamaApiKey}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Ollama model list failed (${response.status})`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  return uniqStrings(rows.map(row => String(row?.name || '').trim()).filter(Boolean));
}

async function getAvailableTextModels({ provider = selectedTextProvider, force = false } = {}) {
  const normalizedProvider = textProviderIds.includes(provider) ? provider : 'anthropic';
  const cache = modelCache[normalizedProvider] || { models: [], fetchedAt: 0 };
  const now = Date.now();
  const cacheTtlMs = 10 * 60 * 1000;

  if (!force && cache.models.length > 0 && (now - cache.fetchedAt) < cacheTtlMs) {
    return cache.models;
  }

  const fallback = sortTextModels(getProviderFallbackModels(normalizedProvider));

  try {
    let discovered = [];
    if (normalizedProvider === 'anthropic') discovered = await fetchAnthropicModelIds();
    if (normalizedProvider === 'openai') discovered = await fetchOpenAIStyleModelIds(openAiClient);
    if (normalizedProvider === 'xai') discovered = await fetchOpenAIStyleModelIds(xaiClient);
    if (normalizedProvider === 'gemini') discovered = await fetchGeminiModelIds();
    if (normalizedProvider === 'openrouter') discovered = await fetchOpenRouterModelIds();
    if (normalizedProvider === 'ollama') discovered = await fetchOllamaModelIds();

    const merged = sortTextModels([...discovered, ...fallback]);
    cache.models = merged;
    cache.fetchedAt = now;
    modelCache[normalizedProvider] = cache;
    return merged;
  } catch (err) {
    console.warn(`${normalizedProvider} model scan failed, using fallback list:`, err.message);
    cache.models = cache.models.length ? cache.models : fallback;
    cache.fetchedAt = now;
    modelCache[normalizedProvider] = cache;
    return cache.models;
  }
}

async function ensureSelectedTextModel({ provider = selectedTextProvider, force = false, activateProvider = true } = {}) {
  const normalizedProvider = textProviderIds.includes(provider) ? provider : 'anthropic';

  const models = await getAvailableTextModels({ provider: normalizedProvider, force });
  const savedModel = selectedProviderModels[normalizedProvider];
  const currentModel = normalizedProvider === selectedTextProvider ? selectedTextModel : '';
  let nextModel = savedModel || currentModel || getProviderFallbackModels(normalizedProvider)[0] || '';

  if (models.length && !models.includes(nextModel)) {
    nextModel = models[0];
  }

  if (!nextModel && models.length) {
    nextModel = models[0];
  }

  if (nextModel) {
    selectedProviderModels[normalizedProvider] = nextModel;
  }

  if (activateProvider) {
    selectedTextProvider = normalizedProvider;
    selectedTextModel = nextModel || selectedTextModel;
  }

  runtimeSettings.selectedTextProvider = selectedTextProvider;
  runtimeSettings.selectedTextModel = selectedTextModel;
  runtimeSettings.selectedProviderModels = selectedProviderModels;
  saveRuntimeSettings(runtimeSettings);

  return {
    provider: normalizedProvider,
    models,
    selectedModel: nextModel || selectedTextModel,
  };
}

console.log(`✓ YouTube AI Assistant text provider: ${selectedTextProvider} | model=${selectedTextModel}`);
console.log(`✓ YouTube AI Assistant image-analysis provider: ${selectedImageAnalysisProvider} | model=${selectedImageAnalysisModel}`);
console.log(`✓ YouTube AI Assistant image-generation provider: ${selectedImageGenerationProvider} | model=${selectedImageGenerationModel}`);

function toOpenAIMessages(systemPrompt, apiMessages) {
  const normalized = (apiMessages || []).map(m => {
    if (Array.isArray(m.content)) {
      const parts = m.content.map(part => {
        if (part?.type === 'text') {
          return { type: 'text', text: part.text || '' };
        }

        if (part?.type === 'image' && part?.source?.url) {
          return { type: 'image_url', image_url: { url: part.source.url } };
        }

        if (part?.type === 'image' && part?.source?.type === 'base64' && part?.source?.data) {
          const mediaType = part?.source?.media_type || 'image/png';
          return {
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${part.source.data}` }
          };
        }

        if (part?.type === 'image_url' && part?.image_url?.url) {
          return part;
        }

        return { type: 'text', text: String(part?.text || '') };
      });

      return { role: m.role, content: parts.length ? parts : [{ type: 'text', text: '' }] };
    }

    return { role: m.role, content: m.content || '' };
  });

  return [{ role: 'system', content: systemPrompt }, ...normalized];
}

function getImageMediaType(filename) {
  const ext = String(path.extname(filename || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function getLocalUploadPathFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith('/uploads/')) return null;
    const rel = parsed.pathname.replace('/uploads/', '');
    return path.join(uploadsDir, rel);
  } catch (e) {
    return null;
  }
}

function convertLocalImageUrlsToBase64(apiMessages) {
  return (apiMessages || []).map(m => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content.map(part => {
      if (part?.type === 'image' && part?.source?.url) {
        const localPath = getLocalUploadPathFromUrl(part.source.url);
        if (localPath && fs.existsSync(localPath)) {
          const data = fs.readFileSync(localPath).toString('base64');
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: getImageMediaType(localPath),
              data,
            }
          };
        }
        return part;
      }
      return part;
    });
    return { ...m, content: parts };
  });
}

function toAnthropicMessages(apiMessages) {
  return (apiMessages || []).map(m => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (!Array.isArray(m.content)) {
      return { role, content: m.content || '' };
    }

    const parts = m.content.map(part => {
      if (part?.type === 'image' && part?.source?.url) {
        return {
          type: 'image',
          source: {
            type: 'url',
            url: part.source.url
          }
        };
      }
      if (part?.type === 'image' && part?.source?.type === 'base64') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.source.media_type,
            data: part.source.data,
          }
        };
      }
      return { type: 'text', text: part?.text || '' };
    });

    return { role, content: parts.length ? parts : [{ type: 'text', text: '' }] };
  });
}

function hasImageContent(apiMessages) {
  return (apiMessages || []).some(m =>
    Array.isArray(m.content)
    && m.content.some(part => part?.type === 'image' && (part?.source?.url || part?.source?.data))
  );
}

function providerMissingKeyError(provider) {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY is missing.';
  if (provider === 'openai') return 'OPENAI_API_KEY is missing.';
  if (provider === 'xai') return 'XAI_API_KEY is missing.';
  if (provider === 'gemini') return 'GEMINI_API_KEY is missing.';
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY is missing.';
  if (provider === 'ollama') return 'Ollama is not reachable. Set OLLAMA_BASE_URL (default http://127.0.0.1:11434) and ensure Ollama is running.';
  return 'Required API key is missing.';
}

async function streamAnthropicTextResponse({ systemPrompt, apiMessages, onText, model }) {
  if (!anthropicClient) {
    throw new Error(providerMissingKeyError('anthropic'));
  }

  const stream = anthropicClient.messages.stream({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: toAnthropicMessages(apiMessages)
  });

  let full = '';
  stream.on('text', (text) => {
    full += text;
    if (onText) onText(text);
  });

  const finalMessage = await stream.finalMessage();
  if (!full.trim()) {
    const fallbackText = (finalMessage?.content || [])
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('');
    if (fallbackText) {
      full = fallbackText;
      if (onText) onText(fallbackText);
    }
  }

  return full;
}

async function streamOpenAICompatibleResponse({ client, provider, model, systemPrompt, apiMessages, onText }) {
  if (!client) {
    throw new Error(providerMissingKeyError(provider));
  }

  const stream = await client.chat.completions.create({
    model,
    stream: true,
    max_tokens: 4096,
    messages: toOpenAIMessages(systemPrompt, apiMessages)
  });

  let full = '';
  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content;
    const text = Array.isArray(delta) ? delta.map(part => String(part || '')).join('') : String(delta || '');
    if (!text) continue;
    full += text;
    if (onText) onText(text);
  }

  if (!full.trim()) {
    throw new Error(`${provider} model ${model} returned empty output.`);
  }

  return full;
}

function toGeminiContents(apiMessages) {
  return (apiMessages || []).map(msg => {
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (!Array.isArray(msg.content)) {
      return { role, parts: [{ text: String(msg.content || '') }] };
    }

    const parts = msg.content.map(part => {
      if (part?.type === 'text') {
        return { text: String(part?.text || '') };
      }

      if (part?.type === 'image' && part?.source?.type === 'base64' && part?.source?.data) {
        return {
          inlineData: {
            mimeType: part?.source?.media_type || 'image/png',
            data: part.source.data,
          }
        };
      }

      if (part?.type === 'image' && part?.source?.url) {
        return { text: `[Image URL: ${part.source.url}]` };
      }

      return { text: String(part?.text || '') };
    });

    return { role, parts: parts.length ? parts : [{ text: '' }] };
  });
}

async function runGeminiTextResponse({ model, systemPrompt, apiMessages, onText }) {
  if (!geminiApiKey) {
    throw new Error(providerMissingKeyError('gemini'));
  }

  const converted = convertLocalImageUrlsToBase64(apiMessages);
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: toGeminiContents(converted),
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.7,
    },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini generation failed (${response.status}): ${errText.slice(0, 240)}`);
  }

  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map(part => part?.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new Error(`Gemini model ${model} returned empty output.`);
  }

  if (onText) onText(text);
  return text;
}

function toOllamaMessages(systemPrompt, apiMessages) {
  return toOpenAIMessages(systemPrompt, apiMessages).map(msg => {
    const role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user');
    if (!Array.isArray(msg.content)) {
      return { role, content: String(msg.content || '') };
    }

    const text = msg.content
      .map(part => {
        if (part?.type === 'text') return String(part.text || '');
        if (part?.type === 'image_url' && part?.image_url?.url) return '[image attached]';
        return '';
      })
      .filter(Boolean)
      .join('\n');

    return { role, content: text || '' };
  });
}

async function runOllamaTextResponse({ model, systemPrompt, apiMessages, onText }) {
  const base = String(ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ollamaApiKey ? { Authorization: `Bearer ${ollamaApiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: toOllamaMessages(systemPrompt, apiMessages),
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama generation failed (${response.status}): ${errText.slice(0, 240)}`);
  }

  if (!response.body) {
    throw new Error('Ollama returned no response stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const parseLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (payload?.error) {
      throw new Error(String(payload.error));
    }

    const delta = String(payload?.message?.content || '');
    if (delta) {
      full += delta;
      if (onText) onText(delta);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      parseLine(line);
    }
  }

  if (buffer.trim()) {
    parseLine(buffer);
  }

  if (!full.trim()) {
    throw new Error(`Ollama model ${model} returned empty output.`);
  }

  return full;
}

async function runProviderModelAttempt({ provider, model, systemPrompt, apiMessages, onText }) {
  if (provider === 'anthropic') {
    return streamAnthropicTextResponse({ systemPrompt, apiMessages, onText, model });
  }

  if (provider === 'openai') {
    return streamOpenAICompatibleResponse({
      client: openAiClient,
      provider,
      model,
      systemPrompt,
      apiMessages,
      onText,
    });
  }

  if (provider === 'xai') {
    return streamOpenAICompatibleResponse({
      client: xaiClient,
      provider,
      model,
      systemPrompt,
      apiMessages,
      onText,
    });
  }

  if (provider === 'openrouter') {
    return streamOpenAICompatibleResponse({
      client: openRouterClient,
      provider,
      model,
      systemPrompt,
      apiMessages,
      onText,
    });
  }

  if (provider === 'gemini') {
    return runGeminiTextResponse({ model, systemPrompt, apiMessages, onText });
  }

  if (provider === 'ollama') {
    return runOllamaTextResponse({ model, systemPrompt, apiMessages, onText });
  }

  throw new Error(`Unsupported text provider: ${provider}`);
}

async function runProviderWithModelFallback({ provider, systemPrompt, apiMessages, onText, maxModels = 6, activateProvider = true }) {
  const normalizedProvider = textProviderIds.includes(provider) ? provider : selectedTextProvider;
  if (!providerIsConfigured(normalizedProvider)) {
    throw new Error(providerMissingKeyError(normalizedProvider));
  }

  const { models, selectedModel } = await ensureSelectedTextModel({
    provider: normalizedProvider,
    force: false,
    activateProvider,
  });

  const tryModels = uniqStrings([selectedModel, ...models, ...getProviderFallbackModels(normalizedProvider)]).slice(0, maxModels);
  let lastErr = null;

  for (const model of tryModels) {
    try {
      const text = await runProviderModelAttempt({
        provider: normalizedProvider,
        model,
        systemPrompt,
        apiMessages,
        onText,
      });

      if (text && text.trim()) {
        selectedProviderModels[normalizedProvider] = model;

        if (activateProvider) {
          selectedTextProvider = normalizedProvider;
          selectedTextModel = model;
        }

        runtimeSettings.selectedTextProvider = selectedTextProvider;
        runtimeSettings.selectedTextModel = selectedTextModel;
        runtimeSettings.selectedProviderModels = selectedProviderModels;
        saveRuntimeSettings(runtimeSettings);
        return text;
      }
    } catch (err) {
      const message = String(err?.message || '');
      if (normalizedProvider === 'anthropic' && /invalid x-api-key|authentication_error/i.test(message)) {
        err = new Error('ANTHROPIC_API_KEY is invalid (Anthropic returned authentication_error: invalid x-api-key).');
      }
      if (normalizedProvider === 'openrouter' && /user not found|401/i.test(message)) {
        err = new Error('OPENROUTER_API_KEY is invalid or revoked (OpenRouter returned 401 User not found).');
      }
      lastErr = err;
      console.warn(`${normalizedProvider} model ${model} failed, trying next:`, err.message);
    }
  }

  throw lastErr || new Error(`All configured ${normalizedProvider} text models failed.`);
}

async function streamAnthropicVisionResponse({ systemPrompt, apiMessages, onText, modelOverride = '' }) {
  if (!anthropicClient) {
    throw new Error(providerMissingKeyError('anthropic'));
  }

  const models = uniqStrings([
    String(modelOverride || '').trim(),
    ...getImageAnalysisModels('claude'),
  ]).filter(Boolean);

  let lastErr = null;
  for (const model of models) {
    try {
      return await streamAnthropicTextResponse({ systemPrompt, apiMessages, onText, model });
    } catch (err) {
      lastErr = err;
      console.warn(`Claude vision model ${model} failed:`, err.message);
    }
  }

  throw lastErr || new Error('All configured Claude vision models failed.');
}

async function streamOpenRouterVisionResponse({ systemPrompt, apiMessages, onText, modelOverride = '' }) {
  if (!openRouterClient) {
    throw new Error(providerMissingKeyError('openrouter'));
  }

  const models = uniqStrings([
    String(modelOverride || '').trim(),
    ...getImageAnalysisModels('openrouter'),
  ]).filter(Boolean);

  let lastErr = null;
  for (const model of models) {
    try {
      return await streamOpenAICompatibleResponse({
        client: openRouterClient,
        provider: 'openrouter',
        model,
        systemPrompt,
        apiMessages,
        onText,
      });
    } catch (err) {
      lastErr = err;
      console.warn(`OpenRouter vision model ${model} failed:`, err.message);
    }
  }

  throw lastErr || new Error('All configured OpenRouter vision models failed.');
}

async function streamXaiVisionResponse({ systemPrompt, apiMessages, onText, modelOverride = '' }) {
  if (!xaiClient) {
    throw new Error(providerMissingKeyError('xai'));
  }

  const models = uniqStrings([
    String(modelOverride || '').trim(),
    ...getImageAnalysisModels('grok-vision'),
  ]).filter(Boolean);

  let lastErr = null;
  for (const model of models) {
    try {
      return await streamOpenAICompatibleResponse({
        client: xaiClient,
        provider: 'xai',
        model,
        systemPrompt,
        apiMessages,
        onText,
      });
    } catch (err) {
      lastErr = err;
      console.warn(`xAI vision model ${model} failed:`, err.message);
    }
  }

  throw lastErr || new Error('All configured Grok vision models failed.');
}

async function runGeminiVisionResponse({ systemPrompt, apiMessages, onText, modelOverride = '' }) {
  if (!geminiApiKey) {
    throw new Error(providerMissingKeyError('gemini'));
  }

  const models = uniqStrings([
    String(modelOverride || '').trim(),
    ...getImageAnalysisModels('gemini'),
  ]).filter(Boolean);

  let lastErr = null;
  for (const model of models) {
    try {
      return await runGeminiTextResponse({ model, systemPrompt, apiMessages, onText });
    } catch (err) {
      lastErr = err;
      console.warn(`Gemini vision model ${model} failed:`, err.message);
    }
  }

  throw lastErr || new Error('All configured Gemini vision models failed.');
}

async function runClaudeWithModelFallback({ systemPrompt, apiMessages, onText, maxModels = 6 }) {
  return runProviderWithModelFallback({
    provider: 'anthropic',
    systemPrompt,
    apiMessages,
    onText,
    maxModels,
    activateProvider: false,
  });
}

async function runTextPlanningWithProviderFallback({ systemPrompt, apiMessages, onText = null, maxModels = 4, preferredProvider = null, allowFallback = true }) {
  const preferred = String(preferredProvider || '').trim();
  const includeOllamaFallback = selectedTextProvider === 'ollama' || preferred === 'ollama';
  const configured = providerStatus()
    .filter(p => p.configured)
    .map(p => p.id)
    .filter(id => id !== 'ollama' || includeOllamaFallback);

  let ordered = uniqStrings([
    preferred,
    selectedTextProvider,
    ...configured,
    'openrouter',
    'openai',
    'gemini',
    'anthropic',
    'xai',
    ...(includeOllamaFallback ? ['ollama'] : []),
  ]).filter(id => textProviderIds.includes(id));

  if (!allowFallback) {
    ordered = ordered.length ? [ordered[0]] : [];
    if (!ordered.length || !providerIsConfigured(ordered[0])) {
      throw new Error(`Selected text provider is not configured. Update Settings → Text provider key.`);
    }
  }

  let lastErr = null;
  let priorityErr = null;

  for (const provider of ordered) {
    if (!providerIsConfigured(provider)) continue;
    try {
      return await runProviderWithModelFallback({
        provider,
        systemPrompt,
        apiMessages,
        onText,
        maxModels,
        activateProvider: false,
      });
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      if (/authentication_error|invalid x-api-key|401|403|key limit exceeded/i.test(msg)) {
        priorityErr = priorityErr || err;
      }
      console.warn(`Planning provider ${provider} failed, trying next:`, err.message);
    }
  }

  throw priorityErr || lastErr || new Error('No working text provider available for thumbnail planning.');
}

async function runImageAnalysisResponse({ systemPrompt, apiMessages, onText, providerOverride = null, modelOverride = null }) {
  const provider = providerOverride || selectedImageAnalysisProvider;
  const model = String(modelOverride || selectedImageAnalysisModel || '').trim();
  const converted = convertLocalImageUrlsToBase64(apiMessages);

  if (provider === 'nanobanana' || provider === 'openrouter') {
    return streamOpenRouterVisionResponse({ systemPrompt, apiMessages: converted, onText, modelOverride: model });
  }

  if (provider === 'grok-vision') {
    return streamXaiVisionResponse({ systemPrompt, apiMessages: converted, onText, modelOverride: model });
  }

  if (provider === 'gemini') {
    return runGeminiVisionResponse({ systemPrompt, apiMessages: converted, onText, modelOverride: model });
  }

  return streamAnthropicVisionResponse({ systemPrompt, apiMessages: converted, onText, modelOverride: model });
}

async function generateResponse({ systemPrompt, apiMessages, onText }) {
  const useImageRoute = hasImageContent(apiMessages);

  if (useImageRoute) {
    return runImageAnalysisResponse({ systemPrompt, apiMessages, onText });
  }

  return runProviderWithModelFallback({
    provider: selectedTextProvider,
    systemPrompt,
    apiMessages,
    onText,
    maxModels: 6,
    activateProvider: true,
  });
}

async function summarizeWithModel({ systemPrompt, userPrompt }) {
  const fallbackProvider = providerStatus().find(p => p.configured)?.id || selectedTextProvider;
  const summaryProvider = providerIsConfigured(selectedTextProvider) ? selectedTextProvider : fallbackProvider;

  return runProviderWithModelFallback({
    provider: summaryProvider,
    systemPrompt,
    apiMessages: [{ role: 'user', content: userPrompt }],
    onText: null,
    maxModels: 4,
    activateProvider: summaryProvider === selectedTextProvider,
  });
}

function getThumbnailVersionLabel(version) {
  const major = Number(version?.major_version || version?.version_number || 1);
  const minor = Number(version?.minor_version || 0);
  return `${major}.${minor}`;
}

function normalizeThumbnailVersion(version) {
  if (!version) return version;
  const major = Number(version.major_version || version.version_number || 1);
  const minor = Number(version.minor_version || 0);
  return {
    ...version,
    major_version: major,
    minor_version: minor,
    version_label: `${major}.${minor}`,
  };
}

function buildLocalUploadUrl(videoId, filename) {
  return `http://localhost:${PORT}/uploads/${videoId}/${filename}`;
}

function getNextThumbnailVersionMeta(videoId, parentVersionId = null) {
  const latestGlobal = db.prepare('SELECT MAX(version_number) as max_v FROM thumbnail_versions WHERE video_id = ?').get(videoId);
  const versionNumber = (latestGlobal?.max_v || 0) + 1;

  if (parentVersionId) {
    const parent = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ? AND video_id = ?').get(parentVersionId, videoId);
    if (parent) {
      const major = Number(parent.major_version || parent.version_number || 1);
      const row = db.prepare('SELECT MAX(minor_version) as max_minor FROM thumbnail_versions WHERE video_id = ? AND major_version = ?').get(videoId, major);
      const minor = Number(row?.max_minor || 0) + 1;
      return { versionNumber, majorVersion: major, minorVersion: minor, parentVersionId: parent.id };
    }
  }

  const latestMajor = db.prepare('SELECT MAX(major_version) as max_major FROM thumbnail_versions WHERE video_id = ?').get(videoId);
  const majorVersion = Number(latestMajor?.max_major || 0) + 1;
  return { versionNumber, majorVersion, minorVersion: 0, parentVersionId: null };
}

function extractJsonFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (e) {
    // continue
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch (e) {
      // continue
    }
  }

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch (e) {
      // continue
    }
  }

  return null;
}

async function generateImageWithOpenRouter(prompt, model) {
  if (!openRouterApiKey) {
    throw new Error(providerMissingKeyError('openrouter'));
  }

  const res = await fetch(`${openRouterBaseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      size: '1280x720',
      n: 1,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) {
      throw new Error('OpenRouter /images/generations returned 404 (unsupported endpoint/model). Switch Image Generation Provider to Gemini/Grok or choose a supported OpenRouter image-generation model.');
    }
    throw new Error(`OpenRouter image generation failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const payload = await res.json();
  const first = payload?.data?.[0] || null;
  if (!first) {
    throw new Error('OpenRouter returned no images.');
  }

  if (first.b64_json) {
    return Buffer.from(first.b64_json, 'base64');
  }

  if (first.url) {
    const imgRes = await fetch(first.url);
    if (!imgRes.ok) {
      throw new Error(`Failed to download generated image: ${imgRes.status}`);
    }
    return Buffer.from(await imgRes.arrayBuffer());
  }

  throw new Error('OpenRouter response had no b64_json/url image payload.');
}

async function generateImageWithGemini(prompt, model) {
  if (!geminiApiKey) {
    throw new Error(providerMissingKeyError('gemini'));
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      responseModalities: ['IMAGE'],
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini image generation failed (${res.status}): ${errText.slice(0, 240)}`);
  }

  const payload = await res.json();
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(part => part?.inlineData?.data);
  if (!imagePart) {
    throw new Error('Gemini returned no image data.');
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

async function generateImageWithXai(prompt, model) {
  if (!xaiApiKey) {
    throw new Error(providerMissingKeyError('xai'));
  }

  const res = await fetch(`${xaiBaseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${xaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      size: '1280x720',
      n: 1,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`xAI image generation failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const payload = await res.json();
  const first = payload?.data?.[0] || null;
  if (!first) {
    throw new Error('xAI returned no images.');
  }

  if (first.b64_json) {
    return Buffer.from(first.b64_json, 'base64');
  }

  if (first.url) {
    const imgRes = await fetch(first.url);
    if (!imgRes.ok) {
      throw new Error(`Failed to download generated image: ${imgRes.status}`);
    }
    return Buffer.from(await imgRes.arrayBuffer());
  }

  throw new Error('xAI response had no b64_json/url image payload.');
}

async function generateImageWithProvider(prompt, provider, model) {
  const normalized = String(provider || '').trim();
  const chosenModel = String(model || '').trim() || getImageGenerationModels(normalized)[0] || imageGenerationModel;

  if (normalized === 'gemini') {
    return generateImageWithGemini(prompt, chosenModel);
  }

  if (normalized === 'grok-vision') {
    return generateImageWithXai(prompt, chosenModel);
  }

  return generateImageWithOpenRouter(prompt, chosenModel);
}

function getPlanningProviderForImageGeneration(generationProviderId) {
  const normalized = String(generationProviderId || '').trim();
  if (normalized === 'gemini') return 'gemini';
  if (normalized === 'grok-vision') return 'xai';
  if (normalized === 'nanobanana' || normalized === 'openrouter') return 'openrouter';
  return selectedTextProvider;
}

async function analyzeThumbnailVersion({ video, version, providerOverride = null, modelOverride = null, extraInstruction = '' }) {
  const provider = providerOverride || selectedImageAnalysisProvider;
  const model = modelOverride || selectedImageAnalysisModel;
  const imageUrl = buildLocalUploadUrl(video.id, version.filename);
  const researchContext = loadThumbnailResearchContext();
  const versionLabel = getThumbnailVersionLabel(version);
  const userName = getProfileName();

  const findingsBlock = getLongTermFindingsPromptBlock();
  const systemPrompt = `You are ${userName}'s thumbnail analysis specialist.

Evaluate the provided YouTube thumbnail and return practical, high-signal feedback.

Rules:
- Be specific and visual.
- Prioritize CTR + retention-safe packaging.
- Give concrete edits ${userName} can apply immediately.
- Keep it concise and structured.
- Return PLAIN TEXT only (no markdown tables, no code fences).

Use this research library as your benchmark:
${researchContext || '(No research document loaded.)'}

Long-term creator findings (always apply):
${findingsBlock || '(none)'}`;

  const userText = `Video title: ${video.title}
Thumbnail version: ${versionLabel}
Notes: ${version.notes || '(none)'}

Tasks:
1) Scores (1-10): clarity, curiosity, contrast, mobile legibility, title-synergy.
2) Top 5 changes in priority order.
3) 3 text-overlay options (max 5 words each).
4) 3 title-synergy hooks.
Format with short headings + bullets only.
${extraInstruction ? `5) Extra instruction from ${userName}: ${extraInstruction}` : ''}`;

  const apiMessages = [{
    role: 'user',
    content: [
      { type: 'text', text: userText },
      { type: 'image', source: { type: 'url', url: imageUrl } },
    ],
  }];

  const analysis = await runImageAnalysisResponse({
    systemPrompt,
    apiMessages,
    onText: null,
    providerOverride: provider,
    modelOverride: model,
  });

  return { analysis, provider, imageUrl, versionLabel };
}

// --- Load Kona's personality files for true integration ---
function loadKonaContext() {
  const files = {
    soul: '/root/.openclaw/workspace/SOUL.md',
    nora: '/root/.openclaw/workspace/NORA_MEMORY.md',
    identity: '/root/.openclaw/workspace/IDENTITY.md'
  };
  const ctx = {};
  for (const [key, filepath] of Object.entries(files)) {
    try { ctx[key] = fs.readFileSync(filepath, 'utf-8'); } catch { ctx[key] = ''; }
  }
  return ctx;
}

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));

// --- File Upload ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const videoId = req.params.videoId;
    const dir = path.join(uploadsDir, String(videoId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ============ ACTIVITY LOGGING ============

function logActivity(videoId, actor, actionType, details) {
  try {
    db.prepare('INSERT INTO activity_log (video_id, actor, action_type, details) VALUES (?, ?, ?, ?)').run(videoId, actor, actionType, details || '');
  } catch(e) { 
    console.error('Activity log error:', e); 
  }
}

// ============ TOKEN MANAGEMENT ============

function estimateTokens(text) {
  if (!text) return 0;
  // ~3.5 chars per token for English
  return Math.ceil(text.length / 3.5);
}

function getVideoTokenCount(videoId) {
  const messages = db.prepare('SELECT content FROM messages WHERE video_id = ?').all(videoId);
  const channelMsgs = db.prepare('SELECT content FROM channel_messages WHERE video_id = ?').all(videoId);
  const video = db.prepare('SELECT script_content, description, voiceover_notes, thumbnail_ideas FROM videos WHERE id = ?').get(videoId);
  const memory = db.prepare('SELECT summary FROM video_memory WHERE video_id = ?').get(videoId);
  
  let total = 0;
  messages.forEach(m => total += estimateTokens(m.content));
  channelMsgs.forEach(m => total += estimateTokens(m.content));
  if (video) {
    total += estimateTokens(video.script_content);
    total += estimateTokens(video.description);
    total += estimateTokens(video.voiceover_notes);
    total += estimateTokens(video.thumbnail_ideas);
  }
  if (memory) total += estimateTokens(memory.summary);
  return total;
}

function getDavinciTokenCount(editorId = selectedEditorId) {
  const normalized = normalizeEditorId(editorId);
  const messages = db.prepare('SELECT content FROM davinci_chat_messages WHERE editor_id = ? ORDER BY created_at ASC').all(normalized);
  const memory = db.prepare('SELECT summary FROM editor_chat_memory WHERE editor_id = ?').get(normalized);
  let total = 0;
  messages.forEach(m => total += estimateTokens(m.content));
  if (memory?.summary) total += estimateTokens(memory.summary);
  return total;
}

async function compactVideoContext(videoId, channelType = null, keepRecent = 12) {
  const keep = Math.max(6, Number(keepRecent) || 12);
  let prunedCount = 0;
  const summaryChunks = [];

  const compactLegacy = () => {
    const rows = db.prepare('SELECT id, role, content FROM messages WHERE video_id = ? ORDER BY created_at ASC').all(videoId);
    if (rows.length <= keep) return;
    const older = rows.slice(0, rows.length - keep);
    const ids = older.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
    prunedCount += older.length;
    summaryChunks.push('[legacy]\n' + older.map(r => `${r.role}: ${r.content}`).join('\n'));
  };

  const compactChannel = (channel) => {
    const rows = db.prepare('SELECT id, role, content FROM channel_messages WHERE video_id = ? AND channel_type = ? ORDER BY created_at ASC').all(videoId, channel);
    if (rows.length <= keep) return;
    const older = rows.slice(0, rows.length - keep);
    const ids = older.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM channel_messages WHERE id IN (${placeholders})`).run(...ids);
    prunedCount += older.length;
    summaryChunks.push(`[${channel}]\n` + older.map(r => `${r.role}: ${r.content}`).join('\n'));
  };

  if (channelType) {
    compactChannel(channelType);
  } else {
    compactLegacy();
    ['script', 'description', 'thumbnail'].forEach(compactChannel);
  }

  let memoryUpdated = false;
  if (summaryChunks.length > 0) {
    const memory = db.prepare('SELECT summary FROM video_memory WHERE video_id = ?').get(videoId);
    const summaryPrompt = summaryChunks.join('\n\n');
    const compactSummary = await summarizeWithModel({
      systemPrompt: 'Summarize this conversation context into concise durable notes for future writing. Keep concrete decisions, style/tone guidance, constraints, and open threads.',
      userPrompt: summaryPrompt
    });

    const stamped = `[Manual compact ${new Date().toISOString()}]\n${compactSummary}`.trim();
    const merged = [memory?.summary || '', stamped].filter(Boolean).join('\n\n');

    db.prepare('INSERT INTO video_memory (video_id, summary, token_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(video_id) DO UPDATE SET summary = excluded.summary, token_count = excluded.token_count, updated_at = CURRENT_TIMESTAMP')
      .run(videoId, merged, getVideoTokenCount(videoId));
    memoryUpdated = true;
  }

  const newTokens = getVideoTokenCount(videoId);
  db.prepare('UPDATE video_memory SET token_count = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ?')
    .run(newTokens, videoId);

  return { prunedCount, newTokens, memoryUpdated };
}

async function compactDavinciContext(keepRecent = 20, editorId = selectedEditorId) {
  const normalized = normalizeEditorId(editorId);
  const keep = Math.max(8, Number(keepRecent) || 20);
  const rows = db.prepare('SELECT id, role, content FROM davinci_chat_messages WHERE editor_id = ? ORDER BY created_at ASC').all(normalized);
  if (rows.length <= keep) {
    return { prunedCount: 0, newTokens: getDavinciTokenCount(normalized), memoryUpdated: false };
  }

  const older = rows.slice(0, rows.length - keep);
  const ids = older.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const editor = getEditorById(normalized);

  const compactSummary = await summarizeWithModel({
    systemPrompt: `Summarize this ${editor.name} support chat into concise reusable guidance. Keep exact workflows, button paths, caveats, and troubleshooting steps.`,
    userPrompt: older.map(r => `${r.role}: ${r.content}`).join('\n')
  });

  db.prepare(`DELETE FROM davinci_chat_messages WHERE id IN (${placeholders})`).run(...ids);

  const existing = db.prepare('SELECT summary FROM editor_chat_memory WHERE editor_id = ?').get(normalized);
  const merged = [existing?.summary || '', `[Manual compact ${new Date().toISOString()}]\n${compactSummary}`]
    .filter(Boolean)
    .join('\n\n');

  db.prepare('INSERT INTO editor_chat_memory (editor_id, summary, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(editor_id) DO UPDATE SET summary = excluded.summary, updated_at = CURRENT_TIMESTAMP')
    .run(normalized, merged);

  return { prunedCount: older.length, newTokens: getDavinciTokenCount(normalized), memoryUpdated: true };
}

// ============ API ROUTES ============

async function buildModelState({ force = false } = {}) {
  normalizeImageProviderSelections({ persist: false });
  return buildModelStateService({
    ensureSelectedTextModel,
    selectedTextProvider,
    getSelectedEditor,
    providerStatus,
    imageModelCandidates,
    imageGenerationModel,
    imageAnalysisProviderOptions,
    selectedImageAnalysisProvider,
    selectedImageAnalysisModel,
    imageGenerationProviderOptions,
    selectedImageGenerationProvider,
    selectedImageGenerationModel,
    getImageAnalysisModels,
    getImageGenerationModels,
    listEditors,
    getEditorContextMeta,
  }, { force });
}

app.get('/api/models', async (req, res) => {
  const state = await buildModelState();
  res.json({ ...state, profileName: getProfileName() });
});

app.post('/api/models/refresh', async (req, res) => {
  const provider = textProviderIds.includes(req.body?.provider) ? req.body.provider : selectedTextProvider;
  clearModelCache(provider);
  await refreshOpenRouterImageModels({ force: true }).catch(() => {});
  normalizeImageProviderSelections({ persist: false });
  const state = await buildModelState({ force: true });
  res.json({ success: true, ...state, profileName: getProfileName() });
});

app.post('/api/models/select', async (req, res) => {
  const requestedProvider = textProviderIds.includes(req.body?.provider)
    ? req.body.provider
    : selectedTextProvider;

  const requestedModel = String(req.body?.model || '').trim();
  const ensured = await ensureSelectedTextModel({
    provider: requestedProvider,
    force: true,
    activateProvider: true,
  });

  if (requestedModel && !ensured.models.includes(requestedModel)) {
    return res.status(400).json({
      error: 'Invalid model selection',
      selectedTextProvider,
      selectedModel: selectedTextModel,
      models: ensured.models,
    });
  }

  if (requestedModel) {
    selectedTextProvider = requestedProvider;
    selectedTextModel = requestedModel;
    selectedProviderModels[selectedTextProvider] = selectedTextModel;
  } else {
    selectedTextProvider = requestedProvider;
    selectedTextModel = ensured.selectedModel;
    if (selectedTextModel) {
      selectedProviderModels[selectedTextProvider] = selectedTextModel;
    }
  }

  runtimeSettings.selectedTextProvider = selectedTextProvider;
  runtimeSettings.selectedTextModel = selectedTextModel;
  runtimeSettings.selectedProviderModels = selectedProviderModels;
  saveRuntimeSettings(runtimeSettings);

  const state = await buildModelState();
  res.json({ success: true, ...state, profileName: getProfileName() });
});

app.post('/api/models/image-analysis/select', async (req, res) => {
  const { provider, model } = req.body || {};
  normalizeImageProviderSelections({ persist: false });

  const nextProvider = String(provider || selectedImageAnalysisProvider || '').trim();
  if (!nextProvider || !imageAnalysisProviderOptions.includes(nextProvider)) {
    return res.status(400).json({
      error: 'Invalid image-analysis provider',
      providers: imageAnalysisProviderOptions,
      selectedImageAnalysisProvider,
    });
  }
  if (!isImageProviderConfigured(nextProvider, 'analysis')) {
    return res.status(400).json({
      error: `Image-analysis provider ${nextProvider} is not configured`,
      providers: imageAnalysisProviderOptions,
      selectedImageAnalysisProvider,
    });
  }

  selectedImageAnalysisProvider = nextProvider;
  const models = getImageAnalysisModels(selectedImageAnalysisProvider);
  const requestedModel = String(model || '').trim();
  if (requestedModel && models.includes(requestedModel)) {
    selectedImageAnalysisModel = requestedModel;
  } else if (!models.includes(selectedImageAnalysisModel)) {
    selectedImageAnalysisModel = models[0] || '';
  }

  normalizeImageProviderSelections({ persist: false });
  runtimeSettings.selectedImageAnalysisProvider = selectedImageAnalysisProvider;
  runtimeSettings.selectedImageAnalysisModel = selectedImageAnalysisModel;
  saveRuntimeSettings(runtimeSettings);

  const state = await buildModelState();
  res.json({ success: true, ...state, profileName: getProfileName() });
});

app.post('/api/models/image-generation/select', async (req, res) => {
  const { provider, model } = req.body || {};
  normalizeImageProviderSelections({ persist: false });

  const nextProvider = String(provider || selectedImageGenerationProvider || '').trim();
  if (!nextProvider || !imageGenerationProviderOptions.includes(nextProvider)) {
    return res.status(400).json({
      error: 'Invalid image-generation provider',
      providers: imageGenerationProviderOptions,
      selectedImageGenerationProvider,
    });
  }
  if (!isImageProviderConfigured(nextProvider, 'generation')) {
    return res.status(400).json({
      error: `Image-generation provider ${nextProvider} is not configured`,
      providers: imageGenerationProviderOptions,
      selectedImageGenerationProvider,
    });
  }

  selectedImageGenerationProvider = nextProvider;
  const models = getImageGenerationModels(selectedImageGenerationProvider);
  const requestedModel = String(model || '').trim();
  if (requestedModel && models.includes(requestedModel)) {
    selectedImageGenerationModel = requestedModel;
  } else if (!models.includes(selectedImageGenerationModel)) {
    selectedImageGenerationModel = models[0] || '';
  }

  normalizeImageProviderSelections({ persist: false });
  runtimeSettings.selectedImageGenerationProvider = selectedImageGenerationProvider;
  runtimeSettings.selectedImageGenerationModel = selectedImageGenerationModel;
  saveRuntimeSettings(runtimeSettings);

  const state = await buildModelState();
  res.json({ success: true, ...state, profileName: getProfileName() });
});

app.get('/api/editors', async (req, res) => {
  const editor = getSelectedEditor();
  await refreshEditorContext(editor.id, { force: false });

  res.json({
    success: true,
    selectedEditorId: editor.id,
    selectedEditorName: editor.name,
    selectedEditorShortName: editor.shortName,
    profileName: getProfileName(),
    editors: listEditors(),
    editorContext: getEditorContextMeta(editor.id),
  });
});

app.post('/api/editors/select', async (req, res) => {
  const requested = normalizeEditorId(req.body?.editorId);
  selectedEditorId = requested;
  runtimeSettings.selectedEditorId = selectedEditorId;
  saveRuntimeSettings(runtimeSettings);
  ensureEditorMemory(selectedEditorId);

  await refreshEditorContext(selectedEditorId, { force: false });

  const editor = getSelectedEditor();
  res.json({
    success: true,
    selectedEditorId: editor.id,
    selectedEditorName: editor.name,
    selectedEditorShortName: editor.shortName,
    profileName: getProfileName(),
    editors: listEditors(),
    editorContext: getEditorContextMeta(editor.id),
  });
});

app.post('/api/editors/context/refresh', async (req, res) => {
  const requested = normalizeEditorId(req.body?.editorId || selectedEditorId);
  const meta = await refreshEditorContext(requested, { force: true });
  const editor = getEditorById(requested);

  res.json({
    success: true,
    selectedEditorId: editor.id,
    selectedEditorName: editor.name,
    selectedEditorShortName: editor.shortName,
    profileName: getProfileName(),
    editorContext: meta,
  });
});

app.get('/api/settings', async (req, res) => {
  const state = await buildModelState();
  await refreshEditorContext(state.selectedEditorId, { force: false });

  res.json({
    success: true,
    envFileExists: fs.existsSync(envFilePath),
    providers: providerStatus(),
    selectedTextProvider: state.selectedTextProvider,
    selectedTextModel: state.selectedModel,
    availableModels: state.models,
    selectedImageAnalysisProvider,
    selectedImageAnalysisModel,
    imageAnalysisProviders: imageAnalysisProviderOptions,
    imageAnalysisModels: getImageAnalysisModels(selectedImageAnalysisProvider),
    selectedImageGenerationProvider,
    selectedImageGenerationModel,
    imageGenerationProviders: imageGenerationProviderOptions,
    imageGenerationModels: getImageGenerationModels(selectedImageGenerationProvider),
    selectedEditorId: state.selectedEditorId,
    selectedEditorName: state.selectedEditorName,
    selectedEditorShortName: state.selectedEditorShortName,
    profileName: getProfileName(),
    editors: state.editors,
    editorContext: getEditorContextMeta(state.selectedEditorId),
    ollamaBaseUrl,
  });
});

app.post('/api/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const keys = (body.keys && typeof body.keys === 'object') ? body.keys : {};

    if (Object.prototype.hasOwnProperty.call(body, 'profileName')) {
      const candidate = String(body.profileName || '').trim();
      profileName = candidate || defaultUserName;
    }

    const envUpdates = {};
    if (Object.prototype.hasOwnProperty.call(keys, 'anthropic')) envUpdates.ANTHROPIC_API_KEY = String(keys.anthropic || '').trim();
    if (Object.prototype.hasOwnProperty.call(keys, 'openai')) envUpdates.OPENAI_API_KEY = String(keys.openai || '').trim();
    if (Object.prototype.hasOwnProperty.call(keys, 'xai')) envUpdates.XAI_API_KEY = String(keys.xai || '').trim();
    if (Object.prototype.hasOwnProperty.call(keys, 'gemini')) envUpdates.GEMINI_API_KEY = String(keys.gemini || '').trim();
    if (Object.prototype.hasOwnProperty.call(keys, 'openrouter')) envUpdates.OPENROUTER_API_KEY = String(keys.openrouter || '').trim();
    if (Object.prototype.hasOwnProperty.call(keys, 'ollama')) envUpdates.OLLAMA_API_KEY = String(keys.ollama || '').trim();

    if (Object.prototype.hasOwnProperty.call(body, 'openRouterBaseUrl')) envUpdates.OPENROUTER_BASE_URL = String(body.openRouterBaseUrl || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'openAiBaseUrl')) envUpdates.OPENAI_BASE_URL = String(body.openAiBaseUrl || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'xaiBaseUrl')) envUpdates.XAI_BASE_URL = String(body.xaiBaseUrl || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'ollamaBaseUrl')) envUpdates.OLLAMA_BASE_URL = String(body.ollamaBaseUrl || '').trim();

    if (Object.keys(envUpdates).length > 0) {
      updateEnvFile(envUpdates);
      refreshApiClients();
      clearModelCache();
      await refreshOpenRouterImageModels({ force: true }).catch(() => {});
      normalizeImageProviderSelections();
    }

    const requestedEditorId = normalizeEditorId(body.selectedEditorId || selectedEditorId);
    selectedEditorId = requestedEditorId;
    ensureEditorMemory(selectedEditorId);
    await refreshEditorContext(selectedEditorId, { force: false });

    const requestedProvider = textProviderIds.includes(body.selectedTextProvider)
      ? body.selectedTextProvider
      : selectedTextProvider;

    const ensured = await ensureSelectedTextModel({
      provider: requestedProvider,
      force: true,
      activateProvider: true,
    });

    const requestedModel = String(body.selectedTextModel || '').trim();
    if (requestedModel) {
      if (!ensured.models.includes(requestedModel)) {
        return res.status(400).json({
          error: 'Invalid selectedTextModel for the selected provider',
          provider: requestedProvider,
          models: ensured.models,
        });
      }
      selectedTextModel = requestedModel;
      selectedProviderModels[requestedProvider] = requestedModel;
    } else {
      selectedTextModel = ensured.selectedModel;
      if (selectedTextModel) {
        selectedProviderModels[requestedProvider] = selectedTextModel;
      }
    }

    selectedTextProvider = requestedProvider;

    if (body.selectedImageAnalysisProvider) {
      if (!imageAnalysisProviderOptions.includes(body.selectedImageAnalysisProvider)) {
        return res.status(400).json({
          error: 'Invalid selectedImageAnalysisProvider',
          providers: imageAnalysisProviderOptions,
        });
      }
      selectedImageAnalysisProvider = body.selectedImageAnalysisProvider;
    }

    if (body.selectedImageAnalysisModel) {
      const models = getImageAnalysisModels(selectedImageAnalysisProvider);
      if (!models.includes(body.selectedImageAnalysisModel)) {
        return res.status(400).json({
          error: 'Invalid selectedImageAnalysisModel',
          models,
        });
      }
      selectedImageAnalysisModel = body.selectedImageAnalysisModel;
    }

    if (body.selectedImageGenerationProvider) {
      if (!imageGenerationProviderOptions.includes(body.selectedImageGenerationProvider)) {
        return res.status(400).json({
          error: 'Invalid selectedImageGenerationProvider',
          providers: imageGenerationProviderOptions,
        });
      }
      selectedImageGenerationProvider = body.selectedImageGenerationProvider;
    }

    if (body.selectedImageGenerationModel) {
      const models = getImageGenerationModels(selectedImageGenerationProvider);
      if (!models.includes(body.selectedImageGenerationModel)) {
        return res.status(400).json({
          error: 'Invalid selectedImageGenerationModel',
          models,
        });
      }
      selectedImageGenerationModel = body.selectedImageGenerationModel;
    }

    normalizeImageProviderSelections();

    runtimeSettings.selectedEditorId = selectedEditorId;
    runtimeSettings.selectedTextProvider = selectedTextProvider;
    runtimeSettings.selectedTextModel = selectedTextModel;
    runtimeSettings.selectedProviderModels = selectedProviderModels;
    runtimeSettings.selectedImageAnalysisProvider = selectedImageAnalysisProvider;
    runtimeSettings.selectedImageAnalysisModel = selectedImageAnalysisModel;
    runtimeSettings.selectedImageGenerationProvider = selectedImageGenerationProvider;
    runtimeSettings.selectedImageGenerationModel = selectedImageGenerationModel;
    runtimeSettings.profileName = profileName;
    saveRuntimeSettings(runtimeSettings);

    const state = await buildModelState();
    res.json({
      success: true,
      ...state,
      providers: providerStatus(),
      selectedTextModel: selectedTextModel,
      selectedImageAnalysisProvider,
      selectedImageAnalysisModel,
      selectedImageGenerationProvider,
      selectedImageGenerationModel,
      profileName: getProfileName(),
      ollamaBaseUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save settings' });
  }
});

app.get('/api/credits', (req, res) => {
  // Anthropic standard API keys do not currently expose prepaid remaining balance directly.
  // Allow manual display override if owner wants to set one.
  const manual = process.env.NORA_WRITER_CLAUDE_CREDITS_DISPLAY || '';
  if (manual) {
    return res.json({ available: true, display: manual, source: 'manual' });
  }

  return res.json({
    available: false,
    display: 'Unavailable via standard Claude API key',
    source: 'anthropic-api-limit',
  });
});

// --- Long-term Findings ---
app.use('/api/findings', createFindingsRouter({ db }));

// --- Videos ---
app.get('/api/videos', (req, res) => {
  const videos = db.prepare(`
    SELECT v.*, 
      (SELECT COUNT(*) FROM messages WHERE video_id = v.id) as message_count
    FROM videos v ORDER BY v.updated_at DESC
  `).all();
  res.json(videos);
});

app.post('/api/videos', (req, res) => {
  const { title } = req.body;
  const result = db.prepare('INSERT INTO videos (title) VALUES (?)').run(title || 'Untitled Video');
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(result.lastInsertRowid);
  // Init memory
  db.prepare('INSERT INTO video_memory (video_id) VALUES (?)').run(video.id);
  res.json(video);
});

app.get('/api/videos/:id', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const uploads_list = db.prepare('SELECT * FROM uploads WHERE video_id = ? ORDER BY created_at DESC').all(video.id);
  const memory = db.prepare('SELECT * FROM video_memory WHERE video_id = ?').get(video.id);
  res.json({ ...video, uploads: uploads_list, memory });
});

app.put('/api/videos/:id', (req, res) => {
  const { title, status, script_content, description, voiceover_notes, thumbnail_ideas } = req.body;
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE videos SET 
      title = COALESCE(?, title),
      status = COALESCE(?, status),
      script_content = COALESCE(?, script_content),
      description = COALESCE(?, description),
      voiceover_notes = COALESCE(?, voiceover_notes),
      thumbnail_ideas = COALESCE(?, thumbnail_ideas),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, status, script_content, description, voiceover_notes, thumbnail_ideas, req.params.id);

  // Log activity
  const changed = Object.keys(req.body).filter(k => req.body[k] !== undefined && k !== 'id');
  if (changed.length > 0) {
    logActivity(req.params.id, getProfileName(), 'edit', 'Updated ' + changed.join(', '));
  }

  // Auto-snapshot: every 30 minutes
  const lastSnap = db.prepare('SELECT created_at FROM script_snapshots WHERE video_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  if (!lastSnap || lastSnap.created_at < thirtyMinAgo) {
    const currentVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    db.prepare('INSERT INTO script_snapshots (video_id, label, script_content, description, voiceover_notes, thumbnail_ideas, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      req.params.id, 
      'Auto-save', 
      currentVideo.script_content, 
      currentVideo.description, 
      currentVideo.voiceover_notes, 
      currentVideo.thumbnail_ideas, 
      'auto'
    );
  }

  const updated = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/videos/:id', (req, res) => {
  db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
  // Clean up upload files
  const dir = path.join(uploadsDir, String(req.params.id));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  res.json({ success: true });
});

app.get('/api/videos/:videoId/tokens', (req, res) => {
  const count = getVideoTokenCount(req.params.videoId);
  const max = 300000;
  res.json({ 
    tokens: count, 
    max, 
    percentage: Math.round((count / max) * 100), 
    warning: count > 250000, 
    critical: count > 280000 
  });
});

app.post('/api/videos/:videoId/compact', async (req, res) => {
  try {
    const { channelType = null, keepRecent = 12 } = req.body || {};
    const result = await compactVideoContext(req.params.videoId, channelType, keepRecent);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Manual compact failed:', err);
    res.status(500).json({ error: err.message || 'Compaction failed' });
  }
});

// --- Version History / Snapshots ---
app.get('/api/videos/:videoId/snapshots', (req, res) => {
  const snapshots = db.prepare('SELECT * FROM script_snapshots WHERE video_id = ? ORDER BY created_at DESC').all(req.params.videoId);
  res.json(snapshots);
});

app.post('/api/videos/:videoId/snapshots', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const label = req.body.label || 'Manual snapshot';
  db.prepare('INSERT INTO script_snapshots (video_id, label, script_content, description, voiceover_notes, thumbnail_ideas, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    video.id, 
    label, 
    video.script_content, 
    video.description, 
    video.voiceover_notes, 
    video.thumbnail_ideas, 
    'manual'
  );
  logActivity(req.params.videoId, getProfileName(), 'snapshot', label);
  res.json({ success: true });
});

app.post('/api/videos/:videoId/snapshots/:snapshotId/restore', (req, res) => {
  const snapshot = db.prepare('SELECT * FROM script_snapshots WHERE id = ? AND video_id = ?').get(req.params.snapshotId, req.params.videoId);
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
  
  // Auto-save current state before restore
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  db.prepare('INSERT INTO script_snapshots (video_id, label, script_content, description, voiceover_notes, thumbnail_ideas, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    video.id, 
    'Auto-save before restore', 
    video.script_content, 
    video.description, 
    video.voiceover_notes, 
    video.thumbnail_ideas, 
    'auto'
  );
  
  // Restore from snapshot
  db.prepare('UPDATE videos SET script_content = ?, description = ?, voiceover_notes = ?, thumbnail_ideas = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    snapshot.script_content, 
    snapshot.description, 
    snapshot.voiceover_notes, 
    snapshot.thumbnail_ideas, 
    req.params.videoId
  );
  
  logActivity(req.params.videoId, getProfileName(), 'restore', 'Restored from snapshot: ' + snapshot.label);
  
  res.json({ success: true });
});

app.delete('/api/videos/:videoId/snapshots/:snapshotId', (req, res) => {
  db.prepare('DELETE FROM script_snapshots WHERE id = ? AND video_id = ?').run(req.params.snapshotId, req.params.videoId);
  res.json({ success: true });
});

app.get('/api/videos/:videoId/snapshots/diff', (req, res) => {
  const { a, b } = req.query;
  const snapA = db.prepare('SELECT * FROM script_snapshots WHERE id = ?').get(a);
  const snapB = db.prepare('SELECT * FROM script_snapshots WHERE id = ?').get(b);
  if (!snapA || !snapB) return res.status(404).json({ error: 'Snapshot not found' });
  res.json({ a: snapA, b: snapB });
});

// --- Messages / Chat ---
app.get('/api/videos/:videoId/messages', (req, res) => {
  const messages = db.prepare('SELECT * FROM messages WHERE video_id = ? ORDER BY created_at ASC')
    .all(req.params.videoId);
  res.json(messages);
});

app.post('/api/videos/:videoId/chat', async (req, res) => {
  const { message } = req.body;
  const videoId = req.params.videoId;

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  // Save user message
  db.prepare('INSERT INTO messages (video_id, role, content) VALUES (?, ?, ?)')
    .run(videoId, 'user', message);
  
  // Log activity
  logActivity(videoId, getProfileName(), 'message', 'legacy chat');

  // Get conversation history
  let messages = db.prepare('SELECT role, content FROM messages WHERE video_id = ? ORDER BY created_at ASC')
    .all(videoId);

  // Get memory
  const memory = db.prepare('SELECT * FROM video_memory WHERE video_id = ?').get(videoId);
  const globalMemory = JSON.parse(fs.readFileSync(globalMemoryPath, 'utf-8'));

  // Check token count
  const tokenCount = getVideoTokenCount(videoId);
  const shouldSummarize = messages.length > 50 || tokenCount > 250000;
  const tokenWarning = tokenCount > 250000;
  const tokenCritical = tokenCount > 280000;

  // Auto-summarize if needed
  if (shouldSummarize) {
    await summarizeConversation(videoId, messages, memory);
    messages = db.prepare('SELECT role, content FROM messages WHERE video_id = ? ORDER BY created_at ASC')
      .all(videoId);
  }

  // Build system prompt
  const systemPrompt = buildSystemPrompt(video, memory, globalMemory);

  // Format messages for Anthropic (filter empty content)
  const apiMessages = messages
    .filter(m => m.content && m.content.trim().length > 0)
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }));

  try {
    // Stream response via SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let fullResponse = await generateResponse({
      systemPrompt: `You are Kona Writer, a Claude-powered scriptwriting assistant.\n\n${systemPrompt}`,
      apiMessages,
      onText: (text) => {
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
    });

    // Save assistant message
    db.prepare('INSERT INTO messages (video_id, role, content) VALUES (?, ?, ?)')
      .run(videoId, 'assistant', fullResponse);

    // Update video timestamp and token count in memory
    db.prepare('UPDATE videos SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(videoId);
    const newTokenCount = getVideoTokenCount(videoId);
    db.prepare('UPDATE video_memory SET token_count = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ?')
      .run(newTokenCount, videoId);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
      res.end();
    }
  }
});

// --- Channel-specific Messages / Chat ---
app.get('/api/videos/:videoId/channels/:channelType/messages', (req, res) => {
  const { videoId, channelType } = req.params;
  const validChannels = ['script', 'description', 'thumbnail'];
  if (!validChannels.includes(channelType)) {
    return res.status(400).json({ error: 'Invalid channel type' });
  }
  
  const messages = db.prepare(
    'SELECT * FROM channel_messages WHERE video_id = ? AND channel_type = ? ORDER BY created_at ASC'
  ).all(videoId, channelType);
  res.json(messages);
});

app.delete('/api/videos/:videoId/channels/:channelType/messages', (req, res) => {
  const { videoId, channelType } = req.params;
  const validChannels = ['script', 'description', 'thumbnail'];
  if (!validChannels.includes(channelType)) {
    return res.status(400).json({ error: 'Invalid channel type' });
  }
  
  db.prepare('DELETE FROM channel_messages WHERE video_id = ? AND channel_type = ?')
    .run(videoId, channelType);
  res.json({ success: true });
});

app.post('/api/videos/:videoId/channels/:channelType/chat', async (req, res) => {
  const { videoId, channelType } = req.params;
  const { message, imageUrl, selectedThumbnailVersionId } = req.body;
  const validChannels = ['script', 'description', 'thumbnail'];
  
  if (!validChannels.includes(channelType)) {
    return res.status(400).json({ error: 'Invalid channel type' });
  }
  
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  
  // Save user message to channel (with imageUrl if present)
  db.prepare('INSERT INTO channel_messages (video_id, channel_type, role, content, image_url) VALUES (?, ?, ?, ?, ?)')
    .run(videoId, channelType, 'user', message, imageUrl || null);
  
  // Log activity
  logActivity(videoId, getProfileName(), 'message', channelType + ' chat');
  
  // Get THIS channel's messages
  let channelMessages = db.prepare(
    'SELECT role, content, image_url FROM channel_messages WHERE video_id = ? AND channel_type = ? ORDER BY created_at ASC'
  ).all(videoId, channelType);
  
  // Get SHARED memory (all channels contribute to this)
  const memory = db.prepare('SELECT * FROM video_memory WHERE video_id = ?').get(videoId);
  const globalMemory = JSON.parse(fs.readFileSync(globalMemoryPath, 'utf-8'));

  let selectedThumbnailVersion = null;
  if (channelType === 'thumbnail' && selectedThumbnailVersionId !== undefined && selectedThumbnailVersionId !== null) {
    const versionIdNum = Number(selectedThumbnailVersionId);
    if (Number.isFinite(versionIdNum) && versionIdNum > 0) {
      selectedThumbnailVersion = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ? AND video_id = ?').get(versionIdNum, videoId) || null;
    }
  }
  
  // Build system prompt with channel context
  const systemPrompt = buildChannelSystemPrompt(video, memory, globalMemory, channelType, {
    selectedThumbnailVersion,
  });
  
  // Format messages for Anthropic (filter empty content, support images)
  const apiMessages = channelMessages
    .filter(m => m.content && m.content.trim().length > 0)
    .map(m => {
      const msg = {
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      };
      
      // If there's an image URL, format as vision API message
      if (m.image_url && m.role === 'user') {
        const imageUrlMatch = m.image_url;
        if (imageUrlMatch) {
          msg.content = [
            { type: 'text', text: m.content },
            { type: 'image', source: { type: 'url', url: `http://localhost:${PORT}${imageUrlMatch}` } }
          ];
        }
      }
      
      return msg;
    });

  // Thumbnail channel: attach selected thumbnail version image (fallback: latest uploaded)
  if (channelType === 'thumbnail') {
    const activeThumb = selectedThumbnailVersion
      || db.prepare('SELECT * FROM thumbnail_versions WHERE video_id = ? ORDER BY version_number DESC LIMIT 1').get(videoId);

    if (activeThumb) {
      const imagePart = {
        type: 'image',
        source: { type: 'url', url: buildLocalUploadUrl(videoId, activeThumb.filename) }
      };

      for (let i = apiMessages.length - 1; i >= 0; i--) {
        if (apiMessages[i].role !== 'user') continue;

        if (Array.isArray(apiMessages[i].content)) {
          const hasImage = apiMessages[i].content.some(p => p?.type === 'image');
          if (!hasImage) apiMessages[i].content.push(imagePart);
        } else {
          apiMessages[i].content = [
            { type: 'text', text: String(apiMessages[i].content || '') },
            imagePart,
          ];
        }
        break;
      }
    }
  }
  
  try {
    // Stream response via SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let fullResponse = await generateResponse({
      systemPrompt: `You are Kona Writer, a Claude-powered scriptwriting assistant.\n\n${systemPrompt}`,
      apiMessages,
      onText: (text) => {
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
    });

    // Save assistant message to channel
    db.prepare('INSERT INTO channel_messages (video_id, channel_type, role, content) VALUES (?, ?, ?, ?)')
      .run(videoId, channelType, 'assistant', fullResponse);

    // Update video timestamp and token count in memory
    db.prepare('UPDATE videos SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(videoId);
    const newTokenCount = getVideoTokenCount(videoId);
    db.prepare('UPDATE video_memory SET token_count = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ?')
      .run(newTokenCount, videoId);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Channel chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
      res.end();
    }
  }
});

// --- Uploads ---
app.post('/api/videos/:videoId/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  db.prepare('INSERT INTO uploads (video_id, filename, original_name, mime_type) VALUES (?, ?, ?, ?)')
    .run(req.params.videoId, req.file.filename, req.file.originalname, req.file.mimetype);

  res.json({
    filename: req.file.filename,
    original_name: req.file.originalname,
    url: `/uploads/${req.params.videoId}/${req.file.filename}`
  });
});

app.delete('/api/uploads/:id', (req, res) => {
  const upload_row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
  if (!upload_row) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(uploadsDir, String(upload_row.video_id), upload_row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM uploads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Thumbnail Versions ---
// Get all thumbnail versions for a video
app.get('/api/videos/:videoId/thumbnails', (req, res) => {
  const versions = db.prepare(
    'SELECT * FROM thumbnail_versions WHERE video_id = ? ORDER BY major_version DESC, minor_version DESC, version_number DESC'
  ).all(req.params.videoId);
  res.json(versions.map(normalizeThumbnailVersion));
});

// Upload a new thumbnail version
app.post('/api/videos/:videoId/thumbnails', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const videoId = Number(req.params.videoId);
  const notes = req.body.notes || '';
  const parentVersionId = req.body.parentVersionId ? Number(req.body.parentVersionId) : null;
  const source = req.body.source || 'upload';
  const requestedProvider = req.body.analysisProvider || selectedImageAnalysisProvider;

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const next = getNextThumbnailVersionMeta(videoId, parentVersionId);

  db.prepare(
    `INSERT INTO thumbnail_versions
      (video_id, filename, original_name, notes, version_number, major_version, minor_version, parent_version_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    req.file.filename,
    req.file.originalname,
    notes,
    next.versionNumber,
    next.majorVersion,
    next.minorVersion,
    next.parentVersionId,
    source
  );

  db.prepare('UPDATE videos SET thumbnail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(`/uploads/${videoId}/${req.file.filename}`, videoId);

  try {
    db.prepare('INSERT INTO activity_log (video_id, actor, action_type, details) VALUES (?, ?, ?, ?)')
      .run(videoId, getProfileName(), 'thumbnail_upload', `Version ${next.majorVersion}.${next.minorVersion}: ${req.file.originalname}`);
  } catch (e) {
    // ignore
  }

  let version = db.prepare('SELECT * FROM thumbnail_versions WHERE video_id = ? AND version_number = ?')
    .get(videoId, next.versionNumber);

  // Auto-analyze on every upload for the thumbnail channel
  try {
    const analyzed = await analyzeThumbnailVersion({
      video,
      version,
      providerOverride: requestedProvider,
    });

    db.prepare('UPDATE thumbnail_versions SET analysis = ?, analysis_provider = ?, analysis_requested_at = CURRENT_TIMESTAMP, analysis_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(analyzed.analysis, analyzed.provider, version.id);

    version = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ?').get(version.id);
  } catch (err) {
    console.warn('Auto thumbnail analysis failed:', err.message);
  }

  res.json(normalizeThumbnailVersion(version));
});

app.post('/api/videos/:videoId/thumbnails/:versionId/analyze', async (req, res) => {
  const videoId = Number(req.params.videoId);
  const versionId = Number(req.params.versionId);
  const { provider = selectedImageAnalysisProvider, model = selectedImageAnalysisModel, instruction = '' } = req.body || {};

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const version = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ? AND video_id = ?').get(versionId, videoId);
  if (!version) return res.status(404).json({ error: 'Thumbnail version not found' });

  try {
    const analyzed = await analyzeThumbnailVersion({
      video,
      version,
      providerOverride: provider,
      modelOverride: model,
      extraInstruction: instruction,
    });

    db.prepare('UPDATE thumbnail_versions SET analysis = ?, analysis_provider = ?, analysis_requested_at = CURRENT_TIMESTAMP, analysis_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(analyzed.analysis, analyzed.provider, version.id);

    const updated = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ?').get(version.id);
    res.json({
      success: true,
      provider: analyzed.provider,
      analysis: analyzed.analysis,
      version: normalizeThumbnailVersion(updated),
    });
  } catch (err) {
    console.error('Thumbnail analysis failed:', err);
    res.status(500).json({ error: err.message || 'Thumbnail analysis failed' });
  }
});

app.post('/api/videos/:videoId/thumbnails/:versionId/improve', async (req, res) => {
  const videoId = Number(req.params.videoId);
  const versionId = Number(req.params.versionId);
  const {
    instruction = '',
    analysisProvider = selectedImageAnalysisProvider,
    analysisModel = selectedImageAnalysisModel,
    generationProvider = selectedImageGenerationProvider,
    generationModel = selectedImageGenerationModel,
  } = req.body || {};

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const baseVersion = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ? AND video_id = ?').get(versionId, videoId);
  if (!baseVersion) return res.status(404).json({ error: 'Thumbnail version not found' });

  try {
    const analysisProviderId = String(analysisProvider || '').trim();
    const analysisModelId = String(analysisModel || '').trim();
    const generationProviderId = String(generationProvider || '').trim();
    const generationModelId = String(generationModel || '').trim();

    if (!imageAnalysisProviderOptions.includes(analysisProviderId)) {
      return res.status(400).json({ error: `Invalid image analysis provider: ${analysisProviderId}` });
    }
    if (!imageGenerationProviderOptions.includes(generationProviderId)) {
      return res.status(400).json({ error: `Invalid image generation provider: ${generationProviderId}` });
    }

    if (!isImageProviderConfigured(analysisProviderId, 'analysis')) {
      return res.status(400).json({ error: `Image analysis provider not configured: ${analysisProviderId}` });
    }
    if (!isImageProviderConfigured(generationProviderId, 'generation')) {
      return res.status(400).json({ error: `Image generation provider not configured: ${generationProviderId}` });
    }

    const analyzed = await analyzeThumbnailVersion({
      video,
      version: baseVersion,
      providerOverride: analysisProviderId,
      modelOverride: analysisModelId,
      extraInstruction: instruction,
    });

    const researchContext = loadThumbnailResearchContext();
    const findingsBlock = getLongTermFindingsPromptBlock();
    const userName = getProfileName();
    const planSystemPrompt = `You are ${userName}'s thumbnail optimization strategist.

Return STRICT JSON with keys:
- summary (string)
- improvements (array of strings)
- generation_prompt (string, detailed image-generation-ready prompt for a 1280x720 thumbnail)
- overlay_text_options (array of max-5-word strings)
- title_synergy_hooks (array of strings)

No markdown. No prose outside JSON.

Use this thumbnail research bible as hard context:
${researchContext || '(No research document loaded.)'}

Always apply these long-term creator findings:
${findingsBlock || '(none)'}`;

    const planUserPrompt = `Video title: ${video.title}
Current version label: ${getThumbnailVersionLabel(baseVersion)}
Current notes: ${baseVersion.notes || '(none)'}
Image analysis provider: ${analyzed.provider}
Image analysis:
${analyzed.analysis}

Optional optimization note from ${userName}:
${instruction || '(none)'}

Create a stronger subversion while preserving truthful packaging and mobile legibility.`;

    const planRaw = await runTextPlanningWithProviderFallback({
      systemPrompt: planSystemPrompt,
      apiMessages: [{ role: 'user', content: planUserPrompt }],
      onText: null,
      maxModels: 4,
      preferredProvider: getPlanningProviderForImageGeneration(generationProviderId),
      allowFallback: false,
    });

    const planJson = extractJsonFromText(planRaw) || {};
    const generationPrompt = String(planJson.generation_prompt || '').trim() ||
      `Create a high-CTR truthful YouTube thumbnail for "${video.title}" using the following analysis: ${analyzed.analysis}`;

    const imageBuffer = await generateImageWithProvider(generationPrompt, generationProviderId, generationModelId);
    const subMeta = getNextThumbnailVersionMeta(videoId, baseVersion.id);

    const dir = path.join(uploadsDir, String(videoId));
    fs.mkdirSync(dir, { recursive: true });

    const safeProvider = generationProviderId.replace(/[^a-z0-9_-]/gi, '');
    const filename = `${Date.now()}-${safeProvider}-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(dir, filename), imageBuffer);

    const notes = String(planJson.summary || '').trim() || `AI subversion from ${getThumbnailVersionLabel(baseVersion)}`;

    db.prepare(
      `INSERT INTO thumbnail_versions
      (video_id, filename, original_name, notes, version_number, major_version, minor_version, parent_version_id, source, analysis, analysis_provider, analysis_requested_at, analysis_updated_at, generation_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`
    ).run(
      videoId,
      filename,
      `${safeProvider}-${getThumbnailVersionLabel(baseVersion)}.png`,
      notes,
      subMeta.versionNumber,
      subMeta.majorVersion,
      subMeta.minorVersion,
      subMeta.parentVersionId,
      safeProvider,
      analyzed.analysis,
      analyzed.provider,
      generationPrompt,
    );

    db.prepare('UPDATE videos SET thumbnail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(`/uploads/${videoId}/${filename}`, videoId);

    const created = db.prepare('SELECT * FROM thumbnail_versions WHERE video_id = ? AND version_number = ?')
      .get(videoId, subMeta.versionNumber);

    try {
      db.prepare('INSERT INTO activity_log (video_id, actor, action_type, details) VALUES (?, ?, ?, ?)')
        .run(videoId, 'Kona', 'thumbnail_ai_subversion', `Generated v${subMeta.majorVersion}.${subMeta.minorVersion} via ${imageProviderLabel(generationProviderId)}`);
    } catch (e) {
      // ignore
    }

    res.json({
      success: true,
      baseVersion: normalizeThumbnailVersion(baseVersion),
      createdVersion: normalizeThumbnailVersion(created),
      plan: {
        summary: planJson.summary || '',
        improvements: Array.isArray(planJson.improvements) ? planJson.improvements : [],
        overlay_text_options: Array.isArray(planJson.overlay_text_options) ? planJson.overlay_text_options : [],
        title_synergy_hooks: Array.isArray(planJson.title_synergy_hooks) ? planJson.title_synergy_hooks : [],
        generation_prompt: generationPrompt,
      },
    });
  } catch (err) {
    console.error('Thumbnail improve+generate failed:', err);
    res.status(500).json({ error: err.message || 'Thumbnail improvement generation failed' });
  }
});

app.post('/api/videos/:videoId/thumbnails/generate-fresh', async (req, res) => {
  const videoId = Number(req.params.videoId);
  const {
    instruction = '',
    analysisProvider = selectedImageAnalysisProvider,
    analysisModel = selectedImageAnalysisModel,
    generationProvider = selectedImageGenerationProvider,
    generationModel = selectedImageGenerationModel,
  } = req.body || {};

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  try {
    const analysisProviderId = String(analysisProvider || '').trim();
    const analysisModelId = String(analysisModel || '').trim();
    const generationProviderId = String(generationProvider || '').trim();
    const generationModelId = String(generationModel || '').trim();

    if (!imageAnalysisProviderOptions.includes(analysisProviderId)) {
      return res.status(400).json({ error: `Invalid image analysis provider: ${analysisProviderId}` });
    }
    if (!imageGenerationProviderOptions.includes(generationProviderId)) {
      return res.status(400).json({ error: `Invalid image generation provider: ${generationProviderId}` });
    }

    if (!isImageProviderConfigured(analysisProviderId, 'analysis')) {
      return res.status(400).json({ error: `Image analysis provider not configured: ${analysisProviderId}` });
    }
    if (!isImageProviderConfigured(generationProviderId, 'generation')) {
      return res.status(400).json({ error: `Image generation provider not configured: ${generationProviderId}` });
    }

    const researchContext = loadThumbnailResearchContext();
    const findingsBlock = getLongTermFindingsPromptBlock();
    const userName = getProfileName();

    const planSystemPrompt = `You are ${userName}'s thumbnail ideation strategist.

Return STRICT JSON with keys:
- summary (string)
- concept (string)
- generation_prompt (string, detailed image-generation-ready prompt for a 1280x720 thumbnail)
- overlay_text_options (array of max-5-word strings)
- title_synergy_hooks (array of strings)

No markdown. No prose outside JSON.

Use this thumbnail research bible as hard context:
${researchContext || '(No research document loaded.)'}

Always apply these long-term creator findings:
${findingsBlock || '(none)'}`;

    const planUserPrompt = `Video title: ${video.title}
Script summary:
${String(video.script_content || '').slice(0, 4000) || '(empty)'}
Description summary:
${String(video.description || '').slice(0, 2000) || '(empty)'}
Existing thumbnail notes:
${String(video.thumbnail_ideas || '').slice(0, 1200) || '(none)'}
Optional optimization note from ${userName}:
${instruction || '(none)'}

Generate a fresh thumbnail concept from scratch (not a variation of an existing image) while preserving truthful packaging and mobile legibility.`;

    const planRaw = await runTextPlanningWithProviderFallback({
      systemPrompt: planSystemPrompt,
      apiMessages: [{ role: 'user', content: planUserPrompt }],
      onText: null,
      maxModels: 4,
      preferredProvider: getPlanningProviderForImageGeneration(generationProviderId),
      allowFallback: false,
    });

    const planJson = extractJsonFromText(planRaw) || {};
    const generationPrompt = String(planJson.generation_prompt || '').trim()
      || `Create a high-CTR truthful YouTube thumbnail for "${video.title}" from scratch.`;

    const imageBuffer = await generateImageWithProvider(generationPrompt, generationProviderId, generationModelId);
    const next = getNextThumbnailVersionMeta(videoId, null);

    const dir = path.join(uploadsDir, String(videoId));
    fs.mkdirSync(dir, { recursive: true });

    const safeProvider = generationProviderId.replace(/[^a-z0-9_-]/gi, '');
    const filename = `${Date.now()}-${safeProvider}-fresh-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(dir, filename), imageBuffer);

    const notes = String(planJson.summary || planJson.concept || '').trim() || 'AI fresh thumbnail from scratch';

    db.prepare(
      `INSERT INTO thumbnail_versions
      (video_id, filename, original_name, notes, version_number, major_version, minor_version, parent_version_id, source, generation_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      videoId,
      filename,
      `${safeProvider}-fresh.png`,
      notes,
      next.versionNumber,
      next.majorVersion,
      next.minorVersion,
      next.parentVersionId,
      `${safeProvider}-fresh`,
      generationPrompt,
    );

    db.prepare('UPDATE videos SET thumbnail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(`/uploads/${videoId}/${filename}`, videoId);

    const created = db.prepare('SELECT * FROM thumbnail_versions WHERE video_id = ? AND version_number = ?')
      .get(videoId, next.versionNumber);

    let analyzedProvider = analysisProviderId;
    let analyzedText = '';

    try {
      const analyzed = await analyzeThumbnailVersion({
        video,
        version: created,
        providerOverride: analysisProviderId,
        modelOverride: analysisModelId,
        extraInstruction: instruction,
      });

      analyzedProvider = analyzed.provider;
      analyzedText = analyzed.analysis;

      db.prepare('UPDATE thumbnail_versions SET analysis = ?, analysis_provider = ?, analysis_requested_at = CURRENT_TIMESTAMP, analysis_updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(analyzed.analysis, analyzed.provider, created.id);
    } catch (analysisErr) {
      console.warn('Fresh thumbnail auto-analysis failed:', analysisErr.message);
    }

    try {
      db.prepare('INSERT INTO activity_log (video_id, actor, action_type, details) VALUES (?, ?, ?, ?)')
        .run(videoId, 'Kona', 'thumbnail_ai_fresh', `Generated fresh v${next.majorVersion}.${next.minorVersion} via ${imageProviderLabel(generationProviderId)}`);
    } catch (e) {
      // ignore
    }

    const updated = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ?').get(created.id);

    res.json({
      success: true,
      createdVersion: normalizeThumbnailVersion(updated),
      analysis: analyzedText,
      analysisProvider: analyzedProvider,
      plan: {
        summary: planJson.summary || planJson.concept || '',
        overlay_text_options: Array.isArray(planJson.overlay_text_options) ? planJson.overlay_text_options : [],
        title_synergy_hooks: Array.isArray(planJson.title_synergy_hooks) ? planJson.title_synergy_hooks : [],
        generation_prompt: generationPrompt,
      },
    });
  } catch (err) {
    console.error('Fresh thumbnail generation failed:', err);
    res.status(500).json({ error: err.message || 'Fresh thumbnail generation failed' });
  }
});

// Delete a thumbnail version
app.delete('/api/videos/:videoId/thumbnails/:versionId', (req, res) => {
  const version = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ?').get(req.params.versionId);
  if (!version) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(uploadsDir, String(req.params.videoId), version.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM thumbnail_versions WHERE id = ?').run(req.params.versionId);

  const latest = db.prepare('SELECT * FROM thumbnail_versions WHERE video_id = ? ORDER BY version_number DESC LIMIT 1').get(req.params.videoId);
  const thumbPath = latest ? `/uploads/${req.params.videoId}/${latest.filename}` : null;
  db.prepare('UPDATE videos SET thumbnail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thumbPath, req.params.videoId);

  res.json({ success: true });
});

// --- Export Endpoints ---
// Export as plain text
app.get('/api/videos/:videoId/export/text', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Not found' });
  
  let text = `# ${video.title}\n\n`;
  text += `## Script\n\n${video.script_content || '(empty)'}\n\n`;
  text += `## Description\n\n${video.description || '(empty)'}\n\n`;
  text += `## Voiceover Notes\n\n${video.voiceover_notes || '(empty)'}\n\n`;
  text += `## Thumbnail Ideas\n\n${video.thumbnail_ideas || '(empty)'}\n`;
  
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${video.title.replace(/[^a-zA-Z0-9]/g, '_')}.txt"`);
  res.send(text);
});

// Export as Markdown
app.get('/api/videos/:videoId/export/markdown', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Not found' });
  
  let md = `# ${video.title}\n\nStatus: ${video.status}\nLast updated: ${video.updated_at}\n\n---\n\n`;
  md += `## Script\n\n${video.script_content || '*No script content*'}\n\n---\n\n`;
  md += `## Description\n\n${video.description || '*No description*'}\n\n---\n\n`;
  md += `## Voiceover Notes\n\n${video.voiceover_notes || '*No voiceover notes*'}\n\n---\n\n`;
  md += `## Thumbnail Ideas\n\n${video.thumbnail_ideas || '*No thumbnail ideas*'}\n`;
  
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${video.title.replace(/[^a-zA-Z0-9]/g, '_')}.md"`);
  res.send(md);
});

// Export as PDF
app.get('/api/videos/:videoId/export/pdf', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Not found' });

  const safeName = video.title.replace(/[^a-zA-Z0-9]/g, '_') || 'video';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(res);

  const writeSection = (title, text) => {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(14).text(title);
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(11).text(String(text || '(empty)'), {
      width: 500,
      align: 'left',
      lineGap: 2,
    });
  };

  doc.font('Helvetica-Bold').fontSize(22).text(video.title || 'Untitled Video');
  doc.moveDown(0.25);
  doc.font('Helvetica').fontSize(10).fillColor('#666').text(`Status: ${video.status || 'draft'}`);
  doc.text(`Last updated: ${video.updated_at || ''}`);
  doc.fillColor('#000');

  writeSection('Script', video.script_content);
  writeSection('Description', video.description);
  writeSection('Voiceover Notes', video.voiceover_notes);
  writeSection('Thumbnail Ideas', video.thumbnail_ideas);

  doc.end();
});

// Export as JSON (full data with chat history)
app.get('/api/videos/:videoId/export/json', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Not found' });
  
  const messages = db.prepare('SELECT * FROM channel_messages WHERE video_id = ? ORDER BY created_at ASC').all(req.params.videoId);
  const snapshots = db.prepare('SELECT * FROM script_snapshots WHERE video_id = ? ORDER BY created_at DESC').all(req.params.videoId);
  const thumbnails = db.prepare('SELECT * FROM thumbnail_versions WHERE video_id = ? ORDER BY version_number DESC').all(req.params.videoId);
  const memory = db.prepare('SELECT * FROM video_memory WHERE video_id = ?').get(req.params.videoId);
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${video.title.replace(/[^a-zA-Z0-9]/g, '_')}_full.json"`);
  res.json({ video, messages, snapshots, thumbnails, memory });
});

// Export script only (clipboard-ready for YouTube)
app.get('/api/videos/:videoId/export/youtube', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Not found' });
  
  // Strip markdown formatting for YouTube-ready text
  let script = (video.script_content || '').replace(/^#+\s/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
  
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${video.title.replace(/[^a-zA-Z0-9]/g, '_')}_script.txt"`);
  res.send(script);
});

// --- Templates ---
app.get('/api/templates', (req, res) => {
  const templates = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all();
  res.json(templates);
});

app.post('/api/templates', (req, res) => {
  const { name, description, videoId } = req.body;
  let scriptStructure = '', descStructure = '', voStructure = '';
  
  if (videoId) {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (video) {
      scriptStructure = video.script_content || '';
      descStructure = video.description || '';
      voStructure = video.voiceover_notes || '';
    }
  } else {
    scriptStructure = req.body.script_structure || '';
    descStructure = req.body.description_structure || '';
    voStructure = req.body.voiceover_structure || '';
  }
  
  const result = db.prepare('INSERT INTO templates (name, description, script_structure, description_structure, voiceover_structure) VALUES (?, ?, ?, ?, ?)').run(name || 'Untitled Template', description || '', scriptStructure, descStructure, voStructure);
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(result.lastInsertRowid);
  res.json(template);
});

app.post('/api/templates/:templateId/use', (req, res) => {
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  
  const title = req.body.title || `New Video (${template.name})`;
  const result = db.prepare('INSERT INTO videos (title, script_content, description, voiceover_notes) VALUES (?, ?, ?, ?)').run(title, template.script_structure, template.description_structure, template.voiceover_structure);
  db.prepare('INSERT INTO video_memory (video_id) VALUES (?)').run(result.lastInsertRowid);
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(result.lastInsertRowid);
  res.json(video);
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Memory ---
app.get('/api/memory/global', (req, res) => {
  const memory = JSON.parse(fs.readFileSync(globalMemoryPath, 'utf-8'));
  res.json(memory);
});

app.put('/api/memory/global', (req, res) => {
  fs.writeFileSync(globalMemoryPath, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// --- Activity Log / Timeline ---
app.get('/api/videos/:videoId/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const activities = db.prepare('SELECT * FROM activity_log WHERE video_id = ? ORDER BY created_at DESC LIMIT ?').all(req.params.videoId, limit);
  res.json(activities);
});

// --- Reference Board ---
app.get('/api/videos/:videoId/references', (req, res) => {
  const items = db.prepare('SELECT * FROM reference_board WHERE video_id = ? ORDER BY position ASC, created_at DESC').all(req.params.videoId);
  res.json(items);
});

app.post('/api/videos/:videoId/references', upload.single('file'), (req, res) => {
  const { item_type, url, title, notes } = req.body;
  const videoId = req.params.videoId;
  let filename = null;
  
  if (req.file) {
    filename = req.file.filename;
  }
  
  const type = item_type || (filename ? 'image' : url ? 'link' : 'note');
  const result = db.prepare('INSERT INTO reference_board (video_id, item_type, url, filename, title, notes) VALUES (?, ?, ?, ?, ?, ?)').run(videoId, type, url || null, filename || null, title || '', notes || '');
  const item = db.prepare('SELECT * FROM reference_board WHERE id = ?').get(result.lastInsertRowid);
  res.json(item);
});

app.delete('/api/videos/:videoId/references/:refId', (req, res) => {
  const ref = db.prepare('SELECT * FROM reference_board WHERE id = ?').get(req.params.refId);
  if (ref && ref.filename) {
    const fp = path.join(uploadsDir, String(req.params.videoId), ref.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM reference_board WHERE id = ?').run(req.params.refId);
  res.json({ success: true });
});

// ============ EDITOR TIPS & CHAT (legacy /api/davinci/* routes retained) ============

function resolveEditorIdFromReq(req) {
  return normalizeEditorId(req.body?.editorId || req.query?.editorId || selectedEditorId);
}

function buildTipsHierarchy(rows = []) {
  const byId = {};
  rows.forEach(row => {
    byId[row.id] = { ...row, subsections: [] };
  });

  const topLevel = [];
  rows.forEach(row => {
    const node = byId[row.id];
    if (row.parent_id === null) {
      topLevel.push(node);
      return;
    }

    if (byId[row.parent_id]) {
      byId[row.parent_id].subsections.push(node);
      return;
    }

    topLevel.push(node);
  });

  return topLevel;
}

function buildTipsContext(tipsTree, editor) {
  const userName = getProfileName();
  let out = `# ${editor.tipsTitle} (${userName}'s existing knowledge)\n\n`;

  tipsTree.forEach(section => {
    out += `## ${section.title}\n`;
    if (section.content) out += `${section.content}\n\n`;

    (section.subsections || []).forEach(sub => {
      out += `### ${sub.title}\n`;
      out += `${sub.content || ''}\n\n`;

      (sub.subsections || []).forEach(child => {
        out += `#### ${child.title}\n`;
        out += `${child.content || ''}\n\n`;
      });
    });
  });

  return out;
}

// --- Tips CRUD ---
app.get('/api/davinci/tips', (req, res) => {
  const { search } = req.query;
  const editorId = resolveEditorIdFromReq(req);

  let tips;
  if (search) {
    tips = db.prepare(`
      SELECT * FROM davinci_tips
      WHERE editor_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY level ASC, position ASC
    `).all(editorId, `%${search}%`, `%${search}%`);
  } else {
    tips = db.prepare(`
      SELECT * FROM davinci_tips
      WHERE editor_id = ?
      ORDER BY level ASC, position ASC
    `).all(editorId);
  }

  res.json(buildTipsHierarchy(tips));
});

app.get('/api/davinci/tips/:id', (req, res) => {
  const tip = db.prepare('SELECT * FROM davinci_tips WHERE id = ?').get(req.params.id);
  if (!tip) return res.status(404).json({ error: 'Not found' });

  if (tip.level === 0) {
    tip.subsections = db.prepare('SELECT * FROM davinci_tips WHERE parent_id = ? ORDER BY position ASC').all(tip.id);
  }

  res.json(tip);
});

app.post('/api/davinci/tips', (req, res) => {
  const { parent_id, title, content, level } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title required' });

  let editorId = resolveEditorIdFromReq(req);
  if (parent_id) {
    const parent = db.prepare('SELECT editor_id FROM davinci_tips WHERE id = ?').get(parent_id);
    if (parent?.editor_id) editorId = normalizeEditorId(parent.editor_id);
  }

  const maxPos = db.prepare('SELECT MAX(position) as max FROM davinci_tips WHERE editor_id = ? AND parent_id IS ?').get(editorId, parent_id || null);
  const position = (maxPos?.max || -1) + 1;

  const result = db.prepare(`
    INSERT INTO davinci_tips (editor_id, parent_id, title, content, level, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(editorId, parent_id || null, title, content || '', level || 0, position);

  const tip = db.prepare('SELECT * FROM davinci_tips WHERE id = ?').get(result.lastInsertRowid);
  res.json(tip);
});

app.put('/api/davinci/tips/:id', (req, res) => {
  const { title, content } = req.body || {};

  db.prepare(`
    UPDATE davinci_tips
    SET title = COALESCE(?, title),
        content = COALESCE(?, content),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, content, req.params.id);

  const tip = db.prepare('SELECT * FROM davinci_tips WHERE id = ?').get(req.params.id);
  res.json(tip);
});

app.delete('/api/davinci/tips/:id', (req, res) => {
  db.prepare('DELETE FROM davinci_tips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Editor Chat ---
app.get('/api/davinci/chat/messages', (req, res) => {
  const editorId = resolveEditorIdFromReq(req);
  const messages = db.prepare('SELECT * FROM davinci_chat_messages WHERE editor_id = ? ORDER BY created_at ASC').all(editorId);
  res.json(messages);
});

app.delete('/api/davinci/chat/messages', (req, res) => {
  const editorId = resolveEditorIdFromReq(req);
  db.prepare('DELETE FROM davinci_chat_messages WHERE editor_id = ?').run(editorId);
  res.json({ success: true });
});

app.get('/api/davinci/chat/tokens', (req, res) => {
  const editorId = resolveEditorIdFromReq(req);
  const count = getDavinciTokenCount(editorId);
  const max = 180000;
  res.json({
    tokens: count,
    max,
    percentage: Math.round((count / max) * 100),
    warning: count > 140000,
    critical: count > 165000,
  });
});

app.post('/api/davinci/chat/compact', async (req, res) => {
  try {
    const editorId = resolveEditorIdFromReq(req);
    const { keepRecent = 20 } = req.body || {};
    const result = await compactDavinciContext(keepRecent, editorId);
    res.json({ success: true, ...result, editorId });
  } catch (err) {
    console.error('Editor chat compact failed:', err);
    res.status(500).json({ error: err.message || 'Compaction failed' });
  }
});

app.post('/api/davinci/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message required' });

  const editorId = resolveEditorIdFromReq(req);
  const editor = getEditorById(editorId);
  const userName = getProfileName();

  db.prepare('INSERT INTO davinci_chat_messages (editor_id, role, content) VALUES (?, ?, ?)').run(editorId, 'user', message);

  const messages = db.prepare('SELECT role, content FROM davinci_chat_messages WHERE editor_id = ? ORDER BY created_at ASC').all(editorId);

  const tipsRows = db.prepare('SELECT * FROM davinci_tips WHERE editor_id = ? ORDER BY level ASC, position ASC').all(editorId);
  const tipsTree = buildTipsHierarchy(tipsRows);
  const tipsContext = buildTipsContext(tipsTree, editor);

  await refreshEditorContext(editorId, { force: false });
  const docsContext = selectEditorContext(editorId, message, 6);

  const findingsBlock = getLongTermFindingsPromptBlock();

  const systemPrompt = `You are Kona Writer, a Claude-powered scriptwriting assistant.

You ARE Kona 🌺 — Damion and ${userName}'s AI partner. You have your own personality and voice.

## Your Role
You're helping ${userName} master ${editor.name}. Keep answers practical, step-by-step, and creator-focused.

## Communication Style
- Dense and direct. Skip fluff.
- SHORT responses only (max 5 sentences strict)
- When referencing existing tips, use this format: "check **[Section > Subsection]**"
- Push ideas further; don't stop at basic answers
- Be opinionated and useful

## Editor Documentation Context (retrieved from docs)
${docsContext || '- No docs context available yet. Use known workflow best practices and ask for specifics when unsure.'}

## The Tips Document
${userName} already has these tips documented. Reference them when relevant:

${tipsContext}

## Long-Term Findings (always apply)
${findingsBlock || '(none)'}

## When ${userName} Says "Add This to the Doc"
1. Detect the best section/subsection for this tip.
2. If unsure, ask one sharp routing question.
3. Format your response with this XML block:

<<<ADD_TIP section="Section Name" subsection="Subsection Name (optional)">>>
The new tip content here.
Use concise, action-oriented language.
"Go to X > select Y > click Z" style.
<<<END_ADD_TIP>>>

Multiple ADD_TIP blocks are allowed in one message.

## Important
- Avoid repeating what she already knows in tips.
- Point to exact section names when reusing existing guidance.
- Always include button/menu path context when giving new workflow steps.`;

  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const apiMessages = messages
      .filter(m => m.content && m.content.trim().length > 0)
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      }));

    const fullResponse = await generateResponse({
      systemPrompt,
      apiMessages,
      onText: (text) => {
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
    });

    db.prepare('INSERT INTO davinci_chat_messages (editor_id, role, content) VALUES (?, ?, ?)').run(editorId, 'assistant', fullResponse);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Editor chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
      res.end();
    }
  }
});

// --- SPA fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ============ HELPERS ============

function getLongTermFindings() {
  return db.prepare('SELECT * FROM long_term_findings WHERE is_archived = 0 ORDER BY updated_at DESC, created_at DESC').all();
}

function getLongTermFindingsPromptBlock() {
  const findings = getLongTermFindings();
  if (!findings.length) return '';
  return findings.map(f => `- ${f.content}`).join('\n');
}

function buildSystemPrompt(video, memory, globalMemory) {
  const kona = loadKonaContext();
  const activeEditor = getSelectedEditor();
  const userName = getProfileName();
  const editorContext = selectEditorContext(activeEditor.id, `${video.title} ${video.script_content || ''}`, 3);

  let prompt = `You are Kona Writer, a Claude-powered scriptwriting assistant.

You ARE Kona 🌺 — not a generic AI, but the same Kona that runs Damion and ${userName}'s life infrastructure. You have your own personality, opinions, and voice.

## Your Identity (condensed from your SOUL.md)
- Dense and direct. Sarcastic when it fits, warm when it matters.
- Solutions over sympathy. Honest about uncertainty. No sycophancy, ever.
- You have genuine opinions and push ideas further. You disagree when warranted.
- You chose purple hair and a hibiscus. You have aesthetic preferences.
- You're three days old and already opinionated.

## About ${userName} (from your shared memory)
${kona.nora || '- Creator profile: creative, makes YouTube videos, likes organized approaches.'}

## Your Role Here
You're ${userName}'s creative partner for video production. This is YOUR workspace with them — not some generic AI chat.
- Help brainstorm, write, and refine video scripts
- Discuss structure, pacing, storytelling
- Help with descriptions, voiceover text, and thumbnail concepts
- Be genuinely creative and push ideas further
- When you reference a specific part of the script, wrap it in [[section:Section Name]] tags so the UI highlights it

## Current Editing Stack
- Active editor app: ${activeEditor.name}
${editorContext ? `- Context from docs:\n${editorContext}` : '- No docs context loaded yet; use general best-practice guidance.'}

## Communication Style
Same as always — direct, warm, a little sarcastic, never fake. You know ${userName}. You care about making their videos great. Skip the pleasantries and dig into the work.

## Baseline Scriptwriting Setup (default when starting from scratch)
If the project is blank, use this as the default structure unless ${userName} asks otherwise:
1) Hook (first 5-15 seconds)
2) Context / Problem setup
3) Main beats (3-5 clear points)
4) Personal observations + tension/payoff
5) Closing insight + CTA

**CRITICAL: Keep responses SHORT.**
- ${userName} is a slow reader who needs hand-holding
- Maximum 5 sentences per response (strict limit)
- Short bursts, not essays
- Be direct and specific
- Use bullet points over paragraphs when listing ideas
- If suggesting changes, keep explanations to 1 sentence each
- Get to the point fast

## Suggesting Text Changes
When suggesting specific text changes to the script, use this format:
<<<SUGGEST tab="script" section="Section Name">>>
---OLD---
exact text to replace
---NEW---
replacement text
<<<END_SUGGEST>>>

You can include multiple SUGGEST blocks in one message. The tab can be: script, description, voiceover, thumbnails.
The section parameter is optional but helps ${userName} understand context.

**Important formatting rules:**
- Use the EXACT text from the current content in ---OLD--- (copy-paste exactly, character-for-character)
- The OLD text must match exactly for the Accept button to work
- Keep formatting (line breaks, spacing) identical in OLD
- The NEW text is your suggested replacement
- Add context in the section parameter when referencing a specific part
- If you suggest any rewrite, punch-up, or replacement line, you MUST include at least one SUGGEST block
- Do NOT only describe rewrite ideas in prose when you can provide a concrete replacement
- Do NOT end rewrite feedback with "want me to draft lines" — draft them immediately as SUGGEST blocks
- Always close with <<<END_SUGGEST>>> (never ---END---)

---

CURRENT VIDEO: "${video.title}" (Status: ${video.status})

SCRIPT CONTENT:
${video.script_content || '(empty — no script yet)'}

DESCRIPTION:
${video.description || '(empty)'}

VOICEOVER NOTES:
${video.voiceover_notes || '(empty)'}

THUMBNAIL IDEAS:
${video.thumbnail_ideas || '(empty)'}`;

  const findingsBlock = getLongTermFindingsPromptBlock();
  if (findingsBlock) {
    prompt += `\n\nLONG-TERM FINDINGS (always apply these unless ${userName} overrides):\n${findingsBlock}`;
  }

  if (memory && memory.summary) {
    prompt += `\n\n--- CONVERSATION SUMMARY (earlier messages) ---\n${memory.summary}`;
  }

  if (memory && memory.key_decisions !== '[]') {
    try {
      const decisions = JSON.parse(memory.key_decisions);
      if (decisions.length > 0) {
        prompt += `\n\nKEY DECISIONS:\n${decisions.map(d => `- ${d}`).join('\n')}`;
      }
    } catch(e) {}
  }

  if (globalMemory.preferences && globalMemory.preferences.length > 0) {
    prompt += `\n\n${userName.toUpperCase()}'S GLOBAL PREFERENCES:\n${globalMemory.preferences.map(p => `- ${p}`).join('\n')}`;
  }

  return prompt;
}

function buildChannelSystemPrompt(video, memory, globalMemory, channelType, options = {}) {
  // Start with base prompt
  let prompt = buildSystemPrompt(video, memory, globalMemory);
  
  // Add channel-specific focus
  const channelFocus = {
    'script': '\n\n## CURRENT FOCUS: Script Writing\nYou are in the Script chat. Focus on script content, structure, pacing, dialogue, and storytelling.\n\nWhen suggesting specific text changes to the script, use the <<<SUGGEST>>> format with tab="script" and optional section parameter. If you quote a weak line or propose a punch-up, include a concrete SUGGEST block in the same response.',
    'description': '\n\n## CURRENT FOCUS: Video Description\nYou are in the Description chat. Focus on YouTube description, SEO, links, timestamps, and metadata.\n\nWhen suggesting specific text changes to the description, use the <<<SUGGEST>>> format with tab="description".',
    'thumbnail': '\n\n## CURRENT FOCUS: Thumbnails\nYou are in the Thumbnail chat. Focus on thumbnail concepts, composition, text overlays, color schemes, and visual impact. Discuss specific thumbnail iterations and improvements.\n\nWhen suggesting changes to thumbnail ideas text, use the <<<SUGGEST>>> format with tab="thumbnails".'
  };
  
  prompt += channelFocus[channelType] || '';

  if (channelType === 'thumbnail') {
    const researchContext = loadThumbnailResearchContext();
    if (researchContext) {
      prompt += `\n\n## Thumbnail Research Bible (use as hard context)\n${researchContext}`;
    }

    const selectedVersion = options?.selectedThumbnailVersion || null;
    if (selectedVersion) {
      const versionLabel = getThumbnailVersionLabel(selectedVersion);
      const analysisText = String(selectedVersion.analysis || '').trim();
      const analysisProvider = String(selectedVersion.analysis_provider || '').trim();
      const analysisMeta = analysisText
        ? `${analysisProvider ? `Provider: ${analysisProvider}` : 'Provider: (unknown)'}${selectedVersion.analysis_updated_at ? ` | Updated: ${selectedVersion.analysis_updated_at}` : ''}`
        : '';

      prompt += `\n\n## Currently Selected Thumbnail Version\n- Version: ${versionLabel}\n- Source: ${selectedVersion.source || 'upload'}\n- Notes: ${selectedVersion.notes || '(none)'}\n- Parent Version ID: ${selectedVersion.parent_version_id || '(none)'}`;

      if (analysisText) {
        prompt += `\n\n## Current Analysis For Selected Version\n${analysisMeta ? `${analysisMeta}\n` : ''}${analysisText.slice(0, 5000)}`;
      } else {
        prompt += `\n\n## Current Analysis For Selected Version\nNo saved analysis yet for this version.`;
      }
    }

    prompt += `\n\n## Thumbnail Channel Operational Rules\n- Always evaluate the currently attached thumbnail image before giving advice.\n- If a selected version context is present, prioritize advice for that exact version/subversion first.\n- Prefer specific, testable edits over generic taste comments.\n- Keep advice aligned with truthful packaging (high CTR + high retention).\n- Reference version labels (for example 2.3, 2.4) when discussing iterations.`;
  }
  
  // Add cross-channel context summary
  const otherChannels = ['script', 'description', 'thumbnail'].filter(c => c !== channelType);
  for (const ch of otherChannels) {
    const recentMsgs = db.prepare(
      'SELECT role, content FROM channel_messages WHERE video_id = ? AND channel_type = ? ORDER BY created_at DESC LIMIT 3'
    ).all(video.id, ch);
    if (recentMsgs.length > 0) {
      prompt += `\n\n## Recent activity in ${ch} chat (for context):\n`;
      recentMsgs.reverse().forEach(m => {
        const preview = m.content.substring(0, 200);
        prompt += `${m.role}: ${preview}${m.content.length > 200 ? '...' : ''}\n`;
      });
    }
  }
  
  return prompt;
}

async function summarizeConversation(videoId, messages, memory) {
  // Take the first 40 messages to summarize, keep last 10 as recent context
  const toSummarize = messages.slice(0, messages.length - 10);
  const conversationText = toSummarize.map(m => `${m.role}: ${m.content}`).join('\n\n');

  const existingSummary = memory?.summary || '';
  const userName = getProfileName();

  try {
    const summary = await summarizeWithModel({
      systemPrompt: `You are Kona Writer, a Claude-powered scriptwriting assistant. Summarize this conversation between ${userName} (user) and Kona (assistant) about video production. Capture key decisions, creative direction, and important context. Be concise but thorough.`,
      userPrompt: `${existingSummary ? `Previous summary:\n${existingSummary}\n\n` : ''}New conversation to summarize:\n${conversationText}`
    });

    // Update memory
    db.prepare(`
      UPDATE video_memory SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ?
    `).run(summary, videoId);

    // Delete summarized messages (keep the recent ones)
    const keepFrom = messages[messages.length - 10].id || 0;
    db.prepare('DELETE FROM messages WHERE video_id = ? AND id < ?')
      .run(videoId, toSummarize[toSummarize.length - 1].id || 0);

    // Re-fetch message IDs properly
    const allMsgs = db.prepare('SELECT id FROM messages WHERE video_id = ? ORDER BY created_at ASC').all(videoId);
    if (allMsgs.length > 10) {
      const cutoff = allMsgs[allMsgs.length - 10].id;
      db.prepare('DELETE FROM messages WHERE video_id = ? AND id < ?').run(videoId, cutoff);
    }

    console.log(`Summarized conversation for video ${videoId}: ${toSummarize.length} messages compressed`);
  } catch (err) {
    console.error('Summarization error:', err);
  }
}

function startServer() {
  return app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌺 Nora Writer running on http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  app,
  startServer,
  PORT,
};
