'use strict';

// PR #205 shipped en/zh-CN locales in which the orchestrator is always called
// "Michael". The user can rename it, and this codebase has already fixed that
// exact revert three times in the spawn path. It also replaced several
// per-agent runtime names with the literal "Michael", so the UI named the wrong
// agent — including a confirmation dialog for a destructive restart.
//
// These tests hold both fixes, plus the founder's rule that nothing changes for
// an existing user until they pick a language.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (l) => JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`));
const LOCALES = ['en', 'zh-CN'];

function flatten(obj, pre = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
const text = (v) => (Array.isArray(v) ? v.join(' ') : String(v));

test('no locale hardcodes the orchestrator name', () => {
  for (const l of LOCALES) {
    const bad = Object.entries(flatten(locale(l)))
      .filter(([, v]) => /Michael/i.test(text(v)))
      .map(([k]) => k);
    assert.deepEqual(bad, [], `${l}.json hardcodes Michael in: ${bad.join(', ')}`);
  }
});

test('the strings that talk about the orchestrator interpolate {{godName}}', () => {
  const en = flatten(locale('en'));
  // A representative spread: settings, command centre, onboarding, triggers.
  for (const k of ['settings.connections.slackDesc', 'commandCenter.michaelDecides',
                   'onboarding.orchestrator.modelNote', 'triggerHistory.approveTitle',
                   'workersTab.liveIntro', 'kanban.newWorkHint']) {
    assert.ok(k in en, `${k} vanished from en.json`);
    assert.match(text(en[k]), /\{\{godName\}\}/, `${k} does not interpolate godName`);
  }
});

test('strings about ONE agent interpolate {{name}}, not the orchestrator', () => {
  // These describe whichever agent is on screen. Naming god here is not a
  // translation nit: "This restarts Michael" on a dialog that restarts Kevin is
  // a destructive action describing the wrong target.
  const perAgent = ['commandCenter.runsTheFloor', 'commandCenter.noTerminal',
                    'commandCenter.confirmRestartEngine', 'commandCenter.restartContinueTitle'];
  for (const l of LOCALES) {
    const f = flatten(locale(l));
    for (const k of perAgent) {
      assert.match(text(f[k]), /\{\{name\}\}/, `${l}: ${k} must interpolate {{name}}`);
      assert.doesNotMatch(text(f[k]), /\{\{godName\}\}/, `${l}: ${k} is per-agent, not god`);
    }
  }
});

test('every per-agent string has a call site that actually passes a name', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  for (const k of ['commandCenter.runsTheFloor', 'commandCenter.noTerminal',
                   'commandCenter.confirmRestartEngine', 'commandCenter.restartContinueTitle']) {
    const call = new RegExp(`t\\('${k.replace('.', '\\.')}',\\s*\\{[^}]*name:`);
    assert.match(src, call, `${k} is used without passing a name`);
  }
});

test('en and zh-CN carry exactly the same keys', () => {
  const en = Object.keys(flatten(locale('en'))).sort();
  const zh = Object.keys(flatten(locale('zh-CN'))).sort();
  assert.deepEqual(zh, en);
});

test('every {{placeholder}} in en has the same placeholders in zh-CN', () => {
  // A translation that drops an interpolation renders a literal gap.
  const en = flatten(locale('en'));
  const zh = flatten(locale('zh-CN'));
  const vars = (v) => [...new Set((text(v).match(/\{\{(\w+)\}\}/g) || []))].sort();
  const drift = Object.keys(en)
    .filter((k) => JSON.stringify(vars(en[k])) !== JSON.stringify(vars(zh[k])))
    .map((k) => `${k}: en=${vars(en[k])} zh=${vars(zh[k])}`);
  assert.deepEqual(drift, [], `placeholder drift:\n  ${drift.join('\n  ')}`);
});

// --- the language default ---------------------------------------------------

test('with nothing saved the app starts in English, never the OS locale', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  const fn = src.slice(src.indexOf('function detectLanguage'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.doesNotMatch(body, /navigator/, 'detectLanguage reads the OS locale again');
  assert.match(body, /return 'en';/, 'detectLanguage does not fall back to English');
});

test('godName reaches i18next as a default variable, so no call site must pass it', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /defaultVariables:\s*\{\s*godName:\s*DEFAULT_GOD_NAME\s*\}/);
  assert.match(src, /export function setGodName/);
  // Without an event react-i18next never re-renders, so a rename would not show.
  assert.match(src, /i18n\.emit\('languageChanged'/);
});

test('something actually calls setGodName, or the wiring is dead', () => {
  const hook = read('src/renderer/src/i18n/useGodNameSync.ts');
  assert.match(hook, /setGodName\(/);
  assert.match(hook, /isGod/);
  assert.match(read('src/renderer/src/App.tsx'), /useGodNameSync\(\)/);
});
