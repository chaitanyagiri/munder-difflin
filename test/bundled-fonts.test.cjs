'use strict';

// The app used to <link> its three faces from fonts.googleapis.com. That host and
// fonts.gstatic.com are blocked in mainland China, so the app booted there with
// every face falling back and the UI looked broken. These tests hold the fix in
// place: the files ship in the bundle, nothing reaches for Google at runtime, and
// the token stacks keep naming a system CJK/Arabic face.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const FONT_DIR = 'src/renderer/src/assets/fonts';
const FILES = [
  'press-start-2p-latin-400.woff2',
  'inter-latin-var.woff2',
  'jetbrains-mono-latin-var.woff2'
];

test('the three faces are real woff2 files inside the repo', () => {
  for (const f of FILES) {
    const buf = fs.readFileSync(path.join(root, FONT_DIR, f));
    // 'wOF2' — a truncated or HTML-error-page download would not carry it.
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${f} is not woff2`);
    assert.ok(buf.length > 2000, `${f} is suspiciously small (${buf.length}b)`);
  }
});

test('bundling stays small: no CJK face was quietly added', () => {
  // A full CJK face is 8-10MB. The founder ruled we do not ship one; if someone
  // adds one later this budget is where they have to argue for it.
  const total = FILES.reduce((n, f) => n + fs.statSync(path.join(root, FONT_DIR, f)).size, 0);
  assert.ok(total < 300 * 1024, `bundled fonts total ${total}b, over the 300KB budget`);
});

test('the OFL license and attribution ship with the fonts', () => {
  const lic = read(`${FONT_DIR}/LICENSE.txt`);
  assert.match(lic, /SIL OPEN FONT LICENSE Version 1\.1/);
  for (const name of ['Press Start 2P', 'Inter', 'JetBrains Mono']) {
    assert.ok(lic.includes(name), `${name} has no attribution`);
  }
});

test('@font-face points at the bundled files, not a URL', () => {
  const css = read('src/renderer/src/design/fonts.css');
  assert.equal((css.match(/@font-face/g) || []).length, 3);
  for (const f of FILES) assert.ok(css.includes(f), `fonts.css does not reference ${f}`);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /https?:/);
});

test('fonts.css is imported before the tokens that use those families', () => {
  const g = read('src/renderer/src/design/global.css');
  assert.ok(g.indexOf("@import './fonts.css'") >= 0, 'fonts.css is never imported');
  assert.ok(
    g.indexOf("@import './fonts.css'") < g.indexOf("@import './tokens.css'"),
    'fonts.css must be imported before tokens.css'
  );
});

test('the app HTML no longer reaches for Google, and its CSP forbids it', () => {
  const html = read('src/renderer/index.html');
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(withoutComments, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  const csp = withoutComments.match(/Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(csp, 'no CSP meta tag');
  assert.match(csp[1], /font-src 'self';/);
  assert.doesNotMatch(csp[1], /googleapis|gstatic/);
});

// --- the token stacks -------------------------------------------------------

/** Every font stack the app exposes, from BOTH files that define them. */
function stacks() {
  const css = read('src/renderer/src/design/tokens.css');
  const ts = read('src/renderer/src/design/tokens.ts');
  const pick = (s, re) => {
    const m = s.match(re);
    assert.ok(m, `no match for ${re}`);
    return m[1];
  };
  return {
    cssDisplay: pick(css, /--cth-font-display:\s*(.+);/),
    cssUi: pick(css, /--cth-font-ui:\s*(.+);/),
    cssMono: pick(css, /--cth-font-mono:\s*(.+);/),
    tsDisplay: pick(ts, /display: '(.+)',/),
    tsUi: pick(ts, /ui: '(.+)',/),
    tsMono: pick(ts, /mono: '(.+)'/)
  };
}

test('every stack falls through to a system CJK face and an Arabic face', () => {
  const s = stacks();
  for (const [name, stack] of Object.entries(s)) {
    assert.match(stack, /PingFang SC|Microsoft YaHei|Noto Sans( Mono)? CJK SC/, `${name} has no CJK fallback`);
    assert.match(stack, /Geeza Pro|Noto Naskh Arabic/, `${name} has no Arabic fallback`);
  }
});

test('tokens.css and tokens.ts do not drift apart', () => {
  // tokens.ts says "mirrors tokens.css — update both together". Nothing enforced
  // that, so a stack could be widened in one file and not the other.
  const s = stacks();
  assert.equal(s.tsDisplay, s.cssDisplay);
  assert.equal(s.tsUi, s.cssUi);
  assert.equal(s.tsMono, s.cssMono);
});

test('the release-drop iframe also falls through to a system CJK face', () => {
  // Its own <style> block, separate from the app tokens, and easy to forget.
  const drop = read('src/shared/releaseDrop.ts');
  for (const re of [/--font-mono: (.+);/, /--font-sans: (.+);/]) {
    const stack = drop.match(re)[1];
    assert.match(stack, /PingFang SC|Microsoft YaHei|Noto Sans( Mono)? CJK SC/);
    assert.match(stack, /Geeza Pro|Noto Naskh Arabic/);
  }
});
