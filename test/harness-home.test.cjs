'use strict';

/**
 * Issue #140 — the onboarding harness-home field is typed by hand as often as it
 * is picked, and `~/HarnessAgents` is the suggestion itself. Node's fs treats a
 * literal `~` as a directory name, so ensureHarnessHome died with ENOENT and the
 * un-expanded home would have been persisted, poisoning every path derived from
 * it.
 *
 * This file exercises the REAL ensureHarnessHome / writeConfig / readConfig from
 * src/main/config.ts (electron's app.getPath stubbed to a temp dir). It replaces
 * the stand-in test that used to live in expand-tilde.test.cjs — that one only
 * re-ran expandTilde and would still have passed with the expandTilde call
 * deleted from the real ensureHarnessHome.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts pulls app.getPath('userData') from electron; outside Electron that
// resolve gives a path string, so seed the cache with a temp userData dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { ensureHarnessHome, writeConfig, readConfig } = loadTs('src/main/config.ts');

const HOME = os.homedir();

test('ensureHarnessHome creates a tilde path on disk (issue #140)', (t) => {
  const name = `md-harness-home-${process.pid}`;
  t.after(() => fs.rmSync(path.join(HOME, name), { recursive: true, force: true }));
  const res = ensureHarnessHome(`~/${name}`);
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.existsSync(path.join(HOME, name)), true, 'the REAL home dir, not a literal "~" folder');
});

test('writeConfig persists harnessHome EXPANDED, like registeredRepos', () => {
  const name = `md-harness-home-${process.pid}-cfg`;
  const expanded = path.join(HOME, name);
  const cfg = writeConfig({ harnessHome: `~/${name}` });
  assert.equal(cfg.harnessHome, expanded);
  assert.equal(cfg.recentHives[0], expanded, 'recent-hives tracking stores the same absolute path');
  assert.equal(readConfig().harnessHome, expanded, 'what lands on disk is absolute');
});
