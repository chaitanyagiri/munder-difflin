/**
 * SKILLS — what the coding agents on this machine can actually do, plus a
 * browsable catalog of what they could.
 *
 * Two halves, deliberately separate:
 *
 *  1. LOCAL — skills already installed, discovered by walking the directories
 *     each CLI reads. Claude Code is the well-specified one: a skill is a folder
 *     containing SKILL.md whose YAML frontmatter carries `name` and
 *     `description`. OpenCode and Codex use plugin/config directories instead,
 *     so they are reported as plugins rather than pretending they share a format.
 *
 *  2. CATALOG — abubakarsiddik31/claude-skills-collection: 227 skills in 13
 *     categories, as markdown tables with a GitHub source link per row. It has no
 *     JSON index (checked), so entries are parsed from the raw markdown and
 *     cached on disk. Network failure is never fatal: a stale cache, then an
 *     empty list, then the UI says so.
 *
 * Nothing here installs anything. Discovery and browsing only — installing a
 * third-party skill means running someone else's instructions inside an agent
 * that has the user's tools, and that decision stays with the user.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename, dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { getText } from './fetchText';

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  /** Which CLI reads this directory. */
  provider: 'claude' | 'opencode' | 'codex';
  /** 'user' = global for the whole machine, 'project' = one repo, 'bundled' = ships with the app. */
  scope: 'user' | 'project' | 'bundled';
  path: string;
}

export interface CatalogSkill {
  name: string;
  description: string;
  url: string;
  category: string;
  /** The publisher, taken from the source URL's GitHub owner — anthropics,
   *  stripe, supabase. The names in this list are bare (`docx`, `pdf`), so the
   *  URL is the only place the publisher appears. */
  owner: string;
}

/** Strip a leading YAML frontmatter block and pull the two fields we render.
 *  Deliberately not a YAML parser: `name` and `description` are all the UI shows,
 *  and description is routinely a multi-line `|` block, which a naive
 *  key:value split would truncate at the first line. */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const body = m[1];
  const out: { name?: string; description?: string } = {};
  const nameM = /^name:\s*(.+)$/m.exec(body);
  if (nameM) out.name = nameM[1].trim().replace(/^["']|["']$/g, '');
  // Block scalar (`description: |`) → take the indented lines that follow.
  // Consecutive INDENTED lines after `description: |`. The earlier lookahead
  // form ended at `\r?\n?$`, which under /m matches the end of the FIRST line —
  // so every multi-line description silently arrived truncated to one line.
  const blockM = /^description:\s*[|>]-?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(body);
  if (blockM) {
    out.description = blockM[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ').trim();
  } else {
    const inlineM = /^description:\s*(.+)$/m.exec(body);
    if (inlineM) out.description = inlineM[1].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Every folder under `dir` holding a SKILL.md, read into a LocalSkill. */
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

/** Plugin directories for the CLIs that do not use Claude's SKILL.md format.
 *  Reported as entries so the tab tells the truth about what a provider has,
 *  instead of implying only Claude Code is extensible. */
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

/**
 * Everything installed, deduped by (provider, name) with the most specific scope
 * winning — a project skill shadows the user's, which shadows the bundled copy,
 * which is the same precedence the CLIs themselves apply.
 */
export function listLocalSkills(opts: { cwds: string[]; bundledDir: string | null }): LocalSkill[] {
  const home = homedir();
  const found: LocalSkill[] = [
    ...(opts.bundledDir ? scanSkillDir(opts.bundledDir, 'claude', 'bundled') : []),
    ...scanSkillDir(join(home, '.claude', 'skills'), 'claude', 'user'),
    ...scanPluginDir(join(home, '.config', 'opencode', 'plugin'), 'opencode', 'user'),
    ...scanPluginDir(join(home, '.codex', 'plugins'), 'codex', 'user')
  ];
  for (const cwd of opts.cwds) {
    if (!cwd) continue;
    found.push(...scanSkillDir(join(cwd, '.claude', 'skills'), 'claude', 'project'));
    found.push(...scanPluginDir(join(cwd, '.opencode', 'plugin'), 'opencode', 'project'));
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
/** A curated list changes on a human timescale; a day-old copy is fine and keeps
 *  the tab instant on every open after the first. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the catalog README into entries.
 *
 * The list is markdown TABLES under `## <emoji> Category` headings:
 *
 *   | Name | Description | Link |
 *   |------|-------------|------|
 *   | **docx** | Create and edit Word documents | [Source](https://github.com/…/tree/main/skills/docx) |
 *
 * Rows that are not skill rows — the header row, the `|---|` rule, the overview
 * table that counts skills per category — are skipped by requiring three cells
 * AND a resolvable https link. Anything else is dropped rather than guessed at:
 * a catalog missing a row is honest, one full of parsed headers is not.
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
        // Leading pictographs only — a blanket non-alphanumeric strip would eat
        // the dot off a name like ".NET".
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
 * The catalog, from cache when fresh and from the network otherwise. A failed
 * refresh falls back to whatever is cached — an offline user still gets to
 * browse, flagged as stale, instead of an empty tab and no explanation.
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
    // An empty parse means the README's shape changed under us. Keep the cache.
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
 * A skill is INSTRUCTIONS THAT RUN INSIDE AN AGENT holding the user's tools and
 * keys, so this half of the file is written as if the source is hostile, because
 * from the app's point of view it is: it is arbitrary content from a public list
 * that anyone can PR into.
 *
 * Every limit below exists to bound a specific abuse:
 *   - the destination name is sanitised, so `../../.claude/settings.json` cannot
 *     be a "skill name";
 *   - each downloaded path is re-checked to be inside the destination AFTER
 *     resolution, so a crafted API response cannot escape it;
 *   - file count, total bytes and depth are capped, so a repo cannot fill a disk;
 *   - only regular files are written — a `symlink` or `submodule` entry from the
 *     contents API is skipped, never followed.
 *
 * Uninstall is the more dangerous verb and is treated as such: it deletes a
 * directory, so it refuses anything that is not INSIDE a known skills root and
 * does not itself contain a SKILL.md. A bundled skill can never be removed — it
 * ships inside the app and would reappear on the next spawn anyway.
 */

/** GitHub's per-directory listing. Only the fields we actually consume. */
interface GhEntry { name: string; path: string; type: string; size?: number; download_url?: string | null }

const MAX_FILES = 60;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 5;

/**
 * A GitHub source URL → the pieces the contents API needs.
 *
 * Two shapes, because the catalog uses both: a folder inside a repo
 * (`owner/repo/tree/<ref>/<path>`, 145 entries) and a whole repo whose root IS
 * the skill (`owner/repo`, 81 entries). For the latter `ref` is empty and the
 * caller omits it, which makes the API use the repo's default branch — there is
 * no reliable way to guess between `main` and `master` and no need to.
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
    // Reserved paths that are not repositories.
    if (['orgs', 'topics', 'collections', 'sponsors', 'features'].includes(owner.toLowerCase())) return null;
    return { owner, repo: repo.replace(/\.git$/i, ''), ref: '', path: '' };
  }
  return null;
}

/** A folder name we are willing to create. Anything with a separator, a dot-dot,
 *  or a leading dot is rejected outright rather than massaged into safety. */
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

/**
 * For a repo-ROOT source, find the directory that actually holds the skill
 * BEFORE anything is walked or downloaded (issue #385).
 *
 * A root URL used to mean "the repo root IS the skill" unconditionally, so the
 * installer walked the entire repository — and MAX_FILES / MAX_TOTAL_BYTES,
 * meant to bound one skill folder, were applied to the whole repo. Any normal
 * repo that keeps its skill under `skills/<name>` failed with "larger than this
 * installer will fetch" even when the skill itself was a few KB.
 *
 * Resolution order, each step one directory listing:
 *   1. Root contains SKILL.md → the root is the skill (the well-formed entries).
 *   2. `skills/<name>`, `.claude/skills/<name>`, `<name>` — probed only when
 *      their first segment exists as a directory in the root listing, so the
 *      outcome is fully determined by listings and no blind 404s are issued.
 *   3. Nothing holds a SKILL.md → a structured refusal, before any download.
 *
 * `listDir` is injected (the contents-API fetch in production) so this policy
 * is testable without the network.
 */
export async function resolveRepoRootSkillDir(
  listDir: (path: string) => Promise<GhEntry[]>,
  entryName: string
): Promise<{ path: string } | { error: string; unsupported?: boolean }> {
  let root: GhEntry[];
  try {
    root = await listDir('');
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const hasSkillMd = (listing: GhEntry[]) =>
    listing.some((it) => it.type === 'file' && it.name === 'SKILL.md');
  if (hasSkillMd(root)) return { path: '' };

  const hasDir = (name: string) => root.some((it) => it.type === 'dir' && it.name === name);
  const name = safeSkillDirName(entryName);
  const candidates = name
    ? [
        ...(hasDir('skills') ? [`skills/${name}`] : []),
        ...(hasDir('.claude') ? [`.claude/skills/${name}`] : []),
        ...(hasDir(name) ? [name] : [])
      ]
    : [];
  for (const candidate of candidates) {
    try {
      if (hasSkillMd(await listDir(candidate))) return { path: candidate };
    } catch {
      // 404 or transient failure on a guess — try the next location.
    }
  }
  return {
    unsupported: true,
    error: "couldn't find the skill's SKILL.md in that repository — open Learn more to install it by hand"
  };
}

/** officialskills.sh pages are a rendering of a GitHub folder and link back to
 *  it. Resolving that link is one request and turns 578 otherwise un-installable
 *  catalog rows into installable ones. */
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
 * Download one skill folder into the user's Claude skills directory.
 *
 * Returns a structured refusal rather than throwing, so the UI can say WHY —
 * "not installable" and "install failed" are different answers for the user.
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

  // An empty ref means "the repo's default branch" — omit the parameter entirely
  // rather than guessing main vs master.
  const api = (p: string) =>
    `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${p ? encodeURI(p) : ''}`
    + (gh.ref ? `?ref=${encodeURIComponent(gh.ref)}` : '');
  const listDir = async (p: string): Promise<GhEntry[]> => {
    const res = await getJson<GhEntry[] | GhEntry>(api(p));
    return Array.isArray(res) ? res : [res];
  };

  // A repo-root source names a repository, not necessarily a skill folder —
  // locate the SKILL.md directory first so the size/file caps bound the skill,
  // not the whole repo (issue #385). Tree URLs keep their explicit path.
  let skillPath = gh.path;
  if (!skillPath) {
    const resolved = await resolveRepoRootSkillDir(listDir, entryName);
    if ('error' in resolved) return { ok: false, error: resolved.error, unsupported: resolved.unsupported };
    skillPath = resolved.path;
  }

  const dirName = safeSkillDirName(skillPath || entryName);
  if (!dirName) return { ok: false, error: 'That skill has a name this app will not create a folder for.' };

  const root = join(homedir(), '.claude', 'skills');
  const dest = join(root, dirName);
  if (existsSync(dest)) return { ok: false, error: `Already installed at ${dest}` };

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
      // Only regular files. A symlink/submodule entry is skipped, never followed.
      if (it.type !== 'file' || !it.download_url) continue;
      const size = it.size ?? 0;
      total += size;
      if (total > MAX_TOTAL_BYTES) return 'that skill is larger than this installer will fetch';
      const rel = skillPath ? it.path.slice(skillPath.length).replace(/^\/+/, '') : it.path;
      files.push({ path: rel, url: it.download_url, size });
    }
    return null;
  };

  const walkErr = await walk(skillPath, 0);
  if (walkErr) return { ok: false, error: walkErr };
  if (files.length === 0) return { ok: false, error: 'No files found at that source.' };

  // Write only after the whole tree resolved, so a mid-download failure cannot
  // leave a half-installed skill that an agent would then load.
  const written: string[] = [];
  try {
    for (const f of files) {
      const target = resolve(dest, f.path);
      // Post-resolution containment: the only check that survives a crafted path.
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
 * Remove an installed skill. Refuses anything it cannot prove is a skill folder
 * inside a skills root — the failure mode of getting this wrong is deleting a
 * directory of the user's work.
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
    join(homedir(), '.config', 'opencode', 'plugin'),
    join(homedir(), '.codex', 'plugins'),
    ...opts.cwds.filter(Boolean).flatMap((c) => [
      join(c, '.claude', 'skills'),
      join(c, '.opencode', 'plugin')
    ])
  ].map((r) => resolve(r));

  const root = roots.find((r) => target.startsWith(r + sep));
  if (!root) return { ok: false, error: 'That folder is not inside a skills directory this app manages.' };
  if (target === root) return { ok: false, error: 'refusing to delete the skills directory itself' };
  if (!existsSync(target)) return { ok: false, error: 'Already gone.' };

  // A directory must look like a skill; a plugin entry must be a plain file.
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
