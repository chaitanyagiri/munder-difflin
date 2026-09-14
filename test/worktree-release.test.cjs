'use strict';
/**
 * Upstream issue #297: a NAMED agent's isolated worktree was force-removed the
 * moment its terminal exited, unintegrated commits and all — the keep-if-
 * unintegrated protection existed only for ephemeral workers. Teardown now
 * routes every isolated agent through releaseWorktree(), which these tests pin
 * down against real git repos: removed only when clean AND integrated into the
 * base branch; preserved for uncommitted changes, for commits the base does not
 * have, and whenever git cannot answer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { releaseWorktree } = loadTs('src/main/git.ts');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeHarness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wt-release-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const wtRoot = path.join(home, 'worktrees');
  fs.mkdirSync(wtRoot);
  const wtPath = path.join(wtRoot, 'jim-1');
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', 'agent/jim-1', 'main');
  return { repo, wtPath };
}

// `git worktree list` prints real paths (macOS: /private/var/… for /var/…).
const listed = (repo, wtPath) => {
  const real = fs.existsSync(wtPath) ? fs.realpathSync(wtPath) : wtPath;
  const out = git(repo, 'worktree', 'list', '--porcelain');
  return out.includes(`worktree ${real}`) || out.includes(`worktree ${wtPath}`);
};

test('a clean worktree with nothing beyond the base is removed', async (t) => {
  const { repo, wtPath } = makeHarness(t);
  const r = await releaseWorktree(repo, wtPath, 'main');
  assert.deepEqual(r, { action: 'removed' });
  assert.equal(fs.existsSync(wtPath), false);
  assert.equal(listed(repo, wtPath), false);
});

test('uncommitted changes are preserved, not discarded', async (t) => {
  const { repo, wtPath } = makeHarness(t);
  fs.writeFileSync(path.join(wtPath, 'draft.ts'), 'half-written\n');
  const r = await releaseWorktree(repo, wtPath, 'main');
  assert.equal(r.action, 'preserved', JSON.stringify(r));
  assert.equal(r.dirty, true);
  assert.equal(r.branch, 'agent/jim-1');
  assert.equal(fs.existsSync(path.join(wtPath, 'draft.ts')), true, 'the file is still there');
  assert.equal(listed(repo, wtPath), true);
});

test('commits the base branch does not have are preserved', async (t) => {
  const { repo, wtPath } = makeHarness(t);
  fs.writeFileSync(path.join(wtPath, 'feature.ts'), 'done\n');
  git(wtPath, 'add', '-A');
  git(wtPath, 'commit', '-q', '-m', 'feature');
  const r = await releaseWorktree(repo, wtPath, 'main');
  assert.equal(r.action, 'preserved', JSON.stringify(r));
  assert.equal(r.dirty, false);
  assert.equal(r.ahead, 1);
  assert.match(r.detail, /ahead/i);
  assert.equal(listed(repo, wtPath), true);
  assert.equal(git(repo, 'rev-parse', '--verify', 'agent/jim-1').length, 40, 'the branch survives too');
});

test('once that work lands in the base branch the worktree is released', async (t) => {
  const { repo, wtPath } = makeHarness(t);
  fs.writeFileSync(path.join(wtPath, 'feature.ts'), 'done\n');
  git(wtPath, 'add', '-A');
  git(wtPath, 'commit', '-q', '-m', 'feature');
  assert.equal((await releaseWorktree(repo, wtPath, 'main')).action, 'preserved');
  git(repo, 'merge', '-q', 'agent/jim-1'); // god integrates it
  const r = await releaseWorktree(repo, wtPath, 'main');
  assert.deepEqual(r, { action: 'removed' });
  assert.equal(fs.existsSync(wtPath), false);
});

test('when git cannot answer, the worktree is kept', async (t) => {
  const { repo, wtPath } = makeHarness(t);
  const r = await releaseWorktree(repo, wtPath, 'no-such-branch');
  assert.equal(r.action, 'preserved', JSON.stringify(r));
  assert.equal(fs.existsSync(wtPath), true);
});
