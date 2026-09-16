/**
 * App-wide theme (v0.3.4) — ONE light/dark switch for the whole UI, not just
 * the terminal.
 *
 * The entire renderer is styled through the `--cth-*` tokens, so dark mode is
 * a token swap: this module stamps `data-cth-theme` on <html> and tokens.css
 * carries the dark overrides. The xterm palette (PtyTerminalView) and the
 * per-agent Claude session theme (config.terminalTheme, applied on spawn)
 * follow the same state, so terminals and TUIs match the chrome.
 *
 * Shared subscribable module (same pattern as terminalFontSize): components
 * read it with `useAppTheme()`; the ONE toggle lives in the title bar.
 */
import { useSyncExternalStore } from 'react';

export type AppTheme = 'light' | 'dark';

const LS_KEY = 'cth.theme';
/** Pre-0.3.4 the terminal had its own theme key — honor it once as the seed. */
const LEGACY_LS_KEY = 'cth.ptyTheme';

function load(): AppTheme {
  try {
    const v = window.localStorage.getItem(LS_KEY) ?? window.localStorage.getItem(LEGACY_LS_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch { /* noop */ }
  return 'dark';
}

let theme: AppTheme = load();
const subscribers = new Set<() => void>();

function apply(): void {
  try { document.documentElement.dataset.cthTheme = theme; } catch { /* SSR/tests */ }
}
apply();

export function appTheme(): AppTheme {
  return theme;
}

export function setAppTheme(next: AppTheme): void {
  if (next === theme) return;
  theme = next;
  try { window.localStorage.setItem(LS_KEY, next); } catch { /* noop */ }
  apply();
  subscribers.forEach((fn) => fn());
}

export function toggleAppTheme(): AppTheme {
  const next: AppTheme = theme === 'dark' ? 'light' : 'dark';
  setAppTheme(next);
  return next;
}

export function useAppTheme(): AppTheme {
  return useSyncExternalStore(
    (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
    () => theme
  );
}
