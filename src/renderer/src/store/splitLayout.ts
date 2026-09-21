/**
 * Split-pane geometry — the floor pane and the agent sidebar, and which axis
 * divides them.
 *
 * Pure and React-free so the clamp rules are unit-testable: every number here is
 * a layout invariant the splitter drag, the orientation flip and the persisted
 * restore all have to agree on, and they used to agree only by all calling the
 * same inline `Math.min(...)`.
 *
 * ORIENTATION NAMES THE DIVIDER, not the stacking. `vertical` is a vertical
 * divider — panes side by side, sidebar on the RIGHT, sized by WIDTH.
 * `horizontal` is a horizontal divider — panes stacked, sidebar BELOW the floor,
 * sized by HEIGHT. This matches how every editor names its splits; naming it
 * after the stacking instead reads backwards to anyone who has used one.
 */

export type SplitOrientation = 'vertical' | 'horizontal';

/**
 * Smallest useful sidebar, per orientation.
 *
 * These are NOT the same number, because the sidebar holds a terminal and a
 * terminal's two axes are not interchangeable: 320px of width is about 40
 * columns (below which agent output wraps into soup), while 240px of height is
 * about 15 rows — cramped but genuinely usable, and a user who flips to
 * horizontal is usually doing it precisely to give the terminal the full width
 * and is happy to trade rows for columns.
 */
export const SIDEBAR_MIN: Record<SplitOrientation, number> = {
  vertical: 320,
  horizontal: 240
};

/** Absolute ceiling, independent of viewport — stops a restored value from a
 *  much larger display swallowing the whole window on a smaller one. Higher for
 *  horizontal because window heights and widths are not comparable scales. */
export const SIDEBAR_MAX: Record<SplitOrientation, number> = {
  vertical: 1200,
  horizontal: 2000
};

/**
 * Room the FLOOR pane always keeps.
 *
 * The office map is 544x352 — a 1.55:1 landscape image — and the camera does a
 * contain-fit (`Camera.getMinZoom` takes the min of the two axis ratios), so
 * whichever axis is over-provisioned becomes dead letterbox space.
 *
 * 360 horizontal-axis pixels is the long-standing vertical-split floor. 180 is
 * the horizontal one: at 180px tall the fit is height-limited and the floor
 * renders ~279x180, which still reads as a floor with recognisable avatars.
 * Reusing 360 here would have made the strip layout — the whole point of the
 * horizontal split — impossible to drag to.
 */
export const FLOOR_MIN: Record<SplitOrientation, number> = {
  vertical: 360,
  horizontal: 180
};

/**
 * Opening size per orientation, and the double-click reset target.
 *
 * Deliberately NOT one shared number. The two orientations size different edges
 * of different panes, so carrying one scalar across a flip turns a 420px-wide
 * sidebar into a 420px-tall one — which in horizontal mode is a small terminal
 * under a huge floor, the exact inverse of what the flip was asked for. Each
 * orientation therefore remembers its own size (see `sidebarWidth` /
 * `sidebarHeight` in the store).
 */
export const SIDEBAR_DEFAULT: Record<SplitOrientation, number> = {
  vertical: 420,
  horizontal: 620
};

/**
 * Confine a sidebar size to what the current orientation and viewport allow.
 *
 * Order matters: the floor's reserved room is applied as a max, but never below
 * the sidebar's own min — on a viewport too small to satisfy both, the sidebar
 * min wins and the floor is the pane that gives. The alternative (floor wins)
 * collapses the terminal to nothing, and the terminal is the pane carrying the
 * work.
 */
export function clampSidebarSize(
  px: number,
  orientation: SplitOrientation,
  viewport: number
): number {
  const min = SIDEBAR_MIN[orientation];
  const roomMax = Math.max(min, viewport - FLOOR_MIN[orientation]);
  const max = Math.min(SIDEBAR_MAX[orientation], roomMax);
  const n = Number.isFinite(px) ? Math.round(px) : SIDEBAR_DEFAULT[orientation];
  return Math.min(max, Math.max(min, n));
}

/** The other orientation. */
export function flipOrientation(o: SplitOrientation): SplitOrientation {
  return o === 'vertical' ? 'horizontal' : 'vertical';
}

/** Narrow an untrusted persisted value (localStorage) to an orientation. */
export function parseOrientation(v: unknown): SplitOrientation {
  return v === 'horizontal' ? 'horizontal' : 'vertical';
}
