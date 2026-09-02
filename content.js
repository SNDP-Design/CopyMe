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

  function isEditable(el) {
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
    if (!el || !isEditable(el)) return;

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
    if (active && isEditable(active)) {
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
        // Selection API not supported for this input type (e.g. email, number, date)
      }

      if (typeof savedSelectionStart === 'number') {
        try {
          start = Math.max(0, Math.min(savedSelectionStart, orig.length));
          end = Math.max(start, Math.min(savedSelectionEnd !== null ? savedSelectionEnd : savedSelectionStart, orig.length));
        } catch (_) {}
      }

      try {
        element.setSelectionRange(start, end);
      } catch (_) {}

      let setSuccess = false;
      try {
        if (typeof element.setRangeText === 'function') {
          element.setRangeText(text, start, end, 'end');
          setSuccess = true;
        }
      } catch (_) {
        setSuccess = false;
      }

      if (!setSuccess) {
        const newVal = orig.substring(0, start) + text + orig.substring(end);
        try {
          const proto = Object.getPrototypeOf(element);
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && descriptor.set) {
            descriptor.set.call(element, newVal);
          } else {
            element.value = newVal;
          }
        } catch (_) {
          element.value = orig.substring(0, start) + text + orig.substring(end);
        }
        const newPos = start + text.length;
        try { element.setSelectionRange(newPos, newPos); } catch (_) {}
      }

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
      const targetEditor = element.isContentEditable ? element : (element.closest('[contenteditable]') || element);
      const beforeText = targetEditor.textContent || '';
      try { targetEditor.focus(); } catch (_) {}

      if (savedRange) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
        } catch (_) {}
      }

      let inserted = insertPlainText(targetEditor, text, targetEditor.ownerDocument || document);
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
    const view = doc.defaultView || window;
    const before = readElementText(target);

    try { target.focus(); } catch (_) {}

    try {
      if (doc.execCommand('insertText', false, text) && contentLooksInserted(before, target, text)) {
        return true;
      }
    } catch (_) {}

    if (contentLooksInserted(before, target, text)) return true;

    try {
      const textEvent = doc.createEvent('TextEvent');
      textEvent.initTextEvent('textInput', true, true, view, text);
      target.dispatchEvent(textEvent);
      if (contentLooksInserted(before, target, text)) return true;
    } catch (_) {
      try {
        const ev = new Event('textInput', { bubbles: true, cancelable: true, composed: true });
        ev.data = text;
        target.dispatchEvent(ev);
        if (contentLooksInserted(before, target, text)) return true;
      } catch (_) {}
    }

    try {
      target.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: text
      }));
      target.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text
      }));
      if (contentLooksInserted(before, target, text)) return true;
    } catch (_) {}

    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const orig = target.value || '';
      let start = orig.length;
      let end = orig.length;
      try {
        if (typeof target.selectionStart === 'number') {
          start = target.selectionStart;
          end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
        }
      } catch (_) {}
      target.value = orig.slice(0, start) + text + orig.slice(end);
      try {
        const pos = start + text.length;
        target.setSelectionRange(pos, pos);
      } catch (_) {}
      target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return true;
    }

    return contentLooksInserted(before, target, text);
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
    const active = getDeepActiveElement();
    const editingInput = input && (
      active === input ||
      lastFocusedElement === input ||
      (lastFocusedAt && lastFocusedAt >= lastSheetsSelectionAt)
    );

    if (editingInput && input) {
      const inserted = insertPlainText(input, text, input.ownerDocument || document);
      if (inserted) triggerVisualFeedback(input);
      return inserted;
    }

    const grid = document.querySelector('#waffle-grid-container, .waffle-grid-container, [role="grid"]');
    if (grid) {
      try { grid.focus(); } catch (_) {}
      try {
        if (document.execCommand('insertText', false, text)) {
          triggerVisualFeedback(grid);
          return true;
        }
      } catch (_) {}
    }

    if (input) {
      try { input.focus(); } catch (_) {}
      try { document.execCommand('selectAll'); } catch (_) {}
      const inserted = insertPlainText(input, text, input.ownerDocument || document);
      if (inserted) {
        triggerVisualFeedback(input);
        return true;
      }
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
    if (!found) return false;

    const { doc, editor } = found;
    const before = editor.value || editor.textContent || '';
    const inserted = insertPlainText(editor, text, doc);
    const after = editor.value || editor.textContent || '';
    const success = inserted || after !== before || (after && after.includes(text));
    if (success) triggerVisualFeedback(editor);
    return success;
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
    if (lastFocusedElement && document.contains(lastFocusedElement) && isEditable(lastFocusedElement)) {
      return lastFocusedElement;
    }

    const deepActive = getDeepActiveElement();
    if (isEditable(deepActive)) {
      return deepActive;
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
      if (text === lastProcessedText && (now - lastProcessedTime < 400)) {
        return { ready: true, filled: true, deduplicated: true };
      }

      const liveTarget = getDeepActiveElement();
      const target = (liveTarget && isEditable(liveTarget)) ? liveTarget : getTargetElement();

      if (target) {
        if (collapseExactDuplicate(target, text)) {
          markFilled(text);
          return { ready: true, filled: true, duplicateRemoved: true };
        }

        const success = insertTextAtCursor(target, text || '');
        if (success) {
          markFilled(text);
          return { ready: true, filled: true, tagName: target.tagName };
        }
      }

      if (isGoogleDocsPage() || getGoogleDocsEditor()) {
        const pasted = pasteIntoGoogleDocs(text || '');
        if (pasted) {
          markFilled(text);
          return { ready: true, filled: true, googleDocs: true };
        }
      }

      if (isGoogleSheetsPage() && (lastSheetsSelectionAt || getSheetsCellInput())) {
        const pasted = pasteIntoGoogleSheets(text || '');
        if (pasted) {
          markFilled(text);
          return { ready: true, filled: true, googleSheets: true };
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
