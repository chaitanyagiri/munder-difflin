'use strict';

/**
 * #141 — "garbled text" in the thought bubbles. The pty scrape stripped ONLY
 * SGR color codes, so the CLI's cursor-movement repaints leaked into bubble
 * text as "all␛[1Cthree␛[1Cland…". Cursor-forward must become the spaces it
 * stands for; every other escape flavor is control, not content.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { stripAnsi, splitTrailingPartialEscape, MAX_ESC_CARRY } = loadTs('src/shared/ansiText.ts');

test('translates cursor-forward into spaces (the issue #141 capture)', () => {
  // Reconstructed from the screenshot attached to the issue: the CLI repaints
  // its interim-message line using ESC[1C to skip over columns.
  const raw =
    'all three land\x1b[1Cd.\x1b[1CSynth\x1b[1Csizing now,\x1b[1Cthen\x1b[1Cwriting' +
    '\x1b[1Cthe\x1b[1CSlack-ready\x1b[1Cresult\x1b[1Cand\x1b[1Creplying\x1b[1Cto' +
    '\x1b[1Cthe\x1b[1Chuman.\x1b[14;6H';
  assert.equal(
    stripAnsi(raw),
    'all three land d. Synth sizing now, then writing the Slack-ready result and replying to the human.'
  );
});

test('a multi-column forward becomes that many spaces (never fuses words)', () => {
  assert.equal(stripAnsi('col\x1b[3Cnext'), 'col   next');
  assert.equal(stripAnsi('a\x1b[Cb'), 'a b', 'a bare ESC[C means forward one');
});

test('SGR color codes are still stripped', () => {
  assert.equal(stripAnsi('\x1b[36m● Read\x1b[0m foo.ts'), '● Read foo.ts');
  assert.equal(stripAnsi('\x1b[1;38;5;208mbold orange\x1b[m'), 'bold orange');
});

test('cursor addressing, erases, and private modes are control, not content', () => {
  assert.equal(stripAnsi('\x1b[2J\x1b[?25lhi\x1b[K\x1b[10;4H there\x1b[?25h'), 'hi there');
  assert.equal(stripAnsi('up\x1b[2A\x1b[5Ddown'), 'updown');
});

test('OSC strings (window title, hyperlinks) vanish entirely', () => {
  assert.equal(stripAnsi('\x1b]0;my title\x07text'), 'text');
  assert.equal(stripAnsi('\x1b]8;;https://x.dev\x1b\\link\x1b]8;;\x1b\\'), 'link');
});

test('stray two-byte escapes and charset selects go too', () => {
  assert.equal(stripAnsi('\x1b7saved\x1b8'), 'saved');
  assert.equal(stripAnsi('\x1b(Bascii'), 'ascii');
});

test('plain text — unicode included — passes through untouched', () => {
  const s = '● Bash npm test — 131/131 ✔ (déjà vu)';
  assert.equal(stripAnsi(s), s);
});

// — split-across-chunks (PTY reads land on arbitrary byte boundaries) —

/** Feed chunks the way usePtyParser does: hold the carry, prepend to the next. */
function scrapeChunks(chunks) {
  let carry = '';
  let out = '';
  for (const c of chunks) {
    const r = splitTrailingPartialEscape(carry + c);
    carry = r.carry;
    out += stripAnsi(r.text);
  }
  return out;
}

test('an escape split across two chunks reassembles instead of leaking as text', () => {
  assert.equal(scrapeChunks(['all\x1b[1', 'Cthree']), 'all three', 'CSI split mid-parameters');
  assert.equal(scrapeChunks(['hi\x1b', '[2Jthere']), 'hithere', 'split right after ESC');
  assert.equal(scrapeChunks(['x\x1b]0;tit', 'le\x07y']), 'xy', 'OSC split mid-title');
  assert.equal(scrapeChunks(['a\x1b(', 'Bb']), 'ab', 'charset select split');
});

test('a completed sequence at end-of-chunk is NOT held back', () => {
  const r = splitTrailingPartialEscape('done\x1b[2m');
  assert.equal(r.text, 'done\x1b[2m');
  assert.equal(r.carry, '');
});

test('text with no escapes carries nothing', () => {
  assert.deepEqual(splitTrailingPartialEscape('plain'), { text: 'plain', carry: '' });
});

test('a pathological partial past the bound is let through, not held forever', () => {
  const runaway = 'x\x1b]0;' + 't'.repeat(MAX_ESC_CARRY + 10);
  const r = splitTrailingPartialEscape(runaway);
  assert.equal(r.carry, '', 'gives up rather than stall the bubble');
  assert.equal(r.text, runaway);
});
