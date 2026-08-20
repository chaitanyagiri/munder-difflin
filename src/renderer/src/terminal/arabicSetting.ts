/**
 * The renderer switch for RTL-script terminal support: ON keeps xterm on its
 * DOM renderer, registers the Arabic character joiner, and lets the bidi CSS
 * in design/global.css do its work — together these render Arabic (and other
 * RTL scripts' neutral runs) shaped and correctly ordered, which the WebGL
 * cell painter structurally cannot (xterm.js has no bidi: xtermjs/xterm.js#701).
 * OFF leases the WebGL renderer: faster, and exactly the previous behavior.
 *
 * DEFAULT: follows the system locale — users whose UI language is an RTL
 * script (Arabic, Farsi, Hebrew, Urdu) get readable terminals out of the box;
 * everyone else keeps the GPU renderer untouched. The Settings toggle
 * overrides either way and persists.
 */
const KEY = 'cth.arabicTerminal';

function defaultEnabled(): boolean {
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
    return langs.some((l) => /^(ar|fa|he|ur)\b/i.test(l ?? ''));
  } catch { return false; }
}

let enabled = read();

function read(): boolean {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch { /* private mode — fall through to the locale default */ }
  return defaultEnabled();
}

/** Hot path — called on terminal attach; reads the cached value. */
export function isArabicTerminalEnabled(): boolean {
  return enabled;
}

/** Flip the switch. Renderer choice is made when a terminal leases WebGL (on
 *  attach), so this applies to newly created terminal views. */
export function setArabicTerminalEnabled(next: boolean): void {
  enabled = next;
  try { window.localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private mode */ }
}
