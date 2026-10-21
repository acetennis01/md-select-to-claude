import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchSelection, normalizeWords } from '../extension/matcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, 'fixtures', 'spec.md'), 'utf8');
const lines = raw.split('\n');

// helper: 1-based line numbers in assertions, since that's what humans read
const range = (m) => [m.startLine + 1, m.endLine + 1];
const lineNo = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;

test('normalizeWords strips markdown syntax', () => {
  assert.equal(normalizeWords('## **Hello**, _world_! `code` [link](http://x)'), 'hello world code link http x');
});

test('selection inside one paragraph maps to that line', () => {
  const m = matchSelection(raw, 'turns a cart into an order');
  assert.equal(m.confidence, 'exact');
  assert.deepEqual(range(m), [lineNo('turns a cart into an order'), lineNo('turns a cart into an order')]);
});

test('selection across a soft-wrapped paragraph spans both source lines', () => {
  // rendered: "It owns pricing, tax, and payment capture" (wrap removed)
  const m = matchSelection(raw, 'It owns pricing, tax, and payment capture');
  assert.equal(m.confidence, 'exact');
  assert.deepEqual(range(m), [lineNo('It owns pricing, tax,'), lineNo('and payment capture')]);
});

test('bold/italic/code rendered text matches source with markers', () => {
  const m = matchSelection(raw, 'it is the only writer of the orders table.');
  assert.equal(m.confidence, 'exact');
  assert.deepEqual(range(m), [lineNo('writer of the'), lineNo('writer of the')]);
});

test('list items: selecting two bullets spans both', () => {
  const m = matchSelection(raw, 'Carts expire after 30 minutes of inactivity.\nA cart may hold at most 50 line items.');
  assert.deepEqual(range(m), [lineNo('Carts expire'), lineNo('at most 50')]);
});

test('bullet with a hard-wrapped continuation line', () => {
  const m = matchSelection(raw, 'Prices are locked when the user reaches the payment step, and they stay locked for 10 minutes even if the catalog changes.');
  assert.equal(m.confidence, 'exact');
  assert.deepEqual(range(m), [lineNo('Prices are locked'), lineNo('locked for 10 minutes')]);
});

test('link text (url hidden in rendered view) still matches', () => {
  const m = matchSelection(raw, 'Tax is computed by the tax service using the shipping address, never the billing address.');
  assert.deepEqual(range(m), [lineNo('Tax is computed'), lineNo('never the billing')]);
});

test('ordered list numbers are not in the rendered selection', () => {
  const m = matchSelection(raw, 'Authorize the card for the full amount.\nCapture only after the warehouse confirms stock.');
  assert.deepEqual(range(m), [lineNo('Authorize the card'), lineNo('Capture only after')]);
});

test('blockquote across lines', () => {
  const m = matchSelection(raw, 'Note: refunds are out of scope for v1 and are handled by the returns service.');
  assert.equal(m.confidence, 'exact');
  assert.deepEqual(range(m), [lineNo('Note: refunds'), lineNo('returns service')]);
});

test('table cells (rendered as tab-separated text)', () => {
  const m = matchSelection(raw, 'POST\t/checkout\tStart checkout\nPOST\t/checkout/{id}\tSubmit payment');
  assert.deepEqual(range(m), [lineNo('Start checkout'), lineNo('Submit payment')]);
});

test('code block contents', () => {
  const m = matchSelection(raw, '"cartId": "abc123",\n  "paymentMethod": "card"');
  assert.deepEqual(range(m), [lineNo('cartId'), lineNo('paymentMethod')]);
});

test('heading selection', () => {
  const m = matchSelection(raw, '2.1 Payment capture');
  assert.deepEqual(range(m), [lineNo('### 2.1'), lineNo('### 2.1')]);
});

test('a whole section from heading through bullets', () => {
  const m = matchSelection(raw, '4. Open questions\nShould we support split payments? The team leans no.\nWhat happens when the tax service is down?');
  assert.deepEqual(range(m), [lineNo('## 4. Open'), lineNo('tax service is down')]);
});

test('repeated phrase picks the occurrence closest to the selection length', () => {
  // "POST" appears twice; "tax service" appears twice; a selection that starts
  // at the second "tax service" must not jump to the first.
  const m = matchSelection(raw, 'tax service is down?');
  assert.deepEqual(range(m), [lineNo('tax service is down'), lineNo('tax service is down')]);
});

test('single word selection', () => {
  const m = matchSelection(raw, 'inactivity');
  assert.deepEqual(range(m), [lineNo('inactivity'), lineNo('inactivity')]);
});

test('smart quotes / typographer differences are tolerated', () => {
  const m = matchSelection(raw, 'The team leans no…'); // ellipsis instead of "."
  assert.deepEqual(range(m), [lineNo('team leans no'), lineNo('team leans no')]);
});

test('returns null for text not in the file', () => {
  assert.equal(matchSelection(raw, 'this sentence does not exist anywhere'), null);
  assert.equal(matchSelection(raw, '   '), null);
});
