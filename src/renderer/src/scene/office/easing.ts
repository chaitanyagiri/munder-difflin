/**
 * Frame-rate-independent easing.
 *
 * The office scene eases the camera by moving a fixed FRACTION of the remaining
 * distance each frame. That is the usual shortcut and it has the usual bug: the
 * result depends on how often frames happen. The same constant converges twice as
 * fast on a 120 Hz ProMotion panel as on a 60 Hz one, and slows down again the
 * moment the ticker is capped.
 *
 * Converting the per-frame fraction to a per-second decay fixes both. Keeping a
 * fraction `f` of the distance each frame leaves `(1 - f)^frames` after that many
 * frames, so the elapsed-time equivalent is `1 - (1 - f)^(dt * refHz)`.
 */

/**
 * @param perFrame fraction of the remaining distance to cover in one frame at `refHz` (0..1)
 * @param dt       seconds elapsed since the last frame
 * @param refHz    the rate `perFrame` was tuned against
 * @returns        the fraction to cover for this frame, easing identically at any rate
 */
export function timeScaledLerp(perFrame: number, dt: number, refHz = 60): number {
  if (!(dt > 0)) return 0;                 // no time passed (or NaN): no movement
  if (perFrame <= 0) return 0;
  if (perFrame >= 1) return 1;             // "snap" stays a snap at every rate
  return 1 - Math.pow(1 - perFrame, dt * refHz);
}
