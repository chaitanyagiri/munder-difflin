/**
 * "Is this keydown just the IME talking?"
 *
 * A CJK, Japanese or Korean user types Latin letters into an input method
 * editor, which shows a candidate list, and presses ENTER to CHOOSE a candidate.
 * That Enter is meant for the IME, not for us. Every `if (e.key === 'Enter')`
 * handler in the app used to treat it as "send", so picking a candidate fired
 * the message, ran the search, or committed the rename with half-typed text.
 * The user then had to retype in a language the app had already sent badly.
 *
 * Two signals, because neither is sufficient alone:
 *
 *  1. `isComposing` — the DOM's own answer, true for keydowns dispatched while a
 *     composition session is open. This is the primary check. React's synthetic
 *     keyboard event does NOT re-expose it, which is why we read through
 *     `nativeEvent` first and only fall back to the object itself (for raw
 *     `KeyboardEvent` listeners, which carry it directly).
 *
 *  2. `keyCode === 229` — the legacy "IME is processing this key" sentinel that
 *     Chromium still reports. It covers the race at the END of a composition,
 *     where the compositionend and the confirming keydown can arrive in an order
 *     that leaves `isComposing` already false for the very Enter we must swallow.
 *     229 is never a real Enter (that is 13), so this cannot swallow a genuine
 *     keypress.
 *
 * Pure and framework-free on purpose so it is testable from `node --test`.
 */

/** The structural shape we need from either a React synthetic event or a raw
 *  DOM `KeyboardEvent`. Deliberately all-optional: a hand-built test double or a
 *  partially-populated event must degrade to "not composing", never throw. */
export interface ComposingKeyEvent {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** True when this keydown belongs to an in-flight IME composition and the
 *  handler must return WITHOUT acting. The next Enter, once composition has
 *  ended, arrives with `isComposing` false and `keyCode` 13 and is handled
 *  normally. */
export function isComposingKey(e: ComposingKeyEvent | null | undefined): boolean {
  if (!e) return false;
  // Prefer the native event: React's SyntheticKeyboardEvent drops `isComposing`.
  const src = e.nativeEvent ?? e;
  return src.isComposing === true || src.keyCode === 229;
}
