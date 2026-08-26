import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCostUsd, normalizeModel } from './pricing';

/** Claude Code's project key: the absolute cwd with EVERY non-alphanumeric
 *  character turned into a dash — the leading slash and any dots included.
 *  /Users/me/app → -Users-me-app, /Users/me/MDv0.3.0 → -Users-me-MDv0-3-0,
 *  C:\Users\me\app → C--Users-me-app.
 *
 *  One rule for every platform. The Windows branch always used it; POSIX had its
 *  own narrower spelling, and that divergence is what broke — see projectDir. */
function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The pre-2026 POSIX key: leading slash DROPPED, only slashes dashed, so dots
 *  survived (/Users/me/MDv0.3.0 → Users-me-MDv0.3.0). Kept solely so transcripts
 *  written before the change stay readable. */
function legacyProjectKey(cwd: string): string {
  return process.platform === 'win32'
    ? projectKey(cwd)
    : cwd.replace(/^\//, '').replaceAll('/', '-');
}

/** Resolve the Claude Code transcript directory for a given working directory:
 *  ~/.claude/projects keyed by cwd.
 *
 *  We used to emit the legacy key unconditionally on POSIX, which silently
 *  stopped matching once Claude Code moved to dashing every non-alphanumeric.
 *  Nothing errored — every caller reads an absent directory as "no transcripts
 *  yet" — so the miss cost months of dead memory condensation (a long run of
 *  `condense-abort`s with zero successes) and a usage reconciler quietly reading
 *  nothing at all.
 *
 *  Prefer the CURRENT spelling; fall back to the legacy one only when it exists
 *  and the current one does not, so pre-change installs stay readable. That order
 *  is not cosmetic: this harness itself created legacy-named directories by
 *  copying transcripts into them, so a fallback-first resolver would keep reading
 *  our own stale copies forever. When neither exists we return the CURRENT
 *  spelling, because callers that go on to create the directory must create the
 *  one Claude Code will actually read. */
export function projectDir(cwd: string): string {
  const root = path.join(os.homedir(), '.claude/projects');
  const current = path.join(root, projectKey(cwd));
  if (existsSync(current)) return current;
  // For cwd '/' the legacy key is the empty string, and path.join(root, '')
  // collapses to the projects ROOT — which always exists, so the fallback would
  // hand back a directory holding every project rather than one, and callers
  // would read/seed `~/.claude/projects/<session>.jsonl`. An empty key is not a
  // project name; treat it as no legacy candidate at all.
  const legacyKey = legacyProjectKey(cwd);
  if (!legacyKey) return current;
  const legacy = path.join(root, legacyKey);
  return existsSync(legacy) ? legacy : current;
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

export function seedSessionTranscript(cwd: string, sessionId: string): boolean {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return false;
    const target = path.join(projectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(target)) return true;
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!existsSync(projectsRoot)) return false;
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(candidate, target);
        return true;
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
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!existsSync(projectsRoot)) return null;
    let best: { file: string; mtime: number } | null = null;
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      try {
        const st = statSync(candidate);
        if (!best || st.mtimeMs > best.mtime) best = { file: candidate, mtime: st.mtimeMs };
      } catch { /* not present in this project dir */ }
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
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return usage;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let lastModel: string | undefined;
    for (const file of files) {
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

/** The latest thing an agent's live session actually SAID, plus when it said it.
 *  `ts` is epoch ms (the record's own `timestamp`, or the transcript's mtime when
 *  a record carries none) — the renderer stores it as `recentTextTs`, which is
 *  what the per-agent Talk relay watches to know the session has answered. */
export interface LatestAssistantText {
  text: string;
  ts: number;
}

/** Tail window for the text scan. Same reasoning as CONTEXT_TAIL_BYTES: the
 *  record we want is always at the END of an append-only transcript, and these
 *  files grow to many MB. 256 KB comfortably spans the last few turns. */
const TEXT_TAIL_BYTES = 256 * 1024;

/** size+mtime memo, so the 3s per-agent poll is a stat in the steady state
 *  rather than a 256 KB read + JSON.parse per agent per tick. */
const latestTextCache = new Map<string, { size: number; mtimeMs: number; value: LatestAssistantText | null }>();
const LATEST_TEXT_CACHE_MAX = 512;

/** Concatenate the `text` blocks of one assistant record. Thinking blocks and
 *  tool_use blocks are deliberately dropped — the relay speaks this aloud, and
 *  neither is something the agent "said". */
function assistantText(rec: { message?: { content?: unknown } }): string {
  const content = rec.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
  }
  return parts.join('\n\n').trim();
}

/**
 * The most recent assistant TEXT in a live session's transcript — the PRODUCER
 * half of per-agent Talk's relay.
 *
 * The relay (renderer/realtime/agentVoice.ts) waits on the store fields
 * `recentAssistantText` + `recentTextTs`; before this function existed nothing in
 * the live pipeline ever wrote them (only the mock event generator did), so every
 * relay timed out and the voice never spoke the session's reply. The live
 * `hive:activity` stream carries metadata only, so the transcript — already read
 * here for usage and context — is the one place the actual words exist.
 *
 * Scans BACKWARDS from the tail for the newest `assistant` record that carries
 * real text. Sidechain records (`isSidechain: true`) are subagent chatter, not the
 * session speaking, and are skipped. Returns null when the transcript is
 * missing/unreadable or has not spoken yet.
 */
export function readLatestAssistantText(transcriptPath: string): LatestAssistantText | null {
  try {
    if (!existsSync(transcriptPath)) return null;
    let st: { size: number; mtimeMs: number };
    try { st = statSync(transcriptPath); } catch { latestTextCache.delete(transcriptPath); return null; }
    const cached = latestTextCache.get(transcriptPath);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.value;

    let value: LatestAssistantText | null = null;
    const fd = openSync(transcriptPath, 'r');
    try {
      const len = Math.min(st.size, TEXT_TAIL_BYTES);
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, st.size - len);
        const lines = buf.subarray(0, read).toString('utf8').split('\n');
        // The first line of the window may be cut mid-record; it simply fails to
        // parse, which is why the scan is tolerant rather than strict.
        for (let i = lines.length - 1; i >= 0; i--) {
          const trimmed = lines[i].trim();
          if (!trimmed) continue;
          let rec: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { content?: unknown } };
          try { rec = JSON.parse(trimmed); } catch { continue; }
          if (rec.type !== 'assistant' || rec.isSidechain === true) continue;
          const text = assistantText(rec);
          if (!text) continue;
          const parsed = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
          value = { text, ts: Number.isFinite(parsed) ? parsed : st.mtimeMs };
          break;
        }
      }
    } finally { closeSync(fd); }

    latestTextCache.set(transcriptPath, { size: st.size, mtimeMs: st.mtimeMs, value });
    if (latestTextCache.size > LATEST_TEXT_CACHE_MAX) {
      let drop = latestTextCache.size - LATEST_TEXT_CACHE_MAX / 2;
      for (const k of latestTextCache.keys()) { if (drop-- <= 0) break; latestTextCache.delete(k); }
    }
    return value;
  } catch {
    return null;
  }
}
