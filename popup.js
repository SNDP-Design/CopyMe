/**
 * CopyMe - Chrome Extension Popup Logic
 * Handles saving, copying, auto-filling into active form fields, filtering, and storage sync.
 */

// State
let clips = [];
let toastTimeout = null;

// DOM Elements
const clipInput = document.getElementById('clipInput');
const addBtn = document.getElementById('addBtn');
const saveTabBtn = document.getElementById('saveTabBtn');
const clipsList = document.getElementById('clipsList');
const emptyState = document.getElementById('emptyState');
const itemCount = document.getElementById('itemCount');
const clearAllBtn = document.getElementById('clearAllBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFileInput = document.getElementById('importFileInput');
const toast = document.getElementById('toast');
const toastMsg = document.getElementById('toastMsg');
const toastIcon = document.getElementById('toastIcon');

// Storage abstraction (Sync with local fallback)
const storage = {
  get: (key) => {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.sync.get([key], (syncRes) => {
          if (chrome.runtime.lastError || !syncRes || !syncRes[key]) {
            chrome.storage.local.get([key], (localRes) => {
              resolve(localRes ? localRes[key] || [] : []);
            });
          } else {
            resolve(syncRes[key] || []);
          }
        });
      } else {
        const data = localStorage.getItem(key);
        resolve(data ? JSON.parse(data) : []);
      }
    });
  },
  set: (key, value) => {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.sync.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            chrome.storage.local.set({ [key]: value }, () => resolve());
          } else {
            chrome.storage.local.set({ [key]: value }, () => resolve());
          }
        });
      } else {
        localStorage.setItem(key, JSON.stringify(value));
        resolve();
      }
    });
  }
};

// URL Detection Helper
function isUrl(string) {
  if (!string || typeof string !== 'string') return false;
  const trimmed = string.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      new URL(trimmed);
      return true;
    } catch (_) {
      return false;
    }
  }
  const urlPattern = /^(www\.)?[a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&//=]*)$/i;
  return urlPattern.test(trimmed);
}

// Keep imported backups compatible with older versions and reject malformed data.
function normalizeImportedClip(item, index) {
  if (!item || typeof item !== 'object' || typeof item.content !== 'string') {
    return null;
  }

  const content = item.content.trim();
  if (!content) return null;

  const type = item.type === 'link' || item.type === 'text'
    ? item.type
    : (isUrl(content) ? 'link' : 'text');

  return {
    id: typeof item.id === 'string' && item.id.trim()
      ? item.id
      : `imported_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    content,
    title: typeof item.title === 'string' ? item.title.trim() : '',
    type,
    pinned: item.pinned === true,
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
  };
}

// Format URL for opening
function formatUrl(url) {
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'https://' + trimmed;
  }
  return trimmed;
}

// Date formatter
function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMinutes = Math.floor((now - date) / 60000);

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Toast notification
function showToast(message, icon = '✓') {
  if (toastTimeout) clearTimeout(toastTimeout);
  
  toastMsg.textContent = message;
  toastIcon.textContent = icon;
  toast.classList.add('show');
  
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

// Direct Clipboard Copy only (does NOT modify the webpage)
async function copyToClipboard(text, btnElement = null) {
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      copied = true;
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      copied = document.execCommand('copy');
      document.body.removeChild(textArea);
    }
  } catch (err) {
    console.error('Clipboard copy failed:', err);
  }

  if (copied) {
    showToast('Copied to clipboard!', '✓');
    if (btnElement) {
      const originalHtml = btnElement.innerHTML;
      btnElement.classList.add('copied');
      btnElement.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Copied!</span>
      `;
      setTimeout(() => {
        btnElement.classList.remove('copied');
        btnElement.innerHTML = originalHtml;
      }, 1500);
    }
  } else {
    showToast('Failed to copy', '✕');
  }
}

let isAutofilling = false;

// Auto-fill active webpage form field + Copy to clipboard
async function autofillAndCopy(text, btnElement = null) {
  if (isAutofilling) return;
  isAutofilling = true;

  try {
    // 1. Copy first so clipboard-based apps such as Google Sheets can paste it.
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }

    // 2. Find the active page and fill the remembered field or selected cell.
    let autofilled = false;
    let noEditableField = false;

    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      try {
        let tab = null;
        const tabQueries = [
          { active: true, lastFocusedWindow: true },
          { active: true, currentWindow: true }
        ];

        for (const query of tabQueries) {
          try {
            const tabs = await chrome.tabs.query(query);
            if (tabs && tabs.length > 0) {
              tab = tabs[0];
              break;
            }
          } catch (_) {}
        }

        const isRestrictedPage = tab && tab.url && (
          tab.url.startsWith('chrome://') ||
          tab.url.startsWith('edge://') ||
          tab.url.startsWith('chrome-extension://')
        );

        if (tab && tab.id !== undefined && !isRestrictedPage) {
          const runAutofill = async (tabId) => {
            let frameResults = await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: () => {
                if (typeof globalThis.__copymeGetFocus !== 'function') {
                  return { ready: false, hasTarget: false, focusedAt: 0 };
                }
                return globalThis.__copymeGetFocus();
              }
            });

            const readyFrames = frameResults.filter(frame => frame.result && frame.result.ready === true);
            if (readyFrames.length === 0) return { filled: false, missing: true };

            const targetFrame = readyFrames
              .filter(frame => frame.result.hasTarget === true)
              .sort((a, b) => b.result.focusedAt - a.result.focusedAt)[0];

            if (!targetFrame) return { filled: false, missing: false };

            frameResults = await chrome.scripting.executeScript({
              target: { tabId, frameIds: [targetFrame.frameId] },
              func: (value) => globalThis.__copymeAutofill(value),
              args: [text]
            });

            return { filled: frameResults.some(frame => frame.result && frame.result.filled === true), missing: false };
          };

          let result = await runAutofill(tab.id);
          if (result.missing) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: ['content.js']
              });
              result = await runAutofill(tab.id);
            } catch (injectErr) {
              console.warn('Could not inject content.js:', injectErr);
            }
          }

          autofilled = result.filled;
          noEditableField = !autofilled && !result.missing;
        }
      } catch (err) {
        console.warn('Tab autofill error:', err);
      }
    }

    // Animate button feedback
    if (btnElement) {
      const originalHtml = btnElement.innerHTML;
      btnElement.classList.add('copied');
      btnElement.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Done!</span>
      `;
      setTimeout(() => {
        btnElement.classList.remove('copied');
        btnElement.innerHTML = originalHtml;
      }, 1500);
    }

    // Toast feedback
    if (autofilled) {
      showToast('Filled into the page & copied!', '⚡');
    } else if (noEditableField && copied) {
      showToast('Copied — click inside a field first', 'i');
    } else if (copied) {
      showToast('Copied to clipboard!', '✓');
    } else {
      showToast('Failed to copy', '✕');
    }
  } finally {
    setTimeout(() => {
      isAutofilling = false;
    }, 400);
  }
}


// Save a new clip
async function saveClip(content, title = '') {
  const trimmed = content.trim();
  if (!trimmed) {
    clipInput.focus();
    return;
  }

  const type = isUrl(trimmed) ? 'link' : 'text';
  const newClip = {
    id: 'clip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    content: trimmed,
    title: title.trim() || (type === 'link' ? trimmed : ''),
    type: type,
    pinned: false,
    createdAt: Date.now()
  };

  clips.unshift(newClip);
  await storage.set('clips', clips);
  
  clipInput.value = '';
  render();
  showToast(type === 'link' ? 'Link saved!' : 'Clip saved!');
}

// Save active browser tab
async function saveCurrentTab() {
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        await saveClip(tab.url, tab.title || '');
      } else {
        showToast('Unable to get tab URL', '✕');
      }
    } catch (e) {
      console.error('Tab query error:', e);
      showToast('Error capturing tab', '✕');
    }
  } else {
    await saveClip('https://developer.chrome.com/docs/extensions/', 'Chrome Extensions Documentation');
  }
}

// Delete a clip
async function deleteClip(id) {
  clips = clips.filter(c => c.id !== id);
  await storage.set('clips', clips);
  render();
  showToast('Clip deleted', '🗑️');
}

// Toggle pin status
async function togglePin(id) {
  const clip = clips.find(c => c.id === id);
  if (clip) {
    clip.pinned = !clip.pinned;
    await storage.set('clips', clips);
    render();
  }
}

// Clear all clips
async function clearAllClips() {
  if (clips.length === 0) return;
  
  if (confirm('Are you sure you want to clear all saved clips? This action cannot be undone.')) {
    clips = [];
    await storage.set('clips', clips);
    render();
    showToast('All clips cleared');
  }
}

// Export clips to JSON
function exportClips() {
  if (clips.length === 0) {
    showToast('No clips to export', '✕');
    return;
  }
  
  const blob = new Blob([JSON.stringify(clips, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `copyme-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Clips exported!');
}

// Import clips from JSON
function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (Array.isArray(imported)) {
        const existingIds = new Set(clips.map(c => c.id));
        const newItems = [];
        imported.forEach((rawItem, index) => {
          const item = normalizeImportedClip(rawItem, index);
          if (item && !existingIds.has(item.id)) {
            existingIds.add(item.id);
            newItems.push(item);
          }
        });
        
        clips = [...newItems, ...clips];
        await storage.set('clips', clips);
        render();
        showToast(`Imported ${newItems.length} clips!`);
      } else {
        showToast('Invalid JSON file', '✕');
      }
    } catch (err) {
      console.error('Import error:', err);
      showToast('Error parsing JSON file', '✕');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// Render clips list
function render() {
  itemCount.textContent = `${clips.length} ${clips.length === 1 ? 'item' : 'items'}`;

  // Sort: Pinned first, then by createdAt descending
  const sortedClips = [...clips].sort((a, b) => {
    if (a.pinned === b.pinned) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    }
    return a.pinned ? -1 : 1;
  });

  // Handle empty state
  if (sortedClips.length === 0) {
    emptyState.style.display = 'flex';
    clipsList.innerHTML = '';
    return;
  }

  emptyState.style.display = 'none';

  // Build card elements
  clipsList.innerHTML = '';
  
  sortedClips.forEach(clip => {
    const card = document.createElement('div');
    card.className = `clip-card ${clip.pinned ? 'pinned' : ''}`;
    card.title = "Click to auto-fill into active form field & copy";
    
    // Header
    const header = document.createElement('div');
    header.className = 'clip-card-header';
    
    const headerLeft = document.createElement('div');
    headerLeft.className = 'card-header-left';
    
    const badge = document.createElement('span');
    badge.className = `badge ${clip.type === 'link' ? 'badge-link' : 'badge-text'}`;
    badge.textContent = clip.type === 'link' ? 'Link' : 'Text';
    
    const dateSpan = document.createElement('span');
    dateSpan.className = 'clip-date';
    dateSpan.textContent = formatDate(clip.createdAt);
    
    headerLeft.appendChild(badge);
    headerLeft.appendChild(dateSpan);
    
    const headerRight = document.createElement('div');
    headerRight.className = 'card-header-right';
    
    // Pin Button
    const pinBtn = document.createElement('button');
    pinBtn.className = `icon-btn ${clip.pinned ? 'pin-active' : ''}`;
    pinBtn.title = clip.pinned ? 'Unpin' : 'Pin to top';
    pinBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="${clip.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="17" x2="12" y2="22"></line>
        <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
      </svg>
    `;
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(clip.id);
    });
    
    // Delete Button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn delete-btn';
    deleteBtn.title = 'Delete clip';
    deleteBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteClip(clip.id);
    });
    
    headerRight.appendChild(pinBtn);
    headerRight.appendChild(deleteBtn);
    
    header.appendChild(headerLeft);
    header.appendChild(headerRight);
    
    // Content Body
    const contentBody = document.createElement('div');
    contentBody.className = 'clip-content';
    
    if (clip.type === 'link') {
      const link = document.createElement('a');
      link.href = formatUrl(clip.content);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'clip-link';
      link.title = 'Open link in new tab';
      link.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      `;
      const linkLabel = document.createElement('span');
      linkLabel.textContent = clip.title && clip.title !== clip.content ? clip.title : clip.content;
      link.appendChild(linkLabel);
      contentBody.appendChild(link);
    } else {
      contentBody.textContent = clip.content;
    }
    
    // Card Footer with Actions
    const cardFooter = document.createElement('div');
    cardFooter.className = 'clip-card-footer';
    
    // Fill & Copy Button
    const fillBtn = document.createElement('button');
    fillBtn.className = 'btn-card-action btn-fill-primary';
    fillBtn.title = 'Auto-fill into active form field & copy';
    fillBtn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
      <span>Auto-fill</span>
    `;
    fillBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      autofillAndCopy(clip.content, fillBtn);
    });

    // Copy Only Button (copies to clipboard only, does not fill into webpage)
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-card-action';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span>Copy</span>
    `;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(clip.content, copyBtn);
    });
    
    cardFooter.appendChild(fillBtn);
    cardFooter.appendChild(copyBtn);
    
    // Clicking the entire card triggers auto-fill & copy
    card.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('button')) return;
      autofillAndCopy(clip.content, fillBtn);
    });

    card.appendChild(header);
    card.appendChild(contentBody);
    card.appendChild(cardFooter);
    
    clipsList.appendChild(card);
  });
}

// Event Listeners
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved clips
  clips = await storage.get('clips');
  render();

  // Focus input automatically
  clipInput.focus();

  // Add Button Click
  addBtn.addEventListener('click', () => {
    saveClip(clipInput.value);
  });

  // Enter to save, Shift+Enter for newline
  clipInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveClip(clipInput.value);
    }
  });

  // Save Current Tab Button Click
  saveTabBtn.addEventListener('click', saveCurrentTab);

  // Clear all button
  clearAllBtn.addEventListener('click', clearAllClips);

  // Export button
  exportBtn.addEventListener('click', exportClips);

  // Import button & file picker
  importBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', handleImportFile);
});
