// === State ===
let currentVideo = null;
let autoSaveTimer = null;
let isStreaming = false;
let editors = {};
let currentChatChannel = 'script';
let pendingSuggestions = [];
let activeSuggestionIdx = null;
let availableModels = [];
let selectedModel = '';
let selectedImageAnalysisProvider = 'claude';
let creditsRefreshTimer = null;
let thumbnailVersions = [];
let selectedThumbnailVersionId = null;
let isPaneSyncing = false;

const tabToChannelMap = {
  script: 'script',
  description: 'description',
  thumbnails: 'thumbnail',
};

const channelToTabMap = {
  script: 'script',
  description: 'description',
  thumbnail: 'thumbnails',
};

// === DOM refs ===
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// === Theme ===
function initTheme() {
  const saved = localStorage.getItem('nw-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeButtons();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('nw-theme', next);
  updateThemeButtons();
  updateEditorThemes();
}

function updateThemeButtons() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const icon = isDark ? '☀️' : '🌙';
  if ($('#theme-toggle')) $('#theme-toggle').textContent = icon;
  if ($('#theme-toggle-ws')) $('#theme-toggle-ws').textContent = icon;
  if ($('#theme-toggle-nav')) $('#theme-toggle-nav').textContent = icon;
}

function initEditors() {
  const editorIds = ['script-editor', 'description-editor', 'voiceover-editor'];
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dracula' : 'default';
  
  editorIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el || editors[id]) return; // Skip if element doesn't exist or already initialized
    
    editors[id] = CodeMirror(el, {
      mode: 'markdown',
      theme: theme,
      lineNumbers: true,
      lineWrapping: true,
      autofocus: false
    });
    
    // Auto-save on change
    editors[id].on('change', debounce(saveVideo, 1000));
  });
  
  // Add timing widget listener to script editor
  if (editors['script-editor']) {
    editors['script-editor'].on('change', debounce(updateTimingWidget, 300));
    editors['script-editor'].on('change', debounce(updateOutline, 500));
  }
}

function updateEditorThemes() {
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dracula' : 'default';
  Object.values(editors).forEach(ed => {
    if (ed && ed.setOption) ed.setOption('theme', theme);
  });
}

// === Global Model + Credits ===
async function loadModelOptions() {
  const select = document.getElementById('global-model-select');
  const imageSelect = document.getElementById('global-image-analysis-select');
  if (!select) return;

  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    availableModels = data.models || [];
    selectedModel = data.selectedModel || '';
    selectedImageAnalysisProvider = data.selectedImageAnalysisProvider || 'claude';

    if (!availableModels.length) {
      select.innerHTML = '<option value="">No models</option>';
    } else {
      select.innerHTML = availableModels.map(m => {
        const safe = (m || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<option value="${safe}">${safe}</option>`;
      }).join('');

      if (selectedModel) select.value = selectedModel;
    }

    select.onchange = async (e) => {
      const nextModel = e.target.value;
      if (!nextModel) return;
      try {
        const res = await fetch('/api/models/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: nextModel })
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || 'Model switch failed');
        selectedModel = payload.selectedModel || nextModel;
        showToast(`Model set to ${selectedModel}`);
      } catch (err) {
        showToast('Model switch failed: ' + err.message);
        if (selectedModel) select.value = selectedModel;
      }
    };

    if (imageSelect) {
      const providers = data.imageAnalysisProviders || ['claude', 'nanobanana'];
      imageSelect.innerHTML = providers.map(p => {
        const label = p === 'claude' ? 'Claude Vision' : 'Nanobanana Vision';
        return `<option value="${p}">${label}</option>`;
      }).join('');
      imageSelect.value = selectedImageAnalysisProvider;

      imageSelect.onchange = async (e) => {
        const provider = e.target.value;
        try {
          const res = await fetch('/api/models/image-analysis/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider })
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(payload.error || 'Image analysis switch failed');
          selectedImageAnalysisProvider = payload.selectedImageAnalysisProvider || provider;
          showToast(`Image analysis set to ${selectedImageAnalysisProvider}`);
        } catch (err) {
          showToast('Image analysis switch failed: ' + err.message);
          imageSelect.value = selectedImageAnalysisProvider;
        }
      };
    }
  } catch (err) {
    select.innerHTML = '<option value="">Model load failed</option>';
    if (imageSelect) imageSelect.innerHTML = '<option value="claude">Claude Vision</option>';
  }
}

async function updateCreditsDisplay() {
  const pill = document.getElementById('credits-pill');
  if (!pill) return;
  pill.textContent = 'Claude credits: checking…';
  try {
    const res = await fetch('/api/credits');
    const data = await res.json();
    pill.textContent = `Claude credits: ${data.display || 'Unavailable'}`;
  } catch (err) {
    pill.textContent = 'Claude credits: unavailable';
  }
}

function startCreditsRefresh() {
  if (creditsRefreshTimer) clearInterval(creditsRefreshTimer);
  creditsRefreshTimer = setInterval(updateCreditsDisplay, 5 * 60 * 1000);
}

// === Timing Widget ===
let targetWPM = 150;

function updateTimingWidget() {
  const editor = editors['script-editor'];
  if (!editor) return;
  
  const text = editor.getValue();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const minutes = words / targetWPM;
  const mins = Math.floor(minutes);
  const secs = Math.round((minutes - mins) * 60);
  
  const wordEl = document.getElementById('word-count');
  const charEl = document.getElementById('char-count');
  const durEl = document.getElementById('duration-estimate');
  
  if (wordEl) wordEl.textContent = `${words.toLocaleString()} words`;
  if (charEl) charEl.textContent = `${chars.toLocaleString()} chars`;
  if (durEl) durEl.textContent = `~${mins}:${secs.toString().padStart(2, '0')}`;
  
  // Color code duration
  if (durEl) {
    durEl.style.color = minutes > 20 ? '#ef4444' : minutes > 15 ? '#f59e0b' : minutes > 10 ? '#22c55e' : 'var(--text-secondary)';
  }
  
  // Update section timing
  updateSectionTiming();
}

function updateSectionTiming() {
  const editor = editors['script-editor'];
  if (!editor) return;
  
  const text = editor.getValue();
  const sections = text.split(/^(?=#{1,3}\s)/m);
  const container = document.getElementById('section-timing');
  
  if (!container || sections.length <= 1) {
    if (container) container.innerHTML = '';
    return;
  }
  
  container.innerHTML = sections.filter(s => s.trim()).map(section => {
    const firstLine = section.split('\n')[0].replace(/^#+\s*/, '').trim();
    const words = section.trim().split(/\s+/).length;
    const mins = words / targetWPM;
    const m = Math.floor(mins);
    const s = Math.round((mins - m) * 60);
    return `<div class="section-time-item"><span class="section-time-name">${escapeHtml(firstLine || 'Untitled')}</span><span class="section-time-dur">${m}:${s.toString().padStart(2, '0')}</span></div>`;
  }).join('');
}

// === Section Outline ===
let draggedSectionIndex = null;

function updateOutline() {
  const editor = editors['script-editor'];
  if (!editor) return;
  
  const text = editor.getValue();
  const lines = text.split('\n');
  const sections = [];
  
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,3})\s+(.+)/);
    if (match) {
      if (sections.length > 0) sections[sections.length - 1].endLine = i - 1;
      sections.push({ 
        level: match[1].length, 
        title: match[2], 
        startLine: i, 
        endLine: lines.length - 1 
      });
    }
  }
  
  const list = document.getElementById('outline-list');
  if (!list) return;
  
  if (sections.length === 0) {
    list.innerHTML = '<p class="no-sections">No sections found. Use # headers.</p>';
    return;
  }
  
  list.innerHTML = sections.map((s, idx) => `
    <div class="outline-item" draggable="true" data-index="${idx}" data-start="${s.startLine}" data-end="${s.endLine}"
      ondragstart="dragSection(event, ${idx})"
      ondragover="event.preventDefault(); this.classList.add('drag-target')"
      ondragleave="this.classList.remove('drag-target')"
      ondrop="dropSection(event, ${idx}); this.classList.remove('drag-target')"
      onclick="scrollToLine(${s.startLine})">
      <span class="outline-drag">☰</span>
      <span class="outline-title" style="padding-left: ${(s.level - 1) * 12}px">${escapeHtml(s.title)}</span>
    </div>
  `).join('');
}

function dragSection(e, index) {
  draggedSectionIndex = index;
  e.dataTransfer.effectAllowed = 'move';
}

function dropSection(e, targetIndex) {
  e.preventDefault();
  if (draggedSectionIndex === null || draggedSectionIndex === targetIndex) return;
  
  const editor = editors['script-editor'];
  if (!editor) return;
  
  const text = editor.getValue();
  const origLines = text.split('\n');
  
  // Parse sections
  const origSections = [];
  let preamble = [];
  let currentSec = null;
  
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i].match(/^#{1,3}\s/)) {
      if (currentSec) origSections.push(currentSec);
      currentSec = { lines: [origLines[i]] };
    } else if (currentSec) {
      currentSec.lines.push(origLines[i]);
    } else {
      preamble.push(origLines[i]);
    }
  }
  if (currentSec) origSections.push(currentSec);
  
  if (origSections.length === 0) return;
  
  // Reorder
  const moved = origSections.splice(draggedSectionIndex, 1)[0];
  const adjustedTarget = targetIndex > draggedSectionIndex ? targetIndex - 1 : targetIndex;
  origSections.splice(adjustedTarget, 0, moved);
  
  // Rebuild
  const newText = preamble.join('\n') + (preamble.length ? '\n' : '') + origSections.map(s => s.lines.join('\n')).join('\n');
  editor.setValue(newText);
  saveVideo();
  updateOutline();
  updateTimingWidget();
  
  draggedSectionIndex = null;
}

function scrollToLine(lineNum) {
  const editor = editors['script-editor'];
  if (!editor) return;
  editor.scrollIntoView({ line: lineNum, ch: 0 }, 100);
  editor.setCursor({ line: lineNum, ch: 0 });
  editor.focus();
}

function toggleOutline() {
  const outline = document.getElementById('section-outline');
  if (outline) outline.classList.toggle('collapsed');
}

// === Navigation ===
function showView(view) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#${view}-view`).classList.add('active');
}

// === Library ===
async function loadVideos() {
  const res = await fetch('/api/videos');
  const videos = await res.json();
  const grid = $('#video-grid');
  const empty = $('#empty-state');

  if (videos.length === 0) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  grid.classList.remove('hidden');
  empty.classList.add('hidden');

  grid.innerHTML = videos.map(v => {
    const statusClass = `status-${v.status}`;
    const statusLabel = { draft: '📋 Draft', 'in-progress': '✏️ In Progress', complete: '✅ Complete' }[v.status] || v.status;
    const date = new Date(v.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const thumbnail = v.thumbnail ? `<img src="${v.thumbnail}" alt="">` : '🎬';

    return `
      <div class="video-card" onclick="openVideo(${v.id})">
        <button class="card-delete" onclick="event.stopPropagation(); deleteVideo(${v.id})" title="Delete">✕</button>
        <div class="card-thumbnail">${thumbnail}</div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(v.title)}</div>
          <div class="card-meta">
            <span class="card-status ${statusClass}">${statusLabel}</span>
            <span>${date}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  // Load templates alongside videos
  await loadTemplates();
}

// === Video CRUD ===
function createNewVideo() {
  $('#modal-overlay').classList.remove('hidden');
  const input = $('#new-video-title');
  input.value = '';
  setTimeout(() => input.focus(), 100);
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
}

async function confirmNewVideo() {
  const title = $('#new-video-title').value.trim() || 'Untitled Video';
  const templateId = document.getElementById('template-picker')?.value;
  closeModal();
  
  if (templateId) {
    const res = await fetch(`/api/templates/${templateId}/use`, { 
      method: 'POST', 
      headers: {'Content-Type':'application/json'}, 
      body: JSON.stringify({ title }) 
    });
    const video = await res.json();
    openVideo(video.id);
  } else {
    const res = await fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const video = await res.json();
    openVideo(video.id);
  }
}

// === Templates ===
async function loadTemplates() {
  const res = await fetch('/api/templates');
  const templates = await res.json();
  
  // Template chips in library
  const chips = document.getElementById('template-chips');
  if (chips) {
    chips.innerHTML = templates.map(t => `
      <button class="template-chip" onclick="useTemplate(${t.id}, '${escapeHtml(t.name)}')">
        📋 ${escapeHtml(t.name)}
      </button>
    `).join('') || '<span class="no-templates">No templates yet</span>';
  }
  
  // Template picker in new video modal
  const picker = document.getElementById('template-picker');
  if (picker) {
    picker.innerHTML = '<option value="">Blank</option>' + templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  }
}

async function useTemplate(templateId, name) {
  const title = prompt(`New video title:`, `New ${name} Video`) || 'Untitled';
  const res = await fetch(`/api/templates/${templateId}/use`, { 
    method: 'POST', 
    headers: {'Content-Type':'application/json'}, 
    body: JSON.stringify({ title }) 
  });
  const video = await res.json();
  openVideo(video.id);
}

async function saveAsTemplate() {
  if (!currentVideo) return;
  const name = prompt('Template name:', currentVideo.title + ' Template');
  if (!name) return;
  const desc = prompt('Brief description (optional):') || '';
  await fetch('/api/templates', { 
    method: 'POST', 
    headers: {'Content-Type':'application/json'}, 
    body: JSON.stringify({ name, description: desc, videoId: currentVideo.id }) 
  });
  showToast('Template saved!');
  await loadTemplates();
}

let deleteTargetId = null;

function deleteVideo(id) {
  deleteTargetId = id;
  $('#delete-overlay').classList.remove('hidden');
  $('#confirm-delete-btn').onclick = async () => {
    await fetch(`/api/videos/${deleteTargetId}`, { method: 'DELETE' });
    closeDeleteModal();
    loadVideos();
  };
}

function closeDeleteModal() {
  $('#delete-overlay').classList.add('hidden');
  deleteTargetId = null;
}

// === Workspace ===
async function openVideo(id) {
  const res = await fetch(`/api/videos/${id}`);
  currentVideo = await res.json();

  // Switch view first so editors exist in DOM
  showView('workspace');
  
  // NOW initialize editors (they exist now)
  initEditors();

  // Populate fields
  $('#video-title').value = currentVideo.title;
  $('#video-status').value = currentVideo.status;
  
  // Set editor values (CodeMirror)
  if (editors['script-editor']) editors['script-editor'].setValue(currentVideo.script_content || '');
  if (editors['description-editor']) editors['description-editor'].setValue(currentVideo.description || '');
  if (editors['voiceover-editor']) editors['voiceover-editor'].setValue(currentVideo.voiceover_notes || '');

  // Load chat messages
  await loadChannelMessages(id, currentChatChannel);

  // Load uploaded images
  loadUploads();
  
  // Load thumbnails
  thumbnailVersions = [];
  selectedThumbnailVersionId = null;
  loadThumbnails();

  // View already switched (done earlier to init editors)
  
  // Set up auto-save
  setupAutoSave();
  
  // Update token bar
  updateTokenBar();
  
  // Update timing widget
  updateTimingWidget();
  
  // Update section outline
  updateOutline();
}

async function loadMessages(videoId) {
  const res = await fetch(`/api/videos/${videoId}/messages`);
  const messages = await res.json();
  const container = $('#chat-messages');

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="chat-welcome">
        <p>🌺 <strong>Kona here!</strong> Ready to work on "${escapeHtml(currentVideo.title)}" together. What's the vision?</p>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map(m => renderMessage(m.role, m.content, m.image_url)).join('');
  scrollChat();
}

async function switchChatChannel(channel) {
  currentChatChannel = channel;
  // Update tab active states
  document.querySelectorAll('.chat-tab').forEach(t => 
    t.classList.toggle('active', t.dataset.channel === channel)
  );

  const mappedTab = channelToTabMap[channel];
  if (mappedTab && !isPaneSyncing) {
    const tabEl = document.querySelector(`.tab[data-tab="${mappedTab}"]`);
    if (tabEl && !tabEl.classList.contains('active')) {
      isPaneSyncing = true;
      switchTab(mappedTab);
      isPaneSyncing = false;
    }
  }

  // Load messages for this channel
  if (currentVideo) {
    await loadChannelMessages(currentVideo.id, channel);
    updateTokenBar();
  }
}

async function loadChannelMessages(videoId, channel) {
  const res = await fetch(`/api/videos/${videoId}/channels/${channel}/messages`);
  const messages = await res.json();
  const container = $('#chat-messages');
  
  const channelNames = { script: 'script', description: 'description', thumbnail: 'thumbnails' };
  
  if (messages.length === 0) {
    const welcomeText = channel === 'script' 
      ? `Ready to work on "${escapeHtml(currentVideo.title)}"` 
      : channel === 'description' 
      ? 'Let\'s craft the perfect description' 
      : 'Let\'s design some thumbnails';
    
    container.innerHTML = `
      <div class="chat-welcome">
        <p>🌺 <strong>Kona here!</strong> ${welcomeText}. What are you thinking?</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = messages.map(m => renderMessage(m.role, m.content, m.image_url)).join('');
  scrollChat();
}

function renderMessage(role, content, imageUrl = null) {
  const sender = role === 'user' ? 'Nora' : 'Kona 🌺';
  const processed = processMessageContent(content, role === 'assistant');
  
  // If there's an image URL, display it before the text
  let imageHtml = '';
  if (imageUrl && role === 'user') {
    imageHtml = `<img src="${imageUrl}" class="chat-image" onclick="openImagePreview('${imageUrl}')" alt="Shared image">`;
  }
  
  return `
    <div class="chat-message ${role}">
      <span class="sender">${sender}</span>
      <div class="bubble">${imageHtml}${processed}</div>
    </div>
  `;
}

function processMessageContent(content, isAssistant) {
  // Extract suggestion blocks FIRST — show as clickable one-liners in chat
  if (isAssistant) {
    const suggestionRegex = /<<<SUGGEST\s+tab="(\w+)"(?:\s+section="(.*?)")?\s*>>>\n---OLD---\n([\s\S]*?)\n---NEW---\n([\s\S]*?)\n<<<END_SUGGEST>>>/g;
    
    content = content.replace(suggestionRegex, (match, tab, section, oldText, newText) => {
      const idx = pendingSuggestions.length;
      const label = section || tab;
      pendingSuggestions.push({ tab, section, oldText: oldText.trim(), newText: newText.trim() });
      return `[SUGGESTION_CHIP:${idx}:${label}]`;
    });
  }

  // Parse markdown-ish content
  let html = escapeHtml(content);

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Section references (Kona's [[section:Name]] tags)
  if (isAssistant) {
    html = html.replace(/\[\[section:(.+?)\]\]/g, '<span class="section-ref" onclick="scrollToSection(\'$1\')">📌 <u>$1</u></span>');
  }
  // Image URLs (shared images)
  html = html.replace(/\[Image shared: [^\]]+\]\s*(\S+\.(?:png|jpg|jpeg|gif|webp))/gi, 
    '<img src="$1" class="chat-image" onclick="openImagePreview(\'$1\')" alt="Shared image">');
  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<h[123]>)/g, '$1');
  html = html.replace(/(<\/h[123]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');

  // Render suggestion chips as clickable one-liners
  html = html.replace(/\[SUGGESTION_CHIP:(\d+):(.*?)\]/g, (match, idx, label) => {
    return `<span class="suggestion-chip" onclick="showSuggestion(${idx})" id="suggestion-chip-${idx}">💡 <u>Suggestion: ${escapeHtml(label)}</u></span>`;
  });

  // Process suggestions into inline diffs (Feature 5)
  if (isAssistant) {
    html = processSuggestions(html);
  }

  return html;
}

// === Feature 5: Inline Git-Diff Style Suggestions ===

function processSuggestions(html) {
  const suggestionRegex = /&lt;&lt;&lt;SUGGEST\s+tab=&quot;(\w+)&quot;(?:\s+section=&quot;([^&]*)&quot;)?\s*&gt;&gt;&gt;\n---OLD---\n([\s\S]*?)\n---NEW---\n([\s\S]*?)\n&lt;&lt;&lt;END_SUGGEST&gt;&gt;&gt;/g;
  
  let idx = 0;
  return html.replace(suggestionRegex, (match, tab, section, oldText, newText) => {
    const id = `suggest-${Date.now()}-${idx++}`;
    // Unescape HTML entities in oldText and newText for proper display
    const oldTextUnescaped = unescapeHtml(oldText);
    const newTextUnescaped = unescapeHtml(newText);
    
    // Escape for JSON embedding
    const oldTextJson = JSON.stringify(oldTextUnescaped).replace(/'/g, "\\'");
    const newTextJson = JSON.stringify(newTextUnescaped).replace(/'/g, "\\'");
    
    return `
      <div class="suggestion-diff" id="${id}">
        <div class="diff-header">
          <span class="diff-tab">📝 ${escapeHtml(tab)}${section ? ` › ${escapeHtml(section)}` : ''}</span>
          <div class="diff-actions">
            <button class="diff-accept" onclick="acceptSuggestion('${id}', '${escapeHtml(tab)}', ${oldTextJson}, ${newTextJson})">✓ Accept</button>
            <button class="diff-reject" onclick="rejectSuggestion('${id}')">✕ Reject</button>
          </div>
        </div>
        <div class="diff-body">
          <div class="diff-old"><span class="diff-label">- Remove</span><pre>${oldTextUnescaped}</pre></div>
          <div class="diff-new"><span class="diff-label">+ Add</span><pre>${newTextUnescaped}</pre></div>
        </div>
      </div>
    `;
  });
}

function acceptSuggestion(id, tab, oldText, newText) {
  const editorId = tab === 'thumbnails' ? 'thumbnails-editor' : `${tab}-editor`;
  const editor = editors[editorId];
  if (!editor) {
    console.error('Editor not found:', editorId);
    return;
  }
  
  const content = editor.getValue();
  const newContent = content.replace(oldText.trim(), newText.trim());
  
  if (newContent !== content) {
    editor.setValue(newContent);
    saveVideo();
    // Mark as accepted
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('suggestion-accepted');
      el.querySelector('.diff-actions').innerHTML = '<span class="diff-status accepted">✓ Applied</span>';
    }
  } else {
    // Text not found — maybe already changed
    const el = document.getElementById(id);
    if (el) {
      el.querySelector('.diff-actions').innerHTML = '<span class="diff-status warn">⚠ Text not found in editor</span>';
    }
  }
}

function rejectSuggestion(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('suggestion-rejected');
    el.querySelector('.diff-actions').innerHTML = '<span class="diff-status rejected">✗ Dismissed</span>';
  }
}

function showSuggestion(idx) {
  const s = pendingSuggestions[idx];
  if (!s) return;
  activeSuggestionIdx = idx;
  
  const overlay = $('#suggestion-overlay');
  $('#suggestion-section').textContent = s.section ? `› ${s.section}` : `› ${s.tab}`;
  
  // Get context from the editor
  const editorId = s.tab === 'thumbnails' ? 'thumbnails-editor' : `${s.tab}-editor`;
  const editor = editors[editorId];
  const fullText = editor ? editor.getValue() : '';
  
  // Find the old text in the script and extract 10 lines of context
  const matchIdx = fullText.indexOf(s.oldText);
  let contextBefore = '', contextAfter = '';
  const CONTEXT_LINES = 10;
  
  if (matchIdx >= 0) {
    // Get 10 lines before
    const textBefore = fullText.slice(0, matchIdx);
    const linesBefore = textBefore.split('\n');
    const slicedBefore = linesBefore.slice(-CONTEXT_LINES);
    contextBefore = (linesBefore.length > CONTEXT_LINES ? '…\n' : '') + slicedBefore.join('\n');
    
    // Get 10 lines after
    const textAfter = fullText.slice(matchIdx + s.oldText.length);
    const linesAfter = textAfter.split('\n');
    const slicedAfter = linesAfter.slice(0, CONTEXT_LINES);
    contextAfter = slicedAfter.join('\n') + (linesAfter.length > CONTEXT_LINES ? '\n…' : '');
  }
  
  // Render context as formatted markdown
  const renderMd = (text) => processMessageContent(text, false);
  
  // Build the contextual diff view
  const diffView = $('.suggestion-diff-view');
  diffView.innerHTML = `
    ${contextBefore ? `<div class="diff-context">${renderMd(contextBefore)}</div>` : ''}
    <div class="diff-side diff-remove">
      <div class="diff-side-label">— Current</div>
      <div class="diff-content">${renderMd(s.oldText)}</div>
    </div>
    <div class="diff-side diff-add">
      <div class="diff-side-label">+ Suggested</div>
      <div class="diff-content">${renderMd(s.newText)}</div>
    </div>
    ${contextAfter ? `<div class="diff-context">${renderMd(contextAfter)}</div>` : ''}
  `;
  
  overlay.classList.remove('hidden');
  
  // Show correct buttons based on state
  const acceptBtn = $('#suggestion-accept-btn');
  const rejectBtn = $('#suggestion-reject-btn');
  
  if (s.applied) {
    acceptBtn.textContent = '↩ Undo Change';
    acceptBtn.className = 'btn btn-ghost';
    acceptBtn.onclick = () => undoSuggestion(idx);
    rejectBtn.textContent = '✕ Close';
    rejectBtn.onclick = () => closeSuggestionOverlay();
  } else {
    acceptBtn.textContent = '✓ Accept Change';
    acceptBtn.className = 'btn btn-success';
    acceptBtn.onclick = () => applySuggestion(idx);
    rejectBtn.textContent = '✕ Dismiss';
    rejectBtn.onclick = () => dismissSuggestion(idx);
  }
}

function applySuggestion(idx) {
  const s = pendingSuggestions[idx];
  if (!s) return;
  
  const editorId = s.tab === 'thumbnails' ? 'thumbnails-editor' : `${s.tab}-editor`;
  const editor = editors[editorId];
  if (!editor) { console.error('Editor not found:', editorId); return; }
  
  const content = editor.getValue();
  const newContent = content.replace(s.oldText, s.newText);
  
  if (newContent !== content) {
    editor.setValue(newContent);
    saveVideo();
    s.applied = true;
    const chip = document.getElementById(`suggestion-chip-${idx}`);
    if (chip) { chip.innerHTML = '✅ Suggestion applied — <u>click to review/undo</u>'; chip.style.opacity = '0.7'; }
  } else {
    const chip = document.getElementById(`suggestion-chip-${idx}`);
    if (chip) { chip.innerHTML = '⚠️ Text not found in editor — <u>click to review</u>'; }
  }
  closeSuggestionOverlay();
}

function undoSuggestion(idx) {
  const s = pendingSuggestions[idx];
  if (!s || !s.applied) return;
  
  const editorId = s.tab === 'thumbnails' ? 'thumbnails-editor' : `${s.tab}-editor`;
  const editor = editors[editorId];
  if (!editor) return;
  
  const content = editor.getValue();
  const reverted = content.replace(s.newText, s.oldText);
  
  if (reverted !== content) {
    editor.setValue(reverted);
    saveVideo();
    s.applied = false;
    const chip = document.getElementById(`suggestion-chip-${idx}`);
    if (chip) { chip.innerHTML = '💡 <u>Suggestion: ' + escapeHtml(s.section || s.tab) + '</u> (reverted)'; chip.style.opacity = '1'; }
  }
  closeSuggestionOverlay();
}

function dismissSuggestion(idx) {
  const s = pendingSuggestions[idx];
  if (s) s.dismissed = true;
  const chip = document.getElementById(`suggestion-chip-${idx}`);
  if (chip) { chip.innerHTML = '❌ Dismissed — <u>click to review</u>'; chip.style.opacity = '0.5'; }
  closeSuggestionOverlay();
}

function closeSuggestionOverlay() {
  $('#suggestion-overlay').classList.add('hidden');
  activeSuggestionIdx = null;
}

function scrollChat() {
  const container = $('#chat-messages');
  container.scrollTop = container.scrollHeight;
}

// === Image Upload ===
async function handleChatImage(file) {
  if (!currentVideo) return;
  
  // Upload the image
  const formData = new FormData();
  formData.append('file', file);
  
  const uploadRes = await fetch(`/api/videos/${currentVideo.id}/upload`, {
    method: 'POST',
    body: formData
  });
  const uploadData = await uploadRes.json();
  
  // Show image in chat as user message
  const imageUrl = uploadData.url;
  const imageHtml = `
    <div class="chat-message user">
      <span class="sender">Nora</span>
      <div class="bubble">
        <img src="${imageUrl}" class="chat-image" alt="Uploaded image" onclick="openImagePreview('${imageUrl}')">
        <p class="image-caption">Shared an image</p>
      </div>
    </div>
  `;
  
  // Remove welcome message if present
  const welcome = $('#chat-messages .chat-welcome');
  if (welcome) welcome.remove();
  
  $('#chat-messages').insertAdjacentHTML('beforeend', imageHtml);
  scrollChat();
  
  // Send a message referencing the image
  // Add streaming placeholder
  const streamId = `stream-${Date.now()}`;
  $('#chat-messages').insertAdjacentHTML('beforeend', `
    <div class="chat-message assistant" id="${streamId}">
      <span class="sender">Kona 🌺</span>
      <div class="bubble"><span class="streaming-indicator"><span></span></span></div>
    </div>
  `);
  scrollChat();
  
  isStreaming = true;
  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/channels/${currentChatChannel}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        message: `I'm sharing this image with you: ${imageUrl}\nPlease look at it and give me your thoughts.`, 
        imageUrl 
      })
    });
    
    // Standard SSE streaming reader (same as sendMessage)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'text') {
            fullText += data.content;
            const el = document.getElementById(streamId);
            if (el) el.querySelector('.bubble').innerHTML = processMessageContent(fullText, true);
            scrollChat();
          }
        } catch(e) {}
      }
    }
  } catch(err) {
    const el = document.getElementById(streamId);
    if (el) el.querySelector('.bubble').innerHTML = '<p style="color:var(--danger)">Error processing image</p>';
  }
  isStreaming = false;
  updateTokenBar();
}

// === Chat ===
async function sendMessage() {
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message || isStreaming) return;

  isStreaming = true;
  input.value = '';
  input.style.height = 'auto';

  // Remove welcome message
  const welcome = $('#chat-messages .chat-welcome');
  if (welcome) welcome.remove();

  // Add user message
  $('#chat-messages').insertAdjacentHTML('beforeend', renderMessage('user', message));
  scrollChat();

  // Add streaming placeholder
  const streamId = `stream-${Date.now()}`;
  $('#chat-messages').insertAdjacentHTML('beforeend', `
    <div class="chat-message assistant" id="${streamId}">
      <span class="sender">Kona 🌺</span>
      <div class="bubble"><span class="streaming-indicator"><span></span></span></div>
    </div>
  `);
  scrollChat();

  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/channels/${currentChatChannel}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'text') {
            fullText += data.content;
            const el = document.getElementById(streamId);
            if (el) {
              el.querySelector('.bubble').innerHTML = processMessageContent(fullText, true);
              scrollChat();
            }
          } else if (data.type === 'error') {
            const el = document.getElementById(streamId);
            if (el) {
              el.querySelector('.bubble').innerHTML = `<p style="color:var(--danger)">Error: ${escapeHtml(data.content)}</p>`;
            }
          }
        } catch(e) {}
      }
    }
  } catch (err) {
    const el = document.getElementById(streamId);
    if (el) {
      el.querySelector('.bubble').innerHTML = `<p style="color:var(--danger)">Connection error. Please try again.</p>`;
    }
  }

  isStreaming = false;
  $('#send-btn').disabled = false;
  
  // Update token count after message
  updateTokenBar();
}

// === Token Management ===
async function updateTokenBar() {
  if (!currentVideo) return;
  
  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/tokens`);
    const data = await res.json();
    
    const fillEl = $('#token-fill');
    const textEl = $('#token-text');
    
    if (!fillEl || !textEl) return;
    
    const percentage = data.percentage;
    fillEl.style.width = `${percentage}%`;
    
    // Color coding
    let color;
    if (percentage < 70) {
      color = '#4caf50'; // green
    } else if (percentage < 85) {
      color = '#ffa726'; // yellow
    } else if (percentage < 93) {
      color = '#ff9800'; // orange
    } else {
      color = '#e74c3c'; // red
    }
    fillEl.style.backgroundColor = color;
    
    // Format token count (e.g. 150K / 300K)
    const tokensK = Math.round(data.tokens / 1000);
    const maxK = Math.round(data.max / 1000);
    textEl.textContent = `${tokensK}K / ${maxK}K tokens`;
    
    // Visual warning if critical
    if (data.critical) {
      textEl.style.fontWeight = '700';
      textEl.style.color = '#fff';
    } else {
      textEl.style.fontWeight = '600';
      textEl.style.color = 'var(--text)';
    }
  } catch (err) {
    console.error('Token count error:', err);
  }
}

async function compactCurrentChat() {
  if (!currentVideo || isStreaming) return;
  const btn = document.getElementById('compact-chat-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Compacting…'; }

  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelType: currentChatChannel, keepRecent: 12 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Compaction failed');
    showToast(`Compacted ${data.prunedCount || 0} messages`);
    await updateTokenBar();
  } catch (err) {
    showToast('Compaction failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧹 Compact'; }
  }
}

// === Section Scrolling ===
function scrollToSection(sectionName) {
  const normalizedSearch = sectionName.toLowerCase().trim();
  
  // Map of tab names to editor IDs
  const tabEditors = {
    'script': 'script-editor',
    'description': 'description-editor',
    'voiceover': 'voiceover-editor',
    'thumbnails': 'thumbnails-editor'
  };
  
  for (const [tab, editorId] of Object.entries(tabEditors)) {
    const editor = editors[editorId];
    if (!editor) continue;
    
    const text = editor.getValue();
    const lines = text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase().trim();
      const cleaned = line.replace(/^#+\s*/, '').replace(/\*+/g, '').trim();
      
      if (cleaned.includes(normalizedSearch) || normalizedSearch.includes(cleaned)) {
        // Switch to correct tab
        switchTab(tab);
        
        // Find the section boundaries (from this header to next header or end)
        let endLine = lines.length - 1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(/^#{1,3}\s/)) {
            endLine = j - 1;
            break;
          }
        }
        
        // Clear any existing highlights
        editor.getAllMarks().forEach(mark => {
          if (mark.className === 'section-highlight') mark.clear();
        });
        
        // Highlight the section
        const marker = editor.markText(
          { line: i, ch: 0 },
          { line: endLine, ch: lines[endLine].length },
          { className: 'section-highlight' }
        );
        
        // Scroll to the section
        editor.scrollIntoView({ line: i, ch: 0 }, 100);
        editor.setCursor({ line: i, ch: 0 });
        editor.focus();
        
        // Remove highlight after 3 seconds with fade
        setTimeout(() => {
          marker.clear();
        }, 3000);
        
        return;
      }
    }
  }
}

// === Editor Tabs ===
function switchTab(tabName) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.editor-area').forEach(a => a.classList.toggle('active', a.id === `editor-${tabName}`));
  
  // Refresh CodeMirror for the active tab
  const editorId = `${tabName}-editor`;
  if (editors[editorId]) {
    setTimeout(() => editors[editorId].refresh(), 10);
  }

  const mappedChannel = tabToChannelMap[tabName];
  if (mappedChannel && !isPaneSyncing) {
    const chatTab = document.querySelector(`.chat-tab[data-channel="${mappedChannel}"]`);
    if (chatTab && !chatTab.classList.contains('active')) {
      isPaneSyncing = true;
      Promise.resolve(switchChatChannel(mappedChannel)).finally(() => {
        isPaneSyncing = false;
      });
    }
  }
  
  // Run SEO analysis when switching to SEO tab
  if (tabName === 'seo') {
    analyzeSEO();
  }
  
  // Load timeline when switching to timeline tab
  if (tabName === 'timeline') {
    loadTimeline();
  }
  
  // Load references when switching to references tab
  if (tabName === 'references') {
    loadReferences();
  }
}

// === Auto-save ===
function setupAutoSave() {
  // For non-editor fields
  const fields = ['#video-title', '#video-status'];

  fields.forEach(sel => {
    const el = $(sel);
    if (el) {
      el.addEventListener('input', debounce(saveVideo, 1000));
      el.addEventListener('change', debounce(saveVideo, 500));
    }
  });
  
  // CodeMirror editors already have change listeners set up in initEditors()
}

async function saveVideo() {
  if (!currentVideo) return;

  const indicator = $('#save-indicator');
  indicator.textContent = 'Saving...';
  indicator.classList.add('saving');

  try {
    await fetch(`/api/videos/${currentVideo.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: $('#video-title').value,
        status: $('#video-status').value,
        script_content: editors['script-editor'] ? editors['script-editor'].getValue() : '',
        description: editors['description-editor'] ? editors['description-editor'].getValue() : '',
        voiceover_notes: editors['voiceover-editor'] ? editors['voiceover-editor'].getValue() : '',
        thumbnail_ideas: editors['thumbnails-editor'] ? editors['thumbnails-editor'].getValue() : ''
      })
    });

    indicator.textContent = 'Saved ✓';
    indicator.classList.remove('saving');
    setTimeout(() => { indicator.textContent = 'Saved'; }, 2000);
    
    // Update SEO analysis if SEO tab is active
    const seoTab = document.getElementById('editor-seo');
    if (seoTab && seoTab.classList.contains('active')) {
      analyzeSEO();
    }
  } catch (err) {
    indicator.textContent = 'Save failed';
    indicator.classList.add('saving');
  }
}

// === File Upload ===
async function uploadFile(file) {
  if (!currentVideo) return;

  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`/api/videos/${currentVideo.id}/upload`, {
    method: 'POST',
    body: formData
  });

  const data = await res.json();
  loadUploads();
  return data;
}

function loadUploads() {
  if (!currentVideo?.uploads) return;

  const gallery = $('#thumbnail-gallery');
  if (!gallery) return;
  gallery.innerHTML = currentVideo.uploads.map(u =>
    `<img src="/uploads/${currentVideo.id}/${u.filename}" alt="${escapeHtml(u.original_name)}" title="${escapeHtml(u.original_name)}">`
  ).join('');
}

// === Resize Handle ===
function initResize() {
  const handle = $('#resize-handle');
  const chatPane = $('#chat-pane');
  let isResizing = false;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const containerRect = $('.workspace-container').getBoundingClientRect();
    const newWidth = e.clientX - containerRect.left;
    const pct = (newWidth / containerRect.width) * 100;
    if (pct > 20 && pct < 70) {
      chatPane.style.width = pct + '%';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// === Utilities ===
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function unescapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.innerHTML = str;
  return div.textContent;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function renderMarkdownPanel(mdText) {
  const lines = String(mdText || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const out = [];

  const parseRow = (line) => line.split('|').map(c => c.trim()).filter(Boolean);

  while (i < lines.length) {
    const line = lines[i] || '';
    const trimmed = line.trim();

    const isTableHeader = line.includes('|')
      && i + 1 < lines.length
      && /^\s*\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(lines[i + 1]);

    if (isTableHeader) {
      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      out.push('<table class="thumb-analysis-table"><thead><tr>' + headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>');
      rows.forEach(r => {
        out.push('<tr>' + r.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>');
      });
      out.push('</tbody></table>');
      continue;
    }

    if (/^###\s+/.test(trimmed)) { out.push(`<h4>${escapeHtml(trimmed.replace(/^###\s+/, ''))}</h4>`); i++; continue; }
    if (/^##\s+/.test(trimmed)) { out.push(`<h3>${escapeHtml(trimmed.replace(/^##\s+/, ''))}</h3>`); i++; continue; }
    if (/^#\s+/.test(trimmed)) { out.push(`<h2>${escapeHtml(trimmed.replace(/^#\s+/, ''))}</h2>`); i++; continue; }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test((lines[i] || '').trim())) {
        items.push((lines[i] || '').trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map(item => `<li>${escapeHtml(item)}</li>`).join('') + '</ul>');
      continue;
    }

    if (!trimmed) {
      out.push('<div class="md-spacer"></div>');
      i++;
      continue;
    }

    out.push(`<p>${escapeHtml(trimmed)}</p>`);
    i++;
  }

  return out.join('');
}

// === Thumbnails ===
function getSelectedThumbnailVersion() {
  return thumbnailVersions.find(v => Number(v.id) === Number(selectedThumbnailVersionId)) || null;
}

function renderSelectedThumbnail() {
  const current = $('#thumb-current');
  if (!current || !currentVideo) return;

  const selected = getSelectedThumbnailVersion();
  if (!selected) {
    current.innerHTML = '<p class="thumb-empty">No thumbnail selected.</p>';
    return;
  }

  const sourceLabel = selected.source === 'nanobanana' ? 'AI subversion' : 'Upload';
  current.innerHTML = `
    <img src="/uploads/${currentVideo.id}/${selected.filename}" alt="Current thumbnail" class="thumb-preview-large" onclick="openImagePreview('/uploads/${currentVideo.id}/${selected.filename}')">
    <div class="thumb-version-label">v${selected.version_label || selected.version_number} • ${sourceLabel}</div>
    <div class="thumb-version-meta">${selected.notes ? escapeHtml(selected.notes) : 'No notes'}</div>
  `;

  const analysisOutput = document.getElementById('thumb-analysis-output');
  if (analysisOutput) {
    if (selected.analysis) {
      const provider = selected.analysis_provider ? `(${selected.analysis_provider})` : '';
      analysisOutput.innerHTML = `<div class="thumb-analysis-header"><strong>Analysis ${provider}</strong></div>${renderMarkdownPanel(selected.analysis)}`;
    } else {
      analysisOutput.innerHTML = '<em>No analysis yet. Click “Analyze Selected”.</em>';
    }
  }
}

async function loadThumbnails() {
  if (!currentVideo) return;
  const res = await fetch(`/api/videos/${currentVideo.id}/thumbnails`);
  thumbnailVersions = await res.json();

  const current = $('#thumb-current');
  const timeline = $('#thumb-timeline');
  if (!current || !timeline) return;

  if (!thumbnailVersions.length) {
    current.innerHTML = '<p class="thumb-empty">No thumbnails yet. Upload one above!</p>';
    timeline.innerHTML = '';
    selectedThumbnailVersionId = null;
    return;
  }

  if (!selectedThumbnailVersionId || !thumbnailVersions.some(v => Number(v.id) === Number(selectedThumbnailVersionId))) {
    selectedThumbnailVersionId = thumbnailVersions[0].id;
  }

  timeline.innerHTML = thumbnailVersions.map(v => {
    const source = v.source === 'nanobanana' ? '<span class="thumb-source-badge">AI</span>' : '';
    return `
      <div class="thumb-version-card ${Number(v.id) === Number(selectedThumbnailVersionId) ? 'active' : ''}" data-version-id="${v.id}" onclick="selectThumbnailVersion(${v.id})">
        <img src="/uploads/${currentVideo.id}/${v.filename}" alt="v${v.version_label || v.version_number}">
        <div class="thumb-version-info">
          <span class="thumb-v-number">v${v.version_label || v.version_number}</span>
          <span class="thumb-v-date">${new Date(v.created_at).toLocaleDateString()}</span>
          ${source}
          ${v.notes ? `<span class="thumb-v-notes">${escapeHtml(v.notes)}</span>` : ''}
        </div>
        <button class="thumb-delete" onclick="event.stopPropagation(); deleteThumbnailVersion(${currentVideo.id}, ${v.id})">✕</button>
      </div>
    `;
  }).join('');

  renderSelectedThumbnail();
}

async function uploadThumbnail(file, parentVersionId = null, source = 'upload') {
  if (!currentVideo) return;
  const notes = $('#thumb-notes')?.value || '';
  const formData = new FormData();
  formData.append('file', file);
  formData.append('notes', notes);
  formData.append('source', source);
  formData.append('analysisProvider', selectedImageAnalysisProvider || 'claude');
  if (parentVersionId) formData.append('parentVersionId', String(parentVersionId));

  const res = await fetch(`/api/videos/${currentVideo.id}/thumbnails`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');

  $('#thumb-notes').value = '';
  selectedThumbnailVersionId = data.id;
  await loadThumbnails();
}

async function analyzeSelectedThumbnail() {
  if (!currentVideo || !selectedThumbnailVersionId) return;
  const instruction = ($('#thumb-improve-instruction')?.value || '').trim();
  const btn = document.getElementById('thumb-analyze-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }

  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/thumbnails/${selectedThumbnailVersionId}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: selectedImageAnalysisProvider || 'claude', instruction }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analyze failed');

    const idx = thumbnailVersions.findIndex(v => Number(v.id) === Number(data.version.id));
    if (idx >= 0) thumbnailVersions[idx] = data.version;

    renderSelectedThumbnail();
    showToast(`Analysis updated (${data.provider})`);
  } catch (err) {
    showToast('Analyze failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔬 Analyze Selected'; }
  }
}

async function generateThumbnailSubversion() {
  if (!currentVideo || !selectedThumbnailVersionId) return;
  const instruction = ($('#thumb-improve-instruction')?.value || '').trim();
  const btn = document.getElementById('thumb-generate-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/thumbnails/${selectedThumbnailVersionId}/improve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, analysisProvider: selectedImageAnalysisProvider || 'claude' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI subversion generation failed');

    selectedThumbnailVersionId = data.createdVersion.id;
    await loadThumbnails();

    const plan = data.plan || {};
    const out = document.getElementById('thumb-analysis-output');
    if (out) {
      out.innerHTML = `<strong>Generated subversion v${data.createdVersion.version_label}</strong><br>${escapeHtml(plan.summary || 'Done')}<br><br><strong>Prompt used:</strong><br>${escapeHtml(plan.generation_prompt || '')}`;
    }

    showToast(`Generated v${data.createdVersion.version_label}`);
  } catch (err) {
    showToast('Generation failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate AI Subversion'; }
  }
}

async function deleteThumbnailVersion(videoId, versionId) {
  if (!confirm('Delete this thumbnail version?')) return;
  await fetch(`/api/videos/${videoId}/thumbnails/${versionId}`, { method: 'DELETE' });
  if (Number(selectedThumbnailVersionId) === Number(versionId)) selectedThumbnailVersionId = null;
  await loadThumbnails();
}

function selectThumbnailVersion(versionId) {
  selectedThumbnailVersionId = Number(versionId);
  document.querySelectorAll('.thumb-version-card').forEach(card => card.classList.remove('active'));
  const selectedCard = document.querySelector(`.thumb-version-card[data-version-id="${versionId}"]`);
  if (selectedCard) selectedCard.classList.add('active');
  renderSelectedThumbnail();
}

function openImagePreview(src) {
  const overlay = $('#image-preview-overlay');
  const img = $('#image-preview-img');
  img.src = src;
  overlay.classList.remove('hidden');
}

function closeImagePreview() {
  $('#image-preview-overlay').classList.add('hidden');
}

// === TTS Preview ===
async function previewVoiceover() {
  const editor = editors['voiceover-editor'];
  if (!editor) return;
  const text = editor.getValue().trim();
  if (!text) { 
    showToast('No voiceover text to preview'); 
    return; 
  }
  await generateTTS(text);
}

async function previewSelection() {
  const editor = editors['voiceover-editor'];
  if (!editor) return;
  const selection = editor.getSelection().trim();
  if (!selection) { 
    showToast('Select some text first'); 
    return; 
  }
  await generateTTS(selection);
}

async function generateTTS(text) {
  const btn = document.getElementById('tts-btn');
  const status = document.getElementById('tts-status');
  const player = document.getElementById('tts-player');
  
  if (!btn || !status || !player) {
    showToast('TTS UI elements not found');
    return;
  }
  
  if (text.length > 5000) {
    showToast('Text too long (max 5000 chars). Select a section.');
    return;
  }
  
  btn.disabled = true;
  status.textContent = '🔄 Generating...';
  
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    
    if (data.error) {
      status.textContent = '❌ ' + data.error;
      showToast('TTS error: ' + data.error);
      return;
    }
    
    player.src = data.url;
    player.classList.remove('hidden');
    player.play();
    status.textContent = `✅ ~${data.duration}s`;
    showToast('Audio generated!');
  } catch (err) {
    status.textContent = '❌ Error generating audio';
    showToast('Error generating audio: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  // NOTE: initEditors() is called in openVideo() after the workspace view is shown
  loadVideos();
  initResize();
  loadModelOptions();
  updateCreditsDisplay();
  startCreditsRefresh();

  const bind = (selector, event, handler) => {
    const el = $(selector);
    if (el) el.addEventListener(event, handler);
    return el;
  };

  // Navigation
  bind('#back-btn', 'click', () => {
    saveVideo();
    currentVideo = null;
    showView('library');
    loadVideos();
  });

  // New video
  bind('#new-video-btn', 'click', createNewVideo);

  // Theme toggle
  bind('#theme-toggle', 'click', toggleTheme);
  bind('#theme-toggle-ws', 'click', toggleTheme);
  bind('#theme-toggle-nav', 'click', toggleTheme);

  // Chat send
  bind('#send-btn', 'click', sendMessage);
  bind('#compact-chat-btn', 'click', compactCurrentChat);
  bind('#thumb-analyze-btn', 'click', analyzeSelectedThumbnail);
  bind('#thumb-generate-btn', 'click', generateThumbnailSubversion);
  const chatInput = bind('#chat-input', 'keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Image paste handler on chat input
  if (chatInput) {
    chatInput.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) await handleChatImage(file);
          return;
        }
      }
    });

    // Auto-resize textarea
    chatInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }

  // Drag-drop handler on chat messages area
  const chatArea = $('#chat-messages');
  if (chatArea) {
    chatArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      chatArea.classList.add('drag-over');
    });
    chatArea.addEventListener('dragleave', () => chatArea.classList.remove('drag-over'));
    chatArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      chatArea.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        await handleChatImage(file);
      }
    });
  }

  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // WPM input handler
  const wpmInput = document.getElementById('wpm-input');
  if (wpmInput) {
    wpmInput.addEventListener('change', (e) => {
      targetWPM = parseInt(e.target.value) || 150;
      updateTimingWidget();
    });
    wpmInput.addEventListener('input', (e) => {
      targetWPM = parseInt(e.target.value) || 150;
      updateTimingWidget();
    });
  }

  // File upload
  bind('#upload-btn', 'click', () => {
    const input = $('#file-input');
    if (input) input.click();
  });
  bind('#file-input', 'change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await uploadFile(file);
      e.target.value = '';
    }
  });

  // Modal keyboard
  bind('#new-video-title', 'keydown', (e) => {
    if (e.key === 'Enter') confirmNewVideo();
    if (e.key === 'Escape') closeModal();
  });

  // Close modals on overlay click
  bind('#modal-overlay', 'click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  bind('#delete-overlay', 'click', (e) => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });
  
  // Thumbnail drop zone
  const thumbDrop = document.getElementById('thumb-drop-zone');
  if (thumbDrop) {
    thumbDrop.addEventListener('click', () => document.getElementById('thumb-file-input').click());
    thumbDrop.addEventListener('dragover', e => { e.preventDefault(); thumbDrop.classList.add('drag-over'); });
    thumbDrop.addEventListener('dragleave', () => thumbDrop.classList.remove('drag-over'));
    thumbDrop.addEventListener('drop', async e => { 
      e.preventDefault(); 
      thumbDrop.classList.remove('drag-over'); 
      if (e.dataTransfer.files[0]) {
        try {
          await uploadThumbnail(e.dataTransfer.files[0]);
        } catch (err) {
          showToast('Thumbnail upload failed: ' + err.message);
        }
      }
    });
    document.getElementById('thumb-file-input').addEventListener('change', async e => { 
      if (e.target.files[0]) { 
        try {
          await uploadThumbnail(e.target.files[0]);
        } catch (err) {
          showToast('Thumbnail upload failed: ' + err.message);
        }
        e.target.value = ''; 
      } 
    });
  }
  
  // Reference board file input
  const refFileInput = document.getElementById('ref-file-input');
  if (refFileInput) {
    refFileInput.addEventListener('change', async (e) => {
      if (!e.target.files[0] || !currentVideo) return;
      const title = prompt('Title for this reference (optional):') || '';
      const notes = prompt('Notes (optional):') || '';
      const formData = new FormData();
      formData.append('file', e.target.files[0]);
      formData.append('item_type', 'image');
      formData.append('title', title);
      formData.append('notes', notes);
      await fetch(`/api/videos/${currentVideo.id}/references`, { method: 'POST', body: formData });
      e.target.value = '';
      await loadReferences();
    });
  }
});

// --- Version History / Snapshots ---
async function toggleSnapshotPanel() {
  const panel = $('#snapshot-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) await loadSnapshots();
}

let selectedSnapshots = [];

async function loadSnapshots() {
  if (!currentVideo) return;
  const res = await fetch(`/api/videos/${currentVideo.id}/snapshots`);
  const snapshots = await res.json();
  const list = $('#snapshot-list');
  
  if (snapshots.length === 0) {
    list.innerHTML = '<p class="no-snapshots">No versions saved yet</p>';
    return;
  }
  
  // Clear selection
  selectedSnapshots = [];
  
  // Add compare mode toggle if more than 1 snapshot
  let html = '';
  if (snapshots.length > 1) {
    html += `
      <div class="snapshot-toolbar">
        <button class="btn btn-sm" onclick="toggleCompareMode()" id="compare-mode-btn">
          🔍 Compare Versions
        </button>
        <button class="btn btn-success btn-sm hidden" onclick="showDiff()" id="compare-btn">
          Compare Selected
        </button>
      </div>
    `;
  }
  
  html += snapshots.map(s => {
    const date = new Date(s.created_at).toLocaleString();
    const icon = s.created_by === 'manual' ? '📌' : '🔄';
    return `<div class="snapshot-item" data-id="${s.id}">
      <input type="checkbox" class="snapshot-checkbox hidden" onchange="updateCompareSelection(${s.id})" id="snap-${s.id}">
      <div class="snapshot-info">
        <span class="snapshot-label">${icon} ${escapeHtml(s.label)}</span>
        <span class="snapshot-date">${date}</span>
      </div>
      <div class="snapshot-actions">
        <button onclick="restoreSnapshot(${s.id})" title="Restore" class="btn-snapshot">↩️</button>
        <button onclick="deleteSnapshot(${s.id})" title="Delete" class="btn-snapshot">🗑️</button>
      </div>
    </div>`;
  }).join('');
  
  list.innerHTML = html;
}

function toggleCompareMode() {
  const checkboxes = $$('.snapshot-checkbox');
  const btn = $('#compare-mode-btn');
  const isCompareMode = !checkboxes[0]?.classList.contains('hidden');
  
  checkboxes.forEach(cb => cb.classList.toggle('hidden', isCompareMode));
  btn.textContent = isCompareMode ? '🔍 Compare Versions' : '✕ Cancel';
  
  if (isCompareMode) {
    selectedSnapshots = [];
    $('#compare-btn')?.classList.add('hidden');
  }
}

function updateCompareSelection(id) {
  const checkbox = $(`#snap-${id}`);
  if (checkbox.checked) {
    selectedSnapshots.push(id);
  } else {
    selectedSnapshots = selectedSnapshots.filter(sid => sid !== id);
  }
  
  // Limit to 2 selections
  if (selectedSnapshots.length > 2) {
    const oldest = selectedSnapshots.shift();
    const oldCheckbox = $(`#snap-${oldest}`);
    if (oldCheckbox) oldCheckbox.checked = false;
  }
  
  // Show/hide compare button
  const compareBtn = $('#compare-btn');
  if (selectedSnapshots.length === 2) {
    compareBtn?.classList.remove('hidden');
  } else {
    compareBtn?.classList.add('hidden');
  }
}

async function showDiff() {
  if (selectedSnapshots.length !== 2) return;
  
  const res = await fetch(`/api/videos/${currentVideo.id}/snapshots/diff?a=${selectedSnapshots[0]}&b=${selectedSnapshots[1]}`);
  const { a, b } = await res.json();
  
  // Create diff modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'diff-overlay';
  overlay.innerHTML = `
    <div class="modal modal-diff">
      <div class="modal-header">
        <h2>Compare Versions</h2>
        <button class="btn-close" onclick="closeDiffModal()">✕</button>
      </div>
      <div class="diff-metadata">
        <div class="diff-meta-item">
          <strong>Version A:</strong> ${escapeHtml(a.label)} (${new Date(a.created_at).toLocaleString()})
        </div>
        <div class="diff-meta-item">
          <strong>Version B:</strong> ${escapeHtml(b.label)} (${new Date(b.created_at).toLocaleString()})
        </div>
      </div>
      <div class="diff-tabs">
        <button class="diff-tab active" onclick="switchDiffTab('script')">Script</button>
        <button class="diff-tab" onclick="switchDiffTab('description')">Description</button>
        <button class="diff-tab" onclick="switchDiffTab('voiceover')">Voiceover</button>
        <button class="diff-tab" onclick="switchDiffTab('thumbnails')">Thumbnail Ideas</button>
      </div>
      <div class="diff-content">
        <div class="diff-view" id="diff-script">
          <div class="diff-pane">
            <h4>Version A</h4>
            <pre class="diff-text">${escapeHtml(a.script_content || '(empty)')}</pre>
          </div>
          <div class="diff-pane">
            <h4>Version B</h4>
            <pre class="diff-text">${escapeHtml(b.script_content || '(empty)')}</pre>
          </div>
        </div>
        <div class="diff-view hidden" id="diff-description">
          <div class="diff-pane">
            <h4>Version A</h4>
            <pre class="diff-text">${escapeHtml(a.description || '(empty)')}</pre>
          </div>
          <div class="diff-pane">
            <h4>Version B</h4>
            <pre class="diff-text">${escapeHtml(b.description || '(empty)')}</pre>
          </div>
        </div>
        <div class="diff-view hidden" id="diff-voiceover">
          <div class="diff-pane">
            <h4>Version A</h4>
            <pre class="diff-text">${escapeHtml(a.voiceover_notes || '(empty)')}</pre>
          </div>
          <div class="diff-pane">
            <h4>Version B</h4>
            <pre class="diff-text">${escapeHtml(b.voiceover_notes || '(empty)')}</pre>
          </div>
        </div>
        <div class="diff-view hidden" id="diff-thumbnails">
          <div class="diff-pane">
            <h4>Version A</h4>
            <pre class="diff-text">${escapeHtml(a.thumbnail_ideas || '(empty)')}</pre>
          </div>
          <div class="diff-pane">
            <h4>Version B</h4>
            <pre class="diff-text">${escapeHtml(b.thumbnail_ideas || '(empty)')}</pre>
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  setTimeout(() => overlay.classList.add('active'), 10);
}

function switchDiffTab(tab) {
  $$('.diff-tab').forEach(t => t.classList.toggle('active', t.textContent.toLowerCase() === tab));
  $$('.diff-view').forEach(v => v.classList.toggle('hidden', !v.id.includes(tab)));
}

function closeDiffModal() {
  const overlay = $('#diff-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 300);
  }
}

async function createSnapshot() {
  if (!currentVideo) return;
  const label = prompt('Version label (optional):') || 'Manual snapshot';
  await fetch(`/api/videos/${currentVideo.id}/snapshots`, { 
    method: 'POST', 
    headers: {'Content-Type':'application/json'}, 
    body: JSON.stringify({ label }) 
  });
  await loadSnapshots();
}

async function restoreSnapshot(id) {
  if (!currentVideo) return;
  if (!confirm('Restore this version? Current work will be auto-saved first.')) return;
  
  await fetch(`/api/videos/${currentVideo.id}/snapshots/${id}/restore`, { method: 'POST' });
  await openVideo(currentVideo.id); // Reload everything
  
  // Close snapshot panel after restore
  $('#snapshot-panel').classList.add('hidden');
}

async function deleteSnapshot(id) {
  if (!currentVideo) return;
  if (!confirm('Delete this snapshot?')) return;
  
  await fetch(`/api/videos/${currentVideo.id}/snapshots/${id}`, { method: 'DELETE' });
  await loadSnapshots();
}

// --- Export Functions ---
function toggleExportMenu() {
  const menu = $('#export-menu');
  if (!menu) return;
  menu.classList.toggle('hidden');
  
  // Close menu when clicking outside
  if (!menu.classList.contains('hidden')) {
    setTimeout(() => {
      document.addEventListener('click', closeExportMenuOutside, { once: true });
    }, 100);
  }
}

function closeExportMenuOutside(e) {
  const menu = $('#export-menu');
  const dropdown = e.target.closest('.export-dropdown');
  if (!dropdown && menu && !menu.classList.contains('hidden')) {
    menu.classList.add('hidden');
  }
}

function exportVideo(format) {
  if (!currentVideo) return;
  window.open(`/api/videos/${currentVideo.id}/export/${format}`, '_blank');
  toggleExportMenu();
}

async function copyDescription() {
  if (!currentVideo) return;
  const editor = editors['description-editor'];
  const text = editor ? editor.getValue() : '';
  
  try {
    await navigator.clipboard.writeText(text);
    showToast('Description copied to clipboard!');
  } catch (err) {
    showToast('Failed to copy to clipboard');
  }
  
  toggleExportMenu();
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { 
    toast.classList.remove('show'); 
    setTimeout(() => toast.remove(), 300); 
  }, 2000);
}

// === Clear Chat ===
async function clearChat() {
  if (!currentVideo) return;
  
  if (!confirm('Clear chat history for this video? This will delete all messages in the current channel.')) {
    return;
  }
  
  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/channels/${currentChatChannel}/messages`, {
      method: 'DELETE'
    });
    
    if (!res.ok) throw new Error('Failed to clear chat');
    
    // Clear the chat display
    const container = $('#chat-messages');
    const channelNames = { script: 'script', description: 'description', thumbnail: 'thumbnails' };
    const welcomeText = currentChatChannel === 'script' 
      ? `Ready to work on "${escapeHtml(currentVideo.title)}"` 
      : currentChatChannel === 'description' 
      ? 'Let\'s craft the perfect description' 
      : 'Let\'s design some thumbnails';
    
    container.innerHTML = `
      <div class="chat-welcome">
        <p>🌺 <strong>Kona here!</strong> ${welcomeText}. What are you thinking?</p>
      </div>
    `;
    
    showToast('Chat history cleared');
  } catch (err) {
    showToast('Failed to clear chat');
    console.error(err);
  }
}

// === Script Preview Toggle ===
let scriptPreviewMode = false;

function toggleScriptPreview() {
  const editor = editors['script-editor'];
  const preview = document.getElementById('script-preview');
  const btn = document.getElementById('preview-toggle-btn');
  const editorWrap = document.getElementById('script-editor');
  
  if (!editor || !preview || !btn || !editorWrap) return;
  
  scriptPreviewMode = !scriptPreviewMode;
  
  if (scriptPreviewMode) {
    // Switch to preview mode
    const markdown = editor.getValue();
    const html = processMessageContent(markdown, false);
    preview.innerHTML = html;
    preview.classList.remove('hidden');
    editorWrap.classList.add('hidden');
    btn.textContent = '✏️ Edit';
  } else {
    // Switch to edit mode
    preview.classList.add('hidden');
    editorWrap.classList.remove('hidden');
    btn.textContent = '👁️ Preview';
  }
}

// === SEO Assistant ===
function analyzeSEO() {
  if (!currentVideo) return;
  const title = document.getElementById('video-title')?.value || '';
  const description = editors['description-editor']?.getValue() || '';
  const script = editors['script-editor']?.getValue() || '';
  
  const checks = [];
  let score = 0;
  const maxScore = 100;
  
  // Title checks
  if (title.length > 0) { checks.push({ pass: true, msg: 'Has title', points: 5 }); score += 5; }
  else { checks.push({ pass: false, msg: 'Missing title', points: 0 }); }
  
  if (title.length >= 30 && title.length <= 60) { checks.push({ pass: true, msg: `Title length good (${title.length} chars)`, points: 10 }); score += 10; }
  else if (title.length > 0) { checks.push({ pass: false, msg: `Title ${title.length < 30 ? 'too short' : 'too long'} (${title.length} chars, aim for 30-60)`, points: 0 }); }
  
  if (title.match(/[!?|\-:]/)) { checks.push({ pass: true, msg: 'Title has engaging punctuation', points: 5 }); score += 5; }
  else if (title.length > 0) { checks.push({ pass: false, msg: 'Add punctuation (?, !, |, :) for engagement', points: 0 }); }
  
  // Description checks
  if (description.length > 100) { checks.push({ pass: true, msg: `Description length good (${description.length} chars)`, points: 15 }); score += 15; }
  else if (description.length > 0) { checks.push({ pass: false, msg: `Description too short (${description.length}/100+ chars)`, points: 5 }); score += 5; }
  else { checks.push({ pass: false, msg: 'No description', points: 0 }); }
  
  if (description.match(/https?:\/\//)) { checks.push({ pass: true, msg: 'Has links in description', points: 10 }); score += 10; }
  else { checks.push({ pass: false, msg: 'Add links (social, website)', points: 0 }); }
  
  if (description.includes('#')) { checks.push({ pass: true, msg: 'Has hashtags', points: 10 }); score += 10; }
  else { checks.push({ pass: false, msg: 'Add 3-5 hashtags at the end', points: 0 }); }
  
  const hasTimestamps = description.match(/\d{1,2}:\d{2}/g);
  if (hasTimestamps && hasTimestamps.length >= 3) { checks.push({ pass: true, msg: `Has timestamps (${hasTimestamps.length})`, points: 15 }); score += 15; }
  else { checks.push({ pass: false, msg: 'Add timestamps (improves SEO + chapters)', points: 0 }); }
  
  if (description.length >= 500) { checks.push({ pass: true, msg: 'Rich description (500+ chars)', points: 10 }); score += 10; }
  
  // First 150 chars matter most (shown in search)
  const first150 = description.substring(0, 150);
  if (first150.length >= 100) { checks.push({ pass: true, msg: 'Strong opening paragraph (visible in search)', points: 10 }); score += 10; }
  else { checks.push({ pass: false, msg: 'First 150 chars appear in search — make them count', points: 0 }); }
  
  // Script-based checks
  if (script.length > 500) { checks.push({ pass: true, msg: 'Has substantial script', points: 10 }); score += 10; }
  
  // Render
  const scoreEl = document.getElementById('score-circle');
  const checksEl = document.getElementById('seo-checks');
  const descAnalysis = document.getElementById('desc-analysis');
  
  if (scoreEl) {
    scoreEl.textContent = score;
    scoreEl.style.borderColor = score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';
  }
  
  if (checksEl) {
    checksEl.innerHTML = checks.map(c => `
      <div class="seo-check ${c.pass ? 'pass' : 'fail'}">
        <span>${c.pass ? '✅' : '❌'}</span>
        <span>${escapeHtml(c.msg)}</span>
      </div>
    `).join('');
  }
  
  if (descAnalysis) {
    descAnalysis.innerHTML = `
      <div class="desc-stat">Characters: ${description.length} / 5000</div>
      <div class="desc-stat">Words: ${description.trim() ? description.trim().split(/\s+/).length : 0}</div>
      <div class="desc-stat">Links: ${(description.match(/https?:\/\//g) || []).length}</div>
      <div class="desc-stat">Hashtags: ${(description.match(/#\w+/g) || []).length}</div>
    `;
  }
}

async function generateTitleVariants() {
  const container = document.getElementById('title-variants');
  if (!container) return;
  container.innerHTML = '<span class="loading">✨ Generating...</span>';
  
  const title = document.getElementById('video-title')?.value || '';
  const description = editors['description-editor']?.getValue() || '';
  
  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/channels/description/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Generate 5 alternative YouTube title variants for this video. Current title: "${title}". Context: ${description.substring(0, 300)}. Just list the titles, numbered 1-5. Make them engaging and SEO-friendly (30-60 chars each).` })
    });
    
    // Read the SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { const d = JSON.parse(line.slice(6)); if (d.type === 'text') text += d.content; } catch(e) {}
      }
    }
    
    container.innerHTML = text.split('\n').filter(l => l.trim() && l.match(/^\d+\./)).map(l => 
      `<div class="title-variant" onclick="applyTitle(this.textContent)">${escapeHtml(l.replace(/^\d+\.\s*/, ''))}</div>`
    ).join('');
  } catch(err) {
    container.innerHTML = '<span class="error">Failed to generate</span>';
  }
}

function applyTitle(title) {
  document.getElementById('video-title').value = title.trim();
  saveVideo();
  showToast('Title updated!');
}

async function generateTags() {
  const container = document.getElementById('tag-suggestions');
  if (!container) return;
  container.innerHTML = '<span class="loading">🏷️ Generating...</span>';
  
  const title = document.getElementById('video-title')?.value || '';
  const description = editors['description-editor']?.getValue() || '';
  const script = editors['script-editor']?.getValue() || '';
  
  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/channels/description/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Suggest 10-15 relevant YouTube tags for this video. Title: "${title}". Content: ${script.substring(0, 500)}. Return ONLY the tags as a comma-separated list.` })
    });
    
    // Read the SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { const d = JSON.parse(line.slice(6)); if (d.type === 'text') text += d.content; } catch(e) {}
      }
    }
    
    const tags = text.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(t => t);
    container.innerHTML = tags.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
  } catch(err) {
    container.innerHTML = '<span class="error">Failed to generate</span>';
  }
}

// === Timeline / Activity Log ===
async function loadTimeline() {
  if (!currentVideo) return;
  const res = await fetch(`/api/videos/${currentVideo.id}/activity?limit=100`);
  const activities = await res.json();
  const panel = document.getElementById('timeline-panel');
  
  if (activities.length === 0) { 
    panel.innerHTML = '<p class="empty-timeline">No activity yet</p>'; 
    return; 
  }
  
  // Group by date
  const grouped = {};
  activities.forEach(a => {
    const date = new Date(a.created_at).toLocaleDateString();
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(a);
  });
  
  const icons = {
    'edit': '✏️', 
    'message': '💬', 
    'snapshot': '💾', 
    'restore': '↩️',
    'thumbnail_upload': '🖼️', 
    'export': '📤', 
    'template': '📋'
  };
  
  panel.innerHTML = Object.entries(grouped).map(([date, items]) => `
    <div class="timeline-date">
      <h4>${date}</h4>
      ${items.map(a => {
        const time = new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const icon = icons[a.action_type] || '🔵';
        return `<div class="timeline-item">
          <span class="timeline-time">${time}</span>
          <span class="timeline-icon">${icon}</span>
          <span class="timeline-actor ${a.actor.toLowerCase()}">${a.actor}</span>
          <span class="timeline-detail">${escapeHtml(a.details || a.action_type)}</span>
        </div>`;
      }).join('')}
    </div>
  `).join('');
}

// === Reference Board ===
async function loadReferences() {
  if (!currentVideo) return;
  const res = await fetch(`/api/videos/${currentVideo.id}/references`);
  const items = await res.json();
  const grid = document.getElementById('ref-grid');
  
  if (items.length === 0) { 
    grid.innerHTML = '<p class="empty-refs">No references yet. Add images, links, or notes for inspiration.</p>'; 
    return; 
  }
  
  grid.innerHTML = items.map(item => {
    if (item.item_type === 'image') {
      const src = item.filename ? `/uploads/${currentVideo.id}/${item.filename}` : item.url;
      return `<div class="ref-card">
        <img src="${src}" alt="${escapeHtml(item.title)}" onclick="openImagePreview('${src}')">
        ${item.title ? `<div class="ref-title">${escapeHtml(item.title)}</div>` : ''}
        ${item.notes ? `<div class="ref-notes">${escapeHtml(item.notes)}</div>` : ''}
        <button class="ref-delete" onclick="deleteRef(${item.id})">✕</button>
      </div>`;
    } else if (item.item_type === 'link') {
      return `<div class="ref-card ref-link">
        <a href="${escapeHtml(item.url)}" target="_blank">🔗 ${escapeHtml(item.title || item.url)}</a>
        ${item.notes ? `<div class="ref-notes">${escapeHtml(item.notes)}</div>` : ''}
        <button class="ref-delete" onclick="deleteRef(${item.id})">✕</button>
      </div>`;
    } else {
      return `<div class="ref-card ref-note">
        ${item.title ? `<div class="ref-title">${escapeHtml(item.title)}</div>` : ''}
        <div class="ref-notes">${escapeHtml(item.notes || '')}</div>
        <button class="ref-delete" onclick="deleteRef(${item.id})">✕</button>
      </div>`;
    }
  }).join('');
}

async function addRefImage() {
  document.getElementById('ref-file-input').click();
}

async function addRefLink() {
  const url = prompt('URL:');
  if (!url) return;
  const title = prompt('Title (optional):') || '';
  const notes = prompt('Notes (optional):') || '';
  await fetch(`/api/videos/${currentVideo.id}/references`, { 
    method: 'POST', 
    headers: {'Content-Type':'application/json'}, 
    body: JSON.stringify({ item_type: 'link', url, title, notes }) 
  });
  await loadReferences();
}

async function addRefNote() {
  const title = prompt('Note title:') || '';
  const notes = prompt('Note content:');
  if (!notes) return;
  await fetch(`/api/videos/${currentVideo.id}/references`, { 
    method: 'POST', 
    headers: {'Content-Type':'application/json'}, 
    body: JSON.stringify({ item_type: 'note', title, notes }) 
  });
  await loadReferences();
}

async function deleteRef(id) {
  if (!confirm('Remove this reference?')) return;
  await fetch(`/api/videos/${currentVideo.id}/references/${id}`, { method: 'DELETE' });
  await loadReferences();
}
