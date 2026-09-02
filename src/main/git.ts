import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { safeJoin } from './fs';

/** 在 `cwd` 中用 `args` 运行 git。返回 stdout 文本或错误。 */
function runGit(cwd: string, args: string[], timeoutMs = 8000): Promise<{
  ok: true; stdout: string;
} | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* 空操作 */ }
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
  index: string;   // 已暂存状态字符
  worktree: string; // 未暂存状态字符
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
  time: number; // unix 秒
  refs: string[]; // 分支/标签引用
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
  const sep = '\x1e';   // 记录分隔符
  const fsep = '\x1f';  // 字段分隔符
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

/** 尽力检测：`cwd` 到底是不是一个 git 仓库？ */
export async function isRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB —— 保持 diff 视图的响应速度

/** 工作树与 HEAD 对比时一个文件的两侧。`head` 是已提交版本（新/未跟踪文件
 *  为 ''）；`working` 是磁盘上的版本（已从工作树删除的文件为 ''）。渲染进程
 *  直接把它们喂给 Monaco 的 DiffEditor（original = head，modified = working）。 */
export interface GitDiff {
  ok: true;
  path: string;            // 解析后的绝对路径（仅用于显示）
  relPath: string;
  head: string;
  working: string;
  headExists: boolean;     // 文件在 HEAD 被跟踪
  workingExists: boolean;  // 文件存在于工作树
  isBinary: boolean;       // 任一侧是二进制 → 无法做文本 diff
}

/**
 * 对比单个文件：它的已提交（HEAD）内容 vs 当前工作树内容。`relPath` 必须
 * 相对于仓库根目录，并用共享 fs 守卫对照 `cwd` 做路径校验（不允许逃出
 * 工作区）。所有 git/fs 访问都留在主进程——渲染进程只会收到两侧文本。
 */
export async function getDiff(
  cwd: string, relPath: string
): Promise<GitDiff | { ok: false; error: string }> {
  const abs = safeJoin(cwd, relPath);
  if (!abs) return { ok: false, error: 'path escapes repository root' };

  // HEAD 侧：`git show HEAD:<path>` ——出错（未跟踪/新文件）→ 没有 HEAD 版本。
  let head = '';
  let headExists = false;
  const show = await runGit(cwd, ['show', `HEAD:${relPath}`]);
  if (show.ok) { head = show.stdout; headExists = true; }

  // 工作侧：读取磁盘上的文件。ENOENT → 已从工作树删除。
  let working = '';
  let workingExists = false;
  let workingBinary = false;
  try {
    const s = await stat(abs);
    if (s.size > MAX_DIFF_BYTES) {
      return { ok: false, error: `文件过大，无法 diff（${(s.size / 1048576).toFixed(1)} MB）` };
    }
    const buf = await readFile(abs);
    workingExists = true;
    if (buf.includes(0)) workingBinary = true;
    else working = buf.toString('utf8');
  } catch {
    workingExists = false;
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

/** `cwd` 所属仓库的主工作树。
 *
 *  普通检出就是仓库根目录。对于关联的 worktree，它是原始仓库，而不是
 *  worktree 目录——隔离 agent 的 cwd 是 `<harnessHome>/worktrees/<agent-id>`，
 *  其 basename 是 agent id，说明不了它在做哪个项目。`--git-common-dir` 从
 *  worktree 家族的任何位置都能解析到主检出的共享 `.git`。当 `cwd` 不是 git
 *  仓库（或 git 不可用）时返回 null。 */
export async function mainRepoRoot(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!res.ok) return null;
  const gitDir = res.stdout.trim();
  if (!gitDir) return null;
  // `<repo>/.git` → `<repo>`。裸仓库没有可命名的工作树，因此它
  // 自己的路径就是我们能给的最好答案。
  const stripped = gitDir.replace(/[\\/]\.git[\\/]?$/, '');
  return stripped || gitDir;
}

/** 从 worktree 路径的 basename 派生出安全的 `agent/<id>` 分支名。 */
function agentBranchFor(wtPath: string): string {
  const base = wtPath.split(/[\\/]/).filter(Boolean).pop() ?? 'agent';
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `agent/${slug}`;
}

/** 在 `wtPath` 为 agent 提供隔离的 git worktree，从 `baseBranch` 分出分支。
 *  先尝试创建全新的 `agent/<id>` 分支；若该分支已存在，则回退为直接检出
 *  `baseBranch`。 */
export async function addWorktree(
  cwd: string, wtPath: string, baseBranch: string
): Promise<{ ok: boolean; error?: string }> {
  const branch = agentBranchFor(wtPath);
  const fresh = await runGit(cwd, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  if (fresh.ok) return { ok: true };
  // 分支很可能已存在（或路径被占用）——去掉 -b 重试。
  const fallback = await runGit(cwd, ['worktree', 'add', wtPath, baseBranch]);
  if (fallback.ok) return { ok: true };
  return { ok: false, error: fallback.error };
}

/** 尽力移除 agent 的 worktree。强制进行，这样脏工作树不会阻塞拆除；
 *  失败会暴露出来，但调用方可以忽略。 */
export async function removeWorktree(
  cwd: string, wtPath: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await runGit(cwd, ['worktree', 'remove', '--force', wtPath]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}

/** 这个 worktree 是否含有“绝不能自动丢弃”的工作？当工作树是脏的
 *  （未提交/未跟踪的改动）或分支上有 base 分支没有的提交
 *  （未集成/将成为 PR 的提交）时，`keep` 为 true。临时 worker 从不 push，
 *  因此“领先 base 的提交”就是“未 push / 开着的 PR”工作的本地代理。
 *  失败时安全：任何我们无法运行的 git 查询都被当作“可能有工作”→ keep，
 *  这样不确定状态绝不会触发自动移除。 */
export async function worktreeHasUnintegratedWork(
  wtPath: string, baseBranch: string
): Promise<{ keep: boolean; detail: string; branch: string; dirty: boolean; ahead: number }> {
  const br = await getBranch(wtPath);
  const branch = 'current' in br && br.current ? br.current : '(detached)';
  // 有没有未提交或未跟踪的改动？
  const status = await runGit(wtPath, ['status', '--porcelain']);
  const dirty = status.ok ? status.stdout.trim().length > 0 : true; // 未知 → 假定为脏
  // HEAD 上有从 base 分支无法抵达的提交？
  let ahead = 0;
  let aheadKnown = true;
  const rl = await runGit(wtPath, ['rev-list', '--count', `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    ahead = Number.isFinite(n) ? n : 0;
  } else {
    aheadKnown = false; // 未知 → 假定有工作
  }
  const keep = dirty || ahead > 0 || !aheadKnown;
  const detail = `dirty=${dirty}, commitsAheadOf(${baseBranch})=${aheadKnown ? ahead : 'unknown'}`;
  return { keep, detail, branch, dirty, ahead };
}

/** 这个被保留的 worker worktree 是否可以安全地交给垃圾回收——即它的工作
 *  是否已完全集成（或为空），没有任何未提交的东西会丢失？供临时 worker 的
 *  GC 清扫使用，它绝不能丢弃未集成的工作。
 *
 *  仅当同时满足以下两条时才返回 `gc: true`：
 *    (1) 工作树干净（没有未提交/未跟踪的改动），且
 *    (2) worker 的内容已经在 `baseBranch` 中——由以下任一证明：
 *        commitsAheadOf(base) === 0（HEAD 可被 base 抵达：快进/普通合并，
 *        即使 base 已前进仍然稳健），或 `git diff base HEAD` 为空
 *        （base 的树等于 HEAD 的树：能抓住 SQUASH 合并，它会让原始提交
 *        不可达，因此仅靠领先数永远无法清零）。
 *
 *  其他所有情况都安全失败：脏工作树、未集成提交、或任何我们无法运行的
 *  git 查询，全部产出 `gc: false`（保留 worktree）。它是
 *  `worktreeHasUnintegratedWork` 的更强制约——那个门决定拆除时是否
 *  “保留”；这个决定一个被保留的 worktree 现在是否可以回收。 */
export async function worktreeIsGcSafe(
  wtPath: string, baseBranch: string
): Promise<{ gc: boolean; detail: string }> {
  // (1) 工作树干净？
  const status = await runGit(wtPath, ['status', '--porcelain']);
  if (!status.ok) return { gc: false, detail: 'status query failed' };
  if (status.stdout.trim().length > 0) return { gc: false, detail: 'working tree dirty' };
  // (2a) HEAD 完全可被 base 抵达（领先数 == 0）？
  const rl = await runGit(wtPath, ['rev-list', '--count', `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    if (Number.isFinite(n) && n === 0) return { gc: true, detail: `clean + 0 commits ahead of ${baseBranch}` };
  }
  // (2b) base 的树与 HEAD 的树相同（squash 合并/内容等价）？
  // `git diff --quiet <base> HEAD` → 退出码 0（ok）表示没有任何差异。
  const diff = await runGit(wtPath, ['diff', '--quiet', baseBranch, 'HEAD']);
  if (diff.ok) return { gc: true, detail: `clean + tree identical to ${baseBranch} (integrated/squashed)` };
  // 要么确有未集成的提交，要么查询失败 → 保留。
  return { gc: false, detail: `clean but content not yet in ${baseBranch}` };
}

// ─── v0.3.4：历史 / 对比 / 检出管道（git 可视化）──────────────────────────

/** 渲染进程提供的 revs/refs 是不可信字符串。只允许 git ref 实际使用的
 *  保守字符集，拒绝开头的 '-'（选项注入），并且调用处总是在任何路径参数
 *  之前传 '--'。 */
export function isSafeRev(rev: string): boolean {
  return rev.length > 0 && rev.length <= 256 && !rev.startsWith('-') && /^[0-9A-Za-z._/^~@{}-]+$/.test(rev);
}

/** 提交图的全历史 DAG 分页。与 getLog 相同的记录形状，但是拓扑排序
 *  （图布局依赖这一点）且可分页。对 mainRepoRoot(cwd) 运行它，
 *  这样每个 agent worktree 的分支都会出现。 */
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
  status: string;      // A/M/D/R/C/T…（新增/修改/删除/重命名/复制/类型变更）
  oldPath?: string;    // 用于重命名/复制
}

/** 解析 diff-tree 和 diff 共用的 `-z --name-status` 输出。记录格式为
 *  STATUS\0path\0——重命名/复制时为 STATUS<score>\0old\0new\0。 */
function parseNameStatusZ(stdout: string): GitCommitFile[] {
  const tokens = stdout.split('\0').filter((t) => t.length > 0);
  const files: GitCommitFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!/^[A-Z]/.test(status)) continue; // 跳过杂散的提交 id
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

/** 单个提交改动的文件（识别重命名）。 */
export async function getCommitFiles(cwd: string, sha: string): Promise<GitCommitFile[] | { error: string }> {
  if (!isSafeRev(sha)) return { error: 'invalid revision' };
  const res = await runGit(cwd, ['diff-tree', '--no-commit-id', '-r', '--root', '-z', '-M', '--name-status', sha, '--']);
  if (!res.ok) return { error: res.error };
  return parseNameStatusZ(res.stdout);
}

const MAX_SHOW_BYTES = 2 * 1024 * 1024; // 与 getDiff 的上限一致

/** rev 固定 diff 的一侧：文件在 `rev` 处的内容（该处路径不存在时为 '' +
 *  exists:false——例如新增文件的父侧）。 */
export async function getFileAtRev(cwd: string, rev: string, relPath: string): Promise<
  { ok: true; exists: boolean; isBinary: boolean; content: string } | { ok: false; error: string }
> {
  if (!isSafeRev(rev)) return { ok: false, error: 'invalid revision' };
  if (!safeJoin(cwd, relPath)) return { ok: false, error: 'path escapes repository root' };
  const size = await runGit(cwd, ['cat-file', '-s', `${rev}:${relPath}`]);
  if (!size.ok) return { ok: true, exists: false, isBinary: false, content: '' };
  if ((parseInt(size.stdout.trim(), 10) || 0) > MAX_SHOW_BYTES) {
    return { ok: false, error: '文件过大，无法 diff（>2 MB）' };
  }
  const res = await runGit(cwd, ['show', `${rev}:${relPath}`]);
  if (!res.ok) return { ok: true, exists: false, isBinary: false, content: '' };
  if (res.stdout.includes('\0')) return { ok: true, exists: true, isBinary: true, content: '' };
  return { ok: true, exists: true, isBinary: false, content: res.stdout };
}

export interface GitCompare {
  ahead: number;        // head 有而 base 没有的提交
  behind: number;       // base 有而 head 没有的提交
  mergeBase: string | null;
  files: GitCommitFile[];
}

/** 对比两个 ref。mode 'three'（默认，PR 风格）：head 自合并基以来新增了什么。
 *  mode 'two'：base→head 的字面状态差异。 */
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

/** 有守卫的检出（v0.3.4）。与 worktreeHasUnintegratedWork 相同的安全失败哲学：
 *  任何疑虑 → 拒绝。这里的守卫覆盖仓库本身；IPC 层外加
 *  “没有 agent 正在此树中工作”的守卫（它拥有 pty 注册表）。 */
export async function checkoutRef(cwd: string, ref: string, detach: boolean): Promise<{ ok: true; detached: boolean } | { ok: false; error: string }> {
  if (!isSafeRev(ref)) return { ok: false, error: 'invalid revision' };
  const st = await getStatus(cwd);
  if ('error' in st) return { ok: false, error: `无法验证干净的树：${st.error}` };
  const dirty = st.staged.length + st.unstaged.length;
  if (dirty > 0) {
    return { ok: false, error: `工作树有 ${dirty} 处未提交的变更——请先提交或暂存` };
  }
  const res = await runGit(cwd, detach ? ['switch', '--detach', ref] : ['switch', ref], 15000);
  if (!res.ok) {
    // 被另一个 worktree 占用的分支：指出占用者，而不是裸抛 stderr。
    if (/already checked out|already used by worktree/i.test(res.error)) {
      const wts = await listWorktrees(cwd);
      const holder = Array.isArray(wts) ? wts.find((w) => w.branch === ref.replace(/^refs\/heads\//, '')) : undefined;
      return { ok: false, error: holder ? `'${ref}' is checked out in another worktree: ${holder.path}` : res.error };
    }
    return { ok: false, error: res.error };
  }
  return { ok: true, detached: detach };
}
