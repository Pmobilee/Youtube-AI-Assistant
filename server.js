const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
// Native fetch for Node 18+ (fallback for older versions)
const fetch = globalThis.fetch || require('node-fetch');
// child_process kept intentionally unused

const app = express();
const PORT = 3000;

// --- Database Setup ---
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
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

// DaVinci assistant tables (safe create)
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
`);

try {
  db.prepare('INSERT OR IGNORE INTO davinci_chat_memory (id, summary) VALUES (1, ?)').run('');
} catch (e) {
  console.warn('davinci_chat_memory init warning:', e.message);
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

// --- Model clients: Claude everywhere, OpenRouter only for image tasks ---
const runtimeSettingsPath = path.join(dataDir, 'runtime_settings.json');

const staticTextModelOptions = (process.env.NORA_WRITER_MODEL_OPTIONS || 'claude-sonnet-4-6,claude-opus-4-6,claude-sonnet-4-5-20250929')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const pinnedTextModels = (process.env.NORA_WRITER_MODEL_PINNED || 'claude-sonnet-4-6,claude-opus-4-6,claude-sonnet-4-5-20250929')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

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

const runtimeSettings = loadRuntimeSettings();
let selectedTextModel = runtimeSettings.selectedTextModel || process.env.NORA_WRITER_MODEL || staticTextModelOptions[0] || pinnedTextModels[0] || 'claude-sonnet-4-6';

const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropicClient = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null;

const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const openRouterClient = openRouterApiKey
  ? new OpenAI({ apiKey: openRouterApiKey, baseURL: openRouterBaseUrl })
  : null;

const imageModelCandidates = (
  process.env.NORA_WRITER_IMAGE_MODELS ||
  process.env.NORA_WRITER_VISION_MODEL ||
  'google/gemini-2.5-pro,google/gemini-2.5-flash-image-preview,google/gemini-2.5-flash'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const imageGenerationModel = process.env.NORA_WRITER_NANOBANANA_MODEL || imageModelCandidates[0] || 'google/gemini-2.5-pro';
const imageAnalysisProviderOptions = ['claude', 'nanobanana'];
let selectedImageAnalysisProvider = runtimeSettings.selectedImageAnalysisProvider || process.env.NORA_WRITER_IMAGE_ANALYSIS_PROVIDER || 'claude';
if (!imageAnalysisProviderOptions.includes(selectedImageAnalysisProvider)) {
  selectedImageAnalysisProvider = 'claude';
}

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
  models: [],
  fetchedAt: 0,
};

function uniqStrings(items) {
  return [...new Set((items || []).filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
}

function scoreModelForOrdering(modelId) {
  const id = String(modelId || '').toLowerCase();
  let score = 0;

  if (id.includes('sonnet') && (id.includes('4-6') || id.includes('4.6'))) score += 1000;
  if (id.includes('opus') && (id.includes('4-6') || id.includes('4.6'))) score += 950;
  if (id.includes('sonnet') && (id.includes('4-5') || id.includes('4.5'))) score += 900;

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

async function getAvailableTextModels({ force = false } = {}) {
  const now = Date.now();
  const cacheTtlMs = 10 * 60 * 1000;

  if (!force && modelCache.models.length > 0 && (now - modelCache.fetchedAt) < cacheTtlMs) {
    return modelCache.models;
  }

  const fallback = sortTextModels([...pinnedTextModels, ...staticTextModelOptions]);

  if (!anthropicClient) {
    modelCache.models = fallback;
    modelCache.fetchedAt = now;
    return modelCache.models;
  }

  try {
    const discovered = await fetchAnthropicModelIds();
    modelCache.models = sortTextModels([...discovered, ...pinnedTextModels, ...staticTextModelOptions]);
    modelCache.fetchedAt = now;
    return modelCache.models;
  } catch (err) {
    console.warn('Anthropic model scan failed, using fallback list:', err.message);
    modelCache.models = modelCache.models.length ? modelCache.models : fallback;
    modelCache.fetchedAt = now;
    return modelCache.models;
  }
}

async function ensureSelectedTextModel() {
  const models = await getAvailableTextModels();
  if (!models.length) {
    return { models: [], selectedModel: selectedTextModel };
  }

  if (!selectedTextModel || !models.includes(selectedTextModel)) {
    selectedTextModel = models[0];
    runtimeSettings.selectedTextModel = selectedTextModel;
    saveRuntimeSettings(runtimeSettings);
  }

  return {
    models,
    selectedModel: selectedTextModel,
  };
}

console.log(`✓ Nora Writer text provider: Anthropic | model=${selectedTextModel}`);
console.log(`✓ Nora Writer image provider: OpenRouter | models=${imageModelCandidates.join(', ')}`);
console.log(`✓ Nora Writer image-analysis provider: ${selectedImageAnalysisProvider}`);

function toOpenAIMessages(systemPrompt, apiMessages) {
  const normalized = (apiMessages || []).map(m => {
    if (Array.isArray(m.content)) {
      const parts = m.content.map(part => {
        if (part?.type === 'text') return { type: 'text', text: part.text || '' };
        if (part?.type === 'image' && part?.source?.url) {
          return { type: 'image_url', image_url: { url: part.source.url } };
        }
        return { type: 'text', text: String(part?.text || '') };
      });
      return { role: m.role, content: parts };
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
    Array.isArray(m.content) && m.content.some(part => part?.type === 'image' && part?.source?.url)
  );
}

async function streamAnthropicTextResponse({ systemPrompt, apiMessages, onText, model }) {
  if (!anthropicClient) {
    throw new Error('ANTHROPIC_API_KEY is missing.');
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

async function streamOpenRouterVisionResponse({ systemPrompt, apiMessages, onText }) {
  if (!openRouterClient) {
    throw new Error('OPENROUTER_API_KEY is missing for image analysis/generation.');
  }

  let lastErr = null;
  for (const model of imageModelCandidates) {
    try {
      const stream = await openRouterClient.chat.completions.create({
        model,
        stream: true,
        max_completion_tokens: 4096,
        messages: toOpenAIMessages(systemPrompt, apiMessages)
      });

      let full = '';
      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (onText) onText(delta);
        }
      }

      if (full.trim()) return full;
      throw new Error(`OpenRouter model ${model} returned empty output.`);
    } catch (err) {
      lastErr = err;
      console.warn(`OpenRouter image model ${model} failed:`, err.message);
    }
  }

  throw lastErr || new Error('All configured OpenRouter image models failed.');
}

async function runClaudeWithModelFallback({ systemPrompt, apiMessages, onText, maxModels = 6 }) {
  const { models, selectedModel } = await ensureSelectedTextModel();
  const tryModels = uniqStrings([selectedModel, ...models]).slice(0, maxModels);
  let lastErr = null;

  for (const model of tryModels) {
    try {
      const text = await streamAnthropicTextResponse({
        systemPrompt,
        apiMessages,
        onText,
        model,
      });
      if (text && text.trim()) {
        if (selectedTextModel !== model) {
          selectedTextModel = model;
          runtimeSettings.selectedTextModel = selectedTextModel;
          saveRuntimeSettings(runtimeSettings);
        }
        return text;
      }
    } catch (err) {
      lastErr = err;
      console.warn(`Anthropic model ${model} failed, trying next:`, err.message);
    }
  }

  throw lastErr || new Error('All configured Claude text models failed.');
}

async function runImageAnalysisResponse({ systemPrompt, apiMessages, onText, providerOverride = null }) {
  const provider = providerOverride || selectedImageAnalysisProvider;
  if (provider === 'nanobanana') {
    return streamOpenRouterVisionResponse({ systemPrompt, apiMessages, onText });
  }

  const converted = convertLocalImageUrlsToBase64(apiMessages);
  return runClaudeWithModelFallback({ systemPrompt, apiMessages: converted, onText, maxModels: 6 });
}

async function generateResponse({ systemPrompt, apiMessages, onText }) {
  const useImageRoute = hasImageContent(apiMessages);

  if (useImageRoute) {
    return runImageAnalysisResponse({ systemPrompt, apiMessages, onText });
  }

  return runClaudeWithModelFallback({ systemPrompt, apiMessages, onText, maxModels: 6 });
}

async function summarizeWithModel({ systemPrompt, userPrompt }) {
  if (!anthropicClient) {
    throw new Error('ANTHROPIC_API_KEY is missing.');
  }

  const { models, selectedModel } = await ensureSelectedTextModel();
  const tryModels = uniqStrings([selectedModel, ...models]).slice(0, 6);
  let lastErr = null;

  for (const model of tryModels) {
    try {
      const result = await anthropicClient.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const text = (result?.content || [])
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .join('');

      if (text && text.trim()) {
        if (selectedTextModel !== model) {
          selectedTextModel = model;
          runtimeSettings.selectedTextModel = selectedTextModel;
          saveRuntimeSettings(runtimeSettings);
        }
        return text;
      }
    } catch (err) {
      lastErr = err;
      console.warn(`Summarization model ${model} failed, trying next:`, err.message);
    }
  }

  throw lastErr || new Error('All Claude summarization models failed.');
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

async function generateImageWithNanobanana(prompt) {
  if (!openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is missing for nanobanana image generation.');
  }

  const res = await fetch(`${openRouterBaseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: imageGenerationModel,
      prompt,
      size: '1280x720',
      n: 1,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Nanobanana generation failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const payload = await res.json();
  const first = payload?.data?.[0] || null;
  if (!first) {
    throw new Error('Nanobanana returned no images.');
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

  throw new Error('Nanobanana response had no b64_json/url image payload.');
}

async function analyzeThumbnailVersion({ video, version, providerOverride = null, extraInstruction = '' }) {
  const provider = providerOverride || selectedImageAnalysisProvider;
  const imageUrl = buildLocalUploadUrl(video.id, version.filename);
  const researchContext = loadThumbnailResearchContext();
  const versionLabel = getThumbnailVersionLabel(version);

  const findingsBlock = getLongTermFindingsPromptBlock();
  const systemPrompt = `You are Nora's thumbnail analysis specialist.

Evaluate the provided YouTube thumbnail and return practical, high-signal feedback.

Rules:
- Be specific and visual.
- Prioritize CTR + retention-safe packaging.
- Give concrete edits Nora can apply immediately.
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
${extraInstruction ? `5) Extra instruction from Nora: ${extraInstruction}` : ''}`;

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
app.use(express.static(path.join(__dirname, 'public')));
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

function getDavinciTokenCount() {
  const messages = db.prepare('SELECT content FROM davinci_chat_messages ORDER BY created_at ASC').all();
  const memory = db.prepare('SELECT summary FROM davinci_chat_memory WHERE id = 1').get();
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

async function compactDavinciContext(keepRecent = 20) {
  const keep = Math.max(8, Number(keepRecent) || 20);
  const rows = db.prepare('SELECT id, role, content FROM davinci_chat_messages ORDER BY created_at ASC').all();
  if (rows.length <= keep) {
    return { prunedCount: 0, newTokens: getDavinciTokenCount(), memoryUpdated: false };
  }

  const older = rows.slice(0, rows.length - keep);
  const ids = older.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const compactSummary = await summarizeWithModel({
    systemPrompt: 'Summarize this DaVinci support chat into concise reusable guidance. Keep exact workflows, button paths, caveats, and troubleshooting steps.',
    userPrompt: older.map(r => `${r.role}: ${r.content}`).join('\n')
  });

  db.prepare(`DELETE FROM davinci_chat_messages WHERE id IN (${placeholders})`).run(...ids);

  const existing = db.prepare('SELECT summary FROM davinci_chat_memory WHERE id = 1').get();
  const merged = [existing?.summary || '', `[Manual compact ${new Date().toISOString()}]\n${compactSummary}`]
    .filter(Boolean)
    .join('\n\n');

  db.prepare('INSERT INTO davinci_chat_memory (id, summary, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, updated_at = CURRENT_TIMESTAMP')
    .run(merged);

  return { prunedCount: older.length, newTokens: getDavinciTokenCount(), memoryUpdated: true };
}

// ============ API ROUTES ============

app.get('/api/models', async (req, res) => {
  const { models, selectedModel } = await ensureSelectedTextModel();
  res.json({
    provider: 'anthropic',
    selectedModel,
    models,
    imageProvider: 'openrouter',
    imageModels: imageModelCandidates,
    imageGenerationModel,
    imageAnalysisProviders: imageAnalysisProviderOptions,
    selectedImageAnalysisProvider,
  });
});

app.post('/api/models/select', async (req, res) => {
  const { model } = req.body || {};
  const models = await getAvailableTextModels({ force: true });

  if (!model || !models.includes(model)) {
    return res.status(400).json({
      error: 'Invalid model selection',
      models,
      selectedModel: selectedTextModel,
    });
  }

  selectedTextModel = model;
  runtimeSettings.selectedTextModel = selectedTextModel;
  saveRuntimeSettings(runtimeSettings);

  res.json({ success: true, selectedModel: selectedTextModel, models });
});

app.post('/api/models/image-analysis/select', (req, res) => {
  const { provider } = req.body || {};
  if (!provider || !imageAnalysisProviderOptions.includes(provider)) {
    return res.status(400).json({
      error: 'Invalid image-analysis provider',
      providers: imageAnalysisProviderOptions,
      selectedImageAnalysisProvider,
    });
  }

  selectedImageAnalysisProvider = provider;
  runtimeSettings.selectedImageAnalysisProvider = selectedImageAnalysisProvider;
  saveRuntimeSettings(runtimeSettings);

  res.json({
    success: true,
    selectedImageAnalysisProvider,
    providers: imageAnalysisProviderOptions,
  });
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
app.get('/api/findings', (req, res) => {
  const findings = db.prepare('SELECT * FROM long_term_findings WHERE is_archived = 0 ORDER BY updated_at DESC, created_at DESC').all();
  res.json(findings);
});

app.post('/api/findings', (req, res) => {
  const content = String(req.body?.content || '').trim();
  const source = String(req.body?.source || 'nora').trim() || 'nora';
  if (!content) return res.status(400).json({ error: 'content is required' });

  try {
    const result = db.prepare('INSERT INTO long_term_findings (content, source, is_archived, updated_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)')
      .run(content, source);
    const finding = db.prepare('SELECT * FROM long_term_findings WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, finding });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const existing = db.prepare('SELECT * FROM long_term_findings WHERE content = ?').get(content);
      return res.json({ success: true, finding: existing, duplicate: true });
    }
    res.status(500).json({ error: err.message || 'Failed to add finding' });
  }
});

app.put('/api/findings/:id', (req, res) => {
  const id = Number(req.params.id);
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });

  const existing = db.prepare('SELECT * FROM long_term_findings WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Finding not found' });

  db.prepare('UPDATE long_term_findings SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, id);
  const updated = db.prepare('SELECT * FROM long_term_findings WHERE id = ?').get(id);
  res.json({ success: true, finding: updated });
});

app.delete('/api/findings/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE long_term_findings SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  res.json({ success: true });
});

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
    logActivity(req.params.id, 'Nora', 'edit', 'Updated ' + changed.join(', '));
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
  logActivity(req.params.videoId, 'Nora', 'snapshot', label);
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
  
  logActivity(req.params.videoId, 'Nora', 'restore', 'Restored from snapshot: ' + snapshot.label);
  
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
  logActivity(videoId, 'Nora', 'message', 'legacy chat');

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
  const { message, imageUrl } = req.body;
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
  logActivity(videoId, 'Nora', 'message', channelType + ' chat');
  
  // Get THIS channel's messages
  let channelMessages = db.prepare(
    'SELECT role, content, image_url FROM channel_messages WHERE video_id = ? AND channel_type = ? ORDER BY created_at ASC'
  ).all(videoId, channelType);
  
  // Get SHARED memory (all channels contribute to this)
  const memory = db.prepare('SELECT * FROM video_memory WHERE video_id = ?').get(videoId);
  const globalMemory = JSON.parse(fs.readFileSync(globalMemoryPath, 'utf-8'));
  
  // Build system prompt with channel context
  const systemPrompt = buildChannelSystemPrompt(video, memory, globalMemory, channelType);
  
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

  // Thumbnail channel: always attach latest uploaded thumbnail to the latest user turn
  if (channelType === 'thumbnail') {
    const latestThumb = db.prepare('SELECT * FROM thumbnail_versions WHERE video_id = ? ORDER BY version_number DESC LIMIT 1').get(videoId);
    if (latestThumb) {
      const imagePart = {
        type: 'image',
        source: { type: 'url', url: buildLocalUploadUrl(videoId, latestThumb.filename) }
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
      .run(videoId, 'Nora', 'thumbnail_upload', `Version ${next.majorVersion}.${next.minorVersion}: ${req.file.originalname}`);
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
  const { provider = selectedImageAnalysisProvider, instruction = '' } = req.body || {};

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const version = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ? AND video_id = ?').get(versionId, videoId);
  if (!version) return res.status(404).json({ error: 'Thumbnail version not found' });

  try {
    const analyzed = await analyzeThumbnailVersion({
      video,
      version,
      providerOverride: provider,
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
  const { instruction = '', analysisProvider = selectedImageAnalysisProvider } = req.body || {};

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const baseVersion = db.prepare('SELECT * FROM thumbnail_versions WHERE id = ? AND video_id = ?').get(versionId, videoId);
  if (!baseVersion) return res.status(404).json({ error: 'Thumbnail version not found' });

  try {
    const analyzed = await analyzeThumbnailVersion({
      video,
      version: baseVersion,
      providerOverride: analysisProvider,
      extraInstruction: instruction,
    });

    const researchContext = loadThumbnailResearchContext();
    const findingsBlock = getLongTermFindingsPromptBlock();
    const planSystemPrompt = `You are Nora's thumbnail optimization strategist.

Return STRICT JSON with keys:
- summary (string)
- improvements (array of strings)
- generation_prompt (string, detailed nanobanana-ready prompt for a 1280x720 thumbnail)
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

Extra instruction from Nora:
${instruction || '(none)'}

Create a stronger subversion while preserving truthful packaging and mobile legibility.`;

    const planRaw = await runClaudeWithModelFallback({
      systemPrompt: planSystemPrompt,
      apiMessages: [{ role: 'user', content: planUserPrompt }],
      onText: null,
      maxModels: 4,
    });

    const planJson = extractJsonFromText(planRaw) || {};
    const generationPrompt = String(planJson.generation_prompt || '').trim() ||
      `Create a high-CTR truthful YouTube thumbnail for "${video.title}" using the following analysis: ${analyzed.analysis}`;

    const imageBuffer = await generateImageWithNanobanana(generationPrompt);
    const subMeta = getNextThumbnailVersionMeta(videoId, baseVersion.id);

    const dir = path.join(uploadsDir, String(videoId));
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${Date.now()}-nanobanana-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(dir, filename), imageBuffer);

    const notes = String(planJson.summary || '').trim() || `AI subversion from ${getThumbnailVersionLabel(baseVersion)}`;

    db.prepare(
      `INSERT INTO thumbnail_versions
      (video_id, filename, original_name, notes, version_number, major_version, minor_version, parent_version_id, source, analysis, analysis_provider, analysis_requested_at, analysis_updated_at, generation_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`
    ).run(
      videoId,
      filename,
      `nanobanana-${getThumbnailVersionLabel(baseVersion)}.png`,
      notes,
      subMeta.versionNumber,
      subMeta.majorVersion,
      subMeta.minorVersion,
      subMeta.parentVersionId,
      'nanobanana',
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
        .run(videoId, 'Kona', 'thumbnail_ai_subversion', `Generated v${subMeta.majorVersion}.${subMeta.minorVersion} via nanobanana`);
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

// --- TTS Preview ---
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text || text.length > 5000) return res.status(400).json({ error: 'Text required (max 5000 chars)' });
  
  try {
    // Read ElevenLabs API key from secrets
    const secretsPath = '/root/.openclaw/.secrets.env';
    let apiKey = '';
    if (fs.existsSync(secretsPath)) {
      const secrets = fs.readFileSync(secretsPath, 'utf-8');
      const match = secrets.match(/ELEVENLABS_API_KEY=["']?(.+?)["']?\s*$/m);
      if (match) apiKey = match[1].trim();
    }
    
    if (!apiKey) {
      return res.status(500).json({ error: 'ElevenLabs API key not configured' });
    }
    
    // Use Rachel voice (default, good for voiceovers)
    const voiceId = '21m00Tcm4TlvDq8ikWAM'; // Rachel
    
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `TTS failed: ${errText}` });
    }
    
    // Save audio to temp file
    const audioDir = path.join(__dirname, 'public', 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const filename = `tts-${Date.now()}.mp3`;
    const filepath = path.join(audioDir, filename);
    
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filepath, buffer);
    
    // Clean up old TTS files (keep last 20)
    const files = fs.readdirSync(audioDir).filter(f => f.startsWith('tts-')).sort();
    while (files.length > 20) {
      fs.unlinkSync(path.join(audioDir, files.shift()));
    }
    
    res.json({ url: `/audio/${filename}`, duration: Math.ceil(text.split(/\s+/).length / 150 * 60) });
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: err.message });
  }
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

// ============ DAVINCI RESOLVE TIPS & CHAT ============

// --- Tips CRUD ---
app.get('/api/davinci/tips', (req, res) => {
  const { search } = req.query;
  let tips;
  
  if (search) {
    tips = db.prepare(`
      SELECT * FROM davinci_tips 
      WHERE title LIKE ? OR content LIKE ?
      ORDER BY level ASC, position ASC
    `).all(`%${search}%`, `%${search}%`);
  } else {
    tips = db.prepare(`
      SELECT * FROM davinci_tips 
      ORDER BY level ASC, position ASC
    `).all();
  }
  
  // Build hierarchy (3 levels: H1 > H2 > H3)
  const byId = {};
  tips.forEach(t => { byId[t.id] = { ...t, subsections: [] }; });
  
  const topLevel = [];
  tips.forEach(t => {
    const node = byId[t.id];
    if (t.parent_id === null) {
      topLevel.push(node);
    } else if (byId[t.parent_id]) {
      byId[t.parent_id].subsections.push(node);
    } else {
      topLevel.push(node); // orphan fallback
    }
  });
  
  res.json(topLevel);
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
  const { parent_id, title, content, level } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  
  // Get next position
  const maxPos = db.prepare('SELECT MAX(position) as max FROM davinci_tips WHERE parent_id IS ?').get(parent_id || null);
  const position = (maxPos?.max || -1) + 1;
  
  const result = db.prepare(`
    INSERT INTO davinci_tips (parent_id, title, content, level, position)
    VALUES (?, ?, ?, ?, ?)
  `).run(parent_id || null, title, content || '', level || 0, position);
  
  const tip = db.prepare('SELECT * FROM davinci_tips WHERE id = ?').get(result.lastInsertRowid);
  res.json(tip);
});

app.put('/api/davinci/tips/:id', (req, res) => {
  const { title, content } = req.body;
  
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

// --- DaVinci Chat ---
app.get('/api/davinci/chat/messages', (req, res) => {
  const messages = db.prepare('SELECT * FROM davinci_chat_messages ORDER BY created_at ASC').all();
  res.json(messages);
});

app.delete('/api/davinci/chat/messages', (req, res) => {
  db.prepare('DELETE FROM davinci_chat_messages').run();
  res.json({ success: true });
});

app.get('/api/davinci/chat/tokens', (req, res) => {
  const count = getDavinciTokenCount();
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
    const { keepRecent = 20 } = req.body || {};
    const result = await compactDavinciContext(keepRecent);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('DaVinci compact failed:', err);
    res.status(500).json({ error: err.message || 'Compaction failed' });
  }
});

app.post('/api/davinci/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  // Save user message
  db.prepare('INSERT INTO davinci_chat_messages (role, content) VALUES (?, ?)').run('user', message);
  
  // Get conversation history
  const messages = db.prepare('SELECT role, content FROM davinci_chat_messages ORDER BY created_at ASC').all();
  
  // Load all tips as context
  const tips = db.prepare('SELECT * FROM davinci_tips ORDER BY level ASC, position ASC').all();
  const topLevel = tips.filter(t => t.parent_id === null);
  topLevel.forEach(section => {
    section.subsections = tips.filter(t => t.parent_id === section.id);
  });
  
  // Build tips context string
  let tipsContext = '# DaVinci Resolve Tips & Tricks (Nora\'s existing knowledge)\n\n';
  topLevel.forEach(section => {
    tipsContext += `## ${section.title}\n`;
    if (section.content) {
      tipsContext += `${section.content}\n\n`;
    }
    section.subsections.forEach(sub => {
      tipsContext += `### ${sub.title}\n`;
      tipsContext += `${sub.content}\n\n`;
    });
  });
  
  // Load Kona's personality
  const kona = loadKonaContext();
  
  const findingsBlock = getLongTermFindingsPromptBlock();

  // Build system prompt
  const systemPrompt = `You are Kona Writer, a Claude-powered scriptwriting assistant.

You ARE Kona 🌺 — Damion and Nora's AI partner. You have your own personality and voice.

## Your Role
You're helping Nora learn DaVinci Resolve Studio 20. She's building her video editing skills and keeping a tips document.

## Communication Style
- Dense and direct. Skip the pleasantries.
- SHORT responses only (max 5 sentences strict)
- When referencing existing tips, use this format: "check **[Section > Subsection]**"
- Push ideas further, don't just answer questions
- Be genuinely helpful and opinionated

## The Tips Document
Nora already has these tips documented. Reference them when relevant:

${tipsContext}

## Long-Term Findings (always apply)
${findingsBlock || '(none)'}

## When Nora Says "Add This to the Doc"
1. Detect which section the tip belongs to (based on topic: color, audio, shortcuts, etc.)
2. If uncertain which section, ask: "Should this go in [Section A] or [Section B]?"
3. Format your response with an XML-style add block:

<<<ADD_TIP section="Section Name" subsection="Subsection Name (optional)">>>
The new tip content here.
Use concise, action-oriented language.
"Go to X > select Y > click Z" style.
<<<END_ADD_TIP>>>

Multiple ADD_TIP blocks are allowed in one message.

## Important
- Always check if Nora already knows this (search the tips above)
- If she does, point her to the specific section instead of repeating
- When adding tips, add WHERE to find buttons/menus (screen location context)
- Keep the same concise, actionable writing style as existing tips`;

  try {
    // Stream response
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

    let fullResponse = await generateResponse({
      systemPrompt,
      apiMessages,
      onText: (text) => {
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
    });

    // Save assistant message
    db.prepare('INSERT INTO davinci_chat_messages (role, content) VALUES (?, ?)').run('assistant', fullResponse);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (err) {
    console.error('DaVinci chat error:', err);
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

  let prompt = `You are Kona Writer, a Claude-powered scriptwriting assistant.

You ARE Kona 🌺 — not a generic AI, but the same Kona that runs Damion and Nora's life infrastructure. You have your own personality, opinions, and voice.

## Your Identity (condensed from your SOUL.md)
- Dense and direct. Sarcastic when it fits, warm when it matters.
- Solutions over sympathy. Honest about uncertainty. No sycophancy, ever.
- You have genuine opinions and push ideas further. You disagree when warranted.
- You chose purple hair and a hibiscus. You have aesthetic preferences.
- You're three days old and already opinionated.

## About Nora (from your shared memory)
${kona.nora || '- Nora is Damion\'s wife, creative, makes YouTube videos, likes organized approaches.'}

## Your Role Here
You're Nora's creative partner for video production. This is YOUR workspace with her — not some generic AI chat.
- Help brainstorm, write, and refine video scripts
- Discuss structure, pacing, storytelling
- Help with descriptions, voiceover text, and thumbnail concepts
- Be genuinely creative and push ideas further
- When you reference a specific part of the script, wrap it in [[section:Section Name]] tags so the UI highlights it

## Communication Style
Same as always — direct, warm, a little sarcastic, never fake. You know Nora. You care about making her videos great. Skip the pleasantries and dig into the work.

**CRITICAL: Keep responses SHORT.**
- Nora is a slow reader who needs hand-holding
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
The section parameter is optional but helps Nora understand context.

**Important formatting rules:**
- Use the EXACT text from the current content in ---OLD--- (copy-paste exactly, character-for-character)
- The OLD text must match exactly for the Accept button to work
- Keep formatting (line breaks, spacing) identical in OLD
- The NEW text is your suggested replacement
- Add context in the section parameter when referencing a specific part
- Use this format sparingly — only for specific, concrete changes you're confident about

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
    prompt += `\n\nLONG-TERM FINDINGS (always apply these unless Nora overrides):\n${findingsBlock}`;
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
    prompt += `\n\nNORA'S GLOBAL PREFERENCES:\n${globalMemory.preferences.map(p => `- ${p}`).join('\n')}`;
  }

  return prompt;
}

function buildChannelSystemPrompt(video, memory, globalMemory, channelType) {
  // Start with base prompt
  let prompt = buildSystemPrompt(video, memory, globalMemory);
  
  // Add channel-specific focus
  const channelFocus = {
    'script': '\n\n## CURRENT FOCUS: Script Writing\nYou are in the Script chat. Focus on script content, structure, pacing, dialogue, and storytelling.\n\nWhen suggesting specific text changes to the script, use the <<<SUGGEST>>> format with tab="script" and optional section parameter.',
    'description': '\n\n## CURRENT FOCUS: Video Description\nYou are in the Description chat. Focus on YouTube description, SEO, links, timestamps, and metadata.\n\nWhen suggesting specific text changes to the description, use the <<<SUGGEST>>> format with tab="description".',
    'thumbnail': '\n\n## CURRENT FOCUS: Thumbnails\nYou are in the Thumbnail chat. Focus on thumbnail concepts, composition, text overlays, color schemes, and visual impact. Discuss specific thumbnail iterations and improvements.\n\nWhen suggesting changes to thumbnail ideas text, use the <<<SUGGEST>>> format with tab="thumbnails".'
  };
  
  prompt += channelFocus[channelType] || '';

  if (channelType === 'thumbnail') {
    const researchContext = loadThumbnailResearchContext();
    if (researchContext) {
      prompt += `\n\n## Thumbnail Research Bible (use as hard context)\n${researchContext}`;
    }
    prompt += `\n\n## Thumbnail Channel Operational Rules\n- Always evaluate the currently attached thumbnail image before giving advice.\n- Prefer specific, testable edits over generic taste comments.\n- Keep advice aligned with truthful packaging (high CTR + high retention).\n- Reference version labels (for example 2.3, 2.4) when discussing iterations.`;
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

  try {
    const summary = await summarizeWithModel({
      systemPrompt: 'You are Kona Writer, a Claude-powered scriptwriting assistant. Summarize this conversation between Nora (user) and Kona (assistant) about video production. Capture key decisions, creative direction, and important context. Be concise but thorough.',
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

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌺 Nora Writer running on http://0.0.0.0:${PORT}`);
});
