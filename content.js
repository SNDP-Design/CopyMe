/**
 * CopyMe - Content Script
 * Universal, non-destructive form and rich-text editor auto-fill handler.
 * Compatible with standard inputs, textareas, React/Vue forms, and rich text editors (Twitter/X, Claude, ChatGPT, Notion, Discord).
 */

(function () {
  if (globalThis.__copymeContentLoaded) return;
  globalThis.__copymeContentLoaded = true;

  let lastFocusedElement = null;
  let savedSelectionStart = null;
  let savedSelectionEnd = null;
  let savedRange = null;
  let lastFocusedAt = 0;
  let lastSheetsSelectionAt = 0;

  // Deduplication lock
  let lastProcessedTime = 0;
  let lastProcessedText = '';

  // Check if standard input or textarea
  function isInputOrTextarea(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el instanceof HTMLInputElement) {
      const type = (el.type || 'text').toLowerCase();
      const nonTextTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'hidden', 'range', 'color'];
      return !nonTextTypes.includes(type) && !el.disabled && !el.readOnly;
    }
    if (el instanceof HTMLTextAreaElement) {
      return !el.disabled && !el.readOnly;
    }
    const tag = (el.tagName || '').toUpperCase();
    return (tag === 'INPUT' || tag === 'TEXTAREA') && !el.disabled && !el.readOnly;
  }

  // Check if contenteditable / rich-text editor
  function isContentEditableElement(el) {
    if (!el || !(el instanceof Element)) return false;
    if (isInputOrTextarea(el)) return false;
    return el.isContentEditable || 
           el.getAttribute('contenteditable') === 'true' || 
           el.getAttribute('role') === 'textbox' ||
           !!el.closest('[contenteditable="true"]');
  }

  function isPanelElement(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.id === 'copyme-panel-host' || el.hasAttribute('data-copyme-panel')) return true;
    if (el.closest && el.closest('#copyme-panel-host, [data-copyme-panel]')) return true;
    try {
      const root = el.getRootNode && el.getRootNode();
      if (root && root.host && (root.host.id === 'copyme-panel-host' || root.host.hasAttribute('data-copyme-panel'))) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  function isEditable(el) {
    if (isPanelElement(el)) return false;
    return isInputOrTextarea(el) || isContentEditableElement(el);
  }

  function isGoogleSheetsPage() {
    return (location.hostname === 'docs.google.com' && location.pathname.includes('/spreadsheets/')) ||
      document.referrer.includes('docs.google.com/spreadsheets/');
  }

  function isGoogleDocsPage() {
    return (location.hostname === 'docs.google.com' && location.pathname.includes('/document/')) ||
      document.referrer.includes('docs.google.com/document/');
  }

  function isXPostComposer(el) {
    if (!el || !(el instanceof Element)) return false;
    const hostname = location.hostname.toLowerCase();
    if (hostname !== 'x.com' && hostname !== 'twitter.com' && !hostname.endsWith('.x.com') && !hostname.endsWith('.twitter.com')) {
      return false;
    }

    return el.matches('[data-testid^="tweetTextarea_"]') ||
      !!el.closest('[data-testid^="tweetTextarea_"]') ||
      (el.getAttribute('role') === 'textbox' && el.classList.contains('public-DraftEditor-content'));
  }

  function isGoogleSheetsGridElement(el) {
    if (!isGoogleSheetsPage() || !el || !(el instanceof Element)) return false;
    return !!el.closest('#waffle-grid-container, .waffle-grid-container, [role="grid"]');
  }

  function getDeepActiveElement(root = document) {
    let active = root.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function recordCursorPosition(el) {
    if (!el || !isEditable(el) || isPanelElement(el)) return;

    if (isContentEditableElement(el)) {
      el = el.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]') ||
        (el.isContentEditable ? el : (el.closest('[contenteditable]') || el));
    }

    if (lastFocusedElement !== el) {
      savedSelectionStart = null;
      savedSelectionEnd = null;
      savedRange = null;
    }

    lastFocusedElement = el;
    lastFocusedAt = Date.now();

    if (isInputOrTextarea(el)) {
      try {
        if (typeof el.selectionStart === 'number') {
          savedSelectionStart = el.selectionStart;
          savedSelectionEnd = el.selectionEnd;
        }
      } catch (_) {
        savedSelectionStart = null;
        savedSelectionEnd = null;
      }
    }

    if (isContentEditableElement(el)) {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          savedRange = sel.getRangeAt(0).cloneRange();
        }
      } catch (_) {
        savedRange = null;
      }
    }
  }

  function handleInteraction(event) {
    const path = event.composedPath ? event.composedPath() : [event.target];
    for (const el of path) {
      if (isPanelElement(el)) return;
      if (isEditable(el)) {
        recordCursorPosition(el);
        return;
      }
    }

    if (path.some(isGoogleSheetsGridElement)) {
      lastFocusedElement = null;
      savedSelectionStart = null;
      savedSelectionEnd = null;
      savedRange = null;
      lastSheetsSelectionAt = Date.now();
    }
  }

  function snapshotActiveCursor() {
    const active = getDeepActiveElement();
    if (active && isEditable(active) && !isPanelElement(active)) {
      recordCursorPosition(active);
      return;
    }
    if (isGoogleSheetsPage()) {
      lastSheetsSelectionAt = Date.now();
    }
  }

  document.addEventListener('focusin', handleInteraction, true);
  document.addEventListener('pointerdown', handleInteraction, true);
  document.addEventListener('click', handleInteraction, true);
  document.addEventListener('keyup', (e) => {
    if (e.target && isEditable(e.target)) recordCursorPosition(e.target);
  }, true);
  document.addEventListener('input', (e) => {
    if (e.target && isEditable(e.target)) recordCursorPosition(e.target);
  }, true);
  document.addEventListener('selectionchange', () => {
    const active = getDeepActiveElement();
    if (active && isEditable(active)) recordCursorPosition(active);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target && isEditable(e.target)) recordCursorPosition(e.target);
  }, true);
  window.addEventListener('blur', snapshotActiveCursor, true);

  // Universal text insertion function - STRICT SINGLE PASS
  function insertTextAtCursor(element, text) {
    if (!element || text === undefined || text === null) return false;

    // Case 1: Standard <input> and <textarea>
    if (isInputOrTextarea(element)) {
      try { element.focus(); } catch (_) {}
      const orig = element.value || '';
      let start = orig.length;
      let end = orig.length;

      try {
        if (typeof element.selectionStart === 'number') {
          start = element.selectionStart;
          end = typeof element.selectionEnd === 'number' ? element.selectionEnd : start;
        }
      } catch (_) {
        // Selection API not supported for this input type
      }

      if (typeof savedSelectionStart === 'number' && savedSelectionStart >= 0) {
        try {
          start = Math.max(0, Math.min(savedSelectionStart, orig.length));
          end = Math.max(start, Math.min(savedSelectionEnd !== null ? savedSelectionEnd : savedSelectionStart, orig.length));
        } catch (_) {}
      }

      try {
        element.setSelectionRange(start, end);
      } catch (_) {}

      const newVal = orig.substring(0, start) + text + orig.substring(end);
      let setDone = false;
      try {
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) {
          descriptor.set.call(element, newVal);
          setDone = true;
        }
      } catch (_) {}

      if (!setDone) {
        try {
          if (typeof element.setRangeText === 'function') {
            element.setRangeText(text, start, end, 'end');
            setDone = true;
          }
        } catch (_) {}
      }

      if (!setDone) {
        element.value = newVal;
      }

      const newPos = start + text.length;
      try { element.setSelectionRange(newPos, newPos); } catch (_) {}

      // Notify React's internal value tracker
      try {
        const tracker = element._valueTracker;
        if (tracker) {
          tracker.setValue(orig);
        }
      } catch (_) {}

      try { element.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch (_) {}
      try { element.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (_) {}

      triggerVisualFeedback(element);
      return true;
    }

    // Case 2: Rich Text Editors (Twitter/X, Claude, ChatGPT, Notion, Discord, ProseMirror, Lexical, Draft.js)
    if (isContentEditableElement(element)) {
      const targetEditor = element.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]') ||
        (element.isContentEditable ? element : (element.closest('[contenteditable]') || element));
      const doc = targetEditor.ownerDocument || document;
      const win = doc.defaultView || window;
      const beforeText = targetEditor.textContent || '';
      try { targetEditor.focus(); } catch (_) {}

      if (savedRange) {
        try {
          const sel = win.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
        } catch (_) {}
      }

      // X uses Draft.js. Its editor can apply execCommand text once through the
      // browser and once through Draft.js, producing an exact duplicate. Give
      // Draft.js one paste event instead and never replay a second insertion.
      let inserted = isXPostComposer(targetEditor)
        ? insertIntoXPostComposer(targetEditor, text, doc)
        : insertPlainText(targetEditor, text, doc);
      if (!inserted) {
        inserted = (targetEditor.textContent || '') !== beforeText ||
          (targetEditor.textContent || '').includes(text);
      }

      if (inserted) triggerVisualFeedback(targetEditor);
      return inserted;
    }

    return false;
  }

  function readElementText(target) {
    if (!target) return '';
    if (typeof target.value === 'string') return target.value;
    return target.textContent || '';
  }

  function contentLooksInserted(before, target, text) {
    const after = readElementText(target);
    if (after !== before) return true;
    return !!(text && after && after.includes(text));
  }

  function insertPlainText(target, text, doc = document) {
    if (!target || text === undefined || text === null) return false;
    const before = readElementText(target);

    try { target.focus(); } catch (_) {}

    // One native insertion attempt only. Editors may update asynchronously,
    // so replaying paste/text/input fallbacks can insert the same clip twice.
    try {
      const executed = doc.execCommand('insertText', false, text);
      return executed || contentLooksInserted(before, target, text);
    } catch (_) {
      return false;
    }
  }

  function insertIntoXPostComposer(target, text, doc = document) {
    if (!target || text === undefined || text === null) return false;
    const win = doc.defaultView || window;

    try { target.focus(); } catch (_) {}

    try {
      const clipboardData = new win.DataTransfer();
      clipboardData.setData('text/plain', text);
      target.dispatchEvent(new win.ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function collapseExactDuplicate(element, text) {
    if (!element || !text) return false;

    if (isInputOrTextarea(element)) {
      const value = element.value || '';
      if (value !== text + text) return false;

      try {
        const proto = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(element, text);
        else element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
      } catch (_) {
        return false;
      }
    }

    if (isContentEditableElement(element)) {
      const targetEditor = element.isContentEditable ? element : (element.closest('[contenteditable]') || element);
      if (targetEditor.textContent !== text + text) return false;

      try {
        targetEditor.textContent = text;
        targetEditor.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text
        }));
        return true;
      } catch (_) {
        return false;
      }
    }

    return false;
  }

  function getSheetsCellInput() {
    const selectors = [
      '#t-formula-bar-input-container .cell-input',
      '#t-formula-bar-input-container [contenteditable="true"]',
      '.formula-content .cell-input',
      'div.cell-input[contenteditable="true"]',
      'textarea.cell-input',
      '.cell-input'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest('#t-name-box-container, .name-box, [aria-label="Name box"]')) {
        return el;
      }
    }
    return null;
  }

  function pasteIntoGoogleSheets(text) {
    if (!isGoogleSheetsPage()) return false;

    const input = getSheetsCellInput();
    if (input && input.offsetParent !== null) {
      return insertTextAtCursor(input, text);
    }

    const grid = document.querySelector('#waffle-grid-container, .waffle-grid-container, [role="grid"]');
    const target = grid || document.activeElement;

    if (target) {
      try { target.focus(); } catch (_) {}
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const pasteEv = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt
        });
        target.dispatchEvent(pasteEv);
        triggerVisualFeedback(target);
        return true;
      } catch (_) {}

      try {
        if (document.execCommand('paste')) {
          triggerVisualFeedback(target);
          return true;
        }
      } catch (_) {}
    }

    return false;
  }

  function readIframeDocument(iframe) {
    try {
      return iframe.contentDocument || iframe.contentWindow?.document || null;
    } catch (_) {
      return null;
    }
  }

  function getGoogleDocsEditor() {
    const preferred = document.querySelectorAll(
      'iframe.docs-texteventtarget-iframe, .docs-texteventtarget-iframe, iframe.docs-texteventtarget-iframe iframe'
    );
    const iframes = preferred.length ? preferred : document.querySelectorAll('iframe');

    for (const iframe of iframes) {
      const doc = readIframeDocument(iframe);
      if (!doc) continue;

      const className = iframe.className || '';
      const editor = doc.querySelector('[contenteditable="true"], textarea, [role="textbox"]') ||
        ((className.includes('texteventtarget') || (iframe.id || '').includes('target'))
          ? (doc.body || doc.documentElement)
          : null);

      if (editor) return { doc, editor };
    }
    return null;
  }

  function pasteIntoGoogleDocs(text) {
    if (!isGoogleDocsPage() && !getGoogleDocsEditor()) return false;

    const found = getGoogleDocsEditor();
    const doc = found ? found.doc : document;
    const editor = found ? found.editor : null;

    if (editor) {
      try { editor.focus(); } catch (_) {}
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const pasteEv = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt
        });
        editor.dispatchEvent(pasteEv);
        triggerVisualFeedback(editor);
        return true;
      } catch (_) {}
    }

    try {
      if (doc && doc.execCommand && doc.execCommand('paste')) {
        if (editor) triggerVisualFeedback(editor);
        return true;
      }
    } catch (_) {}

    try {
      if (document.execCommand('paste')) {
        if (editor) triggerVisualFeedback(editor);
        return true;
      }
    } catch (_) {}

    return true;
  }

  function triggerVisualFeedback(el) {
    try {
      const originalOutline = el.style.outline;
      const originalBoxShadow = el.style.boxShadow;
      const originalTransition = el.style.transition;

      el.style.transition = 'all 0.2s ease';
      el.style.outline = '2px solid #000000';
      el.style.boxShadow = '0 0 0 4px rgba(0, 0, 0, 0.15)';

      setTimeout(() => {
        el.style.outline = originalOutline;
        el.style.boxShadow = originalBoxShadow;
        el.style.transition = originalTransition;
      }, 700);
    } catch (_) {}
  }

  function getTargetElement() {
    if (lastFocusedElement && document.contains(lastFocusedElement) && isEditable(lastFocusedElement) && !isPanelElement(lastFocusedElement)) {
      return lastFocusedElement;
    }

    const deepActive = getDeepActiveElement();
    if (isEditable(deepActive) && !isPanelElement(deepActive)) {
      return deepActive;
    }

    // Fallback: find the first visible editable input on the page
    const candidates = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"], [contenteditable=""], [role="textbox"]'
    );
    for (const el of candidates) {
      if (isEditable(el) && !isPanelElement(el) && el.offsetParent !== null) {
        return el;
      }
    }

    return null;
  }

  function markFilled(text) {
    lastProcessedText = text;
    lastProcessedTime = Date.now();
  }

  function autofillFocusedField(text) {
    try {
      const now = Date.now();
      if (text === lastProcessedText && (now - lastProcessedTime < 800)) {
        return { ready: true, filled: true, deduplicated: true };
      }
      lastProcessedText = text;
      lastProcessedTime = now;

      // 1. Google Docs
      if (isGoogleDocsPage() || getGoogleDocsEditor()) {
        const pasted = pasteIntoGoogleDocs(text || '');
        if (pasted) {
          markFilled(text);
          return { ready: true, filled: true, googleDocs: true };
        }
      }

      // 2. Google Sheets
      if (isGoogleSheetsPage()) {
        const pasted = pasteIntoGoogleSheets(text || '');
        if (pasted) {
          markFilled(text);
          return { ready: true, filled: true, googleSheets: true };
        }
      }

      // 3. Social Media, Message Composers, and Standard Inputs
      const liveTarget = getDeepActiveElement();
      const target = (liveTarget && isEditable(liveTarget) && !isPanelElement(liveTarget)) ? liveTarget : getTargetElement();

      if (target) {
        const success = insertTextAtCursor(target, text || '');
        if (success) {
          markFilled(text);
          return { ready: true, filled: true, tagName: target.tagName };
        }
      }

      return { ready: true, filled: false, reason: target ? 'insert_failed' : 'no_input_focused' };
    } catch (err) {
      console.error('Autofill error in content script:', err);
      return { ready: true, filled: false, error: err.toString() };
    }
  }

  globalThis.__copymeAutofill = autofillFocusedField;
  globalThis.__copymeSnapshotCursor = snapshotActiveCursor;
  globalThis.__copymeGetFocus = () => ({
    ready: true,
    hasTarget: !!getTargetElement() || (isGoogleSheetsPage() && lastSheetsSelectionAt > 0),
    focusedAt: Math.max(
      lastFocusedAt || (isEditable(getDeepActiveElement()) ? Date.now() : 0),
      lastSheetsSelectionAt
    )
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'autofill') {
      sendResponse(autofillFocusedField(request.text));
      return true;
    } else if (request.action === 'ping') {
      sendResponse({ status: 'ready', hasTarget: !!getTargetElement() });
      return true;
    }
  });
})();
