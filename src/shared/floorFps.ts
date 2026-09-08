/**
 * Frame-rate choices for the pixel office scene.
 *
 * The floor is ambient decoration: an idle office nobody is tracking, animating
 * for as long as the app is open whether or not anyone is looking at it. Pixi's
 * ticker follows requestAnimationFrame, so left uncapped it runs at whatever the
 * display offers — 120 fps on a ProMotion Mac, which is twice the work a 60 Hz
 * machine does for the same scene.
 *
 * Measured on a live floor, interleaved up and back down in one session so the
 * agents' own varying workload cancels (% of one CPU core, renderer / GPU):
 *
 *   uncapped (120 Hz)   26.7 / 16.9
 *   60 fps              19.7 /  9.3
 *   30 fps              15.1 /  6.6
 *   20 fps              12.7 /  5.8
 *   15 fps              12.7 /  5.7
 *
 * 20 and 15 are the same number. That is why the default is 20 and not lower:
 * below about 20 there is nothing left to take, because what remains is React,
 * the terminals and compositing, none of which is the scene's ticker — so
 * dropping to 15 buys nothing and only costs smoothness.
 *
 * The rate does not change how fast anything MOVES — the floor's motion is a
 * function of elapsed time, so a character covers the same ground per second at
 * every setting and simply does it in fewer steps. It changes how SMOOTH that
 * motion looks, which is a real thing to want and the reason this is a choice
 * rather than a constant. The default is low because on a laptop a continuous
 * cost is battery, and a novelty animation should not be why a machine runs hot.
 */

export interface FloorFpsChoice {
  /** Ceiling in fps. 0 means uncapped: follow the display. */
  fps: number;
  label: string;
  /** One-line consequence, shown beside the label in Settings. */
  note: string;
}

export const FLOOR_FPS_DEFAULT = 20;

export const FLOOR_FPS_CHOICES: readonly FloorFpsChoice[] = [
  { fps: 15, label: '15 fps',   note: 'no cheaper than 20 in practice' },
  { fps: 20, label: '20 fps',   note: 'default — the floor costs about half' },
  { fps: 30, label: '30 fps',   note: 'smoother, about a fifth more CPU' },
  { fps: 60, label: '60 fps',   note: 'smooth, at roughly 1.5× the default' },
  { fps: 0,  label: 'Uncapped', note: 'follows the display; twice the cost at 120 Hz' }
];

/**
 * Coerce a stored value into a supported rate.
 *
 * Anything unrecognised falls back to the default rather than being trusted:
 * a hand-edited config should not be able to pin the scene at 240 fps or at
 * something Pixi will clamp (below its own minFPS, movement silently slows).
 */
export function resolveFloorFps(value: unknown): number {
  return typeof value === 'number' && FLOOR_FPS_CHOICES.some((choice) => choice.fps === value)
    ? value
    : FLOOR_FPS_DEFAULT;
}
