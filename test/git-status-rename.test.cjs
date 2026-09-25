'use strict';

/**
 * getStatus() parses `git status --porcelain=v1 -z` by splitting on NUL and
 * reading every token as one `XY <path>` record. That is wrong for rename and
 * copy records, which porcelain -z emits with a SECOND null-terminated path —
 * the source:
 *
 *     "R  <new>" \0 "<old>" \0
 *
 * When the old-path token was fed through the single-path parser its first two
 * characters became the status letters and slice(3) became the path, so
 * `git mv alpha.txt beta.txt` surfaced a phantom entry
 * { path: "ha.txt", index: "a", worktree: "l" } in BOTH the staged and
 * unstaged lists (both filters pass a letter), while the real old path was
 * dropped. A 2-char old name ("ab") was silently skipped instead. The same
 * file's parseNameStatusZ (commit files) has always consumed the second path
 * of two-path records; getStatus now does too, and keeps it as oldPath.
 *
 * These tests run the parser against real git output in throwaway repos, so a
 * change in porcelain's wire format fails loudly here rather than silently
 * in the IDE panel's staged/unstaged lists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { getStatus } = loadTs('src/main/git.ts');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-rename-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  return repo;
}

function withRepo(fn) {
  const repo = makeRepo();
  return Promise.resolve(fn(repo)).finally(() => fs.rmSync(repo, { recursive: true, force: true }));
}

/** The paths git itself reports, from line-based porcelain — renames render as
 *  one unambiguous "R  old -> new" line there, so this is the ground truth the
 *  -z parser must not disagree with. */
function groundTruthPaths(repo) {
  const out = git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
  const paths = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const rest = line.slice(3);
    if (rest.includes(' -> ')) paths.push(...rest.split(' -> '));
    else paths.push(rest);
  }
  return paths;
}

function allReportedPaths(status) {
  return [
    ...status.staged.map((e) => e.path),
    ...status.unstaged.map((e) => e.path),
    ...status.untracked
  ];
}

/** Shared shape checks: no phantom paths, no worktree leak for a purely staged
 *  rename, the old path survives, the new path is staged. */
function assertRenameParsed(status, oldPath, newPath) {
  const real = new Set(groundTruthPaths(status.cwd));
  const reported = allReportedPaths(status);
  assert.deepEqual(
    reported.filter((p) => !real.has(p)), [],
    `phantom status entries from a misparsed rename record; ` +
    `expected only ${JSON.stringify([...real])}, got ${JSON.stringify(reported)}`
  );
  assert.deepEqual(status.unstaged, [], 'a staged rename must not leak into the unstaged list');
  const staged = status.staged.find((e) => e.path === newPath);
  assert.ok(staged, `staged rename target ${newPath} missing from staged list`);
  assert.equal(staged.oldPath, oldPath, `rename source ${oldPath} must be kept as oldPath`);
}

async function getStatusFor(repo) {
  const status = await getStatus(repo);
  assert.ok(!('error' in status), `getStatus failed: ${JSON.stringify(status)}`);
  return { ...status, cwd: repo };
}

test('a staged git mv parses as one rename entry carrying the old path', () =>
  withRepo(async (repo) => {
    fs.writeFileSync(path.join(repo, 'alpha.txt'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add alpha');
    git(repo, 'mv', 'alpha.txt', 'beta.txt');
    assertRenameParsed(await getStatusFor(repo), 'alpha.txt', 'beta.txt');
  }));

test('a rename staged from an editor (delete + add) parses the same way', () =>
  withRepo(async (repo) => {
    fs.writeFileSync(path.join(repo, 'old-name.txt'), 'content\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add old-name');
    fs.rmSync(path.join(repo, 'old-name.txt'));
    fs.writeFileSync(path.join(repo, 'new-name.txt'), 'content\n');
    git(repo, 'add', '-A');
    assertRenameParsed(await getStatusFor(repo), 'old-name.txt', 'new-name.txt');
  }));

test('a rename staged alongside an untracked file does not swallow the next record', () =>
  withRepo(async (repo) => {
    // The rename's old-path token sits directly before the untracked record in
    // the -z stream; a parser that skips one token too many eats it.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'a');
    git(repo, 'mv', 'a.txt', 'b.txt');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    const status = await getStatusFor(repo);
    assertRenameParsed(status, 'a.txt', 'b.txt');
    assert.ok(status.untracked.includes('new.txt'), `untracked file lost: ${JSON.stringify(status.untracked)}`);
  }));

test('an RM record keeps the old path on the staged entry, and modifies stay unstaged', () =>
  withRepo(async (repo) => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'a');
    git(repo, 'mv', 'a.txt', 'b.txt');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'y\n');
    const status = await getStatusFor(repo);
    const staged = status.staged.find((e) => e.path === 'b.txt');
    assert.ok(staged && staged.index === 'R' && staged.oldPath === 'a.txt',
      `staged side of the rename is wrong: ${JSON.stringify(status.staged)}`);
    const unstaged = status.unstaged.find((e) => e.path === 'b.txt');
    assert.ok(unstaged && unstaged.worktree === 'M',
      `the worktree modification of the new path must still be unstaged: ${JSON.stringify(status.unstaged)}`);
  }));

test('a 2-char old path is kept instead of silently dropped', () =>
  withRepo(async (repo) => {
    // The old-path token ("ab") is 2 chars — below the parser's minimum record
    // length — so before the fix it vanished with no phantom to notice.
    fs.writeFileSync(path.join(repo, 'ab'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'a');
    git(repo, 'mv', 'ab', 'cd');
    assertRenameParsed(await getStatusFor(repo), 'ab', 'cd');
  }));

test('an unstaged rename (delete + untracked) is unaffected', () =>
  withRepo(async (repo) => {
    // Without `git add`, porcelain v1 emits no two-path record at all — a
    // deletion plus an untracked file. Pin that nothing is consumed wrongly.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'a');
    fs.renameSync(path.join(repo, 'a.txt'), path.join(repo, 'b.txt'));
    const status = await getStatusFor(repo);
    assert.ok(status.unstaged.some((e) => e.path === 'a.txt' && e.worktree === 'D'),
      `the deletion must stay unstaged: ${JSON.stringify(status.unstaged)}`);
    assert.ok(status.untracked.includes('b.txt'), `the new file must be untracked: ${JSON.stringify(status.untracked)}`);
  }));
