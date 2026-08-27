import i18n, { isRtlLanguage } from '@/i18n';

/**
 * The renderer switch for RTL-script terminal support: ON keeps xterm on its
 * DOM renderer, registers the Arabic character joiner, and lets the bidi CSS
 * in design/global.css do its work — together these render Arabic (and other
 * RTL scripts' neutral runs) shaped and correctly ordered, which the WebGL
 * cell painter structurally cannot (xterm.js has no bidi: xtermjs/xterm.js#701).
 * OFF leases the WebGL renderer: faster, and exactly the previous behavior.
 *
 * THE LANGUAGE SETS THE DEFAULT; THE TOGGLE IS AN OVERRIDE.
 *
 * This shipped in 59d721ed as a manual switch, defaulting off for everyone,
 * because at the time Arabic could not be selected as a UI language at all — a
 * manual switch was the only door there was. Now that it can, a user who picks
 * Arabic has already answered the question this toggle asks, and asking twice
 * is the confusion the founder reported. So picking an RTL app language turns
 * it on by itself.
 *
 * It is a DEFAULT and not a derived value, because the tradeoff is real in both
 * directions and neither side is rare enough to lock out:
 *   - An ENGLISH user whose colleagues write Arabic, or whose logs carry it,
 *     has a genuine reason to switch this on without changing their UI language.
 *   - An ARABIC user may want the GPU renderer's speed back. It is their machine.
 * So the state is THREE-valued, not two: unset (follow the language), forced on,
 * forced off. An explicit choice outlives a language switch in both directions —
 * a user who deliberately turned this on does not lose it by moving off Arabic.
 *
 * What it deliberately does NOT do is sniff the OS locale, which is the same
 * auto-detect the language picker refuses: `navigator.languages` is not a
 * choice the user made in this app, and acting on it would move an existing
 * user off the GPU renderer on upgrade without them asking. Nothing here reads
 * anything but the language they picked and the override they set.
 */
const KEY = 'cth.arabicTerminal';

/** The user's explicit choice, or `null` for "follow the app language". */
type Override = boolean | null;

let override: Override = readOverride();

function readOverride(): Override {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch { /* private mode — no override, so the language decides */ }
  return null;
}

/** What the current app language asks for, absent an override. */
function languageDefault(): boolean {
  // Read live rather than caching: the language changes at runtime, and this is
  // called on terminal attach, which can happen long after module init.
  try { return isRtlLanguage(i18n.language); } catch { return false; }
}

/** Hot path — called on terminal attach and on every renderer lease. */
export function isArabicTerminalEnabled(): boolean {
  return override ?? languageDefault();
}

/** True when the value above is coming from the language, not a stored choice.
 *  Settings uses this to say so rather than presenting a default as a decision. */
export function isArabicTerminalFollowingLanguage(): boolean {
  return override === null;
}

/** Record an explicit choice. Always writes — an override that happens to agree
 *  with the language today must still survive a switch away from it tomorrow. */
export function setArabicTerminalEnabled(next: boolean): void {
  override = next;
  try { window.localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private mode */ }
}

/** Drop the override and go back to following the app language. */
export function clearArabicTerminalOverride(): void {
  override = null;
  try { window.localStorage.removeItem(KEY); } catch { /* private mode */ }
}
