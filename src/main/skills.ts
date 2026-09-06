/**
 * SKILLS —— 这台机器上的编码 agent 实际能做什么，外加一份可浏览的
 * “它们还能做什么”的目录。
 *
 * 两个半区，刻意分开：
 *
 *  1. LOCAL —— 已安装的技能，通过遍历每个 CLI 读取的目录发现。
 *     Claude Code 是规范最明确的一个：技能是一个包含 SKILL.md 的文件夹，
 *     其 YAML frontmatter 带有 `name` 和 `description`。OpenCode 和 Codex
 *     改用插件/配置目录，所以它们被报成插件，而不是假装共享同一格式。
 *
 *  2. CATALOG —— abubakarsiddik31/claude-skills-collection：13 个类别、
 *     227 个技能，以 markdown 表格呈现，每行带一个 GitHub 源链接。
 *     它没有 JSON 索引（已确认），所以条目从原始 markdown 解析出来并
 *     缓存在磁盘。网络失败绝非致命：先是过期缓存，然后是空列表，
 *     然后 UI 会如实说明。
 *
 * 这里什么都不安装。只做发现和浏览——安装第三方技能意味着在一个拥有
 * 用户工具的 agent 里运行别人的指令，那个决定始终留给用户。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename, dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { getText } from './fetchText';

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  /** 哪个 CLI 读取这个目录。 */
  provider: 'claude' | 'codex';
  /** 'user' = 整台机器的全局，'project' = 某个仓库，'bundled' = 随应用附带。 */
  scope: 'user' | 'project' | 'bundled';
  path: string;
}

export interface CatalogSkill {
  name: string;
  description: string;
  url: string;
  category: string;
  /** 发布者，取自来源 URL 的 GitHub 属主——anthropics、stripe、
   *  supabase。这个列表里的名字都是裸名（`docx`、`pdf`），
   *  所以发布者只出现在 URL 里。 */
  owner: string;
}

/** 剥掉开头的 YAML frontmatter 块，取出我们渲染的两个字段。
 *  刻意不做成 YAML 解析器：UI 只显示 `name` 和 `description`，
 *  而且 description 通常是一个多行 `|` 块，朴素的 key:value 切分
 *  会在第一行截断它。 */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const body = m[1];
  const out: { name?: string; description?: string } = {};
  const nameM = /^name:\s*(.+)$/m.exec(body);
  if (nameM) out.name = nameM[1].trim().replace(/^["']|["']$/g, '');
  // 块标量（`description: |`）→ 取其后缩进的行。
  // `description: |` 之后连续缩进的行。更早的前瞻形式
  // 以 `\r?\n?$` 结尾，在 /m 下匹配的是第一行的末尾 ——
  // 因此每个多行 description 都静默被截断成了一行。
  const blockM = /^description:\s*[|>]-?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(body);
  if (blockM) {
    out.description = blockM[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ').trim();
  } else {
    const inlineM = /^description:\s*(.+)$/m.exec(body);
    if (inlineM) out.description = inlineM[1].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 读取 `dir` 下每个含 SKILL.md 的文件夹，组装为 LocalSkill。 */
function scanSkillDir(
  dir: string,
  provider: LocalSkill['provider'],
  scope: LocalSkill['scope']
): LocalSkill[] {
  const out: LocalSkill[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      const md = join(skillDir, 'SKILL.md');
      try {
        if (!statSync(skillDir).isDirectory() || !existsSync(md)) continue;
        const fm = parseSkillFrontmatter(readFileSync(md, 'utf8'));
        out.push({
          id: `${scope}:${entry}`,
          name: fm.name || entry,
          description: fm.description || '',
          provider,
          scope,
          path: skillDir
        });
      } catch { /* one unreadable skill must not hide the rest */ }
    }
  } catch { /* unreadable root → report nothing rather than throw into IPC */ }
  return out;
}

/** 不支持 Claude SKILL.md 格式的 CLI 的插件目录。
 *  作为条目报告，使标签页如实反映某个提供者可用的东西，
 *  而非暗示只有 Claude Code 可扩展。 */
function scanPluginDir(dir: string, provider: LocalSkill['provider'], scope: LocalSkill['scope']): LocalSkill[] {
  const out: LocalSkill[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      out.push({
        id: `${scope}:${provider}:${entry}`,
        name: entry.replace(/\.(m|c)?js$/i, ''),
        description: `Plugin in ${basename(dirname(dir))}/${basename(dir)}`,
        provider,
        scope,
        path: join(dir, entry)
      });
    }
  } catch { /* noop */ }
  return out;
}

/** 所有已安装的技能，按 (provider, name) 去重，作用域最具体的胜出 ——
 *  项目级技能覆盖用户级，用户级覆盖内置副本，
 *  优先级与 CLI 自身应用的一致。 */
export function listLocalSkills(opts: { cwds: string[]; bundledDir: string | null }): LocalSkill[] {
  const home = homedir();
  const found: LocalSkill[] = [
    ...(opts.bundledDir ? scanSkillDir(opts.bundledDir, 'claude', 'bundled') : []),
    ...scanSkillDir(join(home, '.claude', 'skills'), 'claude', 'user'),
    ...scanPluginDir(join(home, '.codex', 'plugins'), 'codex', 'user')
  ];
  for (const cwd of opts.cwds) {
    if (!cwd) continue;
    found.push(...scanSkillDir(join(cwd, '.claude', 'skills'), 'claude', 'project'));

  }
  const rank = { project: 3, user: 2, bundled: 1 } as const;
  const best = new Map<string, LocalSkill>();
  for (const s of found) {
    const key = `${s.provider}:${s.name.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || rank[s.scope] > rank[prev.scope]) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const CATALOG_URL =
  'https://raw.githubusercontent.com/abubakarsiddik31/claude-skills-collection/main/README.md';
/** 精选列表按人类时间尺度更新，隔天的副本就够用，
 *  且让标签页在首次打开后的每次开启都即时加载。 */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 解析 catalog README 为条目列表。
 *
 * 列表是 `## <emoji> Category` 标题下的 markdown 表格：
 *
 *   | Name | Description | Link |
 *   |------|-------------|------|
 *   | **docx** | 创建和编辑 Word 文档 | [Source](https://github.com/…/tree/main/skills/docx) |
 *
 * 非技能行的行——表头行、`|---|` 分隔行、统计每类技能数量的概览表——
 * 通过要求三列单元格 AND 一个可解析的 https 链接来跳过。其余一律丢弃而非猜测：
 * 缺少行的目录是诚实的，充满已解析表头的目录则不然。
 */
export function parseCatalogMarkdown(md: string): CatalogSkill[] {
  const out: CatalogSkill[] = [];
  let category = 'Skills';
  const seen = new Set<string>();
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (h) {
      category = h[1]
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        // 仅开头的图形符号 —— 无差别剥离非字母数字会吃掉
        // 只剥开头的图形符号，避免吃掉 ".NET" 这类名字里的点。
        .replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '')
        .trim() || category;
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^-{3,}$/.test(cells[0].replace(/:/g, ''))) continue; // the |---| rule
    const name = cells[0].replace(/[*`]/g, '').trim();
    const description = cells[1].replace(/[*`]/g, '').trim();
    const linkM = /\((https?:\/\/[^)]+)\)/.exec(cells[2]) || /(https?:\/\/\S+)/.exec(cells[2]);
    if (!name || !linkM) continue;
    const url = linkM[1].trim();
    const key = `${name}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ghOwner = /^https:\/\/github\.com\/([^/]+)/i.exec(url);
    out.push({
      name,
      description,
      url,
      category,
      owner: ghOwner ? ghOwner[1].toLowerCase() : 'other'
    });
  }
  return out;
}


/**
 * 目录缓存：新鲜时来自缓存，否则从网络获取。刷新失败时回退到已有缓存 ——
 * 离线用户仍可浏览，只是标记为过时，而不是空标签页且无解释。
 */
export async function loadCatalog(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<{ skills: CatalogSkill[]; fetchedAt: number; stale: boolean; error?: string }> {
  let cached: { skills: CatalogSkill[]; fetchedAt: number } | null = null;
  try {
    if (existsSync(cachePath)) cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch { cached = null; }

  const fresh = cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS;
  if (fresh && !opts.force) return { skills: cached!.skills, fetchedAt: cached!.fetchedAt, stale: false };

  try {
    const md = await getText(CATALOG_URL);
    const skills = parseCatalogMarkdown(md);
    // 空解析意味着 README 的格式已变更。保留缓存。
    if (skills.length === 0 && cached) {
      return { skills: cached.skills, fetchedAt: cached.fetchedAt, stale: true, error: 'catalog format changed' };
    }
    const payload = { skills, fetchedAt: Date.now() };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(payload));
    } catch { /* cache is an optimisation, not a requirement */ }
    return { ...payload, stale: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached) return { skills: cached.skills, fetchedAt: cached.fetchedAt, stale: true, error };
    return { skills: [], fetchedAt: 0, stale: true, error };
  }
}

/* ── Install / uninstall ──────────────────────────────────────────────────────
 *
 * 技能是「在持有用户工具和密钥的 agent 内部运行的指令」，所以本文件的这一半
 * 以源端具有敌意的方式来编写 —— 从应用的角度看确实如此：
 * 它是来自任何人可发起 PR 的公开列表的任意内容。
 *
 * 以下所有限制都是为特定滥用场景设界：
 *   - 目标名称经过sanitize，因此 `../../.claude/settings.json` 不能伪装成
 *     "技能名"；
 *   - 每个下载路径在解析后重新检查是否在目标目录内部，
 *     因此伪造的 API 响应无法逃逸；
 *   - 文件数、总字节数和深度均有限制，因此仓库无法撑满磁盘；
 *   - 仅写入常规文件 —— 来自 contents API 的 `symlink` 或 `submodule`
 *     条目被跳过，绝不跟随。
 *
 * 卸载是更危险的动词，因此按更严格的方式处理：它删除一个目录，
 * 所以它拒绝任何不在已知技能根目录内部且自身不含 SKILL.md 的内容。
 * 内置技能永远无法被移除 —— 它随应用一起发布，下次启动仍会重新出现。
 */
/** GitHub 按目录列出的条目。只保留我们实际消费的字段。 */
interface GhEntry { name: string; path: string; type: string; size?: number; download_url?: string | null }

const MAX_FILES = 60;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 5;

/**
 *
 * 两种形状，因为目录同时使用两种：仓库内的文件夹
 * （`owner/repo/tree/<ref>/<path>`，145 个条目）和根目录就是技能本身的整个仓库
 * （`owner/repo`，81 个条目）。后者 `ref` 为空，调用方省略它，
 * 使 API 使用仓库的默认分支 —— 在 `main` 和 `master` 之间没有可靠方法猜测，
 * 也不需要。
 */
export function parseGitHubSourceUrl(url: string): { owner: string; repo: string; ref: string; path: string } | null {
  const clean = url.trim().replace(/[#?].*$/, '').replace(/\/+$/, '');
  const tree = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/.exec(clean);
  if (tree) {
    const [, owner, repo, ref, path] = tree;
    if (!owner || !repo || !ref) return null;
    return { owner, repo, ref, path: path.replace(/\/+$/, '') };
  }
  const root = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(clean);
  if (root) {
    const [, owner, repo] = root;
    // 非仓库的保留路径。
    if (['orgs', 'topics', 'collections', 'sponsors', 'features'].includes(owner.toLowerCase())) return null;
    return { owner, repo: repo.replace(/\.git$/i, ''), ref: '', path: '' };
  }
  return null;
}

/** 我们愿意创建的文件夹名。任何含分隔符、双点或前导点的名字一律拒绝，绝不柔化处理。 */
export function safeSkillDirName(raw: string): string | null {
  const base = raw.trim().split('/').pop() ?? '';
  if (!base || base === '.' || base === '..') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(base)) return null;
  if (base.includes('..')) return null;
  return base;
}

function getJson<T>(url: string): Promise<T> {
  return getText(url).then((t) => JSON.parse(t) as T);
}

/** officialskills.sh 页面是 GitHub 文件夹的渲染，并链接回该仓库。
 *  解析该链接只需一次请求，就能将 578 个原本不可安装的
 *  目录行转换为可安装的。 */
async function resolveSourceUrl(url: string): Promise<string | null> {
  if (parseGitHubSourceUrl(url)) return url;
  if (!/^https:\/\/(www\.)?officialskills\.sh\//i.test(url)) return null;
  try {
    const html = await getText(url);
    const m = /https:\/\/github\.com\/[^/"'\s]+\/[^/"'\s]+\/tree\/[^"'\s<>)]+/.exec(html);
    return m ? m[0].replace(/[.,)]+$/, '') : null;
  } catch { return null; }
}

/**
 * 将单个技能文件夹下载到用户的 Claude 技能目录。
 *
 * 返回结构化的拒绝而非抛出异常，这样 UI 可以说明原因 ——
 * "不可安装"和"安装失败"对用户是两种不同的答案。
 */
export async function installSkill(
  entryUrl: string,
  entryName: string
): Promise<{ ok: true; path: string } | { ok: false; error: string; unsupported?: boolean }> {
  const source = await resolveSourceUrl(entryUrl);
  if (!source) {
    return { ok: false, unsupported: true, error: 'No downloadable source — open Learn more to install it by hand.' };
  }
  const gh = parseGitHubSourceUrl(source);
  if (!gh) return { ok: false, unsupported: true, error: 'Source is not a GitHub folder.' };

  const dirName = safeSkillDirName(gh.path || entryName);
  if (!dirName) return { ok: false, error: 'That skill has a name this app will not create a folder for.' };

  const root = join(homedir(), '.claude', 'skills');
  const dest = join(root, dirName);
  if (existsSync(dest)) return { ok: false, error: `Already installed at ${dest}` };

  // 空 ref 表示"仓库的默认分支" —— 完全省略参数
  // 而非猜测 main 还是 master。
  const api = (p: string) =>
    `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${p ? encodeURI(p) : ''}`
    + (gh.ref ? `?ref=${encodeURIComponent(gh.ref)}` : '');

  const files: { path: string; url: string; size: number }[] = [];
  let total = 0;
  const walk = async (path: string, depth: number): Promise<string | null> => {
    if (depth > MAX_DEPTH) return 'the folder nests deeper than this installer will follow';
    let listing: GhEntry[];
    try {
      const res = await getJson<GhEntry[] | GhEntry>(api(path));
      listing = Array.isArray(res) ? res : [res];
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    for (const it of listing) {
      if (files.length >= MAX_FILES) return 'that skill has more files than this installer will fetch';
      if (it.type === 'dir') {
        const err = await walk(it.path, depth + 1);
        if (err) return err;
        continue;
      }
      // 仅常规文件。symlink/submodule 条目被跳过，绝不跟随。
      if (it.type !== 'file' || !it.download_url) continue;
      const size = it.size ?? 0;
      total += size;
      if (total > MAX_TOTAL_BYTES) return 'that skill is larger than this installer will fetch';
      const rel = gh.path ? it.path.slice(gh.path.length).replace(/^\/+/, '') : it.path;
      files.push({ path: rel, url: it.download_url, size });
    }
    return null;
  };

  const walkErr = await walk(gh.path, 0);
  if (walkErr) return { ok: false, error: walkErr };
  if (files.length === 0) return { ok: false, error: 'No files found at that source.' };

  // 只在整棵树都解析后才写入，以防中途下载失败
  // 留下一个 agent 可能加载的半成品技能。
  const written: string[] = [];
  try {
    for (const f of files) {
      const target = resolve(dest, f.path);
      // 解析后的安全边界检查：唯一能抵御伪造路径的检查。
      if (target !== dest && !target.startsWith(dest + sep)) {
        throw new Error(`refusing to write outside the skill folder: ${f.path}`);
      }
      const body = await getText(f.url);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
      written.push(target);
    }
  } catch (e) {
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, path: dest };
}

/**
 * 移除已安装的技能。拒绝任何无法证明是技能根目录下的技能文件夹的内容 ——
 * 出错时的失败模式是删除用户的作品目录。
 */
export function uninstallSkill(
  skillPath: string,
  opts: { cwds: string[] }
): { ok: true } | { ok: false; error: string } {
  if (typeof skillPath !== 'string' || !skillPath.trim()) return { ok: false, error: 'no path given' };
  let target: string;
  try { target = resolve(skillPath); } catch { return { ok: false, error: 'unreadable path' }; }

  const roots = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.codex', 'plugins'),
    ...opts.cwds.filter(Boolean).flatMap((c) => [
      join(c, '.claude', 'skills')
    ])
  ].map((r) => resolve(r));

  const root = roots.find((r) => target.startsWith(r + sep));
  if (!root) return { ok: false, error: 'That folder is not inside a skills directory this app manages.' };
  if (target === root) return { ok: false, error: 'refusing to delete the skills directory itself' };
  if (!existsSync(target)) return { ok: false, error: 'Already gone.' };

  // 目录必须看起来像个技能；插件条目必须是普通文件。
  try {
    const st = statSync(target);
    if (st.isDirectory()) {
      if (!existsSync(join(target, 'SKILL.md'))) {
        return { ok: false, error: 'That folder has no SKILL.md — refusing to delete it.' };
      }
    } else if (!st.isFile()) {
      return { ok: false, error: 'Not a file or folder this app will remove.' };
    }
  } catch { return { ok: false, error: 'could not inspect that path' }; }

  try {
    rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
