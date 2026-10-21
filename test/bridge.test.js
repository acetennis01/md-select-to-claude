// Exercises the bridge the way Claude Code does: websocket upgrade with the
// auth header, MCP initialize/tools handshake, and receiving at_mentioned /
// selection_changed notifications when the HTTP API is hit. Two agent slots
// are used to check routing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, encodeFrame, decodeFrames } from '../bridge/bridge.js';

const PORT = 41900 + Math.floor(Math.random() * 90);
const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'mdclaude-test-'));
process.env.CLAUDE_CONFIG_DIR = tmpConfig;

let bridge;
before(async () => {
  bridge = createBridge({ port: PORT, workspaceFolders: ['/tmp/ws'], agents: ['A', 'B'], log: () => {} });
  await bridge.start();
});
after(async () => {
  await bridge.stop();
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

// --- a tiny masked-frame websocket client (what Claude Code is, to us) -----
function maskedFrame(text) {
  const f = encodeFrame(text, 0x1);
  const mask = crypto.randomBytes(4);
  const lenByte = f[1];
  const hdrLen = lenByte < 126 ? 2 : lenByte === 126 ? 4 : 10;
  const header = Buffer.from(f.subarray(0, hdrLen));
  header[1] |= 0x80;
  const payload = Buffer.from(f.subarray(hdrLen));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, payload]);
}

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'x-claude-code-ide-authorization': token,
      },
    });
    req.on('upgrade', (res, socket) => {
      const client = {
        socket,
        inbox: [],
        waiters: [],
        buf: Buffer.alloc(0),
        send(obj) { socket.write(maskedFrame(JSON.stringify(obj))); },
        next(timeoutMs = 2000) {
          if (this.inbox.length) return Promise.resolve(this.inbox.shift());
          return new Promise((r, j) => {
            const t = setTimeout(() => j(new Error('timeout waiting for message')), timeoutMs);
            this.waiters.push((m) => { clearTimeout(t); r(m); });
          });
        },
        async expectNothing(ms = 150) {
          await new Promise((r) => setTimeout(r, ms));
          assert.equal(this.inbox.length, 0, `expected no message, got ${JSON.stringify(this.inbox)}`);
        },
        close() { socket.destroy(); },
      };
      socket.on('data', (chunk) => {
        client.buf = Buffer.concat([client.buf, chunk]);
        const { frames, rest } = decodeFrames(client.buf);
        client.buf = rest;
        for (const f of frames) {
          if (f.opcode !== 0x1) continue;
          const msg = JSON.parse(f.payload.toString('utf8'));
          const w = client.waiters.shift();
          if (w) w(msg); else client.inbox.push(msg);
        }
      });
      resolve({ status: res.statusCode, client });
    });
    req.on('response', (res) => resolve({ status: res.statusCode, client: null }));
    req.on('error', reject);
    req.end();
  });
}

async function handshake(client) {
  client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } } });
  const init = await client.next();
  assert.equal(init.result.protocolVersion, '2024-11-05');
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const post = (p, body) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const status = () => fetch(`http://127.0.0.1:${PORT}/status`).then((r) => r.json());

test('writes one lock file per agent slot, with distinct IDE names', () => {
  const [a, b] = bridge.slots;
  assert.equal(a.port, PORT + 1);
  assert.equal(b.port, PORT + 2);
  for (const s of [a, b]) {
    const lock = JSON.parse(fs.readFileSync(path.join(tmpConfig, 'ide', `${s.port}.lock`), 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.transport, 'ws');
    assert.equal(lock.ideName, `Markdown Viewer (${s.name})`);
    assert.deepEqual(lock.workspaceFolders, ['/tmp/ws']);
    assert.match(lock.authToken, /^[0-9a-f]{32}$/);
    assert.equal(lock.authToken, s.authToken);
  }
  assert.notEqual(a.authToken, b.authToken);
  // the API port is not advertised as an IDE
  assert.ok(!fs.existsSync(path.join(tmpConfig, 'ide', `${PORT}.lock`)));
});

test('rejects a websocket connection with the wrong token', async () => {
  const { status: st, client } = await connect(PORT + 1, '0'.repeat(32));
  assert.equal(st, 401);
  assert.equal(client, null);
});

test("agent A's token does not open agent B's slot", async () => {
  const { status: st } = await connect(PORT + 2, bridge.slots[0].authToken);
  assert.equal(st, 401);
});

test('MCP handshake, tools, routing between two agents', async () => {
  const [slotA, slotB] = bridge.slots;
  const { status: sa, client: A } = await connect(slotA.port, slotA.authToken);
  assert.equal(sa, 101);
  await handshake(A);

  // only A connected so far
  let s = await status();
  assert.deepEqual(s.agents.map((a) => [a.name, a.connected]), [['A', 1], ['B', 0]]);

  A.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (await A.next()).result.tools.map((t) => t.name);
  assert.ok(names.includes('getCurrentSelection'));
  assert.ok(names.includes('getWorkspaceFolders'));

  A.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual((await A.next()).result, {});

  // mention to B while B is not connected: nothing delivered, A hears nothing
  let res = await post('/mention', { agent: 'B', filePath: '/tmp/ws/a.md', lineStart: 3, lineEnd: 4, text: 'x' });
  assert.deepEqual(res.delivered, []);
  assert.deepEqual(res.notConnected, ['B']);
  await A.expectNothing();

  // unknown agent
  res = await post('/mention', { agent: 'Z', filePath: '/tmp/ws/a.md', lineStart: 1, lineEnd: 1, text: 'x' });
  assert.equal(res.ok, false);
  assert.deepEqual(res.agents, ['A', 'B']);

  // connect B
  const { client: B } = await connect(slotB.port, slotB.authToken);
  await handshake(B);
  s = await status();
  assert.deepEqual(s.agents.map((a) => [a.name, a.connected]), [['A', 1], ['B', 1]]);

  // mention to A only (1-based lines in, 0-based out)
  res = await post('/mention', { agent: 'A', filePath: '/tmp/ws/a.md', lineStart: 12, lineEnd: 15, text: 'hello world', endCharacter: 7 });
  assert.deepEqual(res.delivered, ['A']);
  assert.deepEqual(res.notConnected, []);
  const sel = await A.next();
  assert.equal(sel.method, 'selection_changed');
  assert.deepEqual(sel.params.selection, { start: { line: 11, character: 0 }, end: { line: 14, character: 7 }, isEmpty: false });
  const at = await A.next();
  assert.equal(at.method, 'at_mentioned');
  assert.deepEqual(at.params, { filePath: '/tmp/ws/a.md', lineStart: 11, lineEnd: 14 });
  await B.expectNothing();

  // A's tool reflects its selection; B's does not
  A.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'getCurrentSelection', arguments: {} } });
  assert.equal(JSON.parse((await A.next()).result.content[0].text).text, 'hello world');
  B.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'getCurrentSelection', arguments: {} } });
  assert.equal(JSON.parse((await B.next()).result.content[0].text).success, false);

  // same doc to both agents at once
  res = await post('/mention', { agent: '*', filePath: '/tmp/ws/a.md', lineStart: 20, lineEnd: 20, text: 'shared' });
  assert.deepEqual(res.delivered, ['A', 'B']);
  for (const c of [A, B]) {
    assert.equal((await c.next()).method, 'selection_changed');
    const m = await c.next();
    assert.equal(m.method, 'at_mentioned');
    assert.deepEqual(m.params, { filePath: '/tmp/ws/a.md', lineStart: 19, lineEnd: 19 });
  }

  // different docs to different agents, concurrently
  await Promise.all([
    post('/mention', { agent: 'A', filePath: '/tmp/ws/a.md', lineStart: 1, lineEnd: 1, text: 'a' }),
    post('/mention', { agent: 'B', filePath: '/tmp/ws/b.md', lineStart: 2, lineEnd: 2, text: 'b' }),
  ]);
  await A.next(); // selection_changed
  assert.equal((await A.next()).params.filePath, '/tmp/ws/a.md');
  await B.next();
  assert.equal((await B.next()).params.filePath, '/tmp/ws/b.md');
  await A.expectNothing();
  await B.expectNothing();

  // live selection (no agent given) goes everywhere, as selection_changed only
  await post('/selection', { filePath: '/tmp/ws/a.md', lineStart: 1, lineEnd: 1, text: '' });
  for (const c of [A, B]) {
    const m = await c.next();
    assert.equal(m.method, 'selection_changed');
    assert.equal(m.params.selection.isEmpty, true);
    await c.expectNothing();
  }

  // unknown method -> JSON-RPC error
  A.send({ jsonrpc: '2.0', id: 6, method: 'nope' });
  assert.equal((await A.next()).error.code, -32601);

  A.close();
  B.close();
  const deadline = Date.now() + 2000;
  do {
    await new Promise((r) => setTimeout(r, 25));
    s = await status();
  } while (s.agents.some((a) => a.connected) && Date.now() < deadline);
  assert.deepEqual(s.agents.map((a) => a.connected), [0, 0]);
});

test('agents can be added at runtime and routed to', async () => {
  const before = (await status()).agents.length;
  const added = await post('/agents', { name: 'qa' });
  assert.equal(added.ok, true);
  assert.equal(added.agent.name, 'qa');
  assert.equal(added.agent.ideName, 'Markdown Viewer (qa)');
  assert.equal(added.agent.port, PORT + before + 1);

  const s = await status();
  assert.equal(s.agents.length, before + 1);
  const slot = bridge.slots.find((x) => x.name === 'qa');
  assert.ok(fs.existsSync(slot.lockPath));

  // duplicate / invalid / reserved names are refused
  assert.equal((await post('/agents', { name: 'QA' })).ok, false);
  assert.equal((await post('/agents', { name: 'all' })).ok, false);
  assert.equal((await post('/agents', { name: 'has space' })).ok, false);
  assert.equal((await post('/agents', { name: '' })).ok, false);

  // the new slot receives mentions (case-insensitive lookup)
  const { client } = await connect(slot.port, slot.authToken);
  await handshake(client);
  const res = await post('/mention', { agent: 'QA', filePath: '/tmp/ws/q.md', lineStart: 5, lineEnd: 5, text: 'q' });
  assert.deepEqual(res.delivered, ['qa']);
  await client.next();
  assert.deepEqual((await client.next()).params, { filePath: '/tmp/ws/q.md', lineStart: 4, lineEnd: 4 });
  client.close();
});

test('removing one agent leaves the others and the bridge running', async () => {
  const names = () => bridge.slots.map((s) => s.name);
  assert.ok(names().includes('qa'));
  const qa = bridge.slots.find((s) => s.name === 'qa');
  const { client } = await connect(qa.port, qa.authToken);
  await handshake(client);

  const res = await fetch(`http://127.0.0.1:${PORT}/agents/qa`, { method: 'DELETE' }).then((r) => r.json());
  assert.equal(res.ok, true);
  assert.equal(res.name, 'qa');
  assert.equal(res.disconnected, 1);
  assert.ok(!names().includes('qa'));
  assert.ok(!fs.existsSync(qa.lockPath));

  // its port is closed, the rest still answer
  await assert.rejects(connect(qa.port, qa.authToken));
  const s = await status();
  assert.deepEqual(s.agents.map((a) => a.name), ['A', 'B']);
  for (const slot of bridge.slots) assert.ok(fs.existsSync(slot.lockPath));

  // unknown name
  const bad = await fetch(`http://127.0.0.1:${PORT}/agents/nope`, { method: 'DELETE' }).then((r) => r.json());
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.agents, ['A', 'B']);

  // can be re-added afterwards
  assert.equal((await post('/agents', { name: 'qa' })).ok, true);
});

test('large payloads use the 16-bit / 64-bit length forms', () => {
  for (const n of [10, 200, 70000]) {
    const text = 'x'.repeat(n);
    const { frames, rest } = decodeFrames(encodeFrame(text));
    assert.equal(frames.length, 1);
    assert.equal(rest.length, 0);
    assert.equal(frames[0].payload.toString(), text);
  }
});

test('a bridge starts with no agents unless told otherwise', async () => {
  const b0 = createBridge({ port: PORT + 20, workspaceFolders: ['/tmp/ws'] });
  await b0.start();
  assert.equal(b0.slots.length, 0);
  const s = await fetch(`http://127.0.0.1:${PORT + 20}/status`).then((r) => r.json());
  assert.deepEqual(s.agents, []);
  // a mention with nobody to route to is accepted but delivered to no one
  const res = await fetch(`http://127.0.0.1:${PORT + 20}/mention`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: '*', filePath: '/tmp/ws/a.md', lineStart: 1, lineEnd: 1, text: 'x' }),
  }).then((r) => r.json());
  assert.deepEqual(res.delivered, []);
  const added = await b0.addAgent('first');
  assert.equal(added.port, PORT + 21);
  await b0.stop();
});

test('stop removes every lock file', async () => {
  const b2 = createBridge({ port: PORT + 10, workspaceFolders: ['/tmp/ws'], agents: ['x', 'y', 'z'] });
  await b2.start();
  for (const s of b2.slots) assert.ok(fs.existsSync(s.lockPath));
  await b2.stop();
  for (const s of b2.slots) assert.ok(!fs.existsSync(s.lockPath));
});
