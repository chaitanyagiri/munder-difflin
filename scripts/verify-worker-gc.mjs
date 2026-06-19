#!/usr/bin/env node
/**
 * Acceptance verify for the P4 ephemeral-worker GC gate (worktreeIsGcSafe in
 * src/main/git.ts). The repo has no test runner and git.ts can't be imported
 * standalone, so this mirrors the EXACT three git commands the helper runs
 * against real throwaway repos + worktrees and asserts the GC decision:
 *
 *   clean = `git status --porcelain` is empty
 *   if !clean              -> KEEP
 *   ahead = `git rev-list --count <base>..HEAD`
 *   if ahead === 0         -> GC   (HEAD reachable from base: FF / plain merge)
 *   if `git diff --quiet <base> HEAD` exits 0 -> GC  (tree identical: SQUASH merge)
 *   else                   -> KEEP
 *
 * Proves the fail-safe gate keeps un-integrated work AND correctly reclaims both
 * fast-forward AND squash-merged worktrees (the case the ahead-count alone misses).
 * Run: node scripts/verify-worker-gc.mjs   (exit 0 = all pass)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const tmp = mkdtempSync(join(tmpdir(), 'wgc-'));
const git = (cwd, ...args) => {
  try { return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8' }).trim() }; }
  catch (e) { return { ok: false, out: (e.stderr || e.stdout || String(e)).toString().trim() }; }
};
const gitOkExit = (cwd, ...args) => {
  // returns true when git exits 0 (used for `diff --quiet`)
  try { execFileSync('git', args, { cwd, stdio: 'ignore' }); return true; }
  catch { return false; }
};

/** The decision under test — a faithful mirror of worktreeIsGcSafe. */
function gcSafe(wtPath, base) {
  const status = git(wtPath, 'status', '--porcelain');
  if (!status.ok) return { gc: false, detail: 'status failed' };
  if (status.out.length > 0) return { gc: false, detail: 'dirty' };
  const rl = git(wtPath, 'rev-list', '--count', `${base}..HEAD`);
  if (rl.ok && parseInt(rl.out, 10) === 0) return { gc: true, detail: 'ahead==0' };
  if (gitOkExit(wtPath, 'diff', '--quiet', base, 'HEAD')) return { gc: true, detail: 'tree==base (squash)' };
  return { gc: false, detail: 'unintegrated' };
}

function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (gc=${got}, expected ${want})`);
}

// ── Build a base repo ──────────────────────────────────────────────────────
const repo = join(tmp, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
git(repo, 'config', 'user.email', 'v@x'); git(repo, 'config', 'user.name', 'v');
writeFileSync(join(repo, 'a.txt'), 'base\n');
git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

const wt = (name) => join(tmp, name);

// ── Scenario A: un-integrated commit → KEEP ─────────────────────────────────
git(repo, 'worktree', 'add', '-q', '-b', 'wA', wt('wA'), 'main');
writeFileSync(join(wt('wA'), 'a.txt'), 'base\nwork-A\n');
git(wt('wA'), 'add', '-A'); git(wt('wA'), 'commit', '-qm', 'A work');
check('A un-integrated commit', gcSafe(wt('wA'), 'main').gc, false);

// ── Scenario B: same branch fast-forward-merged into main → GC (ahead==0) ───
git(repo, 'merge', '-q', '--ff-only', 'wA'); // main now contains wA
check('B fast-forward integrated', gcSafe(wt('wA'), 'main').gc, true);

// ── Scenario C: squash merge — work in main as a NEW commit, original commits
//    stay unreachable (ahead>0) but the TREE is identical → GC via diff --quiet ─
git(repo, 'worktree', 'add', '-q', '-b', 'wC', wt('wC'), 'main');
writeFileSync(join(wt('wC'), 'b.txt'), 'feature-C\n');
git(wt('wC'), 'add', '-A'); git(wt('wC'), 'commit', '-qm', 'C1');
writeFileSync(join(wt('wC'), 'b.txt'), 'feature-C\nmore\n');
git(wt('wC'), 'add', '-A'); git(wt('wC'), 'commit', '-qm', 'C2');
// squash-merge wC's content into main as one new commit
git(repo, 'merge', '-q', '--squash', 'wC');
git(repo, 'commit', '-qm', 'squash C');
const cAhead = parseInt(git(wt('wC'), 'rev-list', '--count', 'main..HEAD').out, 10);
check('C squash-merged (content in base)', gcSafe(wt('wC'), 'main').gc, true);
console.log(`      (sanity: wC is ${cAhead} commits ahead of main yet tree-identical — ahead-count alone would never GC this)`);

// ── Scenario D: dirty working tree → KEEP ───────────────────────────────────
git(repo, 'worktree', 'add', '-q', '-b', 'wD', wt('wD'), 'main');
writeFileSync(join(wt('wD'), 'a.txt'), 'uncommitted edit\n');
check('D dirty working tree', gcSafe(wt('wD'), 'main').gc, false);

// ── Scenario E: clean worktree identical to base, no commits → GC ───────────
git(repo, 'worktree', 'add', '-q', '-b', 'wE', wt('wE'), 'main');
check('E clean + identical to base', gcSafe(wt('wE'), 'main').gc, true);

// ── Scenario F: untracked file only (still dirty) → KEEP ────────────────────
git(repo, 'worktree', 'add', '-q', '-b', 'wF', wt('wF'), 'main');
writeFileSync(join(wt('wF'), 'scratch.tmp'), 'junk\n');
check('F untracked file present', gcSafe(wt('wF'), 'main').gc, false);

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
