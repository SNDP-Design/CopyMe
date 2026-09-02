/**
 * CopyMe - Background service worker
 * Opens the in-page panel so the webpage keeps its cursor/focus.
 */

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

async function togglePanel(tab) {
  if (!tab || tab.id === undefined || isRestrictedUrl(tab.url)) {
    try {
      await chrome.action.setPopup({ popup: 'popup.html' });
      await chrome.action.openPopup();
    } catch (_) {}
    try { await chrome.action.setPopup({ popup: '' }); } catch (_) {}
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => typeof globalThis.__copymeAutofill === 'function'
    });
    const hasEngine = results && results[0] && results[0].result === true;
    if (!hasEngine) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js']
      });
    }
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['panel.js']
    });
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (typeof globalThis.__copymeTogglePanel === 'function') {
          globalThis.__copymeTogglePanel();
        }
      }
    });
  } catch (err) {
    console.warn('CopyMe could not open the on-page panel:', err);
    try {
      await chrome.action.setPopup({ popup: 'popup.html' });
      await chrome.action.openPopup();
    } catch (_) {}
    try { await chrome.action.setPopup({ popup: '' }); } catch (_) {}
  }
}

chrome.action.onClicked.addListener((tab) => {
  togglePanel(tab);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCurrentTab') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        sendResponse({
          url: tab && tab.url ? tab.url : '',
          title: tab && tab.title ? tab.title : ''
        });
      } catch (_) {
        sendResponse({ url: '', title: '' });
      }
    })();
    return true;
  }

  if (request.action === 'autofillAllFrames') {
    (async () => {
      const tabId = sender.tab && sender.tab.id;
      if (tabId === undefined) {
        sendResponse({ filled: false });
        return;
      }

      try {
        const frameResults = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (value) => {
            if (typeof globalThis.__copymeAutofill !== 'function') {
              return { filled: false };
            }
            return globalThis.__copymeAutofill(value);
          },
          args: [request.text || '']
        });
        sendResponse({
          filled: frameResults.some((frame) => frame.result && frame.result.filled === true)
        });
      } catch (_) {
        sendResponse({ filled: false });
      }
    })();
    return true;
  }

  return false;
});
