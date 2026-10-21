#!/usr/bin/env node
// Bridge between the Chrome extension and one or more Claude Code sessions.
//
// It pretends to be an IDE: for each named "agent slot" it opens a WebSocket
// server that speaks Claude Code's IDE protocol (MCP over WebSocket) and
// writes a discovery lock file under ~/.claude/ide/. Each slot shows up as a
// separate entry in Claude Code's /ide list ("Markdown Viewer (A)",
// "Markdown Viewer (B)", ...), so you choose which session is which agent.
//
// A single localhost HTTP API (the "api port") is what the extension talks
// to; it routes a selection to one agent, or to all of them.
//
// Zero dependencies. Node 20+.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const IDE_NAME = 'Markdown Viewer';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage:
  mdclaude [serve] [workspaceFolder ...] [--agents A,B,...] [--port N]
  mdclaude start [workspaceFolder ...] [--agents A,B,...]
  mdclaude run [agent] [-- claude args...]
  mdclaude add <agent>
  mdclaude stop [--force]
  mdclaude status

serve (default)  Start the bridge and keep it in the foreground.
  workspaceFolder   Folder(s) Claude Code will be run from. Defaults to cwd.
                    Claude Code only offers this bridge in /ide when its own
                    cwd is inside one of these folders.
  --agents LIST     Agent slots to create up front, comma separated
                    (--agents design,qa) or a count of lettered ones
                    (--agents 3). Default: none; "add" and "run" create them
                    as needed. Each slot is a separate "Markdown Viewer
                    (<name>)" entry in Claude Code's /ide picker.
  --port N          API port the Chrome extension talks to (default 41417).
                    Agent slots use N+1, N+2, ...

start            Same as serve, but in the background (log: ~/.mdclaude/bridge.log).
                 Use this when you'll attach sessions you already have open,
                 by typing /ide in them and picking "Markdown Viewer (<agent>)".

add <agent>      Create an agent slot on the running bridge without launching
                 anything, so an open Claude Code can /ide into it.

run [agent]      Launch Claude Code already connected as that agent, e.g.
                 "mdclaude run A". An agent that doesn't exist yet is created.
                 With no name, the first idle agent is used, or a new one made.
                 If no bridge is running, one is started in the background for
                 the current folder (log: ~/.mdclaude/bridge.log).
                 Anything after "--" is passed to claude: mdclaude run B -- --resume

stop             Stop a background bridge. Refuses while sessions are connected
                 unless --force is given.
status           Show the bridge's agents and which are connected.
`;

function parseArgs(argv) {
  const out = { cmd: 'serve', port: 41417, workspaceFolders: [], agents: [], quiet: false, agent: null, claudeArgs: [] };
  const rest = [...argv];
  if (['serve', 'start', 'run', 'add', 'stop', 'status'].includes(rest[0])) out.cmd = rest.shift();

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { out.claudeArgs = rest.slice(i + 1); break; }
    if (a === '--port' || a === '-p') out.port = Number(rest[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--agents' || a === '-a') out.agents = parseAgents(rest[++i]);
    else if (a.startsWith('--agents=')) out.agents = parseAgents(a.slice(9));
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if ((out.cmd === 'run' || out.cmd === 'add') && !out.agent) out.agent = a;
    else out.workspaceFolders.push(path.resolve(a));
  }
  if (out.cmd === 'add' && !out.agent) throw new Error('add needs an agent name, e.g. "mdclaude add qa"');
  if (!out.workspaceFolders.length) out.workspaceFolders.push(process.cwd());
  return out;
}

function parseAgents(s) {
  if (/^\d+$/.test(s)) {
    const n = Math.max(1, Math.min(26, Number(s)));
    return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
  }
  const names = String(s).split(',').map((x) => x.trim()).filter(Boolean);
  if (!names.length) throw new Error('--agents needs at least one name');
  if (new Set(names).size !== names.length) throw new Error('--agents names must be unique');
  if (names.includes('*') || names.includes('all')) throw new Error('"*" and "all" are reserved agent names');
  return names;
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket server (server side only)
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, data]);
}

// Parses as many complete frames as are present in buf.
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

class WsConnection {
  constructor(socket, onMessage, onClose, log) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.closed = false;
    this.log = log;
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      const { frames, rest } = decodeFrames(this.buf);
      this.buf = rest;
      for (const f of frames) this.handleFrame(f, onMessage);
    });
    const done = () => {
      if (this.closed) return;
      this.closed = true;
      onClose();
    };
    socket.on('end', () => socket.end());
    socket.on('close', done);
    socket.on('error', done);
  }

  handleFrame(f, onMessage) {
    switch (f.opcode) {
      case 0x0:
        if (this.fragments) {
          this.fragments.parts.push(f.payload);
          if (f.fin) {
            const full = Buffer.concat(this.fragments.parts);
            const op = this.fragments.opcode;
            this.fragments = null;
            if (op === 0x1) onMessage(full.toString('utf8'));
          }
        }
        break;
      case 0x1:
      case 0x2:
        if (!f.fin) this.fragments = { opcode: f.opcode, parts: [f.payload] };
        else if (f.opcode === 0x1) onMessage(f.payload.toString('utf8'));
        break;
      case 0x8:
        try { this.socket.write(encodeFrame(f.payload.subarray(0, 2), 0x8)); } catch {}
        this.socket.end();
        break;
      case 0x9:
        this.socket.write(encodeFrame(f.payload, 0xa));
        break;
      case 0xa:
        break;
      default:
        this.log(`unknown opcode ${f.opcode}, closing`);
        this.socket.end();
    }
  }

  send(text) {
    if (this.closed) return false;
    this.socket.write(encodeFrame(text, 0x1));
    return true;
  }

  ping() {
    if (!this.closed) this.socket.write(encodeFrame(Buffer.alloc(0), 0x9));
  }
}

// ---------------------------------------------------------------------------
// Lock file location
// ---------------------------------------------------------------------------

function lockDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'ide')
    : path.join(os.homedir(), '.claude', 'ide');
}

// ---------------------------------------------------------------------------
// One agent slot = one IDE as far as Claude Code is concerned
// ---------------------------------------------------------------------------

export function createAgentSlot({ name, port, workspaceFolders, log = () => {} }) {
  const ideName = `${IDE_NAME} (${name})`;
  const authToken = crypto.randomBytes(16).toString('hex');
  const clients = new Set();
  let latestSelection = null;
  const lockPath = path.join(lockDir(), `${port}.lock`);

  const tools = [
    { name: 'getCurrentSelection', description: 'Get the current text selection in the rendered markdown viewer', inputSchema: { type: 'object', properties: {} } },
    { name: 'getLatestSelection', description: 'Get the most recent text selection', inputSchema: { type: 'object', properties: {} } },
    { name: 'getOpenEditors', description: 'Get information about open documents', inputSchema: { type: 'object', properties: {} } },
    { name: 'getWorkspaceFolders', description: 'Get all workspace folders', inputSchema: { type: 'object', properties: {} } },
    { name: 'openFile', description: 'Open a file (no-op in the markdown viewer bridge)', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
  ];

  const textResult = (obj) => ({
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }],
  });

  function callTool(toolName, args) {
    switch (toolName) {
      case 'getCurrentSelection':
      case 'getLatestSelection':
        if (!latestSelection || latestSelection.selection?.isEmpty) {
          return textResult({ success: false, message: 'No selection available' });
        }
        return textResult({
          success: true,
          text: latestSelection.text,
          filePath: latestSelection.filePath,
          selection: latestSelection.selection,
        });
      case 'getOpenEditors':
        return textResult({
          tabs: latestSelection
            ? [{ uri: latestSelection.fileUrl, isActive: true, label: path.basename(latestSelection.filePath), languageId: 'markdown', isDirty: false }]
            : [],
        });
      case 'getWorkspaceFolders':
        return textResult({
          success: true,
          folders: workspaceFolders.map((p) => ({ name: path.basename(p), uri: 'file://' + p, path: p })),
          rootPath: workspaceFolders[0],
        });
      case 'openFile':
        return textResult(`Opened file: ${args?.filePath ?? ''}`);
      default:
        return null;
    }
  }

  function handleRpc(conn, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, method, params } = msg;
    const reply = (result) => conn.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const fail = (code, message) => conn.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    if (method === undefined) return;
    const isRequest = id !== undefined && id !== null;

    switch (method) {
      case 'initialize':
        log(`[${name}] claude initialize (client: ${params?.clientInfo?.name ?? '?'} ${params?.clientInfo?.version ?? ''})`);
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'md-select-to-claude', version: VERSION },
        });
      case 'notifications/initialized':
        log(`[${name}] claude connected and initialized`);
        return;
      case 'ping':
        return isRequest ? reply({}) : undefined;
      case 'tools/list':
        return reply({ tools });
      case 'tools/call': {
        const res = callTool(params?.name, params?.arguments);
        if (!res) return fail(-32601, `Unknown tool: ${params?.name}`);
        return reply(res);
      }
      default:
        if (isRequest) return fail(-32601, `Method not found: ${method}`);
    }
  }

  function broadcast(method, params) {
    const text = JSON.stringify({ jsonrpc: '2.0', method, params });
    let n = 0;
    for (const c of clients) if (c.send(text)) n++;
    return n;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end(`${ideName}: websocket only. The HTTP API is on the base port.\n`);
  });

  server.on('upgrade', (req, socket) => {
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const key = req.headers['sec-websocket-key'];
    const token = req.headers['x-claude-code-ide-authorization'];
    if (!key || req.headers['sec-websocket-version'] !== '13') return reject(400, 'Bad Request');
    if (!token || !constantTimeEqual(token, authToken)) {
      log(`[${name}] rejected websocket connection: bad auth token`);
      return reject(401, 'Unauthorized');
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
    const proto = req.headers['sec-websocket-protocol'];
    if (proto) lines.push(`Sec-WebSocket-Protocol: ${String(proto).split(',')[0].trim()}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    socket.setNoDelay(true);

    const conn = new WsConnection(
      socket,
      (text) => handleRpc(conn, text),
      () => { clients.delete(conn); log(`[${name}] claude disconnected (${clients.size} left)`); },
      log,
    );
    clients.add(conn);
    log(`[${name}] websocket connection from claude (${clients.size} total)`);
  });

  const keepalive = setInterval(() => { for (const c of clients) c.ping(); }, 30000);
  keepalive.unref();

  function writeLock() {
    fs.mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ pid: process.pid, workspaceFolders, ideName, transport: 'ws', authToken });
    const tmp = lockPath + '.tmp';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, lockPath);
  }
  function removeLock() { try { fs.unlinkSync(lockPath); } catch {} }

  return {
    name,
    ideName,
    port,
    authToken,
    lockPath,
    clients,
    broadcast,
    get connected() { return clients.size; },
    setSelection(sel) { latestSelection = sel; },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { writeLock(); resolve(); });
      });
    },
    stop() {
      clearInterval(keepalive);
      removeLock();
      for (const c of clients) try { c.socket.destroy(); } catch {}
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge = API server + N agent slots
// ---------------------------------------------------------------------------

const AGENT_NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

export function validateAgentName(name) {
  const n = String(name ?? '').trim();
  if (!AGENT_NAME_RE.test(n)) throw new Error(`invalid agent name "${name}": use letters, digits, - or _ (max 32)`);
  if (n === 'all') throw new Error('"all" is a reserved agent name');
  return n;
}

export function createBridge(opts) {
  const { port, workspaceFolders, log = () => {} } = opts;
  const agentNames = (opts.agents ?? []).map(validateAgentName);
  const slots = agentNames.map((name, i) => createAgentSlot({ name, port: port + 1 + i, workspaceFolders, log }));
  const byName = new Map(slots.map((s) => [s.name, s]));
  const findByName = (name) => byName.get(String(name)) ?? slots.find((s) => s.name.toLowerCase() === String(name).toLowerCase());

  // Add a slot while running: next free port after the last slot.
  async function addAgent(rawName) {
    const name = validateAgentName(rawName);
    if (findByName(name)) throw new Error(`agent "${name}" already exists`);
    let p = Math.max(port, ...slots.map((s) => s.port)) + 1;
    for (let tries = 0; tries < 50; tries++, p++) {
      const slot = createAgentSlot({ name, port: p, workspaceFolders, log });
      try {
        await slot.start();
        slots.push(slot);
        byName.set(name, slot);
        log(`added agent ${name} ("${slot.ideName}") on port ${p}`);
        return slot;
      } catch (e) {
        if (e?.code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error('no free port for a new agent');
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(body));
  }

  // body lines are 1-based inclusive (human numbering); Claude wants 0-based.
  function toSelection(body) {
    const filePath = String(body.filePath);
    const lineStart = Math.max(1, Number(body.lineStart) || 1);
    const lineEnd = Math.max(lineStart, Number(body.lineEnd) || lineStart);
    const text = typeof body.text === 'string' ? body.text : '';
    return {
      text,
      filePath,
      fileUrl: 'file://' + filePath,
      selection: {
        start: { line: lineStart - 1, character: 0 },
        end: { line: lineEnd - 1, character: Number(body.endCharacter) || 0 },
        isEmpty: text.length === 0,
      },
      lineStart,
      lineEnd,
    };
  }

  // Which slots a request targets: a name, "*"/"all", or (default) every slot.
  function targets(agent) {
    if (agent === undefined || agent === null || agent === '' || agent === '*' || agent === 'all') return slots;
    const s = findByName(agent);
    return s ? [s] : null;
  }

  function statusBody() {
    return {
      ok: true,
      ideName: IDE_NAME,
      version: VERSION,
      pid: process.pid,
      port,
      workspaceFolders,
      agents: slots.map((s) => ({ name: s.name, ideName: s.ideName, port: s.port, connected: s.connected })),
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    try {
      if (req.method === 'GET' && url.pathname === '/status') return sendJson(res, 200, statusBody());

      if (req.method === 'POST' && url.pathname === '/agents') {
        const body = await readJson(req);
        try {
          const slot = await addAgent(body.name);
          return sendJson(res, 201, { ok: true, agent: { name: slot.name, ideName: slot.ideName, port: slot.port, connected: 0 } });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message, agents: slots.map((s) => s.name) });
        }
      }

      if (req.method === 'POST' && (url.pathname === '/mention' || url.pathname === '/selection')) {
        const body = await readJson(req);
        if (!body.filePath) return sendJson(res, 400, { ok: false, error: 'filePath required' });
        const to = targets(body.agent);
        if (!to) return sendJson(res, 404, { ok: false, error: `unknown agent "${body.agent}"`, agents: slots.map((s) => s.name) });
        const sel = toSelection(body);
        const selParams = { text: sel.text, filePath: sel.filePath, fileUrl: sel.fileUrl, selection: sel.selection };
        const delivered = [];
        for (const s of to) {
          const n = s.broadcast('selection_changed', selParams);
          if (n > 0) s.setSelection(sel);
          if (url.pathname === '/mention') {
            s.broadcast('at_mentioned', { filePath: sel.filePath, lineStart: sel.selection.start.line, lineEnd: sel.selection.end.line });
          }
          if (n > 0) delivered.push(s.name);
        }
        if (url.pathname === '/mention') {
          log(`@mention ${path.basename(sel.filePath)} L${sel.lineStart}-${sel.lineEnd} -> ${delivered.length ? delivered.join(', ') : 'nobody'} (asked: ${to.map((s) => s.name).join(', ')})`);
        }
        return sendJson(res, 200, {
          ok: true,
          delivered,
          notConnected: to.filter((s) => !delivered.includes(s.name)).map((s) => s.name),
          lineStart: sel.lineStart,
          lineEnd: sel.lineEnd,
        });
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  });

  return {
    port,
    slots,
    addAgent,
    status: statusBody,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      try {
        for (const s of slots) await s.start();
      } catch (e) {
        await this.stop();
        throw e;
      }
    },
    async stop() {
      for (const s of slots) await s.stop();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function fetchStatus(port, timeoutMs = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

function cmdServe(args) {
  const log = args.quiet ? () => {} : (m) => console.log(`[mdclaude] ${m}`);
  const bridge = createBridge({ port: args.port, workspaceFolders: args.workspaceFolders, agents: args.agents, log });

  bridge.start().then(() => {
    console.log(`[mdclaude] api:       http://127.0.0.1:${args.port}`);
    console.log(`[mdclaude] workspace: ${args.workspaceFolders.join(', ')}`);
    if (bridge.slots.length) {
      console.log('[mdclaude] agents:');
      for (const s of bridge.slots) console.log(`    ${s.name.padEnd(8)} "${s.ideName}"  ws port ${s.port}`);
    } else {
      console.log('[mdclaude] agents:    none yet');
    }
    console.log('');
    console.log('Start a Claude Code session as an agent with:   mdclaude run <name>');
    console.log('Attach one you already have open:  mdclaude add <name>, then /ide in it.');
    console.log('');
    console.log('Then highlight text in Chrome and right-click > "Send to Claude Code" > agent.');
  }).catch((e) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`[mdclaude] a port in ${args.port}..${args.port + args.agents.length} is already in use. Is another bridge running? Use --port to change it.`);
    } else {
      console.error('[mdclaude] failed to start:', e?.message ?? e);
    }
    process.exit(1);
  });

  const shutdown = () => { bridge.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown); // terminal closed: still clean up lock files
  process.on('exit', () => { for (const s of bridge.slots) try { fs.unlinkSync(s.lockPath); } catch {} });
}

async function ensureBridge(args) {
  let status = await fetchStatus(args.port);
  if (status) return { status, started: false };

  const logDir = path.join(os.homedir(), '.mdclaude');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'bridge.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), 'serve', ...args.workspaceFolders,
    '--port', String(args.port), ...(args.agents.length ? ['--agents', args.agents.join(',')] : []),
  ], { detached: true, stdio: ['ignore', out, out] });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    status = await fetchStatus(args.port);
    if (status) return { status, started: true, logPath };
  }
  throw new Error(`bridge did not come up on port ${args.port}; see ${logPath}`);
}

async function addAgentRemote(port, name) {
  const res = await fetch(`http://127.0.0.1:${port}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${body.error}${body.agents ? ` (existing: ${body.agents.join(', ')})` : ''}`);
  console.log(`[mdclaude] added agent ${body.agent.name}`);
  return body.agent;
}

async function cmdRun(args) {
  const { status, started } = await ensureBridge(args);
  if (started) {
    console.log(`[mdclaude] started bridge in the background for ${args.workspaceFolders.join(', ')} (stop it with: mdclaude stop)`);
  }
  const cwd = process.cwd();
  const inWorkspace = status.workspaceFolders.some((w) => cwd === w || cwd.startsWith(w.replace(/\/$/, '') + path.sep));
  if (!inWorkspace) {
    console.log(`[mdclaude] note: the running bridge serves ${status.workspaceFolders.join(', ')}, not this folder.`);
    console.log('[mdclaude]       this session will still connect, but "mdclaude stop" then "mdclaude run" here would re-home it.');
  }
  let slot;
  if (args.agent) {
    const want = args.agent.toLowerCase();
    slot = status.agents.find((a) => a.name.toLowerCase() === want);
    if (!slot) slot = await addAgentRemote(args.port, args.agent);
  } else {
    // No name given: first agent nobody is using, else a new lettered one.
    slot = status.agents.find((a) => !a.connected);
    if (!slot) {
      const taken = new Set(status.agents.map((a) => a.name.toUpperCase()));
      let letter = 'A';
      while (taken.has(letter)) letter = String.fromCharCode(letter.charCodeAt(0) + 1);
      slot = await addAgentRemote(args.port, letter);
    }
  }
  if (slot.connected) {
    console.log(`[mdclaude] note: agent ${slot.name} already has ${slot.connected} session connected; this one will share it.`);
  }
  console.log(`[mdclaude] launching claude as agent ${slot.name} ("${slot.ideName}")`);
  const r = spawnSync('claude', args.claudeArgs, {
    stdio: 'inherit',
    env: { ...process.env, ENABLE_IDE_INTEGRATION: 'true', CLAUDE_CODE_SSE_PORT: String(slot.port) },
  });
  if (r.error) {
    console.error(`[mdclaude] could not launch claude: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

async function cmdStart(args) {
  const { status, started } = await ensureBridge(args);
  console.log(started
    ? `[mdclaude] bridge started in the background for ${args.workspaceFolders.join(', ')}`
    : `[mdclaude] bridge already running for ${status.workspaceFolders.join(', ')}`);
  if (status.agents.length) {
    for (const a of status.agents) console.log(`    ${a.name.padEnd(8)} "${a.ideName}"${a.connected ? '  connected' : ''}`);
    console.log('In each open Claude Code, type /ide and pick its entry. Or: mdclaude run <agent>');
  } else {
    console.log('    no agents yet. Name one with "mdclaude add <name>" (then /ide in an open');
    console.log('    Claude Code) or open a new session with "mdclaude run <name>".');
  }
}

async function cmdAdd(args) {
  const status = await fetchStatus(args.port);
  if (!status) { console.error(`[mdclaude] no bridge running on port ${args.port}; run "mdclaude start" first`); process.exit(1); }
  const agent = await addAgentRemote(args.port, args.agent);
  console.log(`[mdclaude] in a Claude Code session, type /ide and pick "${agent.ideName}"`);
}

async function cmdStop(args) {
  const status = await fetchStatus(args.port);
  if (!status) { console.log(`[mdclaude] no bridge running on port ${args.port}`); return; }
  const live = status.agents.filter((a) => a.connected);
  if (live.length && !args.force) {
    console.error(`[mdclaude] not stopping: ${live.length} session(s) still connected (${live.map((a) => a.name).join(', ')})`);
    console.error(`[mdclaude] bridge serves ${status.workspaceFolders.join(', ')}. Use "mdclaude stop --force" to disconnect them.`);
    process.exit(1);
  }
  try {
    process.kill(status.pid, 'SIGTERM');
    console.log(`[mdclaude] stopped bridge (pid ${status.pid})`);
  } catch (e) {
    console.error(`[mdclaude] could not stop pid ${status.pid}: ${e.message}`);
    process.exit(1);
  }
}

async function cmdStatus(args) {
  const status = await fetchStatus(args.port);
  if (!status) { console.log(`[mdclaude] no bridge running on port ${args.port}`); process.exit(1); }
  console.log(`[mdclaude] bridge pid ${status.pid}, workspace: ${status.workspaceFolders.join(', ')}`);
  if (!status.agents.length) console.log('    no agents yet');
  for (const a of status.agents) {
    console.log(`    ${a.name.padEnd(8)} ${a.connected ? `connected (${a.connected})` : 'not connected'}   "${a.ideName}"  port ${a.port}`);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`[mdclaude] ${e.message}\n`); console.error(HELP); process.exit(1); }

  const run = { serve: cmdServe, start: cmdStart, run: cmdRun, add: cmdAdd, stop: cmdStop, status: cmdStatus }[args.cmd];
  Promise.resolve(run(args)).catch((e) => {
    console.error(`[mdclaude] ${e?.message ?? e}`);
    process.exit(1);
  });
}
