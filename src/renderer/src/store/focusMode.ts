/**
 * Focus mode: which agent the full-window terminal is showing, and whether the
 * user wants that view by default.
 *
 * Kept out of the store, and structural rather than typed against `Agent`, so
 * the rules below are testable without dragging zustand into a unit test. Same
 * reasoning as `hooks/queueDelivery.ts`.
 */

/** The subset of an agent these rules need. */
export interface FocusCandidate {
  id: string;
  /** Present once the agent has a terminal. Absent for synthetic agents and for
   *  a persisted agent whose PTY has not been re-established yet. */
  ptyId?: string;
}

/**
 * Keep focus mode pointed at an agent that still exists.
 *
 * Every path that removes an agent already re-homes `selectedId`, but none of
 * them re-homed the focused id, so closing the agent you were focused on left it
 * pointing at nothing. `App.tsx` then finds no agent to render and drops the
 * whole window back to the sidebar, which reads as the app deciding to leave
 * focus mode on your behalf.
 *
 * Closing an agent is not a request to leave focus mode. So follow the selection
 * instead, and only fall out once the last agent is gone.
 *
 * Applies to every removal path, including `reconcileWithLivePtys`: that one runs
 * at STARTUP and prunes agents whose PTY did not survive, so without it a
 * restored focus-mode preference would be undone by the first reconcile.
 */
export function refocusAfterRemoval(
  fullscreenAgentId: string | null,
  agents: FocusCandidate[],
  selectedId: string | null
): string | null {
  if (fullscreenAgentId === null) return null;
  if (agents.some((a) => a.id === fullscreenAgentId)) return fullscreenAgentId;
  return selectedId ?? agents[0]?.id ?? null;
}

/**
 * Resolve a persisted focus-mode preference into an agent to focus on load.
 *
 * The preference is stored as a BOOLEAN, deliberately not as the focused agent's
 * id. An id is meaningless across a restart: that agent may have been closed, or
 * its PTY may not come back, and restoring a stale one lands straight in the
 * dangling reference `refocusAfterRemoval` exists to prevent. The preference
 * means "I work in focus mode", so it resolves against whoever is selected now.
 */
export function focusOnLoad(
  prefersFocusMode: boolean,
  selectedId: string | null
): string | null {
  return prefersFocusMode ? selectedId : null;
}

/**
 * Re-enter focus mode once there is something to focus on.
 *
 * `focusOnLoad` alone was not enough and the reason is a startup ordering one.
 * The store resolves the preference ONCE, while it is being constructed, against
 * the roster read from disk. Every agent in that roster still carries the PTY id
 * it had in the PREVIOUS session, and none of those PTYs exist yet, so the first
 * `reconcileWithLivePtys` correctly prunes the lot and `refocusAfterRemoval`
 * correctly returns null. By the time god respawns with a live terminal the
 * preference has already been read and discarded, so the app opens in the
 * sidebar with `cth.prefersFocusMode` still set to 1.
 *
 * So the preference has to be re-checked whenever the roster changes, not once
 * at construction.
 *
 * Restores only onto an agent that HAS a terminal. `FullscreenTerminal` renders
 * nothing without one and its own re-home effect would immediately bounce us
 * back out, which is a loop rather than a restore.
 *
 * Returns the current value unchanged when there is nothing to do, so callers
 * can compare by identity and skip the state write.
 */
export function restoreFocus(
  prefersFocusMode: boolean,
  fullscreenAgentId: string | null,
  agents: FocusCandidate[],
  selectedId: string | null
): string | null {
  if (!prefersFocusMode) return fullscreenAgentId;
  if (fullscreenAgentId) return fullscreenAgentId;
  const selected = agents.find((a) => a.id === selectedId && a.ptyId);
  return selected?.id ?? agents.find((a) => a.ptyId)?.id ?? null;
}
