'use strict';

/**
 * #140 — onboarding died on `ENOENT: mkdir '~/HarnessAgents'`: the wizard lets
 * the user TYPE the harness-home path, and Node's mkdir/resolve treat `~` as a
 * literal directory name. The write-side seams expand it now, but a config.json
 * PERSISTED by a pre-fix build still holds literal `~/…` strings that nothing
 * rewrites — the hive picker then renders them and feeds them straight back
 * into config:changeHome. So readConfig normalizes on the way OUT too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts pulls `app` from electron for its userData path; outside Electron
// that resolve gives a path string, so seed the cache with the surface it
// touches — pointed at a temp dir this test owns.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tilde-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { ensureHarnessHome, readConfig } = loadTs('src/main/config.ts');

test.after(() => { fs.rmSync(userData, { recursive: true, force: true }); });

test('readConfig serves a pre-fix config with every ~ expanded (the upgrade path)', () => {
  const home = os.homedir();
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    harnessHome: '~/HarnessAgents',
    // A stale tilde entry, its already-absolute twin, and an unrelated recent.
    recentHives: ['~/HarnessAgents', path.join(home, 'HarnessAgents'), '~/OtherHive']
  }));
  const cfg = readConfig();
  assert.equal(cfg.harnessHome, path.join(home, 'HarnessAgents'));
  assert.deepEqual(cfg.recentHives, [
    path.join(home, 'HarnessAgents'), // tilde + absolute twin collapse to one
    path.join(home, 'OtherHive')
  ]);
  assert.ok(!JSON.stringify(cfg.recentHives).includes('~'), 'no consumer ever sees a ~ path');
});

test('ensureHarnessHome expands ~ before mkdir (issue #140)', () => {
  const rel = `.md-issue140-test-${process.pid}`;
  const target = path.join(os.homedir(), rel);
  const literalTilde = path.join(process.cwd(), '~');
  try {
    const res = ensureHarnessHome(`~/${rel}`);
    assert.equal(res.ok, true, res.error);
    assert.ok(fs.existsSync(target), 'created under the real home directory');
    assert.ok(!fs.existsSync(literalTilde), 'no literal "~" directory appeared in cwd');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a failing mkdir still reports ok:false with the error', () => {
  // A path THROUGH a regular file cannot be created.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'md-home-'));
  const file = path.join(target, 'plain-file');
  fs.writeFileSync(file, 'x');
  try {
    const res = ensureHarnessHome(path.join(file, 'child'));
    assert.equal(res.ok, false);
    assert.ok(res.error && res.error.length > 0);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
