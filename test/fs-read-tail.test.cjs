'use strict';

/**
 * `readFileTail` backs the trading desk's order feed: the pipeline's
 * `executions.jsonl` / `decisions.jsonl` are append-only and outgrow the 2 MB
 * `readFile` cap within days, while the UI only ever wants the last few dozen
 * rows. The contract pinned here:
 *
 *  - only WHOLE lines come back — a window that starts mid-record drops that
 *    torn first line, so every returned line is parseable on its own;
 *  - the byte window is honoured, and a request above MAX_TAIL_BYTES is clamped
 *    rather than served;
 *  - a file that fits inside the window comes back untouched and unflagged;
 *  - the same root confinement as `readFileText` applies.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { readFileTail, MAX_TAIL_BYTES } = loadTs('src/main/fs.ts');

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tail-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(root, { recursive: true });
  return { dir, root };
}

/** N numbered JSON lines, each exactly the same width so byte math is exact. */
function jsonl(n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(JSON.stringify({ i: String(i).padStart(6, '0'), s: 'x'.repeat(20) }));
  return lines.map(l => l + '\n').join('');
}

test('a file smaller than the window comes back whole and unflagged', async () => {
  const { dir, root } = makeRoot();
  try {
    const body = jsonl(5);
    fs.writeFileSync(path.join(root, 'small.jsonl'), body);
    const r = await readFileTail(root, 'small.jsonl', 4096);
    assert.equal(r.ok, true);
    assert.equal(r.content, body);
    assert.equal(r.truncated, false);
    assert.equal(r.size, Buffer.byteLength(body));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a window that starts mid-line drops the torn first line', async () => {
  const { dir, root } = makeRoot();
  try {
    const body = jsonl(200);
    fs.writeFileSync(path.join(root, 'big.jsonl'), body);
    const window = 1000; // not a multiple of the line width, so the cut is mid-record
    const r = await readFileTail(root, 'big.jsonl', window);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.content) <= window, 'never more than the requested window');
    const lines = r.content.split('\n').filter(Boolean);
    assert.ok(lines.length > 0);
    for (const line of lines) JSON.parse(line); // every line is a complete record
    // The returned lines are the LAST ones of the file, contiguous to the end.
    const all = body.split('\n').filter(Boolean);
    assert.deepEqual(lines, all.slice(all.length - lines.length));
    // The window began inside the record before the first returned one, which
    // is exactly the one that must have been dropped.
    const lineWidth = Buffer.byteLength(all[0]) + 1;
    const expectedFirst = Math.ceil((Buffer.byteLength(body) - window) / lineWidth);
    assert.equal(lines[0], all[expectedFirst]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a window that lands exactly on a line boundary drops that boundary line (conservative)', async () => {
  const { dir, root } = makeRoot();
  try {
    const body = jsonl(50);
    fs.writeFileSync(path.join(root, 'exact.jsonl'), body);
    const all = body.split('\n').filter(Boolean);
    const lineWidth = Buffer.byteLength(all[0]) + 1;
    // Window = last 10 lines exactly. The byte before the window is a '\n', so
    // the first byte IN the window starts a record; but the reader cannot know
    // that without reading the byte before it, and drops through to the first
    // newline — losing one whole line. Pin the conservative behaviour: 9 lines,
    // all complete, all the last ones.
    const r = await readFileTail(root, 'exact.jsonl', lineWidth * 10);
    assert.equal(r.ok, true);
    const lines = r.content.split('\n').filter(Boolean);
    assert.equal(lines.length, 9);
    assert.deepEqual(lines, all.slice(-9));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the byte cap is clamped to MAX_TAIL_BYTES, never honoured above it', async () => {
  const { dir, root } = makeRoot();
  try {
    const line = 'y'.repeat(1023) + '\n'; // 1 KB per line
    const lines = Math.floor(MAX_TAIL_BYTES / 1024) + 64; // 64 KB past the cap
    fs.writeFileSync(path.join(root, 'huge.log'), line.repeat(lines));
    const r = await readFileTail(root, 'huge.log', MAX_TAIL_BYTES * 4);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.content) <= MAX_TAIL_BYTES);
    // A nonsense cap (0 / negative / NaN) falls back to the ceiling too.
    for (const bad of [0, -5, Number.NaN]) {
      const b = await readFileTail(root, 'huge.log', bad);
      assert.equal(b.ok, true);
      assert.ok(Buffer.byteLength(b.content) <= MAX_TAIL_BYTES);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn window with no newline at all yields an empty (not garbage) tail', async () => {
  const { dir, root } = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'oneline.txt'), 'z'.repeat(5000)); // one 5 KB line, no newline
    const r = await readFileTail(root, 'oneline.txt', 100);
    assert.equal(r.ok, true);
    assert.equal(r.content, '');
    assert.equal(r.truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('confinement: an escape and a missing file are refused like readFileText', async () => {
  const { dir, root } = makeRoot();
  try {
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'secret\n');
    const esc = await readFileTail(root, '../outside.txt', 1024);
    assert.equal(esc.ok, false);
    assert.equal(esc.error, 'path escapes root');
    const missing = await readFileTail(root, 'nope.jsonl', 1024);
    assert.equal(missing.ok, false);
    assert.ok(missing.error.length > 0);
    const notFile = await readFileTail(root, '.', 1024);
    assert.equal(notFile.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
