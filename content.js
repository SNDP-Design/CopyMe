/**
 * CopyMe - Content Script
 * Universal, non-destructive form and rich-text editor auto-fill handler.
 * Compatible with standard inputs, textareas, React/Vue forms, and rich text editors (Twitter/X, Claude, ChatGPT, Notion, Discord).
 */

(function () {
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

      // Single-pass native insertText ONLY:
      let inserted = false;
      try {
        // Some editors insert successfully but return false from execCommand.
        // Treat the command as one insertion so the fallback cannot duplicate it.
        document.execCommand('insertText', false, text);
        inserted = (targetEditor.textContent || '') !== beforeText;
      } catch (_) {
        try {
          const selection = window.getSelection();
          const range = selection && selection.rangeCount > 0
            ? selection.getRangeAt(0)
            : document.createRange();

          if (!selection || selection.rangeCount === 0) {
            range.selectNodeContents(targetEditor);
            range.collapse(false);
          }

          range.deleteContents();
          const textNode = document.createTextNode(text);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);

          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }

          targetEditor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertText',
            data: text
          }));
          inserted = true;
        } catch (_) {}
      }

      if (inserted) triggerVisualFeedback(targetEditor);
      return inserted;
    }

    return false;
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

  function pasteIntoGoogleSheets(text) {
    if (!isGoogleSheetsPage() || !lastSheetsSelectionAt) return false;

    const active = getDeepActiveElement();
    const target = active && active !== document.body
      ? active
      : (document.querySelector('#waffle-grid-container, .waffle-grid-container, [role="grid"]') || document.body);

    try {
      target.focus();
      return document.execCommand('paste');
    } catch (_) {
      return false;
    }
  }

  function pasteIntoGoogleDocs(target) {
    if (!target || !isGoogleDocsPage()) return false;

    try {
      target.focus();
      // Google Docs processes native paste on its hidden editor input.
      return document.execCommand('paste');
    } catch (_) {
      return false;
    }
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

  function autofillFocusedField(text) {
    try {
      const now = Date.now();
      if (text === lastProcessedText && (now - lastProcessedTime < 400)) {
        return { ready: true, filled: true, deduplicated: true };
      }

      if (isGoogleSheetsPage() && lastSheetsSelectionAt >= lastFocusedAt) {
        const pasted = pasteIntoGoogleSheets(text || '');
        if (pasted) {
          lastProcessedText = text;
          lastProcessedTime = now;
        }
        return { ready: true, filled: pasted, googleSheets: true };
      }

      const target = getTargetElement();
      if (!target) {
        return { ready: true, filled: false, reason: 'no_input_focused' };
      }

      if (isGoogleDocsPage()) {
        const pasted = pasteIntoGoogleDocs(target);
        if (pasted) {
          lastProcessedText = text;
          lastProcessedTime = now;
        }
        return { ready: true, filled: pasted, googleDocs: true };
      }

      if (collapseExactDuplicate(target, text)) {
        return { ready: true, filled: true, duplicateRemoved: true };
      }

      const success = insertTextAtCursor(target, text || '');
      if (success) {
        lastProcessedText = text;
        lastProcessedTime = now;
      }

      return { ready: true, filled: success, tagName: target.tagName };
    } catch (err) {
      console.error('Autofill error in content script:', err);
      return { ready: true, filled: false, error: err.toString() };
    }
  }

  globalThis.__copymeAutofill = autofillFocusedField;
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
