/**
 * The roster on disk — agents, their notes, worktree paths, archived and
 * restorable entries, and parked message queues, stored as one JSON file beside
 * the hive.
 *
 * WHY THIS EXISTS. This is the UI floor (cards, notes, queues, worktrees).
 * Hive identity — id, role, cwd, session — lives in `<harnessHome>/hive/registry.json`
 * and is what agents read. The two must not drift: `description` here is the
 * same durable job string as registry `role`, never live status (pause/idle).
 *
 * All of that used to live only in the renderer's localStorage,
 * and localStorage is partitioned by ORIGIN. A dev run loads the renderer from
 * `http://localhost:5173` and a packaged build loads it from `file://`, so the
 * two never see each other's storage: switching between them showed an empty
 * floor and no notes, even though the hive on disk (sessions, memory, inboxes,
 * tasks) was right there and intact. A file keyed on `harnessHome` is shared by
 * both, because it is addressed by path rather than by page origin.
 *
 * localStorage is still written exactly as before. This file is an ADDITION, not
 * a migration away from it — if anything here fails, the renderer falls back to
 * the storage it has always used and nothing is lost.
 *
 * Durability rules, in order of how much they matter:
 *   1. Never lose a roster. Every write first copies the previous file into
 *      `roster-backups/`, which is append-only — nothing in it is ever pruned,
 *      overwritten or deleted.
 *   2. Never write a truncated file. Writes go to a temp file and are renamed
 *      into place, so a crash mid-write leaves the previous file untouched.
 *   3. Never let an empty renderer erase a full roster. See `write`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the renderer mirrors to disk. The inner agent shape is deliberately
 *  opaque here — the renderer's store owns it, and repeating it would mean
 *  editing this file every time an agent gains a field. Main only counts. */
export interface RosterSnapshot {
  version: 1;
  savedAt: string;
  agents: unknown[];
  archived: unknown[];
  restorable: unknown[];
  queues: Record<string, unknown[]>;
  selectedId: string | null;
}

export interface RosterWriteResult {
  ok: boolean;
  /** Set when the write was deliberately declined; the file is unchanged. */
  skipped?: 'empty-first-write';
  error?: string;
}

export function rosterPath(home: string): string {
  return join(home, 'roster.json');
}

export function rosterBackupDir(home: string): string {
  return join(home, 'roster-backups');
}

function isSnapshot(v: unknown): v is RosterSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<RosterSnapshot>;
  return Array.isArray(s.agents) && Array.isArray(s.archived) && Array.isArray(s.restorable);
}

function entryCount(s: RosterSnapshot): number {
  return s.agents.length + s.archived.length + s.restorable.length;
}

/**
 * Reads and writes one home folder's roster.
 *
 * A class rather than free functions because the empty-guard needs to know
 * whether THIS run has written yet, and a module-level flag would be invisible
 * shared state that no test could reset. One instance per process in `index.ts`;
 * tests make their own. The instance lives in MAIN, so a renderer reload reuses
 * it: the guard's state survives reloads (the 2026-08-16 incident was two
 * refusal-worthy writes in one run, minutes apart) and re-arms only on a fresh
 * app launch.
 */
export class RosterStore {
  /** Set once this store has written successfully. The empty-guard applies only
   *  before that: see `write`. */
  private wrote = false;
  /** Disambiguates backups made inside the same millisecond. Two writes in one
   *  tick used to produce the same filename, and the second silently replaced
   *  the first — a backup folder that quietly loses backups is worse than none. */
  private backupSeq = 0;

  constructor(private readonly getHome: () => string | null) {}

  private home(): string | null {
    try { return this.getHome(); } catch { return null; }
  }

  /** The stored roster, or null when there isn't one (or it can't be parsed).
   *  Null means "no opinion" — the renderer then keeps using localStorage, so a
   *  corrupt file degrades to the old behaviour instead of to an empty floor. */
  read(): RosterSnapshot | null {
    const home = this.home();
    if (!home) return null;
    try {
      const p = rosterPath(home);
      if (!existsSync(p)) return null;
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Write the roster, keeping the previous contents as a backup.
   *
   * THE EMPTY-GUARD. The dangerous sequence is: open the packaged build for the
   * first time, its localStorage is empty (different origin), the store boots
   * with zero agents, and the first mirror write flattens a file that holds a
   * real roster. So an empty write is refused until this run has landed a
   * NON-empty write — only then has the renderer proven it actually holds a
   * roster, and a later empty write means the user really removed their agents
   * (refusing those would make deletion impossible). The guard must survive a
   * refusal: a renderer reload used to re-send the same empty snapshot, and
   * because the first refusal disarmed the guard, the second empty write went
   * through and flattened the file (seen live 2026-08-16 20:40:03). The previous
   * file is backed up either way, so even a wrong call here is recoverable.
   */
  write(snap: unknown): RosterWriteResult {
    const home = this.home();
    if (!home) return { ok: false, error: 'no harnessHome' };
    if (!isSnapshot(snap)) return { ok: false, error: 'invalid snapshot' };
    const p = rosterPath(home);
    try {
      mkdirSync(home, { recursive: true });
      const existing = this.read();

      if (!this.wrote && existing && entryCount(existing) > 0 && entryCount(snap) === 0) {
        // Back it up anyway: what is on disk right now is exactly what we are
        // protecting, and a copy of it costs nothing. `wrote` stays false: the
        // guard disarms only when a non-empty write lands, never on a refusal.
        this.backup(home, p, 'declined');
        console.warn('[roster] refused to overwrite a non-empty roster with an empty one');
        return { ok: false, skipped: 'empty-first-write' };
      }

      this.backup(home, p, this.wrote ? 'write' : 'run-start');

      const body: RosterSnapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        agents: snap.agents,
        archived: snap.archived,
        restorable: snap.restorable,
        queues: snap.queues && typeof snap.queues === 'object' ? snap.queues : {},
        selectedId: typeof snap.selectedId === 'string' ? snap.selectedId : null
      };
      // Temp + rename: `rename` is atomic within a filesystem, so a crash leaves
      // either the old file or the new one, never half of either.
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      renameSync(tmp, p);
      this.wrote = true;
      return { ok: true };
    } catch (e) {
      try { rmSync(`${p}.tmp`, { force: true }); } catch { /* noop */ }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Retire the active roster during a full reset: copied into `roster-backups/`
   * first, then the live file is removed.
   *
   * Reset wipes the hive, and the roster must not be left behind as the one
   * survivor — pointing the home folder back here afterwards would show a floor
   * full of agents whose sessions, memory and inboxes no longer exist. Archived
   * rather than deleted, because a roster is never destroyed, only superseded.
   */
  archive(): void {
    const home = this.home();
    if (!home) return;
    const p = rosterPath(home);
    try {
      if (!existsSync(p)) return;
      this.backup(home, p, 'reset');
      rmSync(p, { force: true });
    } catch { /* a reset must never fail on this */ }
  }

  /** Copy the current roster into the append-only backup folder. Never prunes:
   *  these files are the last line of defence, and a few KB per write is a price
   *  worth paying for that. */
  private backup(home: string, p: string, reason: string): void {
    try {
      if (!existsSync(p)) return;
      const dir = rosterBackupDir(home);
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.backupSeq += 1;
      copyFileSync(p, join(dir, `roster-${stamp}-${this.backupSeq}-${reason}.json`));
    } catch { /* a failed backup must never block the write */ }
  }
}
