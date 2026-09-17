/**
 * Reap agent processes a PREVIOUS run left behind.
 *
 * Every agent PTY is a child of the browser process, and the normal quit path
 * tears them down: killAll() kills each one, and on POSIX closing the pty HUPs
 * the foreground group. Neither runs if the app never gets to quit — a main
 * process that is SIGKILLed, OOM-killed, or lost to a power cut leaves its
 * agents running, reparented to init, with no window and nobody to stop them.
 *
 * They are not merely idle. Observed live on 2026-09-07: an orphaned `codex`
 * from a killed run still held its session rollout open, so the NEXT launch
 * could not resume that agent at all —
 *
 *   Error: Failed to resume session from .../rollout-...jsonl:
 *     thread ... already has an active writer (code -32600)
 *
 * — and the agent was dead on arrival every time until the orphan was killed by
 * hand. A survivor also keeps burning tokens and CPU against an account nobody
 * is watching.
 *
 * So the app records the PTYs it starts, and sweeps the survivors at startup.
 *
 * The whole risk here is PID reuse: a recorded pid may belong to something else
 * entirely by the next launch, and killing a stranger's process tree is far
 * worse than leaving an orphan. Every kill is therefore gated on IDENTITY, not
 * just liveness — the process must still have the start time AND the command we
 * recorded. When identity cannot be established, for any reason, nothing is
 * killed. A missed orphan is a nuisance; a wrong kill is not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { hardKillTree, isAlive } from './procKill';

/** One PTY we started, in enough detail to recognise it again after a restart. */
export interface LedgerEntry {
  /** The hive agent id, for the log line — never used to match. */
  id: string;
  pid: number;
  /** `ps -o lstart=` — a full-precision start timestamp. The pid alone is not
   *  an identity; the pid plus its start time effectively is. */
  startedAt: string;
  /** First token of the command, e.g. `codex`. A second, cheap check: a reused
   *  pid that somehow shares a start time is still very unlikely to also be
   *  running the same binary. */
  command: string;
}

/** Identity of one live process, or null when it cannot be established —
 *  the process is gone, or `ps` itself did not answer. POSIX only; see
 *  sweepStaleAgents for why Windows takes a different route. */
export function processIdentity(pid: number): { startedAt: string; command: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], { timeout: 2_000 });
    if (r.error || r.status !== 0) return null;
    const line = String(r.stdout ?? '').trim();
    if (!line) return null;
    // Parsed from the END, not by column width: `lstart` is rendered in the
    // machine's LOCALE, so it is neither a fixed width nor a known format
    // ("Mon Sep  7 09:46:24 2026" in C, "lun. sept.  7 09:46:24 2026" in fr_FR).
    // `comm` is a single token with no spaces, so the last field is the command
    // and everything before it is the timestamp, whatever the locale renders.
    //
    // That the string is locale-dependent is fine and deliberate: it is only
    // ever compared against a value THIS machine recorded earlier. If the locale
    // changes between runs the comparison fails, and a failed comparison spares
    // the process — the safe direction.
    const m = line.match(/^(.*\S)\s+(\S+)$/);
    if (!m) return null;
    return { startedAt: m[1].trim(), command: m[2] };
  } catch { return null; }
}

/** Whether this recorded entry still names the SAME process we started.
 *
 *  Exported because it is the entire safety argument for the sweep, and it is
 *  worth being able to test on its own. */
export function isSameProcess(entry: LedgerEntry, live: { startedAt: string; command: string } | null): boolean {
  if (!live) return false;                                  // gone, or unverifiable
  if (!entry.startedAt || !entry.command) return false;     // ledger from an older build
  return live.startedAt === entry.startedAt && live.command === entry.command;
}

function readLedger(path: string): LedgerEntry[] {
  try {
    if (!existsSync(path)) return [];
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is LedgerEntry =>
      !!e && typeof (e as LedgerEntry).pid === 'number' &&
      typeof (e as LedgerEntry).startedAt === 'string' &&
      typeof (e as LedgerEntry).command === 'string');
  } catch { return []; }
}

function writeLedger(path: string, rows: LedgerEntry[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(rows));
  } catch { /* the ledger is a best-effort record, never a blocker */ }
}

/**
 * Track the PTYs of the CURRENT run.
 *
 * Deliberately a plain file rewritten on each change rather than an append log:
 * the set is small (one row per running agent), and a file that is always the
 * complete truth cannot be left half-replayed by a crash mid-write.
 */
export class AgentLedger {
  private rows: LedgerEntry[] = [];

  constructor(private readonly path: string) {}

  /** Record a PTY we just started. The identity lookup is done HERE, while the
   *  process is definitely ours — reading it at sweep time would be reading the
   *  identity of whatever holds that pid then, which proves nothing. */
  add(id: string, pid: number): void {
    const live = processIdentity(pid);
    if (!live) return;                     // unverifiable now = never sweepable later
    this.rows = this.rows.filter((r) => r.pid !== pid);
    this.rows.push({ id, pid, ...live });
    writeLedger(this.path, this.rows);
  }

  /** Forget a PTY that exited or was killed. */
  remove(pid: number): void {
    const next = this.rows.filter((r) => r.pid !== pid);
    if (next.length === this.rows.length) return;
    this.rows = next;
    writeLedger(this.path, next);
  }

  /** Drop the whole ledger — the clean-quit path, where killAll() has already
   *  stopped everything and nothing should be swept next time. */
  clear(): void {
    this.rows = [];
    try { rmSync(this.path, { force: true }); } catch { /* nothing to remove */ }
  }
}

export interface SweepReport {
  /** Entries that were still the process we started, and were killed. */
  killed: LedgerEntry[];
  /** Entries whose pid was alive but is no longer ours — deliberately spared. */
  spared: LedgerEntry[];
}

/**
 * Kill whatever a previous run left behind, then drop the ledger.
 *
 * Call once at startup, BEFORE spawning this run's agents, so the ledger being
 * read is unambiguously the previous run's.
 *
 * Windows takes the same path: `processIdentity` returns null there (no `ps`),
 * so nothing is killed rather than something wrong being killed. Windows quits
 * already run a synchronous `taskkill /T /F` sweep in killAll(), which is the
 * case this exists to cover elsewhere.
 */
export function sweepStaleAgents(
  ledgerPath: string,
  log: (msg: string, detail?: unknown) => void = () => {}
): SweepReport {
  const report: SweepReport = { killed: [], spared: [] };
  const rows = readLedger(ledgerPath);
  if (!rows.length) return report;

  for (const entry of rows) {
    if (!isAlive(entry.pid)) continue;                    // exited on its own
    if (!isSameProcess(entry, processIdentity(entry.pid))) {
      // The pid is in use by something that is not our agent — or we could not
      // prove otherwise. Either way it is not ours to kill.
      report.spared.push(entry);
      continue;
    }
    hardKillTree(entry.pid);
    report.killed.push(entry);
  }

  if (report.killed.length || report.spared.length) {
    log('[stale-agents] swept a previous run', {
      killed: report.killed.map((e) => `${e.id}:${e.pid}`),
      spared: report.spared.map((e) => `${e.id}:${e.pid}`)
    });
  }
  try { rmSync(ledgerPath, { force: true }); } catch { /* already gone */ }
  return report;
}
