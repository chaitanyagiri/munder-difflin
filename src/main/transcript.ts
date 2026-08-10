import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCostUsd, normalizeModel } from './pricing';

/** Claude Code's current project key: the absolute cwd with EVERY separator
 *  dashed, the leading slash included (/Users/me/app → -Users-me-app). On Windows
 *  every non-alphanumeric character is dashed (C:\Users\me\app → C--Users-me-app). */
function projectKey(cwd: string): string {
  return process.platform === 'win32'
    ? cwd.replace(/[^a-zA-Z0-9]/g, '-')
    : cwd.replaceAll('/', '-');
}

/** The pre-2026 key, which dropped the leading slash (/Users/me/app → Users-me-app). */
function legacyProjectKey(cwd: string): string {
  return projectKey(cwd).replace(/^-/, '');
}

/** Resolve the Claude Code transcript directory for a given working directory:
 *  ~/.claude/projects keyed by cwd.
 *
 *  We used to emit the LEGACY key unconditionally, which silently stopped
 *  matching when Claude Code started dashing the leading slash too. Nothing
 *  errored — every caller reads an absent directory as "no transcripts yet" — so
 *  the miss cost two months of dead memory condensation (4039 `condense-abort`s,
 *  zero successes) plus a usage reconciler quietly reading nothing.
 *
 *  Prefer the CURRENT spelling and fall back to the legacy one only when it
 *  exists and the current one does not, so pre-change installs stay readable.
 *  The preference order matters and is not cosmetic: this harness itself created
 *  legacy-named directories by copying transcripts into them, so a fallback-first
 *  resolver would keep reading our own stale copies. An unresolvable cwd yields
 *  the CURRENT spelling — callers that create the directory must create the one
 *  Claude Code will actually read. */
export function projectDir(cwd: string): string {
  const root = path.join(os.homedir(), '.claude/projects');
  const current = path.join(root, projectKey(cwd));
  if (existsSync(current)) return current;
  const legacy = path.join(root, legacyProjectKey(cwd));
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

/** Sum real token usage across Claude Code transcripts for `cwd`, pricing each
 *  assistant record by ITS OWN model (fixes cost bug #1 — no more Sonnet for
 *  everyone) via the fallback price table. Optionally filtered to one session
 *  (fixes bug #2). Resilient by design: any unreadable file or malformed line is
 *  skipped, and any unexpected failure yields a zeroed result rather than
 *  throwing into the IPC handler. This is the OFFLINE reconciler / fallback —
 *  the live source is the OTel collector (`telemetry.ts`). */
export function readAgentUsage(cwd: string, opts: ReadUsageOptions = {}): AgentUsage {
  const usage = zero();
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return usage;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let lastModel: string | undefined;
    for (const file of files) {
      try {
        const text = readFileSync(path.join(dir, file), 'utf8');
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
          if (opts.sessionId && rec.sessionId !== opts.sessionId) continue;
          const u = rec.message?.usage;
          if (!u) continue;
          const model = typeof rec.message?.model === 'string' ? normalizeModel(rec.message.model) : undefined;
          if (model) lastModel = model;
          const rIn = num(u.input_tokens);
          const rOut = num(u.output_tokens);
          const rCacheWrite = num(u.cache_creation_input_tokens);
          const rCacheRead = num(u.cache_read_input_tokens);
          usage.inputTokens += rIn;
          usage.outputTokens += rOut;
          usage.cacheWriteTokens += rCacheWrite;
          usage.cacheReadTokens += rCacheRead;
          // Price THIS record by its own model, then accumulate — so a mixed-model
          // agent (rare) is still costed correctly rather than at one flat rate.
          usage.estimatedCostUsd += estimateCostUsd(model, {
            inputTokens: rIn,
            outputTokens: rOut,
            cacheReadTokens: rCacheRead,
            cacheWriteTokens: rCacheWrite
          });
        }
      } catch {
        // Skip this file; keep accumulating across the rest.
      }
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
