'use strict';

/**
 * `~` is a SHELL convention — Node's fs/child_process treat it as a literal
 * directory name. Adding a project with `~/dev/foo` therefore died on
 * "cwd does not exist". expandTilde is the single shared expander that fixes it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { expandTilde, statAbs } = loadTs('src/main/fs.ts');

const HOME = os.homedir();

test('expands the tilde-home forms', () => {
  assert.equal(expandTilde('~/dev/proj'), path.join(HOME, 'dev/proj'));
  assert.equal(expandTilde('~'), HOME, 'a bare ~ is a valid cwd too');
  assert.equal(expandTilde('~/'), HOME);
  assert.equal(expandTilde('  ~/dev/proj  '), path.join(HOME, 'dev/proj'), 'pasted paths carry whitespace');
});

test('leaves absolute paths alone (beyond normalizing)', () => {
  // path.resolve anchors POSIX-looking paths to the current drive on Windows
  // ("L:\a\b\c"), so compare against resolve() output rather than literals.
  assert.equal(expandTilde('/a/b/c'), path.resolve('/a/b/c'));
  assert.equal(expandTilde('/a/b/c/'), path.resolve('/a/b/c'));
  assert.equal(expandTilde('/a/b/../c'), path.resolve('/a/c'));
});

test('does not touch anything that is not a tilde-home path', () => {
  assert.equal(expandTilde(''), '');
  assert.equal(expandTilde('~notauser/x'), '~notauser/x', '~user is not a form we expand');
  assert.equal(expandTilde('C:\\Users\\me\\proj'), 'C:\\Users\\me\\proj', 'windows paths must survive');
});

test('a still-relative path is returned untouched, NOT resolved', () => {
  // Deliberate: resolving here would silently anchor the path to the Electron
  // process cwd. Callers keep their own "not absolute" error instead.
  assert.equal(expandTilde('relative/path'), 'relative/path');
  assert.equal(expandTilde('./rel'), './rel');
});

test('the expanded path is what fs can actually stat — the original bug', () => {
  assert.equal(fs.existsSync('~'), false, 'the literal "~" never exists on disk');
  const expanded = expandTilde('~');
  assert.equal(path.isAbsolute(expanded), true);
  assert.equal(fs.existsSync(expanded), true);
});

/* ------------------------------------------------------------------ *
 * #140 — the hive home was the one path that never got expanded.
 * Onboarding suggests `~/HarnessAgents`; accepting that default persisted a
 * literal `~`, and Finish then died on `mkdir '~/HarnessAgents'` (ENOENT),
 * wedging the wizard on its last step with the UI pushed off-screen.
 * ------------------------------------------------------------------ */

const { normalizeHiveHome } = loadTs('src/main/fs.ts');

test('#140: the suggested default is expanded, not persisted literally', () => {
  const { home } = normalizeHiveHome('~/HarnessAgents');
  assert.equal(home, path.join(HOME, 'HarnessAgents'));
  assert.ok(!home.includes('~'), 'a literal ~ is what mkdir choked on');
  assert.ok(path.isAbsolute(home), 'every downstream reader needs an absolute path');
});

test('#140: the new home leads the recent list exactly once', () => {
  const { recentHives } = normalizeHiveHome('~/HarnessAgents', ['/other/hive']);
  assert.deepEqual(recentHives, [path.join(HOME, 'HarnessAgents'), path.resolve('/other/hive')]);
});

test('#140: stale `~` entries already on disk are normalized too', () => {
  // Without this the launch picker could hand a pre-fix `~/…` string straight
  // back and reintroduce the identical mkdir failure.
  const { recentHives } = normalizeHiveHome('/now/here', ['~/HarnessAgents']);
  assert.deepEqual(recentHives, [path.resolve('/now/here'), path.join(HOME, 'HarnessAgents')]);
});

test('#140: the same home written twice does not duplicate', () => {
  const { recentHives } = normalizeHiveHome('~/HarnessAgents', [
    path.join(HOME, 'HarnessAgents'), // same place, already absolute
    '~/HarnessAgents'                 // and again, unexpanded
  ]);
  assert.deepEqual(recentHives, [path.join(HOME, 'HarnessAgents')]);
});

test('#140: the recent list stays capped and skips blanks', () => {
  const prior = Array.from({ length: 20 }, (_, i) => `/hive/${i}`);
  const { recentHives } = normalizeHiveHome('/hive/new', ['', '   ', ...prior]);
  assert.equal(recentHives.length, 8);
  assert.equal(recentHives[0], path.resolve('/hive/new'));
});

/* ------------------------------------------------------------------ *
 * #140, part two. Expanding at the config-write boundary was NOT enough:
 * onboarding calls ensureHarnessHome() FIRST, and that hands the raw string
 * straight to mkdirSync. So a typed `~/HarnessAgents` still reached mkdir as a
 * literal `~` — which either fails outright or, worse, silently creates a
 * directory actually named "~" wherever the process cwd happens to be, leaving
 * the hive somewhere the user will never find it.
 *
 * The real ensureHarnessHome is exercised end-to-end (through a stubbed
 * electron `app`) in test/harness-home.test.cjs.
 * ------------------------------------------------------------------ */

test('#140: both entry points agree on the same directory', () => {
  // The mkdir (ensureHarnessHome) and the persisted value (normalizeHiveHome)
  // must resolve identically, or the app creates one folder and then records a
  // different one — the failure this pair of fixes exists to prevent.
  const typed = '~/HarnessAgents';
  assert.equal(expandTilde(typed), normalizeHiveHome(typed).home);
});

test('statAbs expands bare ~, Windows-style ~\\, and whitespace paths', async () => {
  // Redirect HOME before capturing it, to avoid writing to the real home
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-expand-tilde-'));
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  assert.equal(os.homedir(), base, 'home redirect failed — aborting before touching the real home');

  const HOME = os.homedir();
  const fileBasename = `.md-statabs-${process.pid}`;
  const inHome = path.join(HOME, fileBasename);
  fs.writeFileSync(inHome, 'x');
  try {
    const resSlash = await statAbs(`~/${fileBasename}`);
    assert.equal(resSlash.exists, true);
    assert.equal(resSlash.isFile, true);

    const resWin = await statAbs(`~\\${fileBasename}`);
    assert.equal(resWin.exists, true);
    assert.equal(resWin.isFile, true);

    const resPadded = await statAbs(` ~/${fileBasename} `);
    assert.equal(resPadded.exists, true);
    assert.equal(resPadded.isFile, true);
  } finally {
    fs.rmSync(inHome, { force: true });
    fs.rmSync(base, { recursive: true, force: true });
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  }
});
