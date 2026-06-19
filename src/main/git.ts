import { spawn } from 'node:child_process';

/** Run git in `cwd` with `args`. Returns stdout text or an error. */
function runGit(cwd: string, args: string[], timeoutMs = 8000): Promise<{
  ok: true; stdout: string;
} | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: stderr.trim() || `git exited ${code}` });
    });
  });
}

export interface GitBranchInfo {
  current: string | null;
  detached: boolean;
}
export interface GitStatusEntry {
  path: string;
  index: string;   // staged status char
  worktree: string; // unstaged status char
}
export interface GitStatus {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
}
export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number; // unix seconds
  refs: string[]; // branch/tag refs
}
export interface GitAheadBehind {
  ahead: number;
  behind: number;
  upstream: string | null;
}

export async function getBranch(cwd: string): Promise<GitBranchInfo | { error: string }> {
  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) return { error: head.error };
  const name = head.stdout.trim();
  if (name === 'HEAD') return { current: null, detached: true };
  return { current: name, detached: false };
}

export async function getStatus(cwd: string): Promise<GitStatus | { error: string }> {
  const res = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!res.ok) return { error: res.error };
  const entries: GitStatusEntry[] = [];
  const untracked: string[] = [];
  const tokens = res.stdout.split('\0').filter(Boolean);
  for (const token of tokens) {
    if (token.length < 3) continue;
    const index = token[0];
    const worktree = token[1];
    const path = token.slice(3);
    if (index === '?' && worktree === '?') untracked.push(path);
    else entries.push({ path, index, worktree });
  }
  return {
    staged: entries.filter(e => e.index !== ' ' && e.index !== '?'),
    unstaged: entries.filter(e => e.worktree !== ' ' && e.worktree !== '?'),
    untracked
  };
}

export async function getLog(cwd: string, n: number): Promise<GitCommit[] | { error: string }> {
  const sep = '\x1e';   // record separator
  const fsep = '\x1f';  // field separator
  const fmt = ['%H', '%P', '%s', '%an', '%at', '%D'].join(fsep) + sep;
  const res = await runGit(cwd, ['log', '--all', `--max-count=${n}`, `--pretty=format:${fmt}`]);
  if (!res.ok) return { error: res.error };
  const out: GitCommit[] = [];
  for (const rec of res.stdout.split(sep)) {
    if (!rec.trim()) continue;
    const [sha, parents, subject, author, atime, refs] = rec.split(fsep);
    if (!sha) continue;
    out.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents: parents.split(' ').filter(Boolean),
      subject: subject ?? '',
      author: author ?? '',
      time: parseInt(atime, 10) || 0,
      refs: (refs ?? '').split(', ').map(s => s.trim()).filter(Boolean)
    });
  }
  return out;
}

export async function getBranches(cwd: string): Promise<{
  local: string[]; remote: string[]; current: string | null;
} | { error: string }> {
  const res = await runGit(cwd, ['branch', '-a', '--format=%(HEAD)\x1f%(refname:short)']);
  if (!res.ok) return { error: res.error };
  let current: string | null = null;
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const [head, name] = line.split('\x1f');
    if (!name) continue;
    if (head.trim() === '*') current = name;
    if (name.startsWith('remotes/')) remote.push(name.replace(/^remotes\//, ''));
    else local.push(name);
  }
  return { local, remote, current };
}

export async function getAheadBehind(cwd: string): Promise<GitAheadBehind | { error: string }> {
  const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return { ahead: 0, behind: 0, upstream: null };
  const upstream = up.stdout.trim();
  const ab = await runGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  if (!ab.ok) return { error: ab.error };
  const [ahead, behind] = ab.stdout.trim().split('\t').map(n => parseInt(n, 10) || 0);
  return { ahead, behind, upstream };
}

/** Best-effort detect: is `cwd` actually a git repo? */
export async function isRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

/** Derive a safe `agent/<id>` branch name from a worktree path's basename. */
function agentBranchFor(wtPath: string): string {
  const base = wtPath.split(/[\\/]/).filter(Boolean).pop() ?? 'agent';
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `agent/${slug}`;
}

/** Provision an isolated git worktree for an agent at `wtPath`, branching off
 *  `baseBranch`. Tries to create a fresh `agent/<id>` branch first; if that
 *  branch already exists, falls back to checking out `baseBranch` directly. */
export async function addWorktree(
  cwd: string, wtPath: string, baseBranch: string
): Promise<{ ok: boolean; error?: string }> {
  const branch = agentBranchFor(wtPath);
  const fresh = await runGit(cwd, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  if (fresh.ok) return { ok: true };
  // Branch likely already exists (or the path is taken) — retry without -b.
  const fallback = await runGit(cwd, ['worktree', 'add', wtPath, baseBranch]);
  if (fallback.ok) return { ok: true };
  return { ok: false, error: fallback.error };
}

/** Best-effort removal of an agent's worktree. Forced so a dirty tree doesn't
 *  block teardown; failures are surfaced but callers may ignore them. */
export async function removeWorktree(
  cwd: string, wtPath: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await runGit(cwd, ['worktree', 'remove', '--force', wtPath]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}

/** Does this worktree hold work that must NOT be auto-discarded? `keep` is true if
 *  the working tree is dirty (uncommitted/untracked changes) OR the branch has
 *  commits the base branch doesn't (un-integrated / would-be-PR commits). Ephemeral
 *  workers never push, so "commits ahead of base" is the local proxy for "un-pushed
 *  / open PR" work. Fails SAFE: any git query we can't run is treated as "there
 *  might be work" → keep, so an uncertain state never triggers an auto-remove. */
export async function worktreeHasUnintegratedWork(
  wtPath: string, baseBranch: string
): Promise<{ keep: boolean; detail: string; branch: string; dirty: boolean; ahead: number }> {
  const br = await getBranch(wtPath);
  const branch = 'current' in br && br.current ? br.current : '(detached)';
  // Uncommitted or untracked changes?
  const status = await runGit(wtPath, ['status', '--porcelain']);
  const dirty = status.ok ? status.stdout.trim().length > 0 : true; // unknown → assume dirty
  // Commits on HEAD not reachable from the base branch?
  let ahead = 0;
  let aheadKnown = true;
  const rl = await runGit(wtPath, ['rev-list', '--count', `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    ahead = Number.isFinite(n) ? n : 0;
  } else {
    aheadKnown = false; // unknown → assume there is work
  }
  const keep = dirty || ahead > 0 || !aheadKnown;
  const detail = `dirty=${dirty}, commitsAheadOf(${baseBranch})=${aheadKnown ? ahead : 'unknown'}`;
  return { keep, detail, branch, dirty, ahead };
}

/** Is this preserved worker worktree SAFE to garbage-collect — i.e. is its work
 *  fully integrated (or empty) with nothing uncommitted to lose? Used by the
 *  ephemeral-worker GC sweep, which must NEVER discard un-integrated work.
 *
 *  Returns `gc: true` ONLY when BOTH:
 *    (1) the working tree is clean (no uncommitted/untracked changes), AND
 *    (2) the worker's content is already in `baseBranch` — proven by EITHER
 *        commitsAheadOf(base) === 0 (HEAD reachable from base: fast-forward /
 *        plain merge, robust even after base advances) OR `git diff base HEAD`
 *        being empty (base's tree equals HEAD's tree: catches a SQUASH merge,
 *        which leaves the original commits unreachable so the ahead-count alone
 *        would never clear).
 *
 *  Fails SAFE in every other case: a dirty tree, un-integrated commits, OR any
 *  git query we can't run all yield `gc: false` (keep the worktree). This is the
 *  stronger sibling of `worktreeHasUnintegratedWork` — that gate decides whether
 *  to PRESERVE at teardown; this one decides whether a preserved worktree may now
 *  be reclaimed. */
export async function worktreeIsGcSafe(
  wtPath: string, baseBranch: string
): Promise<{ gc: boolean; detail: string }> {
  // (1) Clean tree?
  const status = await runGit(wtPath, ['status', '--porcelain']);
  if (!status.ok) return { gc: false, detail: 'status query failed' };
  if (status.stdout.trim().length > 0) return { gc: false, detail: 'working tree dirty' };
  // (2a) HEAD fully reachable from base (ahead == 0)?
  const rl = await runGit(wtPath, ['rev-list', '--count', `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    if (Number.isFinite(n) && n === 0) return { gc: true, detail: `clean + 0 commits ahead of ${baseBranch}` };
  }
  // (2b) base tree identical to HEAD tree (squash-merge / equivalent content)?
  // `git diff --quiet <base> HEAD` → exit 0 (ok) means NO differences.
  const diff = await runGit(wtPath, ['diff', '--quiet', baseBranch, 'HEAD']);
  if (diff.ok) return { gc: true, detail: `clean + tree identical to ${baseBranch} (integrated/squashed)` };
  // Either there are real un-integrated commits, or a query failed → keep.
  return { gc: false, detail: `clean but content not yet in ${baseBranch}` };
}
