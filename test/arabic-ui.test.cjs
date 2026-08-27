'use strict';

// The UI half of PR #213: the Arabic locale, and right-to-left layout.
//
// It lands under ONE condition, the same one the terminal half landed under and
// the only condition the founder attached to shipping this with gaps: NOTHING
// CHANGES FOR A USER WHO HAS NOT SELECTED ARABIC. Not layout, not direction,
// not fonts, not spacing. These tests are that condition, plus the structural
// checks that keep a partial translation falling back to English cleanly.
//
// Arabic CORRECTNESS is NOT tested here and is NOT claimed. The strings were
// written by an agent, not reviewed by an Arabic reader. Everything below is
// about coverage, shape, and inertness — never about whether the Arabic reads
// well. Do not let a green run here be read as "the translation was checked".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (code) =>
  JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));

/** Every leaf path in a locale tree, arrays included by index. */
function leaves(node, prefix = '') {
  if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${prefix}.${i}`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}
const pathsOf = (o) => new Map(leaves(o));

/** Source with comments removed, for assertions about what the CODE does. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const en = locale('en');
const ar = locale('ar');
const zh = locale('zh-CN');

// --- the gate: inert for everyone who did not pick Arabic ------------------

test('direction is decided by the SELECTED language and nothing else', () => {
  const src = read('src/renderer/src/i18n/useDirection.ts');
  // Comments stripped throughout this file: these modules explain at length what
  // they refuse to read, and naming an API must not read as calling it.
  const code = strip(src);
  // Not the OS, not the browser, not the content on screen. Each of these would
  // mirror the UI of a user who never asked for it.
  for (const sniff of ['navigator', 'matchMedia', 'textContent']) {
    assert.ok(!code.includes(sniff), `useDirection reads ${sniff} — that is not a user choice`);
  }
  assert.match(code, /isRtlLanguage\(i18n\.language\)/);
});

test('an unregistered language code is left-to-right, never guessed at', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  // Exact set membership. A prefix match ('ar-EG'.startsWith('ar')) or a script
  // guess would let an unknown value mirror somebody's UI, and LTR is the
  // direction every existing user already has.
  assert.match(src, /RTL_CODES\.has\(lng\)/,
    'isRtlLanguage must be exact-match on a registered code');
  assert.match(src, /LANGUAGES\.filter\(\(l\) => l\.dir === 'rtl'\)/,
    'the RTL set must be derived from LANGUAGES, not maintained separately');
});

test('every RTL CSS rule is scoped to [dir="rtl"], so LTR sees no change at all', () => {
  const css = read('src/renderer/src/design/global.css');
  const marker = css.indexOf('─── RTL app language');
  assert.ok(marker > 0, 'the RTL section vanished');
  // Start at the comment's OPENING delimiter, or strip() sees a dangling `*/`
  // and eats the wrong span.
  const start = css.lastIndexOf('/*', marker);
  const next = css.indexOf('/* ───', marker + 20);
  // Comments stripped first: this section explains WHY each rule exists, in
  // prose that otherwise reads like a selector list.
  const body = strip(next > 0 ? css.slice(start, next) : css.slice(start));
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const selectors = lines.filter((l) => /^[.[#a-z]/.test(l) && (l.includes('{') || l.endsWith(',')));
  assert.ok(selectors.length >= 5, `expected the RTL rules, found ${selectors.length}`);
  for (const sel of selectors) {
    assert.ok(sel.includes('[dir="rtl"]'),
      `an unscoped rule in the RTL section changes layout for everyone: ${sel.trim()}`);
  }
});

test('the terminal grid is pinned LTR under an RTL page', () => {
  // `direction` inherits. Without this the xterm viewport picks up rtl from
  // <html>, right-aligns the whole cell grid, and reverses every box-drawing
  // frame — while the pty still addresses columns from the left. Per-row
  // direction is a different layer (.cth-bidi) and is not affected.
  const css = strip(read('src/renderer/src/design/global.css'));
  // Every part of the grid, checked one at a time. A single regex over the whole
  // rule passes while three of the four selectors are missing — the root alone
  // does cover the rows by inheritance, but the viewport carries the scrollbar
  // and the measure container decides cell width, and a partial removal here
  // must not read as green.
  const rule = css.slice(css.indexOf('[dir="rtl"] .xterm'));
  const decl = rule.slice(0, rule.indexOf('}') + 1);
  assert.match(decl, /direction: ltr;/, 'the xterm pin lost its declaration');
  for (const sel of ['.xterm', '.xterm-viewport', '.xterm-screen', '.xterm-rows',
                     '.xterm-width-cache-measure-container']) {
    // Anchored on the selector's END. `.xterm` is a prefix of every other name
    // here, so a plain substring test reports the root as pinned when only
    // `.xterm-viewport` survives.
    const re = new RegExp(`\\[dir="rtl"\\] \\${sel}(?=\\s*[,{])`);
    assert.match(decl, re,
      `${sel} is not pinned to ltr, so an RTL app language mirrors part of the terminal`);
  }
});

test('content direction in components is gated, never content-sniffed', () => {
  // `dir="auto"` resolves from the first strong character, so ungated it flips
  // a block of an ENGLISH user's UI the moment an agent writes a line of
  // Arabic into it. Every site has to be behind the language gate.
  const files = [
    'components/AddAgentModal', 'components/AgentStrip', 'components/AskMeTab',
    'components/CommandCenterPanel', 'components/FullscreenTerminal',
    'components/MemoryPanel', 'components/MessageQueueComposer',
    'components/TasksKanban', 'components/ThreadsPanel',
    'components/triggers/ContextSection', 'components/triggers/SchedulesSection',
    'components/triggers/TriggerHistoryTab'
  ];
  let gated = 0;
  for (const f of files) {
    const src = read(`src/renderer/src/${f}.tsx`);
    const bare = src.match(/dir="auto"/g) ?? [];
    assert.equal(bare.length, 0,
      `${f} has an UNGATED dir="auto" — it fires for an English user`);
    const g = src.match(/dir=\{rtl \? 'auto' : undefined\}/g) ?? [];
    if (g.length) {
      assert.match(src, /const rtl = useRtl\(\);/, `${f} uses rtl without reading it`);
      assert.match(src, /from '@\/i18n\/useDirection'/, `${f} never imports the gate`);
    }
    gated += g.length;
  }
  assert.ok(gated >= 17, `expected the PR's dir sites to be carried over, found ${gated}`);
});

test('the markdown auto-direction plugin only runs for an RTL language', () => {
  // The one piece Kevin held explicitly, because it is content-driven by design:
  // an English user reading a document that happens to contain Arabic would
  // have had blocks of it mirrored.
  const src = read('src/renderer/src/markdown/MarkdownPreview.tsx');
  assert.match(src, /rehypePlugins=\{rtl \? AUTO_DIR_PLUGINS : NO_PLUGINS\}/,
    'rehypeAutoDir is not behind the language gate');
  assert.match(src, /const rtl = useRtl\(\);/);
  // And the security invariant it sits next to is unchanged.
  assert.ok(!src.includes('rehypeRaw'), 'rehype-raw must never be added here');
});

test('no unbundled webfont rides in with the Arabic locale', () => {
  // PR #213 added IBM Plex Sans Arabic to every token stack and re-added the
  // Google Fonts <link> that 41ea4c37 deliberately removed — a network fetch on
  // boot, blocked in mainland China, and an ungated font change for every user.
  // The bundled stacks already name system Arabic faces, so nothing is needed.
  const tokens = read('src/renderer/src/design/tokens.css');
  const html = read('src/renderer/index.html');
  assert.ok(!tokens.includes('IBM Plex Sans Arabic'),
    'an unbundled font in a token stack changes type for every user');
  assert.doesNotMatch(html, /<link[^>]*fonts\.googleapis\.com/,
    'the Google Fonts link is back — the app must render its own type offline');
  assert.match(html, /font-src 'self'/,
    'the CSP no longer pins fonts to the bundle');
  for (const face of ['Geeza Pro', 'Noto Naskh Arabic']) {
    assert.ok(tokens.includes(face), `${face} fallback is missing from the token stacks`);
  }
});

// --- coverage and shape: what makes a PARTIAL translation safe -------------

test('English is still the default, and still not auto-detected', () => {
  const code = strip(read('src/renderer/src/i18n/index.ts'));
  assert.match(code, /return 'en';/, 'the fallback language must stay English');
  assert.match(code, /fallbackLng: 'en'/, 'a missing Arabic key must fall back to English');
  assert.ok(!code.includes('navigator'),
    'adding a locale must not turn on OS auto-detect');
});

test('ar is registered everywhere a language has to be registered', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /ar: \{ translation: ar \}/, 'ar is missing from resources');
  assert.match(src, /supportedLngs: \[[^\]]*'ar'[^\]]*\]/, 'ar is missing from supportedLngs');
  assert.match(src, /code: 'ar'[^}]*dir: 'rtl'/, 'ar is not marked right-to-left');
});

test('every locale has exactly the same key tree', () => {
  const e = pathsOf(en), a = pathsOf(ar), z = pathsOf(zh);
  const missing = [...e.keys()].filter((k) => !a.has(k));
  const extra = [...a.keys()].filter((k) => !e.has(k));
  assert.deepEqual(missing, [], 'ar is missing keys — they would silently fall back');
  assert.deepEqual(extra, [], 'ar has keys en does not — dead strings');
  assert.equal(z.size, e.size, 'zh-CN drifted from en');
  assert.ok(e.size > 1000, `sanity: only ${e.size} keys found`);
});

test('no Arabic string is left as its English source', () => {
  // A copied English string is worse than a missing one: a missing key falls
  // back to English deliberately, a copied one looks translated and is not.
  // Strings that are IDENTICAL ON PURPOSE. Each is a proper noun, a literal
  // path the user types, or a pure format string — translating any of them
  // would make the UI wrong, not more Arabic.
  const SAME_ON_PURPOSE = new Set([
    'settings.connections.slack',            // product name
    'onboarding.providerBlurb.claude',       // "Claude Code — Anthropic": two product names
    'onboarding.providerBlurb.codex',
    'onboarding.providerBlurb.antigravity',
    'onboarding.providerBlurb.gemini',
    'addAgent.projectPlaceholder',           // /path/to/your/project — a filesystem path
    'onboarding.home.placeholder',           // /path/to/HarnessAgents — same
    'mcpDefaults.toggleNote',                // "{{id}}: {{state}}" — pure interpolation
    'webhooksSection.summary'                // "{{count}} · {{state}}" — same
  ]);
  const e = pathsOf(en), a = pathsOf(ar);
  const untranslated = [];
  for (const [k, v] of e) {
    if (typeof v !== 'string' || !/[A-Za-z]{4}/.test(v)) continue; // symbols, ids, brands
    if (a.get(k) === v && !SAME_ON_PURPOSE.has(k)) untranslated.push(k);
  }
  assert.deepEqual(untranslated, [], `${untranslated.length} Arabic strings are still English`);
  // The allowlist must not rot into a way of hiding real gaps.
  const stale = [...SAME_ON_PURPOSE].filter((k) => a.get(k) !== e.get(k));
  assert.deepEqual(stale, [], 'allowlisted keys that ARE translated — drop them from the list');
});

test('every interpolation variable survives translation', () => {
  // `{{godName}}` mistyped is a literal "{{godname}}" on screen, and i18next
  // will not warn. This is the highest-frequency way a locale file breaks.
  const e = pathsOf(en), a = pathsOf(ar), z = pathsOf(zh);
  const vars = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
  const bad = [];
  for (const [k, v] of e) {
    if (vars(v) !== vars(a.get(k))) bad.push(`ar ${k}: [${vars(v)}] -> [${vars(a.get(k))}]`);
    if (vars(v) !== vars(z.get(k))) bad.push(`zh ${k}: [${vars(v)}] -> [${vars(z.get(k))}]`);
  }
  assert.deepEqual(bad, []);
  // Positive control: the comparison above can actually fail.
  assert.notEqual(vars('a {{x}}'), vars('a'));
});

test('inline markup and array shapes are preserved', () => {
  // Several onboarding strings carry <strong>; the office flavour lines are
  // arrays indexed by the scene, so a short array is an out-of-range read.
  const e = pathsOf(en), a = pathsOf(ar);
  const tags = (s) => [...String(s).matchAll(/<\/?([a-z]+)>/g)].map((m) => m[1]).sort().join(',');
  for (const [k, v] of e) {
    assert.equal(tags(a.get(k)), tags(v), `markup changed in ${k}`);
  }
  const count = (o, p) => p.split('.').reduce((n, s) => n?.[s], o);
  for (const p of ['office.errand.smoke', 'office.suckUp', 'office.gossip', 'office.cheer']) {
    assert.equal(count(ar, p).length, count(en, p).length, `${p} changed length`);
  }
});

test('the terminal setting still explains its performance cost, in every locale', () => {
  // The founder's amendment moved this setting's default onto the language but
  // explicitly kept the control, because ON swaps the renderer and costs speed.
  // Losing that explanation would be a real regression.
  for (const [code, l] of [['en', en], ['zh-CN', zh], ['ar', ar]]) {
    const g = l.settings.general;
    assert.ok(g.arabicTerminalDesc, `${code} lost arabicTerminalDesc`);
    assert.ok(g.arabicTerminalDesc.length > 80,
      `${code}'s description is too short to still explain the tradeoff`);
    assert.ok(g.arabicTerminalFollowsLanguage,
      `${code} never says the value is coming from the language`);
  }
  // en names the two renderers explicitly; that is the substance of the note.
  assert.match(en.settings.general.arabicTerminalDesc, /GPU/);
});
