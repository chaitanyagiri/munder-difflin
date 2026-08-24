/**
 * Which quarantined MemPalace segments to delete.
 *
 * MemPalace recovers from a suspect ChromaDB HNSW segment by RENAMING the whole
 * segment directory out of the way — `<uuid>.drift-<stamp>` for mtime drift,
 * `<uuid>.corrupt-<stamp>` for unreadable metadata — and letting Chroma rebuild
 * a clean one. Sound recovery. What it never does, at any version we have read
 * (3.3.5 through the current 3.7.1), is DELETE the copy it renamed aside.
 *
 * That is fine for a one-off. It is not fine here, because on this palace the
 * quarantine is not a one-off: the drawers segment is one 100-vector batch
 * (167,600 bytes at 384 dims), which never reaches Chroma's sync threshold of
 * 1000, so no persist ever fires, so `index_metadata.pickle` is never written,
 * so the health gate fails and quarantines it again. Byte-identical, every few
 * minutes, forever. A user on Discord passed 100GB inside 8 hours this way.
 *
 * The cure belongs upstream — MemPalace's "has real data" floor is 1024 bytes,
 * set for tiny test collections, and a normal vector batch clears it by 163x.
 * We cannot ship their fix and cannot make anyone upgrade. So we contain it:
 * sweep the copies and the disk stops growing on every version, with nothing
 * for the user to notice or do.
 *
 * Pure and browser-global-free so the rules are unit-testable without a palace
 * on disk. Same split as `store/focusMode.ts`: the decision lives here, the
 * `rm` lives in `memory.ts`.
 */

/** A palace directory entry, as far as these rules care. */
export interface PalaceEntry {
  name: string;
}

/**
 * Matches ONLY MemPalace's own quarantine suffix.
 *
 * Deliberately anchored and fully specified — `%Y%m%d-%H%M%S` from
 * `backends/chroma.py`, so exactly 8 digits, a dash, 6 digits, end of name. A
 * looser "contains .corrupt" test is the kind that one day matches a live
 * collection and deletes somebody's index. The live segments are bare UUIDs
 * with no suffix at all, so nothing without this exact shape is ever a
 * candidate.
 */
const QUARANTINE = /\.(?:drift|corrupt)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** The quarantine stamp as local epoch ms, or null if this is not one.
 *
 *  The stamp, not the directory's mtime: renaming a directory does not change
 *  its own mtime (only the parent's), so mtime still reports when the segment
 *  was last WRITTEN, not when it was quarantined. The stamp is written by
 *  MemPalace's `datetime.now()` on this same machine, so local time is the
 *  right reading of it. */
export function quarantineStampMs(name: string): number | null {
  const m = QUARANTINE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isNaN(t) ? null : t;
}

export interface ReapOptions {
  /** Newest N kept for diagnosis. Something has to survive for anyone to be
   *  able to look at what was quarantined and why. */
  keep?: number;
  /** Never touch a quarantine younger than this. The rename and the rebuild are
   *  not atomic with respect to us, so leave the freshest ones alone rather
   *  than race a MemPalace process mid-recovery. */
  minAgeMs?: number;
}

const DEFAULTS = { keep: 2, minAgeMs: 10 * 60_000 };

/**
 * Names to delete, given everything currently in the palace directory.
 *
 * Newest-first by stamp, skip the newest `keep`, then drop whatever is left
 * that is also older than `minAgeMs`. Returns names, not paths — the caller
 * owns the palace path and the filesystem.
 */
export function quarantineDirsToReap(
  entries: PalaceEntry[],
  nowMs: number,
  opts: ReapOptions = {}
): string[] {
  const keep = opts.keep ?? DEFAULTS.keep;
  const minAgeMs = opts.minAgeMs ?? DEFAULTS.minAgeMs;

  const stamped: { name: string; ts: number }[] = [];
  for (const e of entries) {
    const ts = quarantineStampMs(e.name);
    if (ts !== null) stamped.push({ name: e.name, ts });
  }
  // Newest first. Tie-break on name so two quarantines inside the same second
  // produce a stable, reproducible ordering rather than depending on readdir.
  stamped.sort((a, b) => (b.ts - a.ts) || b.name.localeCompare(a.name));

  return stamped
    .slice(Math.max(0, keep))
    .filter((q) => nowMs - q.ts >= minAgeMs)
    .map((q) => q.name);
}

/**
 * How long to wait before the next mine pass.
 *
 * Mining into a palace that just quarantined buys nothing: the segment it
 * rebuilds is the same one the next open will quarantine again, so the only
 * product of a fast cadence is another copy for `quarantineDirsToReap` to
 * clean up. So each pass that sees a fresh quarantine doubles the wait, and
 * the first clean pass drops straight back to the base interval.
 *
 * Capped deliberately, and not high. On a palace stuck in the loop the backoff
 * would otherwise climb forever, and the cost of waiting is real: a memory is
 * not searchable until it has been mined. The reaper already removes 100% of
 * the disk growth, so this is only trimming CPU and IO — not worth making
 * recall an hour stale to save.
 */
export function nextMineDelayMs(
  currentMs: number,
  baseMs: number,
  maxMs: number,
  quarantinedThisPass: boolean
): number {
  if (!quarantinedThisPass) return baseMs;
  return Math.min(Math.max(currentMs, baseMs) * 2, maxMs);
}
