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
  // The label is localized; the key must be the close string, and en must
  // still read as a close control.
  assert.ok(/aria-label=\{t\('updatesSection\.closeReleaseNotes'\)\}/.test(buttons[0]),
    'the only chrome button must be the close');
  const en = JSON.parse(require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src/renderer/src/i18n/locales/en.json'), 'utf8'));
  assert.ok(/^Close/.test(en.updatesSection.closeReleaseNotes), 'the close label must say Close');
  assert.ok(!/Star|Restart|Later|Download|Open release/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    'no release action may be a chrome button');
});

// ─── No render-blocking remote font fetch (the white-screen fix) ──────────────
// The drop used to inject a Google Fonts <link>/@import and PERMIT it in the CSP.
// A remote stylesheet is render-blocking: the frame paints nothing until it
// resolves, and where fonts.googleapis.com is blocked (China) that is a TCP
// timeout of white screen. The fix has three independent parts, each pinned here.

test('the frame reaches the network for NO font at load — no remote <link>/@import/preconnect', () => {
  const doc = buildDropSrcDoc('<h1>hi</h1>');
  assert.doesNotMatch(doc, /<link\b[^>]*fonts\.googleapis\.com/i, 'no remote font stylesheet link');
  assert.doesNotMatch(doc, /<link\b[^>]*rel=["']?preconnect/i, 'no preconnect to a font CDN');
  assert.doesNotMatch(doc, /fonts\.gstatic\.com/i);
  // The only stylesheet is the inline <style> the app controls.
  assert.doesNotMatch(doc, /@import\s+url\(\s*["']?https?:/i, 'no app-injected remote @import');
});

test('the CSP can no longer permit a remote stylesheet or font — it fails such a fetch FAST', () => {
  const doc = buildDropSrcDoc('<h1>hi</h1>');
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(doc)[1];
  // style-src keeps 'unsafe-inline' (authored <style> works) but drops https:,
  // so a remote stylesheet / @import is DENIED — and a denied import fails
  // immediately instead of hanging, which is what stops the white screen.
  assert.match(policy, /style-src 'unsafe-inline'(?:;|$)/, "style-src must be 'unsafe-inline' with no https:");
  assert.doesNotMatch(policy, /style-src[^;]*https:/, 'style-src must not permit remote stylesheets');
  // font-src is data: only — fonts are self-hosted, nothing remote can stall a paint.
  assert.match(policy, /font-src data:(?:;|$)/, 'font-src must be data: only');
  assert.doesNotMatch(policy, /font-src[^;]*https:/, 'font-src must not permit remote fonts');
});

test('the design fonts are self-hosted as data: URIs, so the frame needs no network', () => {
  const doc = buildDropSrcDoc('<h1>hi</h1>');
  // Both families the drop tokens name are present as @font-face data: URIs.
  assert.match(doc, /@font-face[\s\S]*?font-family:\s*'Inter'[\s\S]*?src:\s*url\(data:font\/woff2;base64,/i);
  assert.match(doc, /@font-face[\s\S]*?font-family:\s*'JetBrains Mono'[\s\S]*?src:\s*url\(data:font\/woff2;base64,/i);
  // …and they are real payloads, not empty placeholders.
  const b64 = [...doc.matchAll(/base64,([A-Za-z0-9+/=]+)\)/g)].map((m) => m[1]);
  assert.ok(b64.length >= 2 && b64.every((s) => s.length > 1000), 'both faces carry a real woff2 payload');
});

test('an authored remote @import is stripped — including the founder-shaped one with url-internal ;', () => {
  // The real RELEASE.md line: the url itself contains `;` (wght@400;500;600), the
  // exact shape a naive `[^;]*` strip would truncate and leave broken CSS behind.
  const authored = [
    '<style>',
    '  @import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap");',
    '  :root { --paper: #FFFDF7; }',
    '  body { color: var(--ink); }',
    '</style>',
    '<h1>Launch</h1>'
  ].join('\n');
  const doc = buildDropSrcDoc(authored);
  assert.doesNotMatch(doc, /@import/i, 'the remote @import is gone');
  assert.doesNotMatch(doc, /fonts\.googleapis\.com/i, 'no trace of the font CDN url');
  // No dangling tail from a mid-url truncation.
  assert.doesNotMatch(doc, /500;600&family/i, 'no broken remainder of the stripped url');
  // The rest of the authored CSS and content survives untouched.
  assert.match(doc, /--paper:\s*#FFFDF7/);
  assert.match(doc, /<h1>Launch<\/h1>/);
});

test('a data: @import and a plain https url() are left alone (only remote @import goes)', () => {
  // A data: import blocks on nothing; a background image url is not an @import.
  const doc = buildDropSrcDoc([
    '<style>',
    '  @import "data:text/css,body{margin:0}";',
    '  .hero { background: url("https://cdn.example/hero.png"); }',
    '</style>'
  ].join('\n'));
  assert.match(doc, /@import "data:text\/css/, 'a data: import is not render-blocking and stays');
  assert.match(doc, /url\("https:\/\/cdn\.example\/hero\.png"\)/, 'a remote image url is not an @import');
});

// ─── The loader reveal (fix b), source-level on ReleaseDrop.tsx ───────────────
// The reveal logic decides whether the user sees the drop or a stuck spinner, and
// its failure modes (permanently hidden frame / permanently visible spinner) both
// stay green in CI. So the wiring is pinned as text — the loader is a .tsx the
// shared loader cannot import.

test('the loader reveals on onLoad OR a timeout cap — never on onLoad alone', () => {
  const src = readDrop();
  // onLoad wires the reveal…
  assert.match(src, /onLoad=\{reveal\}/, 'the iframe onLoad must reveal');
  // …and a timeout races it, so a delayed/never-firing onLoad cannot hang the loader.
  assert.match(src, /setTimeout\(reveal, REVEAL_TIMEOUT_MS\)/, 'a timeout cap must also reveal');
  assert.match(src, /clearTimeout\(t\)/, 'the timer is cleared on unmount');
  // The cap is a real, stated number, not left implicit.
  assert.match(src, /REVEAL_TIMEOUT_MS = \d{3,5}/, 'the timeout is a named constant');
});

test('the frame is always mounted; only the loader is conditionally rendered', () => {
  const src = readDrop();
  // The iframe must not be behind a `revealed &&` — a broken reveal must never
  // unmount the frame. It is the LOADER that is conditional and removed on reveal.
  assert.doesNotMatch(src, /revealed\s*&&\s*<iframe/, 'the iframe must not be gated on reveal');
  assert.doesNotMatch(src, /revealed\s*\?\s*<iframe/, 'the iframe must not be gated on reveal');
  assert.match(src, /\{!revealed && <DropLoader \/>\}/, 'the loader is shown only until revealed');
  // Reveal is monotonic: latched true, never set back to false.
  assert.doesNotMatch(src, /setReveal\(false\)/, 'reveal must never flip back');
});
