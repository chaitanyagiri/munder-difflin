import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icon';
import { acquireTerminal, attachTerminal } from './terminalPool';

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 40;

const LS_FONT_SIZE = 'cth.ptyFontSize';
const LS_THEME = 'cth.ptyTheme';

type PtyTheme = 'light' | 'dark';

function loadFontSize(): number {
  try {
    const n = parseInt(window.localStorage.getItem(LS_FONT_SIZE) ?? '', 10);
    if (!Number.isNaN(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
  } catch { /* noop */ }
  return DEFAULT_FONT_SIZE;
}

function loadTheme(): PtyTheme {
  try {
    const v = window.localStorage.getItem(LS_THEME);
    if (v === 'dark' || v === 'light') return v;
  } catch { /* noop */ }
  return 'light';
}

const zoomBtnStyle: CSSProperties = {
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 12,
  lineHeight: 1,
  color: 'var(--cth-ink-700)',
  background: 'var(--cth-paper-100)',
  border: '1px solid var(--cth-ink-300)',
  cursor: 'pointer',
  padding: 0
};

// Light theme — cream paper. The ANSI "white" / "yellow" / bright slots are
// remapped to readable dark inks: programs that print white or pale-yellow text
// (expecting a dark terminal) were previously invisible on the cream background.
const lightTheme = {
  background: '#FCFAF0',
  foreground: '#1A1320',
  cursor: '#FF6B6B',
  cursorAccent: '#FCFAF0',
  selectionBackground: '#FFEC99',
  selectionForeground: '#1A1320',
  black:        '#1A1320',
  red:          '#D1453B',
  green:        '#2E9E54',
  yellow:       '#B8860B',
  blue:         '#2B6CB0',
  magenta:      '#8A5CF0',
  cyan:         '#1F9C94',
  white:        '#3A2F44',   // default "white" text → dark, so it's visible
  brightBlack:  '#6B5878',
  brightRed:    '#E0584E',
  brightGreen:  '#3DAA62',
  brightYellow: '#A9760A',
  brightBlue:   '#3B7DC4',
  brightMagenta:'#9B72F2',
  brightCyan:   '#2BA89F',
  brightWhite:  '#1A1320'
};

// Dark theme — the original neon-on-ink palette (designed for a dark background).
const darkTheme = {
  background: '#1A1320',
  foreground: '#F3ECF7',
  cursor: '#FF6B6B',
  cursorAccent: '#1A1320',
  selectionBackground: '#3A2F44',
  selectionForeground: '#FFF8E7',
  black:        '#241B2C',
  red:          '#FF6B6B',
  green:        '#6BCF7F',
  yellow:       '#FFD93D',
  blue:         '#4ECDC4',
  magenta:      '#B197FC',
  cyan:         '#4ECDC4',
  white:        '#F3ECF7',
  brightBlack:  '#857693',
  brightRed:    '#FFB4B4',
  brightGreen:  '#B4E5BD',
  brightYellow: '#FFEC99',
  brightBlue:   '#A8E6E0',
  brightMagenta:'#D6C5FF',
  brightCyan:   '#A8E6E0',
  brightWhite:  '#FFFDF5'
};

const THEMES: Record<PtyTheme, typeof lightTheme> = { light: lightTheme, dark: darkTheme };

export interface PtyTerminalViewProps {
  ptyId: string;
  /** Forwarded to the renderer-side onData hook so the parent can also tap
   *  the stream for regex parsing (avatar state inference). */
  onStreamData?: (chunk: string) => void;
  /** Fires with the trimmed text whenever the user submits a line (Enter). */
  onUserPrompt?: (text: string) => void;
  /** When provided, render an expand/minimize button in the header. */
  onToggleFullscreen?: () => void;
  fullscreen?: boolean;
  /** Edge-to-edge mode for the sidebar tab: no outer chrome/border. */
  embedded?: boolean;
}

export function PtyTerminalView({ ptyId, onStreamData, onUserPrompt, onToggleFullscreen, fullscreen, embedded }: PtyTerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onStreamDataRef = useRef(onStreamData);
  onStreamDataRef.current = onStreamData;
  const onUserPromptRef = useRef(onUserPrompt);
  onUserPromptRef.current = onUserPrompt;
  const [fontSize, setFontSize] = useState(loadFontSize);
  const fontSizeRef = useRef(fontSize);
  const [ptyTheme, setPtyTheme] = useState<PtyTheme>(loadTheme);
  const ptyThemeRef = useRef(ptyTheme);
  ptyThemeRef.current = ptyTheme;

  // Attach this view to the pty's persistent terminal. The terminal and its
  // buffer live in the pool across mounts, so re-parenting its host element
  // here shows the already-rendered content immediately — no blank pane while
  // switching agents or toggling fullscreen.
  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    const entry = acquireTerminal(ptyId, THEMES[ptyThemeRef.current], fontSizeRef.current);
    entry.term.options.theme = THEMES[ptyThemeRef.current];
    entry.term.options.fontSize = fontSizeRef.current;
    attachTerminal(entry, container);
    entry.onData = (chunk) => onStreamDataRef.current?.(chunk);
    entry.onPrompt = (text) => onUserPromptRef.current?.(text);

    // Snap to bottom immediately on re-attach before fit settles
    try { entry.term.scrollToBottom(); } catch { /* not yet open */ }

    // `scrollToEnd` is true only for the initial attach (switching agents /
    // toggling fullscreen) so we land on the most recent output. Re-parenting
    // the pooled terminal resets its viewport to the top otherwise. Later
    // resize-driven fits pass false so they don't yank a user who has scrolled
    // up to read history back down to the bottom.
    const tryFit = (scrollToEnd = false) => {
      try {
        entry.fit.fit();
        window.cth.resizePty(ptyId, entry.term.cols, entry.term.rows);
        entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
      } catch { /* host may not be sized yet */ }
      if (scrollToEnd) {
        try { entry.term.scrollToBottom(); } catch { /* noop */ }
      }
    };
    // Fit once layout has settled and again once the web font has loaded —
    // these are the initial-attach fits, so snap to the bottom.
    requestAnimationFrame(() => requestAnimationFrame(() => tryFit(true)));
    const retries = [setTimeout(() => tryFit(true), 60), setTimeout(() => tryFit(true), 240)];
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => tryFit(true)).catch(() => { /* noop */ });
    }

    const ro = new ResizeObserver(() => tryFit(false));
    ro.observe(container);
    const onWinResize = () => tryFit(false);
    window.addEventListener('resize', onWinResize);

    return () => {
      retries.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      // Detach (but DON'T dispose) the terminal — it keeps running in the pool.
      entry.onData = undefined;
      entry.onPrompt = undefined;
      if (entry.host.parentElement === container) container.removeChild(entry.host);
    };
  }, [ptyId]);

  // Apply theme changes to the pooled terminal and persist the choice.
  useEffect(() => {
    try { window.localStorage.setItem(LS_THEME, ptyTheme); } catch { /* noop */ }
    acquireTerminal(ptyId, THEMES[ptyTheme], fontSizeRef.current).term.options.theme = THEMES[ptyTheme];
  }, [ptyTheme, ptyId]);

  // Apply font-size (zoom) changes to the pooled terminal and re-fit cols/rows.
  useEffect(() => {
    fontSizeRef.current = fontSize;
    try { window.localStorage.setItem(LS_FONT_SIZE, String(fontSize)); } catch { /* noop */ }
    const entry = acquireTerminal(ptyId, THEMES[ptyThemeRef.current], fontSize);
    entry.term.options.fontSize = fontSize;
    try {
      entry.fit.fit();
      window.cth.resizePty(ptyId, entry.term.cols, entry.term.rows);
    } catch { /* host may not be sized yet */ }
  }, [fontSize, ptyId]);

  const zoom = (delta: number) =>
    setFontSize((s) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, s + delta)));
  const resetZoom = () => setFontSize(DEFAULT_FONT_SIZE);

  // Keyboard zoom: Cmd/Ctrl + '=' / '-' / '0'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom(1); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(-1); }
      else if (e.key === '0') { e.preventDefault(); resetZoom(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{
      background: 'var(--cth-paper-100)',
      boxShadow: embedded ? 'none' : 'var(--cth-panel-border-terminal)',
      padding: embedded ? 0 : 8,
      height: '100%',
      width: '100%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 13,
        color: 'var(--cth-ink-500)',
        borderBottom: '1px dashed var(--cth-ink-300)',
        paddingBottom: 4,
        marginBottom: 4,
        paddingLeft: embedded ? 8 : 0,
        paddingRight: embedded ? 8 : 0,
        paddingTop: embedded ? 6 : 0
      }}>
        <span style={{
          width: 8, height: 8, background: 'var(--cth-mint)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
          animation: 'cth-pulse 1200ms steps(2, end) infinite'
        }} />
        live · pty {ptyId}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            onClick={() => setPtyTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={ptyTheme === 'dark' ? 'Switch to light terminal' : 'Switch to dark terminal'}
            style={{ ...zoomBtnStyle, width: 22, marginRight: 4 }}
          >{ptyTheme === 'dark' ? '☀' : '☾'}</button>
          <button
            onClick={() => zoom(-1)}
            disabled={fontSize <= MIN_FONT_SIZE}
            title="Zoom out (Cmd -)"
            style={zoomBtnStyle}
          >−</button>
          <button
            onClick={resetZoom}
            title="Reset zoom (Cmd 0)"
            style={{ ...zoomBtnStyle, width: 'auto', padding: '0 4px', minWidth: 28 }}
          >{fontSize}px</button>
          <button
            onClick={() => zoom(1)}
            disabled={fontSize >= MAX_FONT_SIZE}
            title="Zoom in (Cmd +)"
            style={zoomBtnStyle}
          >+</button>
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen terminal'}
              style={{ ...zoomBtnStyle, width: 22, height: 22, marginLeft: 4 }}
            >
              <Icon name={fullscreen ? 'minimize' : 'expand'} />
            </button>
          )}
        </div>
      </div>
      <div ref={hostRef} style={{
        flex: 1, minHeight: 0,
        padding: embedded ? '0 8px 8px' : 0
      }} />
    </div>
  );
}
