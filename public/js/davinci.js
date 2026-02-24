/**
 * Editor Tips & Chat functionality
 */

function getEditorState() {
  const id = typeof window.getActiveEditorId === 'function' ? window.getActiveEditorId() : 'davinci-resolve';
  const name = typeof window.getActiveEditorName === 'function' ? window.getActiveEditorName() : 'DaVinci Resolve';
  const shortName = typeof window.getActiveEditorShortName === 'function' ? window.getActiveEditorShortName() : 'DaVinci';
  const tipsTitle = typeof window.getActiveEditorTipsTitle === 'function'
    ? window.getActiveEditorTipsTitle()
    : `${name} Tips & Tricks`;
  const chatTitle = typeof window.getActiveEditorChatTitle === 'function'
    ? window.getActiveEditorChatTitle()
    : `${shortName} Chat`;
  return { id, name, shortName, tipsTitle, chatTitle };
}

// ============ Section Switching ============

function switchSection(section) {
  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.section === section);
  });

  // Use shared view switcher if available (hides workspace view too)
  if (typeof showView === 'function') {
    if (section === 'projects') {
      showView('library');
    } else {
      showView(section);
    }
  } else {
    document.querySelectorAll('.section-view').forEach(view => {
      view.classList.toggle('active', view.dataset.section === section);
    });
  }
  
  // Load data for the section
  if (section === 'tips') {
    loadTips();
  } else if (section === 'davinci-chat') {
    loadDavinciChat();
  } else if (section === 'findings') {
    if (typeof loadFindings === 'function') loadFindings();
  } else if (section === 'settings') {
    if (typeof loadSettingsPage === 'function') loadSettingsPage();
  }
}

// ============ Tips & Tricks ============

let tipsData = [];
let currentEditingTip = null;

async function loadTips(searchQuery = '') {
  try {
    const editor = getEditorState();
    const base = `/api/davinci/tips?editorId=${encodeURIComponent(editor.id)}`;
    const url = searchQuery
      ? `${base}&search=${encodeURIComponent(searchQuery)}`
      : base;
    const res = await fetch(url);
    tipsData = await res.json();
    renderTips();
  } catch (err) {
    console.error('Failed to load tips:', err);
  }
}

function renderTips() {
  const container = document.getElementById('tips-content');
  if (!tipsData || tipsData.length === 0) {
    const editor = getEditorState();
    container.innerHTML = `
      <div class="tips-empty">
        <h3>No tips yet</h3>
        <p>Add your first ${editor.name} tip to get started</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = tipsData.map(section => `
    <div class="tip-section" data-id="${section.id}">
      <div class="tip-section-header" onclick="toggleTipSection(${section.id})">
        <div class="tip-section-title">
          <span class="section-toggle">▶</span>
          ${escapeHtml(section.title)}
        </div>
        <div class="tip-section-actions" onclick="event.stopPropagation()">
          <button class="icon-btn" onclick="editTip(${section.id})" title="Edit">✏️</button>
          <button class="icon-btn" onclick="addSubsection(${section.id})" title="Add subsection">➕</button>
          <button class="icon-btn" onclick="deleteTip(${section.id})" title="Delete">🗑️</button>
        </div>
      </div>
      <div class="tip-section-body">
        ${section.content ? `<div class="tip-content" id="tip-content-${section.id}">${formatTipContent(section.content)}</div>` : ''}
        ${section.subsections && section.subsections.length > 0 ? `
          <div class="tip-subsections">
            ${section.subsections.map(sub => renderSubsection(sub, 1)).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function renderSubsection(sub, depth) {
  const depthClass = depth === 1 ? 'tip-subsection' : 'tip-subsubsection';
  const hasChildren = sub.subsections && sub.subsections.length > 0;
  return `
    <div class="${depthClass}" data-id="${sub.id}">
      <div class="${depthClass}-title" onclick="${hasChildren ? `toggleTipSection(${sub.id})` : `editTip(${sub.id})`}">
        ${hasChildren ? '<span class="section-toggle sub-toggle">▶</span>' : ''}
        ${escapeHtml(sub.title)}
        <span class="icon-btn" onclick="event.stopPropagation(); deleteTip(${sub.id})" title="Delete">🗑️</span>
        ${depth === 1 ? `<span class="icon-btn" onclick="event.stopPropagation(); addSubsection(${sub.id})" title="Add sub-tip">➕</span>` : ''}
      </div>
      ${sub.content ? `<div class="tip-content" id="tip-content-${sub.id}">${formatTipContent(sub.content)}</div>` : ''}
      ${hasChildren ? `
        <div class="tip-subsections tip-subsections-deep">
          ${sub.subsections.map(child => renderSubsection(child, depth + 1)).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function formatTipContent(content) {
  if (!content) return '';
  
  // Handle [TABLE]...[/TABLE] blocks
  const parts = content.split(/\[TABLE\]|\[\/TABLE\]/);
  let inTable = false;
  let html = '';
  
  // content.split alternates: text, table, text, table...
  // First check if content starts with [TABLE]
  const startsWithTable = content.trimStart().startsWith('[TABLE]');
  
  parts.forEach((part, i) => {
    const isTable = startsWithTable ? (i % 2 === 1) : (i % 2 === 1);
    // Actually let's just track it properly
    part = part.trim();
    if (!part) return;
    
    // Check if this part looks like a table (lines with →)
    const lines = part.split('\n').filter(l => l.trim());
    const hasArrows = lines.filter(l => l.includes('→')).length > lines.length * 0.5;
    
    if (hasArrows && lines.length > 1) {
      // Render as table
      html += '<table class="tip-table"><tbody>';
      lines.forEach(line => {
        const [left, right] = line.split('→').map(s => s ? s.trim() : '');
        html += `<tr><td>${escapeHtml(left || '')}</td><td class="tip-shortcut">${escapeHtml(right || '')}</td></tr>`;
      });
      html += '</tbody></table>';
    } else {
      // Render as bullet points
      lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        // Detect URLs and make them clickable
        const escaped = escapeHtml(line);
        const withLinks = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
        html += `<div class="tip-bullet">• ${withLinks}</div>`;
      });
    }
  });
  
  return html || escapeHtml(content).replace(/\n/g, '<br>');
}

function toggleTipSection(sectionId) {
  const section = document.querySelector(`.tip-section[data-id="${sectionId}"]`);
  if (section) {
    section.classList.toggle('expanded');
  }
}

async function editTip(tipId) {
  const tip = findTipById(tipId);
  if (!tip) return;
  
  const contentEl = document.getElementById(`tip-content-${tipId}`);
  if (!contentEl) return;
  
  // Make editable
  contentEl.contentEditable = true;
  contentEl.classList.add('editable');
  contentEl.focus();
  
  // Add save/cancel buttons
  if (!contentEl.nextElementSibling || !contentEl.nextElementSibling.classList.contains('tip-edit-actions')) {
    const actions = document.createElement('div');
    actions.className = 'tip-edit-actions';
    actions.innerHTML = `
      <button class="btn btn-primary btn-sm" onclick="saveTipEdit(${tipId})">💾 Save</button>
      <button class="btn btn-ghost btn-sm" onclick="cancelTipEdit(${tipId})">Cancel</button>
    `;
    contentEl.parentNode.insertBefore(actions, contentEl.nextSibling);
  }
  
  currentEditingTip = { id: tipId, originalContent: tip.content };
}

async function saveTipEdit(tipId) {
  const contentEl = document.getElementById(`tip-content-${tipId}`);
  if (!contentEl) return;
  
  const newContent = contentEl.innerText.trim();
  
  try {
    const res = await fetch(`/api/davinci/tips/${tipId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent })
    });
    
    if (!res.ok) throw new Error('Failed to save');
    
    // Update local data
    const tip = findTipById(tipId);
    if (tip) tip.content = newContent;
    
    // Clean up
    contentEl.contentEditable = false;
    contentEl.classList.remove('editable');
    const actions = contentEl.nextElementSibling;
    if (actions && actions.classList.contains('tip-edit-actions')) {
      actions.remove();
    }
    
    // Re-render
    loadTips();
  } catch (err) {
    console.error('Save failed:', err);
    alert('Failed to save changes');
  }
}

function cancelTipEdit(tipId) {
  const contentEl = document.getElementById(`tip-content-${tipId}`);
  if (!contentEl) return;
  
  if (currentEditingTip && currentEditingTip.id === tipId) {
    contentEl.innerHTML = formatTipContent(currentEditingTip.originalContent);
  }
  
  contentEl.contentEditable = false;
  contentEl.classList.remove('editable');
  const actions = contentEl.nextElementSibling;
  if (actions && actions.classList.contains('tip-edit-actions')) {
    actions.remove();
  }
  
  currentEditingTip = null;
}

async function addNewSection() {
  const title = prompt('New section title:');
  if (!title) return;
  
  try {
    const editor = getEditorState();
    const res = await fetch('/api/davinci/tips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, level: 0, editorId: editor.id })
    });
    
    if (!res.ok) throw new Error('Failed to create');
    
    await loadTips();
  } catch (err) {
    console.error('Failed to create section:', err);
    alert('Failed to create section');
  }
}

async function addSubsection(parentId) {
  const title = prompt('New subsection title:');
  if (!title) return;
  
  try {
    const editor = getEditorState();
    const res = await fetch('/api/davinci/tips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: parentId, title, level: 1, editorId: editor.id })
    });
    
    if (!res.ok) throw new Error('Failed to create');
    
    await loadTips();
  } catch (err) {
    console.error('Failed to create subsection:', err);
    alert('Failed to create subsection');
  }
}

async function deleteTip(tipId) {
  if (!confirm('Delete this tip? This cannot be undone.')) return;
  
  try {
    const res = await fetch(`/api/davinci/tips/${tipId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete');
    await loadTips();
  } catch (err) {
    console.error('Delete failed:', err);
    alert('Failed to delete');
  }
}

function findTipById(id) {
  for (const section of tipsData) {
    if (section.id === id) return section;
    if (section.subsections) {
      for (const sub of section.subsections) {
        if (sub.id === id) return sub;
        if (sub.subsections) {
          const child = sub.subsections.find(s => s.id === id);
          if (child) return child;
        }
      }
    }
  }
  return null;
}

// Search handler
let searchTimeout;
document.getElementById('tips-search')?.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    loadTips(e.target.value);
  }, 300);
});

// ============ DaVinci Chat ============

let davinciChatMessages = [];

async function loadDavinciChat() {
  try {
    const editor = getEditorState();
    const res = await fetch(`/api/davinci/chat/messages?editorId=${encodeURIComponent(editor.id)}`);
    davinciChatMessages = await res.json();
    renderDavinciChat();
    updateDavinciTokenBar();
  } catch (err) {
    console.error('Failed to load chat:', err);
  }
}

async function updateDavinciTokenBar() {
  const fill = document.getElementById('davinci-token-fill');
  const text = document.getElementById('davinci-token-text');
  if (!fill || !text) return;

  try {
    const editor = getEditorState();
    const res = await fetch(`/api/davinci/chat/tokens?editorId=${encodeURIComponent(editor.id)}`);
    const data = await res.json();

    const percentage = data.percentage;
    fill.style.width = `${percentage}%`;

    let color;
    if (percentage < 70) color = '#4caf50';
    else if (percentage < 85) color = '#ffa726';
    else if (percentage < 93) color = '#ff9800';
    else color = '#e74c3c';
    fill.style.backgroundColor = color;

    const tokensK = Math.round(data.tokens / 1000);
    const maxK = Math.round(data.max / 1000);
    text.textContent = `${tokensK}K / ${maxK}K tokens`;
  } catch (err) {
    console.error('DaVinci token error:', err);
  }
}

async function compactDavinciChat() {
  const btn = document.getElementById('davinci-compact-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Compacting…'; }
  try {
    const editor = getEditorState();
    const res = await fetch('/api/davinci/chat/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepRecent: 20, editorId: editor.id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Compaction failed');
    if (typeof showToast === 'function') showToast(`Compacted ${data.prunedCount || 0} messages`);
    updateDavinciTokenBar();
    await loadDavinciChat();
  } catch (err) {
    console.error('DaVinci compact failed:', err);
    if (typeof showToast === 'function') showToast('Compaction failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧹 Compact'; }
  }
}

function renderDavinciChat() {
  const container = document.getElementById('davinci-chat-messages');
  if (!davinciChatMessages || davinciChatMessages.length === 0) {
    const editor = getEditorState();
    container.innerHTML = `
      <div class="chat-welcome">
        <p>🌺 <strong>Hey Nora!</strong> Ask me anything about ${editor.name}. I've got your ${editor.name} tips doc loaded, so I know what you already know.</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = davinciChatMessages.map(msg => {
    const time = new Date(msg.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const content = msg.role === 'assistant' ? parseAssistantMessage(msg.content) : escapeHtml(msg.content);
    
    return `
      <div class="davinci-message ${msg.role}">
        <div class="davinci-message-bubble">${content}</div>
        <div class="davinci-message-time">${time}</div>
      </div>
    `;
  }).join('');
  
  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function parseAssistantMessage(content) {
  // Extract ADD_TIP blocks BEFORE escaping HTML
  const addTipRegex = /<<<ADD_TIP section="([^"]+)"(?:\s+subsection="([^"]+)")?\s*>>>([\s\S]*?)<<<END_ADD_TIP>>>/g;
  const tipBlocks = [];
  let plainContent = content.replace(addTipRegex, (match, section, subsection, tipContent) => {
    const tipId = Math.random().toString(36).slice(2);
    tipBlocks.push({ tipId, section, subsection: subsection || '', tipContent: tipContent.trim() });
    return `__TIP_PLACEHOLDER_${tipId}__`;
  });
  
  // Now escape the remaining text
  let html = escapeHtml(plainContent);
  
  // Re-insert tip blocks as HTML
  tipBlocks.forEach(({ tipId, section, subsection, tipContent }) => {
    const escapedContent = escapeHtml(tipContent);
    const safeSection = section.replace(/'/g, "\\'");
    const safeSub = subsection.replace(/'/g, "\\'");
    const safeTipContent = tipContent.replace(/`/g, '\\`').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    
    const blockHtml = `
      <div class="add-tip-block" id="add-tip-${tipId}">
        <div class="add-tip-block-header">
          💡 Add to ${escapeHtml(section)}${subsection ? ` > ${escapeHtml(subsection)}` : ''}
        </div>
        <div class="add-tip-block-content">${escapedContent.replace(/\n/g, '<br>')}</div>
        <div class="add-tip-block-actions">
          <button class="btn btn-primary btn-sm" onclick="acceptAddTip('${tipId}', '${safeSection}', '${safeSub}', \`${safeTipContent}\`)">✓ Add to Doc</button>
          <button class="btn btn-ghost btn-sm" onclick="dismissAddTip('${tipId}')">Dismiss</button>
        </div>
      </div>
    `;
    html = html.replace(`__TIP_PLACEHOLDER_${tipId}__`, blockHtml);
  });
  
  // Bold section references
  html = html.replace(/\*\*\[([^\]]+)\]\*\*/g, '<strong style="color: var(--accent)">[$1]</strong>');
  
  // Preserve line breaks
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

async function acceptAddTip(tipId, sectionName, subsectionName, content) {
  try {
    // Find the section
    const section = tipsData.find(s => s.title.toLowerCase() === sectionName.toLowerCase());
    if (!section) {
      alert(`Section "${sectionName}" not found. Please add it manually.`);
      return;
    }
    
    let parentId = section.id;
    let level = 1;
    
    // If subsection specified, find or create it
    if (subsectionName) {
      let subsection = section.subsections?.find(sub => sub.title.toLowerCase() === subsectionName.toLowerCase());
      if (!subsection) {
        // Create subsection
        const editor = getEditorState();
        const res = await fetch('/api/davinci/tips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent_id: section.id, title: subsectionName, level: 1, editorId: editor.id })
        });
        if (!res.ok) throw new Error('Failed to create subsection');
        const newSub = await res.json();
        parentId = newSub.id;
        level = 1;
      } else {
        parentId = subsection.id;
        level = 1;
      }
    }
    
    // Add the tip to the existing section/subsection content
    const target = findTipById(parentId);
    if (target) {
      const newContent = target.content 
        ? `${target.content}\n${content.trim()}`
        : content.trim();
      
      const res = await fetch(`/api/davinci/tips/${parentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent })
      });
      
      if (!res.ok) throw new Error('Failed to add tip');
      
      // Remove the add-tip block
      const block = document.getElementById(`add-tip-${tipId}`);
      if (block) block.remove();
      
      // Reload tips if on that view
      if (document.querySelector('.section-view[data-section="tips"]')?.classList.contains('active')) {
        await loadTips();
      }
      
      alert('✅ Tip added to the doc!');
    }
  } catch (err) {
    console.error('Failed to add tip:', err);
    alert('Failed to add tip. Please try again.');
  }
}

function dismissAddTip(tipId) {
  const block = document.getElementById(`add-tip-${tipId}`);
  if (block) block.remove();
}

async function sendDavinciMessage() {
  const input = document.getElementById('davinci-input');
  const message = input.value.trim();
  if (!message) return;
  
  input.value = '';
  input.style.height = 'auto';
  
  // Add user message immediately
  davinciChatMessages.push({
    role: 'user',
    content: message,
    created_at: new Date().toISOString()
  });
  renderDavinciChat();
  
  // Disable send button
  const sendBtn = document.getElementById('davinci-send-btn');
  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  
  try {
    const editor = getEditorState();
    const res = await fetch('/api/davinci/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, editorId: editor.id })
    });
    
    if (!res.ok) throw new Error('Failed to send');
    
    // Stream response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantMessage = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'text') {
            assistantMessage += data.content;
            
            // Update the last message
            if (davinciChatMessages[davinciChatMessages.length - 1]?.role === 'assistant') {
              davinciChatMessages[davinciChatMessages.length - 1].content = assistantMessage;
            } else {
              davinciChatMessages.push({
                role: 'assistant',
                content: assistantMessage,
                created_at: new Date().toISOString()
              });
            }
            renderDavinciChat();
          } else if (data.type === 'error') {
            alert('Error: ' + data.content);
          }
        }
      }
    }
    
  } catch (err) {
    console.error('Send failed:', err);
    alert('Failed to send message');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    updateDavinciTokenBar();
  }
}

async function clearDavinciChat() {
  if (!confirm('Clear all chat history? This cannot be undone.')) return;
  
  try {
    const editor = getEditorState();
    const res = await fetch(`/api/davinci/chat/messages?editorId=${encodeURIComponent(editor.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to clear');
    davinciChatMessages = [];
    renderDavinciChat();
    updateDavinciTokenBar();
  } catch (err) {
    console.error('Failed to clear chat:', err);
    alert('Failed to clear chat');
  }
}

// Event listeners
document.getElementById('davinci-send-btn')?.addEventListener('click', sendDavinciMessage);
document.getElementById('davinci-compact-btn')?.addEventListener('click', compactDavinciChat);
document.getElementById('davinci-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendDavinciMessage();
  }
});

// Auto-resize textarea
document.getElementById('davinci-input')?.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = this.scrollHeight + 'px';
});

// Utility
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

console.log('✅ Editor Tips & Chat loaded');
