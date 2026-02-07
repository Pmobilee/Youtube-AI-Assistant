// === State ===
let currentVideo = null;
let autoSaveTimer = null;
let isStreaming = false;

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
}

function updateThemeButtons() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const icon = isDark ? '☀️' : '🌙';
  if ($('#theme-toggle')) $('#theme-toggle').textContent = icon;
  if ($('#theme-toggle-ws')) $('#theme-toggle-ws').textContent = icon;
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
  closeModal();
  const res = await fetch('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  const video = await res.json();
  openVideo(video.id);
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

  // Populate fields
  $('#video-title').value = currentVideo.title;
  $('#video-status').value = currentVideo.status;
  $('#script-editor').value = currentVideo.script_content || '';
  $('#description-editor').value = currentVideo.description || '';
  $('#voiceover-editor').value = currentVideo.voiceover_notes || '';
  $('#thumbnails-editor').value = currentVideo.thumbnail_ideas || '';

  // Load chat messages
  await loadMessages(id);

  // Load uploaded images
  loadUploads();

  // Switch view
  showView('workspace');

  // Set up auto-save
  setupAutoSave();
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

  container.innerHTML = messages.map(m => renderMessage(m.role, m.content)).join('');
  scrollChat();
}

function renderMessage(role, content) {
  const sender = role === 'user' ? 'Nora' : 'Kona 🌺';
  const processed = processMessageContent(content, role === 'assistant');
  return `
    <div class="chat-message ${role}">
      <span class="sender">${sender}</span>
      <div class="bubble">${processed}</div>
    </div>
  `;
}

function processMessageContent(content, isAssistant) {
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
    html = html.replace(/\[\[section:(.+?)\]\]/g, '<span class="section-ref" onclick="scrollToSection(\'$1\')">📌 $1</span>');
  }
  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<h[123]>)/g, '$1');
  html = html.replace(/(<\/h[123]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');

  return html;
}

function scrollChat() {
  const container = $('#chat-messages');
  container.scrollTop = container.scrollHeight;
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
      <div class="bubble"><span class="streaming-indicator"></span></div>
    </div>
  `);
  scrollChat();

  try {
    const res = await fetch(`/api/videos/${currentVideo.id}/chat`, {
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
}

// === Section Scrolling ===
function scrollToSection(sectionName) {
  // Find the section in the script editor
  const editors = {
    'script': '#script-editor',
    'description': '#description-editor',
    'voiceover': '#voiceover-editor',
    'thumbnails': '#thumbnails-editor'
  };

  const normalizedSearch = sectionName.toLowerCase().trim();

  for (const [tab, selector] of Object.entries(editors)) {
    const textarea = $(selector);
    const text = textarea.value;
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase().trim();
      // Match headers like "# Section Name" or just "Section Name"
      const cleaned = line.replace(/^#+\s*/, '');
      if (cleaned.includes(normalizedSearch) || normalizedSearch.includes(cleaned)) {
        // Switch to correct tab
        switchTab(tab);

        // Calculate position and scroll
        const beforeText = lines.slice(0, i).join('\n');
        textarea.focus();
        textarea.setSelectionRange(beforeText.length, beforeText.length + lines[i].length + 1);

        // Scroll to position
        const lineHeight = 26; // approximate
        textarea.scrollTop = Math.max(0, i * lineHeight - 100);

        // Highlight effect
        textarea.classList.add('highlight-section');
        setTimeout(() => textarea.classList.remove('highlight-section'), 2000);
        return;
      }
    }
  }
}

// === Editor Tabs ===
function switchTab(tabName) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.editor-area').forEach(a => a.classList.toggle('active', a.id === `editor-${tabName}`));
}

// === Auto-save ===
function setupAutoSave() {
  const fields = ['#script-editor', '#description-editor', '#voiceover-editor', '#thumbnails-editor', '#video-title', '#video-status'];

  fields.forEach(sel => {
    $(sel).addEventListener('input', debounce(saveVideo, 1000));
    $(sel).addEventListener('change', debounce(saveVideo, 500));
  });
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
        script_content: $('#script-editor').value,
        description: $('#description-editor').value,
        voiceover_notes: $('#voiceover-editor').value,
        thumbnail_ideas: $('#thumbnails-editor').value
      })
    });

    indicator.textContent = 'Saved ✓';
    indicator.classList.remove('saving');
    setTimeout(() => { indicator.textContent = 'Saved'; }, 2000);
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

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadVideos();
  initResize();

  // Navigation
  $('#back-btn').addEventListener('click', () => {
    saveVideo();
    currentVideo = null;
    showView('library');
    loadVideos();
  });

  // New video
  $('#new-video-btn').addEventListener('click', createNewVideo);

  // Theme toggle
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#theme-toggle-ws').addEventListener('click', toggleTheme);

  // Chat send
  $('#send-btn').addEventListener('click', sendMessage);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  $('#chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // File upload
  $('#upload-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await uploadFile(file);
      e.target.value = '';
    }
  });

  // Modal keyboard
  $('#new-video-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmNewVideo();
    if (e.key === 'Escape') closeModal();
  });

  // Close modals on overlay click
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  $('#delete-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });
});
