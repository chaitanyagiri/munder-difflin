/**
 * Telling floors apart, and moving between them.
 *
 * Floors already run in parallel — each window owns its own PTYs (routed by
 * `PtySession.owner`), and `backgroundThrottling: false` keeps an occluded
 * floor's heartbeat loops running. What was missing was any way to *reach* a
 * particular one.
 *
 * Two things stood in the way, and only the first is obvious:
 *
 *  1. Nothing listed the open floors. The app menu is built once at startup, so
 *     even a static list would have gone stale on the first `New Floor`.
 *
 *  2. Every floor was called "Munder Difflin". `createWindow` passes
 *     `title: 'Munder Difflin — Floor'`, but `src/renderer/index.html` carries
 *     `<title>Munder Difflin</title>`, and in Electron the PAGE title wins as
 *     soon as it loads — silently, with no error. Verified on 2026-09-07: every
 *     open window reported the same title to the compositor, so the window
 *     manager's own switcher could not distinguish them either. Setting the
 *     title at construction is therefore not enough; it has to be re-applied
 *     after load and defended against `page-title-updated`.
 *
 * Numbering is by POSITION, not by a stable id, so the numbers stay dense as
 * floors come and go and always match what the switcher menu shows. A floor
 * being renumbered when an earlier one closes is the same behaviour browser tabs
 * have, and it keeps `Ctrl+Alt+2` meaning "the second one in the list".
 */

/** The primary window keeps the bare product name — it is the one users think
 *  of as "the app", and renaming it to "Floor 1" would be a downgrade. */
export const PRIMARY_TITLE = 'Munder Difflin';

/** Title for the window at `index` in floor order (0 = primary). */
export function floorTitle(index: number): string {
  return index === 0 ? PRIMARY_TITLE : `${PRIMARY_TITLE} — Floor ${index + 1}`;
}

/** Menu label for the window at `index`. Numbered so the row reads the same way
 *  as the accelerator that reaches it. */
export function floorMenuLabel(index: number): string {
  return `${index + 1}  ${floorTitle(index)}`;
}

/** Accelerator for the nth floor, or undefined past what we can bind.
 *
 *  `CmdOrCtrl+Alt+<n>` rather than the browser-style `CmdOrCtrl+<n>`: a menu
 *  accelerator is claimed before the focused element sees the key, and these
 *  windows are mostly full of agent TUIs. Ctrl+1..9 is plausible input for a
 *  TUI; Ctrl+Alt+1..9 is not. (This is the same concern that made the Edit
 *  menu's clipboard items `registerAccelerator: false`, arrived at from the
 *  other direction: there the fix was to leave the key alone, here it is to
 *  choose a key nothing else wants.) */
export function floorAccelerator(index: number): string | undefined {
  return index < 9 ? `CmdOrCtrl+Alt+${index + 1}` : undefined;
}

/**
 * Index of the floor to move to when cycling.
 *
 * Wraps in both directions, so a two-floor setup can be flipped between with one
 * key held down. `current` of -1 (nothing focused, or a window not in the list)
 * enters at the first floor going forward and the last going back.
 */
export function cycleFloorIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}
