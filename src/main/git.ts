import { spawn } from 'node:child_process';
import { openForRead, safeResolve } from './fs';

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

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB — keep the diff view responsive

/** A file's two sides for a working-tree-vs-HEAD diff. `head` is the committed
 *  version ('' for a new/untracked file); `working` is the on-disk version ('' for
 *  a file deleted from the working tree). The renderer feeds these straight into
 *  Monaco's DiffEditor (original = head, modified = working). */
export interface GitDiff {
  ok: true;
  path: string;            // resolved absolute path (display only)
  relPath: string;
  head: string;
  working: string;
  headExists: boolean;     // file is tracked at HEAD
  workingExists: boolean;  // file is present in the working tree
  isBinary: boolean;       // either side is binary → not text-diffable
}

/**
 * Diff a single file: its committed (HEAD) content vs its current working-tree
 * content. `relPath` MUST be repo-root-relative and is path-validated against
 * `cwd` with the shared fs guard (no escaping the workspace). All git/fs access
 * stays in the main process — the renderer only ever receives the two text sides.
 */
export async function getDiff(
  cwd: string, relPath: string
): Promise<GitDiff | { ok: false; error: string }> {
  const abs = await safeResolve(cwd, relPath);
  if (!abs) return { ok: false, error: 'path escapes repository root' };

  // HEAD side: `git show HEAD:<path>` — errors (untracked / new file) → no head version.
  let head = '';
  let headExists = false;
  const show = await runGit(cwd, ['show', `HEAD:${relPath}`]);
  if (show.ok) { head = show.stdout; headExists = true; }

  // Working side: read the on-disk file through the same guarded open as the file
  // IPC, so the final component is re-checked by the kernel at open time rather
  // than trusted from the `safeResolve` above. ENOENT (or a refused open) →
  // nothing diffable in the working tree.
  let working = '';
  let workingExists = false;
  let workingBinary = false;
  let fh;
  try {
    fh = await openForRead(abs);
    // Stat THROUGH the handle: it describes what is actually open, where a second
    // `stat` on the path would resolve it again. A directory has no diffable
    // content, and a FIFO would park the read — and the IPC call behind it —
    // forever.
    const s = await fh.stat();
    if (!s.isFile()) throw new Error('not a regular file');
    if (s.size > MAX_DIFF_BYTES) {
      return { ok: false, error: `file too large to diff (${(s.size / 1048576).toFixed(1)} MB)` };
    }
    const buf = await fh.readFile();
    workingExists = true;
    if (buf.includes(0)) workingBinary = true;
    else working = buf.toString('utf8');
  } catch {
    workingExists = false;
  } finally {
    await fh?.close().catch(() => {});
  }

  const isBinary = workingBinary || head.includes('\0');
  return {
    ok: true,
    path: abs,
    relPath,
    head: isBinary ? '' : head,
    working: isBinary ? '' : working,
    headExists,
    workingExists,
    isBinary
  };
}

/** The MAIN working tree of the repository `cwd` belongs to.
 *
 *  For a normal checkout that's just the repo root. For a linked worktree it is
 *  the original repo, NOT the worktree directory — an isolated agent's cwd is
 *  `<harnessHome>/worktrees/<agent-id>`, whose basename is the agent id and says
 *  nothing about which project it's working on. `--git-common-dir` resolves to
 *  the shared `.git` of the main checkout from anywhere in the worktree family.
 *  Returns null when `cwd` isn't a git repo (or git is unavailable). */
export async function mainRepoRoot(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!res.ok) return null;
  const gitDir = res.stdout.trim();
  if (!gitDir) return null;
  // `<repo>/.git` → `<repo>`. A bare repo has no working tree to name, so its
  // own path is the best answer we have.
  const stripped = gitDir.replace(/[\\/]\.git[\\/]?$/, '');
  return stripped || gitDir;
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

// ─── v0.3.4: history / compare / checkout plumbing (git visualization) ───────

/** Renderer-supplied revs/refs are untrusted strings. Allow the conservative
 *  charset git refs actually use, refuse leading '-' (option injection), and
 *  always pass '--' before any path arguments at call sites. */
export function isSafeRev(rev: string): boolean {
  return rev.length > 0 && rev.length <= 256 && !rev.startsWith('-') && /^[0-9A-Za-z._/^~@{}-]+$/.test(rev);
}

/** Full-history DAG page for the commit graph. Same record shape as getLog but
 *  topologically ordered (the graph layout assumes it) and pageable. Run this
 *  against mainRepoRoot(cwd) so every agent worktree branch appears. */
export async function getLogGraph(cwd: string, n: number, skip = 0): Promise<GitCommit[] | { error: string }> {
  const sep = '\x1e';
  const fsep = '\x1f';
  const fmt = ['%H', '%P', '%s', '%an', '%at', '%D'].join(fsep) + sep;
  const res = await runGit(cwd, [
    'log', '--all', '--topo-order', `--max-count=${n}`, ...(skip > 0 ? [`--skip=${skip}`] : []),
    `--pretty=format:${fmt}`
  ], 15000);
  if (!res.ok) return { error: res.error };
  const out: GitCommit[] = [];
  for (const rec of res.stdout.split(sep)) {
    if (!rec.trim()) continue;
    const [sha, parents, subject, author, atime, refs] = rec.split(fsep);
    if (!sha) continue;
    out.push({
      sha: sha.trim(),
      shortSha: sha.trim().slice(0, 7),
      parents: (parents ?? '').split(' ').filter(Boolean),
      subject: subject ?? '',
      author: author ?? '',
      time: parseInt(atime, 10) || 0,
      refs: (refs ?? '').split(', ').map(s => s.trim()).filter(Boolean)
    });
  }
  return out;
}

export interface GitCommitFile {
  path: string;
  status: string;      // A/M/D/R/C/T…
  oldPath?: string;    // for renames/copies
}

/** Parse `-z --name-status` output shared by diff-tree and diff. Records are
 *  STATUS\0path\0 — with renames/copies STATUS<score>\0old\0new\0. */
function parseNameStatusZ(stdout: string): GitCommitFile[] {
  const tokens = stdout.split('\0').filter((t) => t.length > 0);
  const files: GitCommitFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!/^[A-Z]/.test(status)) continue; // skip stray commit ids
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      i += 2;
      if (path) files.push({ path, status: kind, oldPath });
    } else {
      const path = tokens[i + 1];
      i += 1;
      if (path) files.push({ path, status: kind });
    }
  }
  return files;
}

/** Files touched by one commit (rename-aware). */
export async function getCommitFiles(cwd: string, sha: string): Promise<GitCommitFile[] | { error: string }> {
  if (!isSafeRev(sha)) return { error: 'invalid revision' };
  const res = await runGit(cwd, ['diff-tree', '--no-commit-id', '-r', '--root', '-z', '-M', '--name-status', sha, '--']);
  if (!res.ok) return { error: res.error };
  return parseNameStatusZ(res.stdout);
}

const MAX_SHOW_BYTES = 2 * 1024 * 1024; // match getDiff's cap

/** One side of a rev-pinned diff: the file's content at `rev` ('' + exists:false
 *  when the path doesn't exist there — e.g. an added file's parent side). */
export async function getFileAtRev(cwd: string, rev: string, relPath: string): Promise<
  { ok: true; exists: boolean; isBinary: boolean; content: string } | { ok: false; error: string }
> {
  if (!isSafeRev(rev)) return { ok: false, error: 'invalid revision' };
  if (!(await safeResolve(cwd, relPath))) return { ok: false, error: 'path escapes repository root' };
  const size = await runGit(cwd, ['cat-file', '-s', `${rev}:${relPath}`]);
  if (!size.ok) return { ok: true, exists: false, isBinary: false, content: '' };
  if ((parseInt(size.stdout.trim(), 10) || 0) > MAX_SHOW_BYTES) {
    return { ok: false, error: 'file too large to diff (>2 MB)' };
  }
  const res = await runGit(cwd, ['show', `${rev}:${relPath}`]);
  if (!res.ok) return { ok: true, exists: false, isBinary: false, content: '' };
  if (res.stdout.includes('\0')) return { ok: true, exists: true, isBinary: true, content: '' };
  return { ok: true, exists: true, isBinary: false, content: res.stdout };
}

export interface GitCompare {
  ahead: number;        // commits in head, not base
  behind: number;       // commits in base, not head
  mergeBase: string | null;
  files: GitCommitFile[];
}

/** Compare two refs. mode 'three' (default, PR-style): what head adds since the
 *  merge base. mode 'two': the literal state difference base→head. */
export async function compareRefs(cwd: string, base: string, head: string, mode: 'two' | 'three'): Promise<GitCompare | { error: string }> {
  if (!isSafeRev(base) || !isSafeRev(head)) return { error: 'invalid revision' };
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', `${base}...${head}`]);
  if (!counts.ok) return { error: counts.error };
  const [behind, ahead] = counts.stdout.trim().split('\t').map((x) => parseInt(x, 10) || 0);
  const mb = await runGit(cwd, ['merge-base', base, head]);
  const mergeBase = mb.ok ? mb.stdout.trim() : null;
  const diffArgs = mode === 'three'
    ? ['diff', '-z', '-M', '--name-status', `${base}...${head}`, '--']
    : ['diff', '-z', '-M', '--name-status', base, head, '--'];
  const res = await runGit(cwd, diffArgs, 15000);
  if (!res.ok) return { error: res.error };
  return { ahead, behind, mergeBase, files: parseNameStatusZ(res.stdout) };
}

export interface GitWorktreeInfo { path: string; head: string; branch: string | null }

export async function listWorktrees(cwd: string): Promise<GitWorktreeInfo[] | { error: string }> {
  const res = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return { error: res.error };
  const out: GitWorktreeInfo[] = [];
  let cur: Partial<GitWorktreeInfo> = {};
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { if (cur.path) out.push(cur as GitWorktreeInfo); cur = { path: line.slice(9), head: '', branch: null }; }
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  if (cur.path) out.push(cur as GitWorktreeInfo);
  return out;
}

/** Guarded checkout (v0.3.4). FAIL-SAFE philosophy like worktreeHasUnintegratedWork:
 *  any doubt → refuse. Guards here cover the repo itself; the IPC layer adds the
 *  "no agent actively working in this tree" guard (it owns the pty registry). */
export async function checkoutRef(cwd: string, ref: string, detach: boolean): Promise<{ ok: true; detached: boolean } | { ok: false; error: string }> {
  if (!isSafeRev(ref)) return { ok: false, error: 'invalid revision' };
  const st = await getStatus(cwd);
  if ('error' in st) return { ok: false, error: `could not verify a clean tree: ${st.error}` };
  const dirty = st.staged.length + st.unstaged.length;
  if (dirty > 0) {
    return { ok: false, error: `working tree has ${dirty} uncommitted change${dirty === 1 ? '' : 's'} — commit or stash first` };
  }
  const res = await runGit(cwd, detach ? ['switch', '--detach', ref] : ['switch', ref], 15000);
  if (!res.ok) {
    // A branch held by another worktree: name the holder instead of raw stderr.
    if (/already checked out|already used by worktree/i.test(res.error)) {
      const wts = await listWorktrees(cwd);
      const holder = Array.isArray(wts) ? wts.find((w) => w.branch === ref.replace(/^refs\/heads\//, '')) : undefined;
      return { ok: false, error: holder ? `'${ref}' is checked out in another worktree: ${holder.path}` : res.error };
    }
    return { ok: false, error: res.error };
  }
  return { ok: true, detached: detach };
}
