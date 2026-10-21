// Service worker: owns the context menu + keyboard command, reads the raw
// markdown file, maps the selection to source lines, and talks to the bridge.
//
// The bridge runs named agent slots (A, B, ...), each a separate Claude Code
// session. The context menu is "Send to Claude Code" > one item per agent,
// plus "All connected agents". Alt+K re-sends to the last agent you used.

import { matchSelection, lineLength } from './matcher.js';

const DEFAULT_BRIDGE = 'http://127.0.0.1:41417';
const PARENT_ID = 'md-send-to-claude';
const AGENT_PREFIX = 'md-agent:';
const ALL_ID = AGENT_PREFIX + '*';
const NONE_ID = 'md-no-bridge';

async function bridgeUrl() {
  const { bridgeUrl } = await chrome.storage.sync.get({ bridgeUrl: DEFAULT_BRIDGE });
  return bridgeUrl.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Context menu, rebuilt from the bridge's /status
// ---------------------------------------------------------------------------

let lastMenuKey = null;

async function fetchStatus() {
  try {
    const url = await bridgeUrl();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${url}/status`, { signal: ctrl.signal }).then((r) => r.json());
    clearTimeout(t);
    return res?.ok ? res : null;
  } catch {
    return null;
  }
}

function menuItems(status) {
  const items = [];
  if (!status) {
    items.push({ id: NONE_ID, title: 'Bridge not running (start: mdclaude)', enabled: false });
    return items;
  }
  if (!status.agents.length) {
    items.push({ id: NONE_ID, title: 'No agents yet (mdclaude run <name>)', enabled: false });
    return items;
  }
  for (const a of status.agents) {
    items.push({
      id: AGENT_PREFIX + a.name,
      title: a.connected ? `Agent ${a.name}` : `Agent ${a.name} (not connected)`,
      enabled: true,
    });
  }
  if (status.agents.length > 1) {
    const n = status.agents.filter((a) => a.connected).length;
    items.push({ id: ALL_ID, title: `All connected agents (${n})`, enabled: n > 0 });
  }
  return items;
}

async function rebuildMenu(status) {
  const items = menuItems(status);
  const key = JSON.stringify(items);
  if (key === lastMenuKey) return;
  lastMenuKey = key;
  await chrome.contextMenus.removeAll();
  const common = { contexts: ['selection'], documentUrlPatterns: ['file:///*'] };
  chrome.contextMenus.create({ id: PARENT_ID, title: 'Send to Claude Code', ...common });
  for (const it of items) {
    chrome.contextMenus.create({ id: it.id, parentId: PARENT_ID, title: it.title, enabled: it.enabled, ...common });
  }
}

async function refreshMenu() {
  await rebuildMenu(await fetchStatus());
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh-menu', { periodInMinutes: 0.5 });
  refreshMenu();
});
chrome.runtime.onStartup.addListener(refreshMenu);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'refresh-menu') refreshMenu(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith(AGENT_PREFIX) && tab?.id) sendMention(tab, id.slice(AGENT_PREFIX.length));
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'send-selection' || !tab?.id) return;
  const status = await fetchStatus();
  if (!status) return toast(tab.id, 'Bridge not running. Start it with: mdclaude', 'error');
  const connected = status.agents.filter((a) => a.connected).map((a) => a.name);
  const { lastAgent } = await chrome.storage.local.get('lastAgent');
  let agent = null;
  if (lastAgent && (lastAgent === '*' || connected.includes(lastAgent))) agent = lastAgent;
  else if (connected.length === 1) agent = connected[0];
  if (!agent) return toast(tab.id, 'Which agent? Right-click the selection and pick one.', 'warn');
  sendMention(tab, agent);
});

// Live selection updates from the content script (debounced there).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'live-selection' && sender.tab?.id) {
    handleLiveSelection(sender.tab, msg).then(sendResponse, () => sendResponse(null));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------

function filePathFromUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'file:') return null;
  return decodeURIComponent(u.pathname);
}

const rawCache = new Map(); // url -> { at, text }

async function readRaw(url, { maxAgeMs = 1500 } = {}) {
  const hit = rawCache.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.text;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const text = await res.text();
  rawCache.set(url, { at: Date.now(), text });
  return text;
}

// After the extension is reloaded, content scripts in already-open tabs are
// orphaned and can't receive messages. Re-inject on demand instead of making
// the user reload the page.
async function messageTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function getSelectionFromTab(tabId) {
  return messageTab(tabId, { type: 'get-selection' });
}

async function toast(tabId, text, kind = 'ok') {
  try { await messageTab(tabId, { type: 'toast', text, kind }); } catch {}
}

async function locate(tab, selectionText) {
  const filePath = filePathFromUrl(tab.url);
  if (!filePath) throw new Error('Only local file:// markdown files are supported');
  let raw;
  try {
    raw = await readRaw(tab.url);
  } catch {
    throw new Error('Could not read the file. In chrome://extensions, enable "Allow access to file URLs" for this extension.');
  }
  const m = matchSelection(raw, selectionText);
  if (!m) throw new Error('Could not find the selected text in the source file');
  return {
    filePath,
    lineStart: m.startLine + 1,
    lineEnd: m.endLine + 1,
    endCharacter: lineLength(raw, m.endLine),
    confidence: m.confidence,
  };
}

async function sendMention(tab, agent) {
  try {
    const sel = await getSelectionFromTab(tab.id);
    if (!sel?.text?.trim()) return toast(tab.id, 'Nothing selected', 'warn');
    const loc = await locate(tab, sel.text);
    const url = await bridgeUrl();
    let res;
    try {
      res = await fetch(`${url}/mention`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...loc, text: sel.text, agent }),
      }).then((r) => r.json());
    } catch {
      rebuildMenu(null);
      return toast(tab.id, 'Bridge not running. Start it with: mdclaude', 'error');
    }
    if (!res.ok) return toast(tab.id, `Bridge error: ${res.error}`, 'error');

    const range = loc.lineStart === loc.lineEnd ? `L${loc.lineStart}` : `L${loc.lineStart}-${loc.lineEnd}`;
    const name = loc.filePath.split('/').pop();
    if (!res.delivered.length) {
      const who = res.notConnected.length === 1 ? `Agent ${res.notConnected[0]}` : 'No agent';
      const pick = res.notConnected.length === 1 ? `"Markdown Viewer (${res.notConnected[0]})"` : 'a "Markdown Viewer (…)" entry';
      return toast(tab.id, `${who} is not connected. In that Claude Code, run /ide and pick ${pick}.`, 'warn');
    }
    chrome.storage.local.set({ lastAgent: agent });
    const approx = loc.confidence === 'approximate' ? ' (approximate match)' : '';
    const to = res.delivered.length === 1 ? `agent ${res.delivered[0]}` : `agents ${res.delivered.join(', ')}`;
    toast(tab.id, `Sent ${name}#${range} to ${to}${approx}`, 'ok');
    refreshMenu();
  } catch (e) {
    toast(tab.id, e.message || String(e), 'error');
  }
}

// Live selection mirroring to every connected agent. Fails silently; the
// explicit send reports errors. Also keeps the context menu fresh.
let liveBackoffUntil = 0;
async function handleLiveSelection(tab, msg) {
  if (Date.now() < liveBackoffUntil) return null;
  const filePath = filePathFromUrl(tab.url);
  if (!filePath) return null;
  const url = await bridgeUrl();
  let body;
  if (!msg.text?.trim()) {
    body = { filePath, lineStart: 1, lineEnd: 1, text: '', agent: '*' };
  } else {
    try {
      const loc = await locate(tab, msg.text);
      body = { ...loc, text: msg.text, agent: '*' };
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(`${url}/selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    refreshMenu();
    return res;
  } catch {
    liveBackoffUntil = Date.now() + 10000;
    rebuildMenu(null);
    return null;
  }
}
