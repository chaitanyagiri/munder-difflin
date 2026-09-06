/**
 * Process-tree termination helpers (PID-release hardening).
 *
 * Every explicit kill path used to be a bare node-pty `proc.kill()` — SIGHUP to
 * the DIRECT child only. Two leaks follow: (1) a child that ignores/queues
 * SIGHUP never dies, so its PID lingers for the machine's uptime; (2) even when
 * the child dies, its own children (MCP servers, helper daemons the session
 * started) are orphaned to PID 1 and never released. With the breaker/heartbeat
 * spawning and killing sessions all day, PIDs accumulate steadily.
 *
 * The fix: the pty child is a session leader (forkpty does setsid), so its
 * process GROUP covers its descendants — after a graceful kill, verify and then
 * SIGKILL the whole group (POSIX) or `taskkill /T /F` the tree (Windows).
 *
 * Deliberate scope: callers apply this on EXPLICIT kills (breaker stop, archive,
 * respawn, app quit, hidden check sessions) — never on a natural exit, where a
 * daemon the agent intentionally left running (a dev server started via a Bash
 * tool) must survive its parent session.
 */
import { spawnSync } from 'node:child_process';

/** Grace between the polite signal and the SIGKILL escalation. */
export const KILL_GRACE_MS = 4_000;

/** Is the process still alive? Signal 0 probes without touching it. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Forcefully kill pid and its descendants NOW. Group-SIGKILL on POSIX (falls
 *  back to the single pid when the group id is gone); `taskkill /T /F` on
 *  Windows. Killing the group of an already-dead leader is exactly the
 *  orphan-reaping case: any surviving members still hold the group id. */
export function hardKillTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000 }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Snapshot the live members of process group `pgid` as pid -> start time
 *  (`lstart`, a stable full-precision timestamp). Returns null when `ps`
 *  itself fails — callers must treat null as "cannot verify", never as
 *  "group is empty". */
export function groupMembers(pgid: number): Map<number, string> | null {
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,pgid=,lstart='], { timeout: 2_000 });
    if (r.error || r.status !== 0) return null;
    const out = new Map<number, string>();
    for (const line of String(r.stdout ?? '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+\S)\s*$/);
      if (m && Number(m[2]) === pgid) out.set(Number(m[1]), m[3]);
    }
    return out;
  } catch {
    return null;
  }
}

/** Decide whether the delayed sweep may group-SIGKILL. The hazard this guards
 *  (seen live 2026-08-30, T1007): once the leader AND its whole group are
 *  gone, the kernel can recycle the pid as the pgid of an UNRELATED new
 *  process group — a Claude session's background task, say — and the delayed
 *  `kill(-pid)` then executes an innocent bystander. Under fork-heavy load
 *  (parallel pytest suites) recycling happens within the 4s grace.
 *
 *  Sweep exactly when the group still holds at least one member from the
 *  original snapshot (same pid AND same start time — the orphan-reaping case
 *  this helper exists for). Skip when the group is empty (nothing to reap) or
 *  when every current member is a stranger (pgid recycled). When either
 *  snapshot is null (`ps` failed), fall back to sweeping — the pre-guard
 *  behavior — rather than silently leaking. */
export function shouldSweep(
  before: Map<number, string> | null,
  after: Map<number, string> | null
): boolean {
  if (before === null || after === null) return true;
  if (after.size === 0) return false;
  for (const [pid, started] of after) {
    if (before.get(pid) === started) return true;
  }
  return false;
}

/** After a graceful kill (node-pty's SIGHUP), make sure the PIDs actually get
 *  released: wait a short grace, then sweep the process tree. Runs even when
 *  the leader died promptly — the sweep is what reaps grandchildren the polite
 *  signal never reached. Before sweeping, the group membership is re-checked
 *  against a snapshot taken here, so a recycled pgid is never group-killed
 *  (see shouldSweep). The timer is unref'd so it can never keep the app
 *  alive during quit. */
export function ensureKilled(pid: number | undefined, graceMs = KILL_GRACE_MS): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const t = setTimeout(() => hardKillTree(pid), graceMs);
    t.unref?.();
    return;
  }
  const before = groupMembers(pid);
  const t = setTimeout(() => {
    if (shouldSweep(before, groupMembers(pid))) hardKillTree(pid);
  }, graceMs);
  t.unref?.();
}
