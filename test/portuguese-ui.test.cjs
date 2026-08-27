'use strict';

// Portuguese locale (pt-PT). Same contract the Arabic locale holds in
// arabic-ui.test.cjs, minus the RTL machinery — Portuguese is Latin-script
// LTR, so nothing about direction, fonts, or the terminal renderer changes.
//
// PT_LOCALES is a list so a second variant (pt-BR) can join these tests by
// registering itself here — European and Brazilian Portuguese differ enough
// ("guardar" vs "salvar", "ficheiro" vs "arquivo") to be separate locales.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (l) => JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`));

const PT_LOCALES = ['pt-PT'];

function leaves(node, prefix = '') {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}
const pathsOf = (o) => new Map(leaves(o));
const text = (v) => (Array.isArray(v) ? v.join(' ') : String(v));

const en = locale('en');

test('pt locales are registered everywhere a language has to be registered', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  for (const code of PT_LOCALES) {
    assert.match(src, new RegExp(`'${code}': \\{ translation: pt\\w\\w \\}`),
      `${code} is missing from resources`);
    assert.match(src, new RegExp(`supportedLngs: \\[[^\\]]*'${code}'[^\\]]*\\]`),
      `${code} is missing from supportedLngs`);
    assert.match(src, new RegExp(`code: '${code}'[^}]*dir: 'ltr'`),
      `${code} must be registered left-to-right`);
  }
});

test('every pt locale has exactly the same key tree as en', () => {
  const e = pathsOf(en);
  for (const code of PT_LOCALES) {
    const p = pathsOf(locale(code));
    const missing = [...e.keys()].filter((k) => !p.has(k));
    const extra = [...p.keys()].filter((k) => !e.has(k));
    assert.deepEqual(missing, [], `${code} is missing keys — they would silently fall back`);
    assert.deepEqual(extra, [], `${code} has keys en does not — dead strings`);
  }
});

test('no pt locale hardcodes the orchestrator name', () => {
  for (const code of PT_LOCALES) {
    const bad = [...pathsOf(locale(code))]
      .filter(([, v]) => /Michael/i.test(text(v)))
      .map(([k]) => k);
    assert.deepEqual(bad, [], `${code} hardcodes Michael in: ${bad.join(', ')}`);
  }
});

test('every interpolation variable survives translation', () => {
  const e = pathsOf(en);
  const vars = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
  const bad = [];
  for (const code of PT_LOCALES) {
    const p = pathsOf(locale(code));
    for (const [k, v] of e) {
      if (vars(text(v)) !== vars(text(p.get(k)))) {
        bad.push(`${code} ${k}: [${vars(text(v))}] -> [${vars(text(p.get(k)))}]`);
      }
    }
  }
  assert.deepEqual(bad, []);
  // Positive control: the comparison above can actually fail.
  assert.notEqual(vars('a {{x}}'), vars('a'));
});

test('inline markup and array shapes are preserved', () => {
  const e = pathsOf(en);
  const tags = (s) => [...String(s).matchAll(/<\/?([a-z]+)>/g)].map((m) => m[1]).sort().join(',');
  for (const code of PT_LOCALES) {
    const l = locale(code);
    const p = pathsOf(l);
    for (const [k, v] of e) {
      assert.equal(tags(text(p.get(k))), tags(text(v)), `${code}: markup changed in ${k}`);
    }
    const count = (o, q) => q.split('.').reduce((n, s) => n?.[s], o);
    for (const q of ['office.errand.smoke', 'office.suckUp', 'office.gossip', 'office.cheer']) {
      assert.equal(count(l, q).length, count(en, q).length, `${code}: ${q} changed length`);
    }
  }
});

test('no Portuguese string is left as its English source', () => {
  // A copied English string is worse than a missing one: a missing key falls
  // back to English deliberately, a copied one looks translated and is not.
  // Strings that are IDENTICAL ON PURPOSE: proper nouns, literal paths, pure
  // format strings, git/dev jargon that stays English in Portuguese UIs, and
  // words Portuguese spells exactly like English ("terminal", "experimental").
  const SHARED = [
    'addAgent.projectPlaceholder',           // /path/to/your/project — a filesystem path
    'addAgent.sections.briefing.label',      // "Briefing" — the loanword pt uses
    'commandBar.skill',                      // "/skill" — a literal command
    'commandCenter.deliveryAuto',            // "auto" — same abbreviation in pt
    'commandCenter.fleetRate',               // "{{value}} tok/min" — pure format
    'commandCenter.fleetTokens',             // "Σ {{value}} tok" — pure format
    'commandCenter.issues',                  // GitHub Issues — the term devs use
    'commandCenter.logMessage',              // "{{from}} → {{to}}: {{subject}}" — pure format
    'commandCenter.tabs.floor',              // "monitor" — same word in pt
    'commandCenter.tabs.skills',             // skill is the feature's name
    'commandCenter.tabs.terminal',           // same word in pt
    'common.tokens',                         // token — the unit's name
    'gitTab.detachedHead',                   // the literal state git reports
    'gitTab.sectionBranches',                // git jargon
    'idePanel.diff',                         // git jargon
    'mcpDefaults.toggleNote',                // "{{id}}: {{state}}" — pure interpolation
    'officeTheme.experimental',              // pt spells it identically
    'onboarding.home.placeholder',           // /path/to/HarnessAgents — a filesystem path
    'onboarding.providerBlurb.antigravity',  // product names only
    'onboarding.providerBlurb.claude',
    'onboarding.providerBlurb.codex',
    'onboarding.providerBlurb.gemini',
    'schedulesSection.prompt',               // "PROMPT" — the term stays English
    'settings.autonomy.budgetEquals',        // "= {{value}} tokens" — pure format
    'settings.connections.slack',            // product name
    'settings.voice.freeFlow',               // the feature's proper name
    'sidebar.terminal',                      // same word in pt
    'toolWaterfall.barOk',                   // "{{tool}} · {{ms}}ms · ok" — pure format
    'toolWaterfall.cache',                   // "cache {{tokens}}t ({{pct}}%)" — pure format
    'triggerHistory.sectionWebhooks',        // webhook stays English
    'triggersTab.webhooks',
    'webhooksSection.offline',               // "offline" — the loanword pt uses
    'webhooksSection.summary',               // "{{count}} · {{state}}" — pure interpolation
    'workersTab.base',                       // "base: {{branch}}" — same word + format
    'workersTab.tokens'                      // "tokens {{value}}" — pure format
  ];
  const SAME_ON_PURPOSE = {
    'pt-PT': new Set(SHARED)
  };
  const e = pathsOf(en);
  for (const code of PT_LOCALES) {
    const p = pathsOf(locale(code));
    const allow = SAME_ON_PURPOSE[code];
    const untranslated = [];
    for (const [k, v] of e) {
      if (typeof v !== 'string' || !/[A-Za-z]{4}/.test(v)) continue; // symbols, ids, brands
      if (p.get(k) === v && !allow.has(k)) untranslated.push(k);
    }
    assert.deepEqual(untranslated, [], `${code}: ${untranslated.length} strings are still English`);
    // The allowlist must not rot into a way of hiding real gaps.
    const stale = [...allow].filter((k) => p.get(k) !== e.get(k));
    assert.deepEqual(stale, [], `${code}: allowlisted keys that ARE translated — drop them`);
  }
});
