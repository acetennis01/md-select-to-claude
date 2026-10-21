// Content script: runs on file:// pages (which Markdown Viewer renders).
// Reports the current selection to the service worker and shows toasts.

(() => {
  if (!/\.(?:markdown|mdown|mkdn|md|mkd|mdwn|mdtxt|mdtext)(?:[#?].*)?$/i.test(location.href)) return;

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    // Ignore selections inside the TOC sidebar: they don't map to source lines.
    const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (node?.closest?.('#_toc')) return '';
    return sel.toString();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'get-selection') {
      sendResponse({ text: selectionText(), url: location.href });
      return false;
    }
    if (msg?.type === 'toast') {
      showToast(msg.text, msg.kind);
      sendResponse(true);
      return false;
    }
    return false;
  });

  // Live selection mirroring (so Claude Code shows "N lines selected" like an IDE).
  let timer = null;
  let lastSent = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = selectionText();
      if (text === lastSent) return;
      if (!text && lastSent === null) return;
      lastSent = text;
      try {
        chrome.runtime.sendMessage({ type: 'live-selection', text }, () => void chrome.runtime.lastError);
      } catch {}
    }, 350);
  });

  // ---- toast ---------------------------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function showToast(text, kind) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = '_md_claude_toast';
      Object.assign(toastEl.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: '420px',
        padding: '10px 14px',
        borderRadius: '8px',
        font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        color: '#fff',
        boxShadow: '0 4px 16px rgba(0,0,0,.25)',
        transition: 'opacity .2s',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(toastEl);
    }
    const colors = { ok: '#1f6f43', warn: '#8a5a00', error: '#a12d2d' };
    toastEl.style.background = colors[kind] || colors.ok;
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, kind === 'ok' ? 2500 : 5000);
  }
})();
