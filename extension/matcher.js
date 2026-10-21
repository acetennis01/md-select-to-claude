// Maps text selected in a *rendered* markdown page back to line numbers in
// the *raw* markdown source.
//
// Approach: normalize both sides down to lowercase alphanumeric words (which
// throws away all markdown syntax: #, *, _, `, [](), >, |, list markers...),
// then locate the first few words and the last few words of the selection in
// the normalized source. Each character of the normalized source remembers
// which raw line it came from, so the match gives a line range directly.
//
// Pure module: no DOM, no chrome.* APIs. Used by the extension's service
// worker and by the node tests.

export function normalizeWords(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function buildIndex(raw) {
  const lines = String(raw).split(/\r?\n/);
  let text = '';
  const lineOf = []; // lineOf[i] = 0-based raw line of text[i]
  for (let i = 0; i < lines.length; i++) {
    const n = normalizeWords(lines[i]);
    if (!n) continue;
    if (text) {
      text += ' ';
      lineOf.push(i);
    }
    for (let k = 0; k < n.length; k++) lineOf.push(i);
    text += n;
  }
  return { text, lineOf, lineCount: lines.length, lines };
}

function findAll(hay, needle, from = 0) {
  const out = [];
  let i = hay.indexOf(needle, from);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * @param {string} raw       raw markdown file contents
 * @param {string} selection text the user selected in the rendered view
 * @param {object} [opts]
 * @param {number} [opts.maxWords=8] words used for the start/end anchors
 * @returns {{ startLine:number, endLine:number, confidence:'exact'|'approximate', words:number } | null}
 *          lines are 0-based inclusive
 */
export function matchSelection(raw, selection, opts = {}) {
  const maxWords = opts.maxWords ?? 8;
  const idx = buildIndex(raw);
  const selNorm = normalizeWords(selection);
  const selWords = selNorm ? selNorm.split(' ') : [];
  if (!selWords.length || !idx.text) return null;

  const hay = ' ' + idx.text + ' ';
  const selLen = selNorm.length;

  for (let k = Math.min(maxWords, selWords.length); k >= 1; k--) {
    const startPhrase = ' ' + selWords.slice(0, k).join(' ') + ' ';
    const endPhrase = ' ' + selWords.slice(-k).join(' ') + ' ';
    const starts = findAll(hay, startPhrase);
    if (!starts.length) continue;
    const ends = findAll(hay, endPhrase);
    if (!ends.length) continue;

    let best = null;
    for (const s of starts) {
      const startTextIdx = s; // hay[s] is the leading space; first char of word is hay[s+1] = text[s]
      for (const e of ends) {
        const endTextIdx = e + endPhrase.length - 3; // last char of last word in text coords
        if (endTextIdx < startTextIdx + (startPhrase.length - 3)) continue; // end before start
        const span = endTextIdx - startTextIdx + 1;
        if (span < selLen * 0.5) continue; // can't be shorter than half the selection
        const score = Math.abs(span - selLen);
        if (!best || score < best.score) best = { startTextIdx, endTextIdx, score, span };
      }
    }
    if (!best) continue;

    const slice = idx.text.slice(best.startTextIdx, best.endTextIdx + 1);
    const confidence = slice === selNorm ? 'exact' : 'approximate';
    return {
      startLine: idx.lineOf[best.startTextIdx],
      endLine: idx.lineOf[best.endTextIdx],
      confidence,
      words: k,
    };
  }
  return null;
}

/** Length of raw line (for selection end character). */
export function lineLength(raw, line) {
  const lines = String(raw).split(/\r?\n/);
  return lines[line]?.length ?? 0;
}
