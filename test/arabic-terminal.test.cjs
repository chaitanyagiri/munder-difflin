'use strict';

// The terminal half of PR #213. It landed on ONE condition: that it is inert
// for everybody who has not switched it on. These tests are that condition.
// Arabic rendering CORRECTNESS is not tested here and is not claimed — it needs
// a reviewer who reads Arabic, which this one is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { arabicJoinRanges, isArabicCp } = loadTs('src/renderer/src/terminal/arabicJoiner.ts');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const HELLO_AR = 'مرحبا'; // 5 Arabic letters, U+0645 U+0631 U+062D U+0628 U+0627

// --- inertness: the whole basis for landing this half ----------------------

test('a row with no Arabic produces no join ranges at all', () => {
  for (const row of [
    '', 'hello world', '$ npm run build', 'const x = 42;',
    '┌───┐│ box │└───┘', // TUI box drawing
    '\x1b[31mred\x1b[0m',                 // an escape sequence that reached the row
    '你好世界',                            // CJK is not RTL and must not join
    'café — naïve « quotes »'             // latin-1 plus the punctuation used as glue
  ]) {
    assert.deepEqual(arabicJoinRanges(row), [], `joined something in: ${JSON.stringify(row)}`);
  }
});

test('glue characters alone never create a range', () => {
  // PHRASE_GLUE only extends a run that already started on an Arabic letter.
  // Its ASCII/Latin half is tested here; the rest of the list (، ؛ ؟ and the
  // tatweel ـ) sits INSIDE the Arabic block, so those are Arabic first and glue
  // second, and they are covered by the phrase tests below.
  assert.deepEqual(arabicJoinRanges(' ,.:;()«»!-—'), []);
});

test('a lone Arabic character is left alone', () => {
  // Nothing to shape across, so there is no reason to make it a span.
  assert.deepEqual(arabicJoinRanges(`a ${HELLO_AR[0]} b`), []);
});

// --- it does do its job ----------------------------------------------------

test('an Arabic word becomes one range', () => {
  assert.deepEqual(arabicJoinRanges(HELLO_AR), [[0, 5]]);
});

test('a range stops at the last Arabic character, not the trailing space', () => {
  const row = `hi ${HELLO_AR} bye`;
  assert.deepEqual(arabicJoinRanges(row), [[3, 8]]);
  assert.equal(row.slice(3, 8), HELLO_AR);
});

test('a phrase flows across the punctuation between its words', () => {
  const two = `${HELLO_AR} ${HELLO_AR}`;
  assert.deepEqual(arabicJoinRanges(two), [[0, two.length]]);
});

test('isArabicCp covers the script blocks and nothing else', () => {
  for (const cp of [0x0600, 0x06ff, 0x0750, 0x077f, 0xfb50, 0xfdff, 0xfe70, 0xfeff]) {
    assert.equal(isArabicCp(cp), true, `0x${cp.toString(16)} should be Arabic`);
  }
  for (const cp of [0x0041, 0x05ff, 0x0700, 0x4e00, 0xfb4f, 0xfe6f]) {
    assert.equal(isArabicCp(cp), false, `0x${cp.toString(16)} should not be Arabic`);
  }
});

// --- the gates -------------------------------------------------------------

test('the default follows the app language, and still never sniffs the OS locale', () => {
  // The founder amended this after the terminal half landed: picking Arabic as
  // the UI language should turn terminal RTL on by itself, because a user who
  // picked Arabic has already answered the question the toggle asks. So the
  // default is no longer a hardcoded false — it is the app language. What did
  // NOT change is where the language comes from: a choice made in this app,
  // never `navigator.languages`.
  const src = read('src/renderer/src/terminal/arabicSetting.ts');
  // Comments stripped: the file explains at length WHY it refuses to read the
  // OS locale, and naming the API it refuses to call must not read as a use.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /navigator/,
    'arabicSetting reads the OS locale again — the founder ruled that out');
  assert.match(code, /isRtlLanguage\(i18n\.language\)/,
    'the default must come from the SELECTED app language');
  assert.match(code, /override \?\? languageDefault\(\)/,
    'an explicit choice must still win over the language default');
});

test('the override is three-valued, so a deliberate choice survives a language switch', () => {
  // Two-valued would make this a derived flag with no escape hatch: an English
  // user who needs Arabic terminals for their colleagues' logs could not keep
  // it on, and an Arabic user could not get the GPU renderer's speed back.
  const src = read('src/renderer/src/terminal/arabicSetting.ts');
  assert.match(src, /type Override = boolean \| null/,
    'unset must be distinguishable from an explicit false');
  assert.match(src, /removeItem\(KEY\)/,
    'there must be a way back to following the language');
  // setArabicTerminalEnabled always WRITES, including when the new value
  // happens to equal today's language default — otherwise the choice would
  // evaporate the moment the language moved.
  const setter = src.slice(src.indexOf('export function setArabicTerminalEnabled'));
  assert.match(setter.slice(0, 300), /setItem\(KEY/,
    'an explicit choice must be persisted unconditionally');
});

test('nothing Arabic is wired into a terminal unless the setting says so', () => {
  const src = read('src/renderer/src/components/terminalPool.ts');
  // All three now live in enableArabicRendering(), which exists so the first
  // attach and the live language switch cannot drift apart. The guarantee is
  // unchanged: nothing reaches a terminal except through that one function, and
  // every call to it is behind isArabicTerminalEnabled().
  const fn = src.slice(src.indexOf('function enableArabicRendering'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const call of ['registerCharacterJoiner(', 'attachArabicSpacingFix(entry.host)', "classList.add('cth-bidi')"]) {
    assert.ok(body.includes(call), `${call} is not in enableArabicRendering`);
    const occurrences = src.split(call).length - 1
      - (call === 'registerCharacterJoiner(' ? src.split('deregisterCharacterJoiner(').length - 1 : 0);
    assert.equal(occurrences, 1,
      `${call} appears more than once — a second path around the gate`);
  }
  for (const [i, _] of [...src.matchAll(/enableArabicRendering\(entry\)/g)].map((m) => [m.index])) {
    const guard = src.lastIndexOf('isArabicTerminalEnabled()', i);
    assert.ok(guard > 0 && i - guard < 900,
      'a call to enableArabicRendering is not behind the enabled check');
  }
});

test('turning it off is a real undo, not a terminal rebuild', () => {
  // A terminal's scrollback lives only in xterm's buffer and the pty will not
  // resend it, so recreating one to apply a setting would silently eat the
  // user's history. Every step of enableArabicRendering has to be reversible.
  const src = read('src/renderer/src/components/terminalPool.ts');
  const off = src.slice(src.indexOf('function disableArabicRendering'));
  const body = off.slice(0, off.indexOf('\n}\n'));
  assert.match(body, /deregisterCharacterJoiner/, 'the joiner is never removed');
  assert.match(body, /classList\.remove\('cth-bidi'\)/, 'the bidi class is never removed');
  assert.match(body, /detachSpacing\(\)/, 'the spacing observer is never detached');
  const sweep = src.slice(src.indexOf('export function notifyArabicTerminalChangeAll'));
  assert.doesNotMatch(sweep.slice(0, sweep.indexOf('\n}\n')), /\bterm\.dispose\b|acquireTerminal/,
    'the live switch must not dispose or recreate a terminal');
});

test('the bidi CSS is scoped, so it cannot reach a terminal that never opted in', () => {
  const css = read('src/renderer/src/design/global.css');
  // Only the terminal-row bidi rules. global.css also has a pre-existing
  // .xterm-rows rule for ligature suppression, and a deliberately global
  // `unicode-bidi: isolate` on markdown code spans; neither is this feature.
  const rules = css.split('\n').filter((l) => l.includes('.xterm-rows > div'));
  assert.ok(rules.length > 0, 'the bidi rules vanished');
  for (const r of rules) {
    assert.ok(r.includes('.cth-bidi'),
      `an unscoped .xterm-rows rule reshapes every DOM-renderer terminal: ${r.trim()}`);
  }
});

test('the markdown direction rules use logical properties, a no-op in LTR', () => {
  // Only the .cth-md-preview rules. The separate .cth-md-card surface still
  // uses physical properties; it belongs to the RTL UI half, which is held.
  const md = read('src/renderer/src/design/global.css')
    .split('\n').filter((l) => l.trim().startsWith('.cth-md-preview') || l.includes('inline-start'))
    .join('\n');
  assert.doesNotMatch(md, /padding-left:|border-left:|margin-right:/,
    'a physical property here renders differently once dir=rtl');
  assert.match(md, /padding-inline-start|border-inline-start|margin-inline-end/);
});
