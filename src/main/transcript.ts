import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCostUsd, normalizeModel } from './pricing';

/** Extra Claude config dirs (from per-agent / default CLAUDE_CONFIG_DIR env,
 *  #105) beyond the default ~/.claude. Registered lazily by index.ts so this
 *  module stays free of config/hive imports. */
let extraConfigDirs: () => string[] = () => [];
export function setExtraClaudeConfigDirs(provider: () => string[]): void {
  extraConfigDirs = provider;
}

function defaultConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** Every `projects/` root transcripts may live under: the default ~/.claude
 *  plus any CLAUDE_CONFIG_DIR overrides. Deduped; order = default first. */
function projectsRoots(): string[] {
  const dirs = [defaultConfigDir()];
  try { dirs.push(...extraConfigDirs()); } catch { /* provider never blocks a read */ }
  return [...new Set(dirs)].map((d) => path.join(d, 'projects'));
}

/** The project-dir KEY Claude Code derives from a cwd (absolute path with the
 *  leading slash dropped and every remaining slash dashed; on Windows every
 *  non-alphanumeric char is dashed — drive colon and backslashes included). */
function projectKey(cwd: string): string {
  return process.platform === 'win32'
    ? cwd.replace(/[^a-zA-Z0-9]/g, '-')
    : cwd.replace(/^\//, '').replaceAll('/', '-');
}

/** Resolve the Claude Code transcript directory for a working directory, under
 *  the given config dir (an agent's CLAUDE_CONFIG_DIR override) or ~/.claude. */
export function projectDir(cwd: string, configDir?: string): string {
  return path.join(configDir ?? defaultConfigDir(), 'projects', projectKey(cwd));
}

/** Ensure session `<sessionId>.jsonl` exists in `cwd`'s Claude project dir so a
 *  `claude --resume <sessionId>` spawn in that cwd can find it. Claude keys
 *  transcripts by cwd, so a session started elsewhere is invisible until its
 *  `.jsonl` is seeded across.
 *
 *  - Already present in the target project dir → no-op, returns true.
 *  - Found under a DIFFERENT project dir (resumed from another cwd — the Add
 *    Agent "resume session" flow, #2) → copied across, returns true.
 *  - Not found anywhere → returns false, so the caller can fall back to a fresh
 *    session instead of launching a broken `--resume`.
 *
 *  Best-effort: any fs error yields false rather than throwing into the spawn. */
/** A Claude session id is a UUID. Renderer-supplied ids flow into `path.join`, so
 *  reject anything outside this charset before using one as a path component (a
 *  crafted id like `../../x` would otherwise traverse out of the project dirs). */
const VALID_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function seedSessionTranscript(cwd: string, sessionId: string, configDir?: string): boolean {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return false;
    const target = path.join(projectDir(cwd, configDir), `${sessionId}.jsonl`);
    if (existsSync(target)) return true;
    // Search EVERY known projects root (default + CLAUDE_CONFIG_DIR overrides,
    // #105) — the session may have run under a different profile than the one
    // this spawn uses.
    const roots = projectsRoots();
    const targetRoot = path.dirname(path.dirname(target));
    if (!roots.includes(targetRoot)) roots.push(targetRoot);
    for (const projectsRoot of roots) {
      if (!existsSync(projectsRoot)) continue;
      for (const dir of readdirSync(projectsRoot)) {
        const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate)) {
          mkdirSync(path.dirname(target), { recursive: true });
          cpSync(candidate, target);
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolve a session id to the ORIGINAL working directory it ran in, for the Add
 *  Agent "resume session" auto-fill. The cwd is read from a transcript RECORD
 *  (every line carries a `cwd` field) — deliberately NOT by un-dashing the
 *  project-dir name, which is lossy when the path itself contains dashes. Searches
 *  every `~/.claude/projects/<dir>/<sessionId>.jsonl`; if more than one matches
 *  (shouldn't — session ids are unique UUIDs) the most-recently-modified wins.
 *  Returns the cwd string, or null if not found / unreadable / no cwd record. */
export function resolveSessionCwd(sessionId: string): string | null {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return null;
    let best: { file: string; mtime: number } | null = null;
    for (const projectsRoot of projectsRoots()) {
      if (!existsSync(projectsRoot)) continue;
      for (const dir of readdirSync(projectsRoot)) {
        const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
        try {
          const st = statSync(candidate);
          if (!best || st.mtimeMs > best.mtime) best = { file: candidate, mtime: st.mtimeMs };
        } catch { /* not present in this project dir */ }
      }
    }
    if (!best) return null;
    const text = readFileSync(best.file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
      } catch { /* skip a malformed line */ }
    }
    return null;
  } catch {
    return null;
  }
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  /** The most-recently-seen model id (normalized, e.g. `claude-opus-4-8`), or
   *  undefined if no priced record was found. Lets the UI label the row. */
  model?: string;
}

function zero(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
}

export interface ReadUsageOptions {
  /** When set, only transcripts whose records carry this `sessionId` are summed.
   *  This is how the co-located-agents double-count (bug #2) is avoided: two
   *  agents sharing a cwd each filter to their own session instead of summing
   *  every `.jsonl` under the shared project dir. When unset, all are summed
   *  (the legacy behavior, used when the agent's session id isn't yet known). */
  sessionId?: string;
}

/** Per-file incremental parse state for the usage cache. Transcripts are
 *  append-only JSONL, so a parsed byte range's totals never change — repeat
 *  reads only stat the file and parse the appended tail. Keyed by
 *  dir|file|sessionFilter since the filter changes what a range sums to. */
interface FileUsageEntry {
  size: number;
  mtimeMs: number;
  /** Bytes parsed so far — always ends on a newline boundary, so a torn
   *  trailing line is simply re-read once the writer completes it. */
  offset: number;
  totals: AgentUsage;
}

const usageCache = new Map<string, FileUsageEntry>();
/** Soft bound; when crossed, the oldest-inserted half is dropped (entries
 *  rebuild on demand). Real fleets have tens of transcripts, not thousands. */
const USAGE_CACHE_MAX = 2048;

/** Parse complete JSONL lines into `acc` (the shared per-record logic). */
function parseUsageLines(text: string, sessionId: string | undefined, acc: AgentUsage): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: {
      type?: unknown;
      sessionId?: unknown;
      message?: { model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type !== 'assistant') continue;
    // Session filter: skip records that aren't this agent's session.
    if (sessionId && rec.sessionId !== sessionId) continue;
    const u = rec.message?.usage;
    if (!u) continue;
    const model = typeof rec.message?.model === 'string' ? normalizeModel(rec.message.model) : undefined;
    if (model) acc.model = model;
    const rIn = num(u.input_tokens);
    const rOut = num(u.output_tokens);
    const rCacheWrite = num(u.cache_creation_input_tokens);
    const rCacheRead = num(u.cache_read_input_tokens);
    acc.inputTokens += rIn;
    acc.outputTokens += rOut;
    acc.cacheWriteTokens += rCacheWrite;
    acc.cacheReadTokens += rCacheRead;
    // Price THIS record by its own model, then accumulate — so a mixed-model
    // agent (rare) is still costed correctly rather than at one flat rate.
    acc.estimatedCostUsd += estimateCostUsd(model, {
      inputTokens: rIn,
      outputTokens: rOut,
      cacheReadTokens: rCacheRead,
      cacheWriteTokens: rCacheWrite
    });
  }
}

/** Cached totals for one transcript file, refreshed incrementally: unchanged
 *  size+mtime → cache hit (no read at all); grown → parse only the appended
 *  tail; shrunk (rewritten) → full re-parse. Null when the file vanished. */
function readFileUsage(dir: string, file: string, sessionId: string | undefined): FileUsageEntry | null {
  const key = `${dir}|${file}|${sessionId ?? '*'}`;
  const full = path.join(dir, file);
  let st: { size: number; mtimeMs: number };
  try { st = statSync(full); } catch { usageCache.delete(key); return null; }
  const cached = usageCache.get(key);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
  const fromScratch = !cached || st.size < cached.offset;
  const entry: FileUsageEntry = fromScratch
    ? { size: st.size, mtimeMs: st.mtimeMs, offset: 0, totals: zero() }
    : { size: st.size, mtimeMs: st.mtimeMs, offset: cached!.offset, totals: { ...cached!.totals } };
  try {
    const fd = openSync(full, 'r');
    try {
      const len = st.size - entry.offset;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, entry.offset);
        const text = buf.subarray(0, read).toString('utf8');
        // Consume only up to the last complete line; a torn trailing line
        // stays unparsed (offset holds at the newline) until the writer
        // finishes it — it is then counted exactly once.
        const lastNl = text.lastIndexOf('\n');
        if (lastNl !== -1) {
          const complete = text.slice(0, lastNl + 1);
          parseUsageLines(complete, sessionId, entry.totals);
          entry.offset += Buffer.byteLength(complete, 'utf8');
        }
      }
    } finally { closeSync(fd); }
  } catch {
    // Unreadable right now — keep what we have; totals refresh on the next call.
  }
  usageCache.set(key, entry);
  if (usageCache.size > USAGE_CACHE_MAX) {
    let drop = usageCache.size - USAGE_CACHE_MAX / 2;
    for (const k of usageCache.keys()) { if (drop-- <= 0) break; usageCache.delete(k); }
  }
  return entry;
}

/** Sum real token usage across Claude Code transcripts for `cwd`, pricing each
 *  assistant record by ITS OWN model (fixes cost bug #1 — no more Sonnet for
 *  everyone) via the fallback price table. Optionally filtered to one session
 *  (fixes bug #2). Resilient by design: any unreadable file or malformed line is
 *  skipped, and any unexpected failure yields a zeroed result rather than
 *  throwing into the IPC handler. This is the OFFLINE reconciler / fallback —
 *  the live source is the OTel collector (`telemetry.ts`).
 *
 *  Called from the ~30s breaker/cost beat for every agent without live OTel, so
 *  it must stay cheap on multi-MB transcript dirs: per-file incremental caching
 *  above means a steady-state call is a readdir + one stat per file. */
export function readAgentUsage(cwd: string, opts: ReadUsageOptions = {}): AgentUsage {
  const usage = zero();
  try {
    const key = projectKey(cwd);
    let lastModel: string | undefined;
    // Multi-root (#105): a CLAUDE_CONFIG_DIR-profiled agent writes its
    // transcripts under that profile's projects/ root, not ~/.claude. Collect
    // candidates across EVERY root first, then dedupe by basename — after a
    // profile switch, seedSessionTranscript (#105) copies the same
    // <sessionId>.jsonl into a second root for this cwd key, and summing both
    // would double-count that session's usage. Keep the newest-mtime copy per
    // basename; a stat failure is best-effort (include the file rather than
    // drop it — never throw out of a usage read).
    const candidates = new Map<string, { dir: string; file: string; mtimeMs: number }>();
    for (const root of projectsRoots()) {
      const dir = path.join(root, key);
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        let mtimeMs = 0;
        try { mtimeMs = statSync(path.join(dir, file)).mtimeMs; } catch { mtimeMs = Infinity; }
        const existing = candidates.get(file);
        if (!existing || mtimeMs >= existing.mtimeMs) candidates.set(file, { dir, file, mtimeMs });
      }
    }
    // Each surviving (dir, file) feeds the incremental per-file cache — its key
    // includes the dir, so profiles never collide and a steady-state call stays
    // readdir + stat per file (no re-parse).
    for (const { dir, file } of candidates.values()) {
      const entry = readFileUsage(dir, file, opts.sessionId);
      if (!entry) continue;
      usage.inputTokens += entry.totals.inputTokens;
      usage.outputTokens += entry.totals.outputTokens;
      usage.cacheWriteTokens += entry.totals.cacheWriteTokens;
      usage.cacheReadTokens += entry.totals.cacheReadTokens;
      usage.estimatedCostUsd += entry.totals.estimatedCostUsd;
      if (entry.totals.model) lastModel = entry.totals.model;
    }
    if (lastModel) usage.model = lastModel;
    return usage;
  } catch {
    return zero();
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Current context size (tokens) of a live session: the token accounting of the
 *  LAST assistant message in its transcript — input + cache read/write is what
 *  the model just consumed as context, plus its output which joins the context
 *  for the next turn. Tail-reads the file (transcripts grow to many MB), so a
 *  poll stays cheap. Returns null when the transcript is missing/unreadable or
 *  holds no assistant message yet. */
const CONTEXT_TAIL_BYTES = 256 * 1024;

export function readContextTokens(transcriptPath: string): number | null {
  try {
    if (!existsSync(transcriptPath)) return null;
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, CONTEXT_TAIL_BYTES);
      if (len === 0) return null;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      // Scan from the end; the very first chunk line may be cut mid-record and
      // simply fails to parse, which is fine.
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        let rec: { type?: unknown; message?: { usage?: Record<string, unknown> } };
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (rec.type !== 'assistant') continue;
        const u = rec.message?.usage;
        if (!u) continue;
        return num(u.input_tokens) + num(u.output_tokens)
          + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
