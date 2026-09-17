/**
 * MemoryReflector — the missing CONDENSE half of the janitor.
 *
 * The janitor flags an oversized `agents/<id>/memory.md` ("Needs condensing.")
 * but never shrinks it. This service finishes that job: on an in-process timer it
 * finds memory files that crossed a size/section threshold and rewrites them into
 * a bounded 3-region shape — pinned durable facts (never touched), one rolling
 * recursive summary, and the newest K verbatim sections — using a cheap headless
 * `claude -p` (Haiku) summarization of the evicted tail.
 *
 * Why in-process (Electron main), NOT launchd: launchd-spawned shells are blocked
 * by macOS TCC from `~/Documents`; only this process has the folder grant. So the
 * loop lives alongside `memory.start()` — never a cron.
 *
 * Safety is layered so a bad LLM pass can NEVER lose data:
 *   backup-first (lossless cold copy) → verify-don't-trust gate → atomic swap.
 * If any check fails the original file is left byte-for-byte untouched and the
 * only side effect is a `condense-abort` log line. The miner re-indexes the new
 * file automatically on the next tick because its mtime changed (memory.ts).
 *
 * Runs in the Electron main process.
 */
import {
  existsSync, statSync, readdirSync, readFileSync, writeFileSync,
  mkdirSync, copyFileSync, renameSync, openSync, fsyncSync, closeSync
} from 'node:fs';
import { join, dirname } from 'node:path';
import { runHiddenClaude } from './hiddenClaude';

/** Total memory.md budget — mirrors the janitor's CONTEXT_BUDGET_BYTES (128 KB). */
const BUDGET_BYTES = 131_072;
/** Cheap tail-summarizer (DECIDED by god). The verify gate covers quality. */
const CONDENSE_MODEL = 'claude-haiku-4-5';
/** Hard cap so a wedged headless run can't stall the reflect loop. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** The fixed region headings of the bounded memory shape (the stable contract). */
const PINNED_HEADING = '## 📌 Durable facts (pinned — never condensed)';
const CONDENSED_HEADING = '## 🗜 Condensed history';
const RECENT_HEADING = '## Recent';

0/** Line-oriented output protocol. The prompt and parser share these literals so
 *  the contract cannot drift without changing both sides together. */
const CONDENSED_MARKER = '<<<CONDENSED>>>';
const HOIST_MARKER = '<<<HOIST>>>';
const END_MARKER = '<<<END>>>';
const HOIST_BULLET_PREFIX = '- ';
const SUMMARY_MARKERS = [CONDENSED_MARKER, HOIST_MARKER, END_MARKER] as const;

/** Instruction prefix — kept byte-identical across calls (no dates/ids spliced
 *  in) so Claude Code prompt-caches it; the dynamic content goes in the tail. */
const CONDENSE_SYSTEM = [
  "You are compacting one AI agent's long-term memory file. You will receive:",
  '(A) the current CONDENSED summary, (B) older RECENT sections being evicted,',
  '(C) the PINNED durable-facts block (for context only — do not rewrite it).',
  'Output exactly one block in this format:',
  CONDENSED_MARKER,
  '<free-form condensed summary>',
  HOIST_MARKER,
  `${HOIST_BULLET_PREFIX}<new durable fact, one per line>`,
  END_MARKER,
  'RULES:',
  '- The condensed section = a single bounded summary of (A)+(B). Re-summarize (A) together',
  '  with (B) so the result does not grow unbounded. Target <= 1500 words. Preserve',
  '  every decision, root cause, protocol, file path, commit SHA, and numeric result.',
  '  Drop routine standup chatter, resolved blockers, and superseded plans.',
  '- Write the condensed section as literal free-form text; do not JSON-encode or escape it.',
  '- The hoist section = any NEW high-importance durable fact found in (B) that belongs',
  '  in the pinned block and is not already in (C). Prefix every fact with "- ".',
  '- Leave the hoist section empty when there are no new durable facts.',
  `- ${SUMMARY_MARKERS.join(', ')} must each appear exactly once on a line by itself,`,
  '  in that order. Never copy these marker strings into either section.',
  '- Output ONLY the framed block. No surrounding prose or code fence.'
].join('\n');

export interface ReflectSettings {
  enabled: boolean;
  /** How often to scan for oversized memory files. */
  intervalMs: number;
  /** Condense when bytes exceed this percent of BUDGET_BYTES. */
  byteTriggerPct: number;
  /** ...OR when `## ` section count exceeds this (AND bytes > minBytes). */
  sectionTrigger: number;
  /** Newest K verbatim `## ` sections always kept untouched. */
  recentKeep: number;
  /** Never condense a file smaller than this — both a "don't waste an LLM call"
   *  guard and the byte floor for the section-count trigger. */
  minBytes: number;
}

/** A `## ` section: its heading line and the body text beneath it. */
interface Section { heading: string; body: string }

/** A parsed memory.md split into the three regions. `pinned`/`condensed` are null
 *  for legacy (un-structured) files — they're created on first condense. */
interface Parsed {
  header: string;            // the `# Memory …` H1 + any preamble before the first `##`
  pinned: string | null;     // body under the pinned heading (no heading line)
  condensed: string | null;  // body under the condensed heading
  recent: Section[];         // every other `## ` section, in file order (oldest→newest)
}

/** Outcome of one agent's reflect attempt — surfaced to the manual IPC + tests. */
export interface ReflectResult {
  id: string;
  condensed: boolean;        // did we actually rewrite the file?
  reason: string;            // why (skipped/aborted/done), for logging + UI
  oldBytes?: number;
  newBytes?: number;
}

export class MemoryReflector {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  /** True while a reflectNow() pass is in flight — serializes the loop (a slow
   *  LLM pass must not overlap the next interval tick), mirroring MemoryManager. */
  private reflecting = false;

  /**
   * @param getHome      Lazily resolve harnessHome so reflection follows config.
   * @param getCommand   The base `claude` command (only its binary name is used).
   * @param getMemoryEnv Extra env (the shared MemPalace path) merged into the call.
   * @param getSettings  Reflect tunables (interval + thresholds), read each tick.
   * @param appendLog    Sink for `condense`/`condense-abort` events (hive log.jsonl).
   */
  constructor(
    private getHome: () => string | null,
    private getCommand: () => string,
    private getMemoryEnv: () => Record<string, string>,
    private getSettings: () => ReflectSettings,
    private appendLog: (event: Record<string, unknown>) => void
  ) {}

  // — lifecycle (mirrors MemoryManager) —

  start(): void {
    if (this.started) return;
    if (!this.getSettings().enabled) return;
    if (!this.getHome()) return;
    this.started = true;
    // First scan one interval out, not on boot, so launch isn't competing with an
    // LLM call (and a freshly-restored home isn't condensed before it's mined).
    const ms = Math.max(60_000, this.getSettings().intervalMs);
    this.timer = setInterval(() => { void this.reflectNow(); }, ms);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.started = false;
  }

  // — scan —

  /** Reflect every agent whose memory crossed a threshold (or just `onlyId`),
   *  one at a time. Serialized via `reflecting` so a slow pass can't overlap the
   *  next tick. Returns the per-agent outcomes (used by the manual IPC + tests). */
  async reflectNow(onlyId?: string): Promise<ReflectResult[]> {
    const home = this.getHome();
    if (!home) return [];
    if (this.reflecting) return [];
    const agentsDir = join(home, 'hive', 'agents');
    if (!existsSync(agentsDir)) return [];
    const settings = this.getSettings();
    let ids: string[];
    try { ids = readdirSync(agentsDir); } catch { return []; }
    if (onlyId) ids = ids.filter((id) => id === onlyId);

    this.reflecting = true;
    const results: ReflectResult[] = [];
    try {
      for (const id of ids) {
        const mem = join(agentsDir, id, 'memory.md');
        if (!existsSync(mem)) continue;
        let bytes = 0;
        let text = '';
        try {
          bytes = statSync(mem).size;
          // A manual single-agent call condenses on demand (skips the trigger);
          // the autonomous loop honors the threshold.
          if (!onlyId && !this.shouldCondense(bytes, mem, settings)) continue;
          text = readFileSync(mem, 'utf8');
        } catch { continue; }
        results.push(await this.condense(home, id, mem, text, settings));
      }
    } finally {
      this.reflecting = false;
    }
    return results;
  }

  /** The dual trigger (DECIDED): bytes > pct% of budget, OR many-section sprawl
   *  above the byte floor. The floor doubles as the "never burn an LLM call on a
   *  tiny file" guard, so it gates BOTH paths. */
  private shouldCondense(bytes: number, mem: string, s: ReflectSettings): boolean {
    if (bytes < s.minBytes) return false;
    if (bytes > (BUDGET_BYTES * s.byteTriggerPct) / 100) return true;
    let sections = 0;
    try { sections = countSections(readFileSync(mem, 'utf8')); } catch { return false; }
    return sections > s.sectionTrigger;
  }

  // — condense one file —

  private async condense(
    home: string, id: string, mem: string, text: string, s: ReflectSettings
  ): Promise<ReflectResult> {
    const oldBytes = Buffer.byteLength(text, 'utf8');
    const parsed = parseMemory(text);
    // Split recent into KEEP (newest K, verbatim) and EVICT (older — summarized).
    const keepCount = Math.max(1, s.recentKeep);
    const keep = parsed.recent.slice(-keepCount);
    const evict = parsed.recent.slice(0, Math.max(0, parsed.recent.length - keepCount));
    if (evict.length === 0) {
      return { id, condensed: false, reason: 'nothing-to-evict', oldBytes };
    }

    // 1) BACK UP first — a lossless cold copy makes every later step recoverable.
    const stamp = utcStamp();
    const backup = join(home, 'hive', 'backups', stamp, id, 'memory.md');
    try {
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(mem, backup);
    } catch (e) {
      this.logAbort(id, 'backup-failed', String(e));
      return { id, condensed: false, reason: 'backup-failed', oldBytes };
    }

    // 2) SUMMARIZE the (condensed + evicted) tail via headless Haiku.
    let summary: { condensed: string; hoist: string[] };
    try {
      summary = await this.summarize(home, parsed.condensed, evict, parsed.pinned);
    } catch (e) {
      this.logAbort(id, 'summarize-failed', String(e));
      return { id, condensed: false, reason: 'summarize-failed', oldBytes };
    }

    // 3) REBUILD into the 3-region shape.
    const oldPinnedLines = pinnedLines(parsed.pinned);
    const mergedPinned = mergePinned(oldPinnedLines, summary.hoist);
    const rebuilt = rebuild(parsed.header, mergedPinned, summary.condensed, keep);
    const newBytes = Buffer.byteLength(rebuilt, 'utf8');

    // 4) VERIFY-DON'T-TRUST — reject the rewrite unless every check holds.
    const verdict = verify({
      rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned,
      condensed: summary.condensed, keep
    });
    if (!verdict.ok) {
      this.logAbort(id, verdict.reason, undefined, { oldBytes, newBytes });
      return { id, condensed: false, reason: verdict.reason, oldBytes, newBytes };
    }

    // 5) ATOMIC SWAP — write a temp sibling, fsync, rename over the original.
    try {
      atomicWrite(mem, rebuilt);
    } catch (e) {
      this.logAbort(id, 'swap-failed', String(e), { oldBytes, newBytes });
      return { id, condensed: false, reason: 'swap-failed', oldBytes, newBytes };
    }

    try {
      this.appendLog({
        kind: 'condense', agentId: id, oldBytes, newBytes,
        evicted: evict.length, kept: keep.length, hoisted: summary.hoist.length, backup
      });
    } catch { /* logging is best-effort */ }
    // The miner re-indexes within its next cycle — mtime changed, no extra wiring.
    return { id, condensed: true, reason: 'condensed', oldBytes, newBytes };
  }

  private logAbort(id: string, reason: string, detail?: string, extra?: Record<string, unknown>): void {
    try { this.appendLog({ kind: 'condense-abort', agentId: id, reason, ...(detail ? { detail } : {}), ...extra }); }
    catch { /* best-effort */ }
  }

  // — the headless LLM call (the only non-deterministic step) —

  private async summarize(
    home: string, condensed: string | null, evict: Section[], pinned: string | null
  ): Promise<{ condensed: string; hoist: string[] }> {
    const evictText = evict.map((s) => `${s.heading}\n${s.body}`).join('\n\n').trim();
    const prompt = [
      CONDENSE_SYSTEM,
      '',
      '--- INPUT ---',
      '(A) CURRENT CONDENSED SUMMARY:',
      condensed?.trim() || '(none yet)',
      '',
      '(B) OLDER SECTIONS BEING EVICTED:',
      evictText || '(none)',
      '',
      '(C) PINNED DURABLE FACTS (context only — do not rewrite):',
      pinned?.trim() || '(none)'
    ].join('\n');

    const result = await runHiddenClaude(prompt, {
      model: CONDENSE_MODEL,
      cwd: home,
      command: this.getCommand(),
      // Pure text transform — must never touch the repo or shell out.
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
      env: this.getMemoryEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    if (!result.ok || !result.text) {
      throw new Error(result.error ?? 'condense: hidden session returned no text');
    }
    const parsed = parseSummary(result.text);
    if (!parsed) throw new Error('condense: response contained no parseable summary');
    return parsed;
  }
}

// ─── pure helpers (the deterministic, unit-testable half) ────────────────────

/** Count level-2 (`## `) headings — `# ` H1 and `### ` deeper headings excluded. */
export function countSections(text: string): number {
  return (text.match(/^##\s/gm) ?? []).length;
}

/** Split a memory.md into header + the three regions. A legacy flat file (no
 *  pinned/condensed headings) parses with those null and every `## ` section in
 *  `recent`; the structured blocks are created on first condense. */
export function parseMemory(text: string): Parsed {
  const lines = text.split('\n');
  let firstSection = lines.findIndex((l) => /^##\s/.test(l));
  if (firstSection === -1) firstSection = lines.length;
  const header = lines.slice(0, firstSection).join('\n').replace(/\s+$/, '');

  // Carve the remaining lines into `## ` sections (heading + body until next `##`).
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (let i = firstSection; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line, body: '' };
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    }
  }
  if (cur) sections.push(cur);

  let pinned: string | null = null;
  let condensed: string | null = null;
  const recent: Section[] = [];
  for (const s of sections) {
    const h = s.heading.trim();
    if (h.startsWith('## 📌')) pinned = s.body.replace(/\s+$/, '');
    else if (h.startsWith('## 🗜')) condensed = s.body.replace(/\s+$/, '');
    else if (h === RECENT_HEADING) { /* divider — its siblings ARE the recent list */ }
    else recent.push(s);
  }
  return { header, pinned, condensed, recent };
}

/** Non-empty, trimmed lines of the pinned block (the set we must never lose). */
export function pinnedLines(pinned: string | null): string[] {
  if (!pinned) return [];
  return pinned.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Append hoisted durable facts to the pinned set, skipping any already present. */
export function mergePinned(oldLines: string[], hoist: string[]): string[] {
  const have = new Set(oldLines);
  const out = [...oldLines];
  for (const raw of hoist) {
    const line = (raw ?? '').trim();
    if (line && !have.has(line)) { have.add(line); out.push(line); }
  }
  return out;
}

/** Reassemble the canonical 3-region file. */
export function rebuild(header: string, pinned: string[], condensed: string, keep: Section[]): string {
  const parts: string[] = [];
  if (header.trim()) parts.push(header.trim());
  parts.push(PINNED_HEADING);
  parts.push(pinned.length ? pinned.join('\n') : '_(none yet)_');
  parts.push(CONDENSED_HEADING);
  parts.push(condensed.trim());
  parts.push(RECENT_HEADING);
  for (const s of keep) parts.push(`${s.heading}\n${s.body}`.replace(/\s+$/, ''));
  return parts.join('\n\n') + '\n';
}

/** The verify-don't-trust gate. The rewrite is rejected — original kept verbatim
 *  — unless ALL checks pass. The lossless backup makes a rejection a pure no-op. */
export function verify(args: {
  rebuilt: string; newBytes: number; oldBytes: number;
  oldPinnedLines: string[]; mergedPinned: string[];
  condensed: string; keep: Section[];
}): { ok: true } | { ok: false; reason: string } {
  const { rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned, condensed, keep } = args;
  // 6) Valid summary structure already enforced upstream (parseSummary). Here: memory shape.
  // 1) Parses back into the 3-region structure.
  const re = parseMemory(rebuilt);
  if (re.pinned === null || re.condensed === null) return { ok: false, reason: 'structure-missing-region' };
  // 4) Non-empty + sane.
  if (newBytes <= 200) return { ok: false, reason: 'too-small' };
  if (!condensed.trim()) return { ok: false, reason: 'empty-condensed' };
  // 3) Actually smaller (a no-op condense is a failure).
  if (!(newBytes < oldBytes * 0.95)) return { ok: false, reason: 'not-smaller' };
  // 2) Pinned preserved: every old pinned line survives (hoist only adds).
  const newPinned = new Set(pinnedLines(re.pinned));
  for (const line of oldPinnedLines) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-line-dropped' };
  for (const line of mergedPinned) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-merge-mismatch' };
  // 5) Recent integrity: the kept newest sections round-trip byte-for-byte.
  if (re.recent.length !== keep.length) return { ok: false, reason: 'recent-count-mismatch' };
  for (let i = 0; i < keep.length; i++) {
    const a = `${keep[i].heading}\n${keep[i].body}`.replace(/\s+$/, '');
    const b = `${re.recent[i].heading}\n${re.recent[i].body}`.replace(/\s+$/, '');
    if (a !== b) return { ok: false, reason: 'recent-section-altered' };
  }
  return { ok: true };
}

/** Unwrap the JSON envelope emitted by `claude -p --output-format json`. If the
 *  text is not a recognized envelope, preserve it as direct model output. */
function unwrapCliEnvelope(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return raw;
    const env = parsed as { result?: unknown; text?: unknown };
    if (typeof env.result === 'string') return env.result;
    if (typeof env.text === 'string') return env.text;
    return raw;
  } catch {
    return raw;
  }
}

/** Strip a complete outer code fence, but reject an opening fence with no exact
 *  closing line. Looking only at boundary lines preserves fences in the payload. */
function stripOuterCodeFence(text: string): string | null {
  const lines = text.split('\n');
  if (!/^```[A-Za-z0-9_-]*\s*$/.test(lines[0].trim())) return text;
  if (lines.length < 2 || lines[lines.length - 1].trim() !== '```') return null;
  return lines.slice(1, -1).join('\n').trim();
}

function isMarkerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

function hasFramedMarker(text: string): boolean {
  const lines = text.split('\n');
  return SUMMARY_MARKERS.some((marker) => lines.some((line) => isMarkerLine(line, marker)));
}

/** Return the marker's sole line index. Missing and duplicated markers are both
 *  invalid because either makes the frame boundary ambiguous. */
function findUniqueMarkerLine(lines: string[], marker: string): number | null {
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isMarkerLine(lines[i], marker)) continue;
    if (found !== -1) return null;
    found = i;
  }
  return found === -1 ? null : found;
}

function parseFramedSummary(text: string): { condensed: string; hoist: string[] } | null {
  const lines = text.split('\n');
  const condensedAt = findUniqueMarkerLine(lines, CONDENSED_MARKER);
  const hoistAt = findUniqueMarkerLine(lines, HOIST_MARKER);
  const endAt = findUniqueMarkerLine(lines, END_MARKER);

  if (condensedAt === null || hoistAt === null || endAt === null) return null;
  if (condensedAt !== 0 || endAt !== lines.length - 1) return null;
  if (!(condensedAt < hoistAt && hoistAt < endAt)) return null;

  const condensed = lines.slice(condensedAt + 1, hoistAt).join('\n').trim();
  if (!condensed) return null;

  const hoist: string[] = [];
  for (const line of lines.slice(hoistAt + 1, endAt)) {
    const bullet = line.trim();
    if (!bullet) continue;
    if (!bullet.startsWith(HOIST_BULLET_PREFIX)) return null;
    const fact = bullet.slice(HOIST_BULLET_PREFIX.length).trim();
    if (!fact) return null;
    hoist.push(fact);
  }
  return { condensed, hoist };
}

/** Preserve the original strict-JSON response contract as a compatibility path
 *  for in-flight or older model responses that do not contain frame markers. */
function parseLegacyJsonSummary(text: string): { condensed: string; hoist: string[] } | null {
  try {
    const obj = JSON.parse(text) as { condensed?: unknown; hoist?: unknown } | null;
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.condensed !== 'string' || !obj.condensed.trim()) return null;
    const hoist = Array.isArray(obj.hoist) ? obj.hoist.filter((x): x is string => typeof x === 'string') : [];
    return { condensed: obj.condensed, hoist };
  } catch { return null; }
}

/** Pull `{condensed, hoist}` out of CLI output. New responses use a literal-text
 *  frame; valid legacy JSON remains accepted. Any partial frame fails closed and
 *  is never reinterpreted as legacy JSON. */
export function parseSummary(stdout: string): { condensed: string; hoist: string[] } | null {
  if (typeof stdout !== 'string') return null;
  const raw = stdout.trim();
  if (!raw) return null;

  const unwrapped = unwrapCliEnvelope(raw).replace(/\r\n?/g, '\n').trim();
  if (!unwrapped) return null;
  const inner = stripOuterCodeFence(unwrapped);
  if (!inner) return null;

  if (hasFramedMarker(inner)) return parseFramedSummary(inner);
  return parseLegacyJsonSummary(inner);
}

/** `20260606T110912Z` — matches the janitor's backup-dir stamp format. */
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Write `text` to `path` atomically: temp sibling → fsync → rename over target. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* fsync best-effort; rename is the durability guarantee */ }
  renameSync(tmp, path);
}
