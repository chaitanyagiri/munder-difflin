'use strict';

/**
 * Release drops render REMOTE, AUTHOR-CONTROLLED HTML inside the app. The
 * renderer it would otherwise reach has `window.cth` bridged onto it — spawnPty,
 * writeFileText, updateConfig — so script execution there is arbitrary code
 * execution with the app's authority, available to anyone who can publish a
 * release.
 *
 * The controls are (1) a minimal sandbox on the iframe and (2) `default-src
 * 'none'` in the document's own CSP. Neither is the only thing standing between
 * a release body and the user's machine.
 *
 * The drop modal carries no buttons, so authored links are how a release offers
 * an action, and the sandbox grants `allow-popups` to make them reach the OS
 * browser. That single grant is now the widest thing in the blast radius, so the
 * last suite here pins it by reading ReleaseDrop.tsx as text — the shared code
 * cannot see the attribute, and a widened sandbox would otherwise pass silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { extractDropHtml, buildDropSrcDoc } = loadTs('src/shared/releaseDrop.ts');

const wrap = (inner) => `# Release\n\nblurb\n\n<!-- drop -->\n${inner}\n<!-- /drop -->\n\nfooter`;

test('extracts the authored block and leaves the surrounding markdown behind', () => {
  const html = extractDropHtml(wrap('<h1>Hello</h1>'));
  assert.equal(html, '<h1>Hello</h1>');
});

test('a release body with no drop block returns null (digest path stays default)', () => {
  assert.equal(extractDropHtml('## What\'s new\n\n- a bullet'), null);
  assert.equal(extractDropHtml(''), null);
  assert.equal(extractDropHtml(null), null);
  assert.equal(extractDropHtml(undefined), null);
});

test('an unbalanced marker pair returns null rather than half a document', () => {
  assert.equal(extractDropHtml('intro <!-- drop --> <h1>truncated'), null);
  assert.equal(extractDropHtml('intro <!-- /drop --> trailing'), null);
});

test('an empty drop block is treated as no drop', () => {
  assert.equal(extractDropHtml(wrap('   \n  ')), null);
});

test('the CSP denies scripts by omission, not by an allowlist that could widen', () => {
  const doc = buildDropSrcDoc('<h1>hi</h1>');
  // Match the CSP meta specifically — a bare /content="…"/ picks up the
  // viewport tag, which precedes it.
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(doc);
  assert.ok(csp, 'a CSP meta tag is present');
  const policy = csp[1];
  assert.match(policy, /default-src 'none'/);
  // The point of default-src 'none': an unlisted directive DENIES. If someone
  // ever adds an explicit script-src, this catches it.
  assert.doesNotMatch(policy, /script-src/);
  assert.doesNotMatch(policy, /connect-src/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  // Media a launch page genuinely needs, https/data only — never http:.
  assert.match(policy, /img-src https: data: blob:/);
  assert.match(policy, /media-src https: data: blob:/);
  assert.doesNotMatch(policy, /img-src[^;]*\bhttp:/);
});

test('defence in depth: script tags and inline handlers are stripped from the body', () => {
  const doc = buildDropSrcDoc([
    '<h1>Launch</h1>',
    '<script>window.parent.cth.spawnPty({})</script>',
    '<script src="https://evil.example/x.js"></script>',
    '<img src="x.png" onerror="window.parent.cth.writeFileText(\'/tmp/x\',\'y\')">',
    '<div ONCLICK=steal()>click</div>'
  ].join('\n'));
  assert.doesNotMatch(doc, /<script/i);
  assert.doesNotMatch(doc, /onerror/i);
  assert.doesNotMatch(doc, /onclick/i);
  // …while the legitimate content around them survives intact.
  assert.match(doc, /<h1>Launch<\/h1>/);
  assert.match(doc, /<img src="x\.png"/);
});

test('authored markup that merely LOOKS active is preserved', () => {
  // A drop describing the update mechanism shouldn't have its prose mangled.
  const doc = buildDropSrcDoc('<p>We removed the old <code>onclick</code> handler.</p>');
  assert.match(doc, /<code>onclick<\/code>/);
});

test('the document is self-contained and declares its charset before content', () => {
  const doc = buildDropSrcDoc('<h1>é — 🎉</h1>');
  assert.match(doc, /^<!doctype html>/i);
  assert.ok(doc.indexOf('charset') < doc.indexOf('<body'), 'charset precedes the body');
  assert.match(doc, /🎉/);
});

// ─── The iframe sandbox attribute ────────────────────────────────────────────
// Source-level, on purpose: the attribute lives in a .tsx the loader cannot
// import, and it is the one control this suite would otherwise miss entirely.
// Only the ATTRIBUTE is inspected, never the file text — the doc block above it
// names allow-scripts and allow-same-origin precisely to say they are banned,
// and a grep over prose would fail on the warning rather than on a real grant.
const readDrop = () => require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src/renderer/src/components/ReleaseDrop.tsx'),
  'utf8'
);

test('ReleaseDrop grants allow-popups and nothing else', () => {
  const attrs = [...readDrop().matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);
  // Exactly one frame, granting exactly one capability. allow-scripts alone is
  // already arbitrary code in the frame; paired with allow-same-origin it lets
  // the frame delete its own sandbox. allow-top-navigation would let a release
  // body replace the app, and allow-forms is an unscripted exfiltration path.
  assert.deepEqual(attrs, ['allow-popups']);
});

// The drop is presentation only. A button here would be an app control wearing
// the release author's page; every action a release wants to offer (star, notes,
// Discord, download) belongs in the authored HTML, which is why the frame can
// open links at all. The ONE control the chrome owns is close: a modal this
// large with no visible way out is a trap, and Esc alone is invisible.
test('ReleaseDrop renders no action buttons, only a close', () => {
  const src = readDrop();
  const buttons = src.match(/<button\b[\s\S]*?>/g) ?? [];
  assert.equal(buttons.length, 1, 'the release drop must carry exactly one chrome button');
  assert.ok(/aria-label="Close/.test(buttons[0]), 'the only chrome button must be the close');
  assert.ok(!/Star|Restart|Later|Download|Open release/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    'no release action may be a chrome button');
});
