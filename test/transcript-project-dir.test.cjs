'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { projectDir } = loadTs('src/main/transcript.ts');

/** projectDir() resolves against os.homedir(), which POSIX reads from $HOME — so
 *  each case gets a throwaway home and never touches the real ~/.claude. */
function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-transcript-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return run(home, (key) => {
      const dir = path.join(home, '.claude/projects', key);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    });
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('an unseen cwd resolves to the CURRENT key, leading slash dashed', () => {
  withHome(() => {
    // The regression: this used to return 'Users-me-app', a directory Claude Code
    // has not written to in months, so every read came back empty and every
    // caller read empty as "no data yet".
    assert.equal(path.basename(projectDir('/Users/me/app')), '-Users-me-app');
  });
});

test('the current directory wins even when a legacy twin exists', () => {
  withHome((_home, mkProject) => {
    // Both spellings exist on this machine for the hive root: the harness itself
    // created the legacy twin by copying transcripts into it. Preferring the
    // legacy one would mean reading our own stale copies forever.
    const legacy = mkProject('Users-me-app');
    const current = mkProject('-Users-me-app');
    const resolved = projectDir('/Users/me/app');
    assert.equal(resolved, current);
    assert.notEqual(resolved, legacy);
  });
});

test('a legacy-only install still resolves, so old transcripts stay readable', () => {
  withHome((_home, mkProject) => {
    const legacy = mkProject('Users-me-app');
    assert.equal(projectDir('/Users/me/app'), legacy);
  });
});

test('the real failing path resolves to the dir Claude Code actually writes', () => {
  withHome((_home, mkProject) => {
    // The exact cwd whose transcripts the condense step could not find.
    const cwd = '/Users/vyapakgoyal/Documents/HarnessAgents';
    mkProject('-Users-vyapakgoyal-Documents-HarnessAgents');
    mkProject('Users-vyapakgoyal-Documents-HarnessAgents');
    assert.equal(
      path.basename(projectDir(cwd)),
      '-Users-vyapakgoyal-Documents-HarnessAgents'
    );
  });
});
