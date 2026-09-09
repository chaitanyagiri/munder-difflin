'use strict';

// The UI half of the Spanish locale change: full-parity `es.json` plus its
// registration and picker entry.
//
// The gate is the same one every locale lands under: NOTHING CHANGES FOR A
// USER WHO HAS NOT SELECTED SPANISH. Spanish is LTR Latin, so the RTL, font,
// CSP and terminal sections of `arabic-ui.test.cjs` are inert here by design
// and are NOT repeated — `directionFor('es')` is `'ltr'` and every RTL branch
// takes its pre-existing path. What this file owns is coverage and shape:
//
//   - the picker renders an "Español" option that selects `es`
//   - `es.json` carries exactly the key tree of `en.json`
//   - no string is empty or a placeholder stub
//   - no string is left as its English source (modulo SAME_ON_PURPOSE)
//   - every interpolation variable, markup tag and array shape survives
//   - English stays the default and the fallback; no OS auto-detect
//
// Spanish CORRECTNESS is NOT tested here and is NOT claimed. The strings were
// written by an agent, not reviewed by a Spanish reader. Everything below is
// about coverage, shape, and inertness — never about whether the Spanish reads
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
const es = locale('es');

// --- the gate: inert for everyone who did not pick Spanish ------------------

test('the selector renders Español and it selects es', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /code: 'es'[^}]*label: 'Español'/,
    'LANGUAGES has no Español entry selecting es');
  // The picker is data-driven: SettingsModal maps LANGUAGES, so no per-locale
  // component change is needed — but the mapping must still be there.
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(modal, /\{LANGUAGES\.map\(\(l\) =>/,
    'the Settings picker no longer renders from LANGUAGES');
});

test('Spanish stays left-to-right', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /code: 'es'[^}]*dir: 'ltr'/,
    'es must declare dir ltr like every non-RTL language');
  assert.match(src, /LANGUAGES\.filter\(\(l\) => l\.dir === 'rtl'\)/,
    'the RTL set must stay derived from LANGUAGES, not maintained separately');
});

test('English is still the default, and still not auto-detected', () => {
  const code = strip(read('src/renderer/src/i18n/index.ts'));
  assert.match(code, /return 'en';/, 'the fallback language must stay English');
  assert.match(code, /fallbackLng: 'en'/, 'a missing Spanish key must fall back to English');
  assert.ok(!code.includes('navigator'),
    'adding a locale must not turn on OS auto-detect');
});

test('es is registered everywhere a language has to be registered', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /es: \{ translation: es \}/, 'es is missing from resources');
  assert.match(src, /supportedLngs: \[[^\]]*'es'[^\]]*\]/, 'es is missing from supportedLngs');
  assert.match(src, /code: 'es'[^}]*dir: 'ltr'/, 'es is not marked left-to-right');
});

// --- coverage and shape: full parity, no gaps --------------------------------

test('es has exactly the same key tree as en', () => {
  const e = pathsOf(en), s = pathsOf(es);
  const missing = [...e.keys()].filter((k) => !s.has(k));
  const extra = [...s.keys()].filter((k) => !e.has(k));
  assert.deepEqual(missing, [], 'es is missing keys — they would silently fall back');
  assert.deepEqual(extra, [], 'es has keys en does not — dead strings');
  assert.ok(e.size > 1000, `sanity: only ${e.size} keys found`);
});

test('no Spanish string is empty or a placeholder stub', () => {
  // Bare ellipses ('...', '…') are legitimate loading indicators in en too —
  // only truly empty values and TODO-style stubs fail here.
  const s = pathsOf(es);
  const bad = [];
  for (const [k, v] of s) {
    if (typeof v !== 'string') continue;
    if (v.trim() === '' || /^(TODO|TBD|FIXME|XXX)$/i.test(v.trim())) bad.push(k);
  }
  assert.deepEqual(bad, [], `${bad.length} Spanish strings are empty or stubs`);
});

test('no Spanish string is left as its English source', () => {
  // A copied English string is worse than a missing one: a missing key falls
  // back to English deliberately, a copied one looks translated and is not.
  // Strings that are IDENTICAL ON PURPOSE, re-audited for Spanish — each is a
  // proper noun, a literal path the user types, or a pure format string, and
  // translating any of them would make the UI wrong, not more Spanish.
  const SAME_ON_PURPOSE = new Set([
    'settings.connections.slack',            // product name
    'onboarding.providerBlurb.claude',       // "Claude Code — Anthropic": two product names
    'onboarding.providerBlurb.codex',
    'onboarding.providerBlurb.antigravity',
    'onboarding.providerBlurb.gemini',
    'addAgent.projectPlaceholder',           // /path/to/your/project — a filesystem path
    'onboarding.home.placeholder',           // /path/to/HarnessAgents — same
    'mcpDefaults.toggleNote',                // "{{id}}: {{state}}" — pure interpolation
    'webhooksSection.summary',               // "{{count}} · {{state}}" — same
    'commandBar.skill',                      // "/skill" — the literal slash command the user types
    'commandCenter.logMessage',              // "{{from}} → {{to}}: {{subject}}" — arrow format, no prose
    'triggersTab.webhooks',                  // WEBHOOKS — technical loanword kept across Spanish UIs
    'triggerHistory.sectionWebhooks',        // Webhooks — same loanword as a section title
    'common.tokens',                         // tokens — accepted loanword (RAE), same convention as the onboarding copy
    'sidebar.terminal',                      // terminal — accepted loanword, used throughout the Spanish copy
    'officeTheme.experimental',              // experimental — valid Spanish spelling, identical to the English source
    'settings.nav.general',                  // General — valid Spanish spelling, identical to the English source
    'settings.autonomy.budgetEquals',        // "= {{value}} tokens" — pure interpolation, no prose to translate
    'settings.memory.kg',                    // Knowledge Graph — feature/product name, also the kg tool name
    'settings.voice.freeFlow',               // Free Flow — feature name, kept in English like the product UI
    'settings.voice.realtime',               // Realtime — OpenAI Realtime API product name
    'commandCenter.tabs.terminal',           // terminal — accepted loanword, same as the sidebar tab
    'commandCenter.tabs.skills',             // skills — product section name, kept across the Spanish UI
    'commandCenter.tabs.workers',            // workers — product section name, kept across the Spanish UI
    'commandCenter.fleetTokens',             // "Σ {{value}} tok" — pure format string, no prose
    'commandCenter.fleetRate',               // "{{value}} tok/min" — pure format string, no prose
    'addAgent.sections.workspace.label',     // Workspace — loanword used across the Spanish copy
    'addAgent.sections.briefing.label',      // Briefing — business loanword, valid Spanish usage
    'addAgent.color',                        // Color — valid Spanish spelling, identical to the English source
    'schedulesSection.prompt',               // PROMPT — technical loanword, field label kept across the Spanish UI
    'triggersUi.min',                        // min — minutes abbreviation, identical in Spanish
  ]);
  const e = pathsOf(en), s = pathsOf(es);
  const untranslated = [];
  for (const [k, v] of e) {
    if (typeof v !== 'string' || !/[A-Za-z]{4}/.test(v)) continue; // symbols, ids, brands
    if (s.get(k) === v && !SAME_ON_PURPOSE.has(k)) untranslated.push(k);
  }
  assert.deepEqual(untranslated, [], `${untranslated.length} Spanish strings are still English`);
  // The allowlist must not rot into a way of hiding real gaps.
  const stale = [...SAME_ON_PURPOSE].filter((k) => s.get(k) !== e.get(k));
  assert.deepEqual(stale, [], 'allowlisted keys that ARE translated — drop them from the list');
});

test('every interpolation variable survives translation', () => {
  // `{{godName}}` mistyped is a literal "{{godname}}" on screen, and i18next
  // will not warn. This is the highest-frequency way a locale file breaks.
  const e = pathsOf(en), s = pathsOf(es);
  const vars = (x) => [...String(x).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
  const bad = [];
  for (const [k, v] of e) {
    if (vars(v) !== vars(s.get(k))) bad.push(`es ${k}: [${vars(v)}] -> [${vars(s.get(k))}]`);
  }
  assert.deepEqual(bad, []);
  // Positive control: the comparison above can actually fail.
  assert.notEqual(vars('a {{x}}'), vars('a'));
});

test('inline markup and array shapes are preserved', () => {
  // Several onboarding strings carry <strong>; the office flavour lines are
  // arrays indexed by the scene, so a short array is an out-of-range read.
  const e = pathsOf(en), s = pathsOf(es);
  const tags = (x) => [...String(x).matchAll(/<\/?([a-z]+)>/g)].map((m) => m[1]).sort().join(',');
  for (const [k, v] of e) {
    assert.equal(tags(s.get(k)), tags(v), `markup changed in ${k}`);
  }
  const count = (o, p) => p.split('.').reduce((n, s) => n?.[s], o);
  for (const p of ['office.errand.smoke', 'office.suckUp', 'office.gossip', 'office.cheer']) {
    assert.equal(count(es, p).length, count(en, p).length, `${p} changed length`);
  }
});

test('the terminal setting still explains its performance cost, in es', () => {
  // The founder's amendment kept this control because ON swaps the renderer
  // and costs speed. The Spanish locale must carry the same explanation.
  const g = es.settings.general;
  assert.ok(g.arabicTerminalDesc, 'es lost arabicTerminalDesc');
  assert.ok(g.arabicTerminalDesc.length > 80,
    'es description is too short to still explain the tradeoff');
  assert.ok(g.arabicTerminalFollowsLanguage,
    'es never says the value is coming from the language');
  // en names the two renderers explicitly; that is the substance of the note.
  assert.match(en.settings.general.arabicTerminalDesc, /GPU/);
});
