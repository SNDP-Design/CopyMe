/**
 * CopyMe - Content Script
 * Universal, non-destructive form and rich-text editor auto-fill handler.
 * Compatible with standard inputs, textareas, React/Vue forms, and rich text editors (Twitter/X, Claude, ChatGPT, Notion, Discord).
 */

(function () {
  if (window.__copyme_injected) return;
  window.__copyme_injected = true;

  let lastFocusedElement = null;
  let savedSelectionStart = null;
  let savedSelectionEnd = null;
  let savedRange = null;

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
      try { targetEditor.focus(); } catch (_) {}

      if (savedRange) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
        } catch (_) {}
      }

      // Single-pass native insertText ONLY:
      try {
        document.execCommand('insertText', false, text);
      } catch (_) {
        try {
          const inputEv = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          });
          targetEditor.dispatchEvent(inputEv);
        } catch (_) {}
      }

      triggerVisualFeedback(targetEditor);
      return true;
    }

    return false;
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

    const inputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable], [role="textbox"]'
    );
    for (const input of inputs) {
      if (isEditable(input) && input.offsetParent !== null) {
        return input;
      }
    }

    return null;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'autofill') {
      try {
        const now = Date.now();
        if (request.text === lastProcessedText && (now - lastProcessedTime < 400)) {
          sendResponse({ success: true, filled: true, deduplicated: true });
          return true;
        }

        const target = getTargetElement();
        if (target) {
          const success = insertTextAtCursor(target, request.text || '');
          if (success) {
            lastProcessedText = request.text;
            lastProcessedTime = now;
          }
          sendResponse({ success: true, filled: success, tagName: target.tagName });
        } else {
          sendResponse({ success: false, filled: false, reason: 'no_input_focused' });
        }
      } catch (err) {
        console.error('Autofill error in content script:', err);
        sendResponse({ success: false, filled: false, error: err.toString() });
      }
      return true;
    } else if (request.action === 'ping') {
      sendResponse({ status: 'ready', hasTarget: !!getTargetElement() });
      return true;
    }
  });
})();
