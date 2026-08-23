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

const { stripAnsi } = loadTs('src/renderer/src/components/ansiText.ts');

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

// An escape split across two pty chunks must not leak its tail as text.
const { createAnsiStripper, MAX_CARRY } = loadTs('src/renderer/src/components/ansiText.ts');

function feed(chunks) {
  const strip = createAnsiStripper();
  return chunks.map(strip).join('');
}

test('stream: SGR split mid-params joins cleanly', () => {
  assert.equal(feed(['a\x1b[3', '2mb\x1b[0m']), 'ab');
  assert.equal(feed(['a\x1b', '[32mb']), 'ab', 'lone ESC at the boundary');
  assert.equal(feed(['a\x1b[', '32mb']), 'ab', 'ESC[ at the boundary');
});

test('stream: cursor-forward split across chunks still becomes spaces', () => {
  assert.equal(feed(['col\x1b[', '3Cnext']), 'col   next');
  assert.equal(feed(['col\x1b[3', 'Cnext']), 'col   next');
});

test('stream: OSC split across chunks vanishes entirely', () => {
  assert.equal(feed(['\x1b]0;my ti', 'tle\x07text']), 'text');
  assert.equal(feed(['\x1b]8;;https://x.dev\x1b', '\\link\x1b]8;;\x1b\\']), 'link');
});

test('stream: charset select and two-byte escapes split at the boundary', () => {
  assert.equal(feed(['\x1b(', 'Bascii']), 'ascii');
  assert.equal(feed(['\x1b', '7saved\x1b8']), 'saved');
});

test('stream: a complete chunk carries nothing over', () => {
  const strip = createAnsiStripper();
  assert.equal(strip('\x1b[36m● Read\x1b[0m foo.ts'), '● Read foo.ts');
  assert.equal(strip('plain'), 'plain');
});

test('stream: carry is bounded, a never-completed escape is flushed', () => {
  const strip = createAnsiStripper();
  assert.equal(strip('\x1b]0;' + 'x'.repeat(10)), '', 'held while under the cap');
  // Over the cap the unterminated OSC is handed to the stateless stripper (which
  // swallows its body) and the carry is dropped, so the next chunk is not
  // appended to a buffer that grows forever.
  assert.equal(strip('x'.repeat(MAX_CARRY)), '');
  assert.equal(strip('after'), 'after');

  // A CSI that never gets its final byte comes out as text once over the cap,
  // exactly as the stateless stripper would have shown it.
  const csi = createAnsiStripper();
  assert.equal(csi('\x1b[' + '1;'.repeat(10)), '', 'held while under the cap');
  const out = csi('1;'.repeat(MAX_CARRY));
  assert.ok(out.length >= MAX_CARRY * 2, 'flushed as literal, not kept');
  assert.equal(csi('after'), 'after');
});

test('stream: the stateless stripAnsi is unchanged by the carry logic', () => {
  // This is the leak the stream stripper exists to prevent: the head is eaten
  // as a stray two-byte escape and the params come out as text.
  assert.equal(stripAnsi('a\x1b[3'), 'a3');
});
