/**
 * CopyMe - On-page panel
 * Stays on the webpage so the cursor/field keeps focus while you pick a saved clip.
 */

(function () {
  if (window !== window.top) return;
  if (globalThis.__copymePanelLoaded) return;
  globalThis.__copymePanelLoaded = true;

  const HOST_ID = 'copyme-panel-host';
  let clips = [];
  let toastTimeout = null;
  let shadow = null;
  let host = null;

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
          resolve([]);
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
          resolve();
        }
      });
    }
  };

  function $(id) {
    return shadow ? shadow.getElementById(id) : null;
  }

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

  function formatUrl(url) {
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return 'https://' + trimmed;
    }
    return trimmed;
  }

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

  function showToast(message, icon = '✓') {
    const toast = $('toast');
    const toastMsg = $('toastMsg');
    const toastIcon = $('toastIcon');
    if (!toast || !toastMsg || !toastIcon) return;

    if (toastTimeout) clearTimeout(toastTimeout);
    toastMsg.textContent = message;
    toastIcon.textContent = icon;
    toast.classList.add('show');
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function fillNowSync(text) {
    if (typeof globalThis.__copymeAutofill === 'function') {
      const result = globalThis.__copymeAutofill(text);
      if (result && result.filled) return true;
    }
    return false;
  }

  function fillNowLater(text) {
    try {
      chrome.runtime.sendMessage({ action: 'autofillAllFrames', text }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  function autofillAndCopy(text, btnElement = null) {
    copyToClipboard(text);
    const filled = fillNowSync(text);
    if (!filled) fillNowLater(text);

    if (btnElement) {
      const originalHtml = btnElement.innerHTML;
      btnElement.classList.add('copied');
      btnElement.innerHTML = filled
        ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Done!</span>`
        : originalHtml;
      if (filled) {
        setTimeout(() => {
          btnElement.classList.remove('copied');
          btnElement.innerHTML = originalHtml;
        }, 1500);
      }
    }

    if (filled) {
      showToast('Pasted at your cursor!', '⚡');
    } else {
      showToast('Copied — click where you want to type, then try the card again', 'i');
    }
  }

  function bindFillAction(element, text, btnElement) {
    element.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest && (e.target.closest('a') || (e.target.closest('button') && e.target.closest('button') !== element))) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      autofillAndCopy(text, btnElement);
    });
    element.addEventListener('click', (e) => {
      if (e.target.closest && (e.target.closest('a') || (e.target.closest('button') && e.target.closest('button') !== element))) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
  }

  async function saveClip(content, title = '') {
    const trimmed = content.trim();
    const clipInput = $('clipInput');
    if (!trimmed) {
      if (clipInput) clipInput.focus();
      return;
    }

    const type = isUrl(trimmed) ? 'link' : 'text';
    const newClip = {
      id: 'clip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      content: trimmed,
      title: title.trim() || (type === 'link' ? trimmed : ''),
      type,
      pinned: false,
      createdAt: Date.now()
    };

    clips.unshift(newClip);
    await storage.set('clips', clips);
    if (clipInput) clipInput.value = '';
    render();
    showToast(type === 'link' ? 'Link saved!' : 'Clip saved!');
  }

  async function saveCurrentTab() {
    chrome.runtime.sendMessage({ action: 'getCurrentTab' }, async (tab) => {
      if (tab && tab.url) {
        await saveClip(tab.url, tab.title || '');
      } else {
        showToast('Unable to get tab URL', '✕');
      }
    });
  }

  async function deleteClip(id) {
    clips = clips.filter((c) => c.id !== id);
    await storage.set('clips', clips);
    render();
    showToast('Clip deleted', '🗑️');
  }

  async function togglePin(id) {
    const clip = clips.find((c) => c.id === id);
    if (clip) {
      clip.pinned = !clip.pinned;
      await storage.set('clips', clips);
      render();
    }
  }

  async function clearAllClips() {
    if (clips.length === 0) return;
    if (confirm('Are you sure you want to clear all saved clips? This action cannot be undone.')) {
      clips = [];
      await storage.set('clips', clips);
      render();
      showToast('All clips cleared');
    }
  }

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

  function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (!Array.isArray(imported)) {
          showToast('Invalid JSON file', '✕');
          return;
        }
        const existingIds = new Set(clips.map((c) => c.id));
        const newItems = [];
        imported.forEach((item, index) => {
          if (!item || typeof item.content !== 'string' || !item.content.trim()) return;
          const id = typeof item.id === 'string' && item.id.trim()
            ? item.id
            : `imported_${Date.now()}_${index}`;
          if (existingIds.has(id)) return;
          existingIds.add(id);
          newItems.push({
            id,
            content: item.content.trim(),
            title: typeof item.title === 'string' ? item.title.trim() : '',
            type: item.type === 'link' || item.type === 'text' ? item.type : (isUrl(item.content) ? 'link' : 'text'),
            pinned: item.pinned === true,
            createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
          });
        });
        clips = [...newItems, ...clips];
        await storage.set('clips', clips);
        render();
        showToast(`Imported ${newItems.length} clips!`);
      } catch (_) {
        showToast('Error parsing JSON file', '✕');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  function render() {
    const itemCount = $('itemCount');
    const emptyState = $('emptyState');
    const clipsList = $('clipsList');
    if (!itemCount || !emptyState || !clipsList) return;

    itemCount.textContent = `${clips.length} ${clips.length === 1 ? 'item' : 'items'}`;

    const sortedClips = [...clips].sort((a, b) => {
      if (a.pinned === b.pinned) return (b.createdAt || 0) - (a.createdAt || 0);
      return a.pinned ? -1 : 1;
    });

    if (sortedClips.length === 0) {
      emptyState.style.display = 'flex';
      clipsList.innerHTML = '';
      return;
    }

    emptyState.style.display = 'none';
    clipsList.innerHTML = '';

    sortedClips.forEach((clip) => {
      const card = document.createElement('div');
      card.className = `clip-card ${clip.pinned ? 'pinned' : ''}`;
      card.title = 'Click to fill the field you were in';

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

      const pinBtn = document.createElement('button');
      pinBtn.className = `icon-btn ${clip.pinned ? 'pin-active' : ''}`;
      pinBtn.title = clip.pinned ? 'Unpin' : 'Pin to top';
      pinBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="${clip.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="17" x2="12" y2="22"></line>
          <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
        </svg>`;
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(clip.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn delete-btn';
      deleteBtn.title = 'Delete clip';
      deleteBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>`;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteClip(clip.id);
      });

      headerRight.appendChild(pinBtn);
      headerRight.appendChild(deleteBtn);
      header.appendChild(headerLeft);
      header.appendChild(headerRight);

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
          </svg>`;
        const linkLabel = document.createElement('span');
        linkLabel.textContent = clip.title && clip.title !== clip.content ? clip.title : clip.content;
        link.appendChild(linkLabel);
        contentBody.appendChild(link);
      } else {
        contentBody.textContent = clip.content;
      }

      const cardFooter = document.createElement('div');
      cardFooter.className = 'clip-card-footer';

      const fillBtn = document.createElement('button');
      fillBtn.className = 'btn-card-action btn-fill-primary';
      fillBtn.title = 'Fill into the field you were in';
      fillBtn.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        <span>Auto-fill</span>`;
      fillBtn.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        autofillAndCopy(clip.content, fillBtn);
      });
      fillBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-card-action';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span>Copy</span>`;
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const copied = await copyToClipboard(clip.content);
        showToast(copied ? 'Copied to clipboard!' : 'Failed to copy', copied ? '✓' : '✕');
      });

      cardFooter.appendChild(fillBtn);
      cardFooter.appendChild(copyBtn);
      bindFillAction(card, clip.content, fillBtn);

      card.appendChild(header);
      card.appendChild(contentBody);
      card.appendChild(cardFooter);
      clipsList.appendChild(card);
    });
  }

  function panelHtml() {
    return `
      <div class="copyme-panel app-container">
        <header class="app-header">
          <div class="brand">
            <div class="brand-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </div>
            <div class="brand-text">
              <h1>CopyMe</h1>
              <span id="itemCount" class="item-count">0 items</span>
            </div>
          </div>
          <div class="header-actions">
            <button id="saveTabBtn" class="btn btn-secondary btn-sm" title="Save current tab">
              <span>+ Current Tab</span>
            </button>
            <button id="closePanelBtn" class="icon-btn close-panel-btn" title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </header>

        <section class="add-section">
          <div class="input-wrapper">
            <textarea id="clipInput" rows="2" placeholder="Paste or type a link / text to save..." spellcheck="false"></textarea>
            <div class="input-actions">
              <span class="shortcut-hint">Tap a card to paste at your cursor</span>
              <button id="addBtn" class="btn btn-primary" title="Save clip">
                <span>Save</span>
              </button>
            </div>
          </div>
        </section>

        <main class="clips-container" id="clipsList"></main>

        <div id="emptyState" class="empty-state" style="display: none;">
          <p class="empty-title">No clips saved yet</p>
          <p class="empty-desc">Type in the box above or click <strong>"+ Current Tab"</strong>.</p>
        </div>

        <footer class="app-footer">
          <div class="footer-left">
            <button id="exportBtn" class="footer-link-btn" title="Export clips as JSON">Export</button>
            <button id="importBtn" class="footer-link-btn" title="Import clips from JSON">Import</button>
            <input type="file" id="importFileInput" accept=".json" style="display: none;" />
          </div>
          <div class="footer-right">
            <button id="clearAllBtn" class="footer-link-btn text-danger" title="Delete all saved clips">Clear All</button>
          </div>
        </footer>

        <div id="toast" class="toast">
          <span id="toastIcon">✓</span>
          <span id="toastMsg">Copied to clipboard!</span>
        </div>
      </div>
    `;
  }

  async function mountPanel() {
    if (host && document.documentElement.contains(host)) {
      host.style.display = host.style.display === 'none' ? 'block' : 'none';
      return;
    }

    host = document.getElementById(HOST_ID);
    if (host) host.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-copyme-panel', 'true');
    host.style.cssText = [
      'all: initial',
      'display: block',
      'position: fixed',
      'top: 16px',
      'right: 16px',
      'z-index: 2147483647',
      'width: 380px',
      'max-width: calc(100vw - 24px)',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ].join(';');

    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = chrome.runtime.getURL('popup.css');
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = panelHtml();
    shadow.appendChild(wrap);

    host.addEventListener('pointerdown', (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const onField = path.some((node) => node && (node.id === 'clipInput' || node.tagName === 'TEXTAREA' || node.tagName === 'INPUT'));
      if (!onField) e.preventDefault();
    }, true);
    host.addEventListener('mousedown', (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const onField = path.some((node) => node && (node.id === 'clipInput' || node.tagName === 'TEXTAREA' || node.tagName === 'INPUT'));
      if (!onField) e.preventDefault();
    }, true);

    document.documentElement.appendChild(host);

    clips = await storage.get('clips');
    render();
    bindEvents();
  }

  function hidePanel() {
    if (host) host.style.display = 'none';
  }

  function bindEvents() {
    const addBtn = $('addBtn');
    const clipInput = $('clipInput');
    const saveTabBtn = $('saveTabBtn');
    const closePanelBtn = $('closePanelBtn');
    const clearAllBtn = $('clearAllBtn');
    const exportBtn = $('exportBtn');
    const importBtn = $('importBtn');
    const importFileInput = $('importFileInput');

    if (addBtn) addBtn.addEventListener('click', () => saveClip(clipInput.value));
    if (clipInput) {
      clipInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          saveClip(clipInput.value);
        }
      });
    }
    if (saveTabBtn) saveTabBtn.addEventListener('click', saveCurrentTab);
    if (closePanelBtn) closePanelBtn.addEventListener('click', hidePanel);
    if (clearAllBtn) clearAllBtn.addEventListener('click', clearAllClips);
    if (exportBtn) exportBtn.addEventListener('click', exportClips);
    if (importBtn && importFileInput) {
      importBtn.addEventListener('click', () => importFileInput.click());
      importFileInput.addEventListener('change', handleImportFile);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && host && host.style.display !== 'none') {
        hidePanel();
      }
    }, true);
  }

  globalThis.__copymeTogglePanel = async function () {
    if (host && document.documentElement.contains(host) && host.style.display !== 'none') {
      hidePanel();
      return;
    }
    await mountPanel();
    if (host) host.style.display = 'block';
  };
})();
