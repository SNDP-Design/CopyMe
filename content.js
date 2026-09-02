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
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        savedRange = sel.getRangeAt(0).cloneRange();
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
      element.focus();
      const orig = element.value || '';
      let start = typeof element.selectionStart === 'number' ? element.selectionStart : orig.length;
      let end = typeof element.selectionEnd === 'number' ? element.selectionEnd : orig.length;

      if (typeof savedSelectionStart === 'number') {
        start = Math.max(0, Math.min(savedSelectionStart, orig.length));
        end = Math.max(start, Math.min(savedSelectionEnd !== null ? savedSelectionEnd : savedSelectionStart, orig.length));
      }

      try {
        element.setSelectionRange(start, end);
      } catch (_) {}

      // Single-pass execCommand: updates undo stack and triggers native input events
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch (_) {
        inserted = false;
      }

      // Only run fallback if execCommand did NOT modify the value
      if (!inserted || element.value === orig) {
        if (typeof element.setRangeText === 'function') {
          element.setRangeText(text, start, end, 'end');
        } else {
          const newVal = orig.substring(0, start) + text + orig.substring(end);
          const proto = Object.getPrototypeOf(element);
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && descriptor.set) {
            descriptor.set.call(element, newVal);
          } else {
            element.value = newVal;
          }
          const newPos = start + text.length;
          try { element.setSelectionRange(newPos, newPos); } catch (_) {}
        }

        // Notify React's internal value tracker
        const tracker = element._valueTracker;
        if (tracker) {
          tracker.setValue(orig);
        }

        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }

      triggerVisualFeedback(element);
      return true;
    }

    // Case 2: Rich Text Editors (Twitter/X, Claude, ChatGPT, Notion, Discord, ProseMirror, Lexical, Draft.js)
    if (isContentEditableElement(element)) {
      const targetEditor = element.isContentEditable ? element : (element.closest('[contenteditable="true"]') || element);
      targetEditor.focus();

      if (savedRange) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
        } catch (_) {}
      }

      // Single-pass native insertText ONLY:
      // execCommand naturally triggers Blink's native beforeinput/input events which the editor processes.
      // NEVER dispatch secondary beforeinput or paste events when execCommand runs, as that creates duplicate insertion.
      try {
        document.execCommand('insertText', false, text);
      } catch (_) {
        // Only if execCommand threw an exception:
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

    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]');
    for (const input of inputs) {
      if (isEditable(input) && input.offsetParent !== null) {
        return input;
      }
    }

    return null;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'autofill') {
      const now = Date.now();
      // Only deduplicate truly rapid-fire duplicate messages (same text within 400ms)
      // This prevents double-fire if the message is somehow echoed, but allows
      // the user to deliberately click the same card twice.
      if (request.text === lastProcessedText && (now - lastProcessedTime < 400)) {
        sendResponse({ success: true, filled: true, deduplicated: true });
        return true;
      }
      lastProcessedText = request.text;
      lastProcessedTime = now;

      const target = getTargetElement();
      if (target) {
        const success = insertTextAtCursor(target, request.text || '');
        sendResponse({ success: true, filled: success, tagName: target.tagName });
      } else {
        sendResponse({ success: false, filled: false, reason: 'no_input_focused' });
      }
      return true;
    } else if (request.action === 'ping') {
      sendResponse({ status: 'ready', hasTarget: !!getTargetElement() });
      return true;
    }
  });
})();
