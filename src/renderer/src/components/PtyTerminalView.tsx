import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icon';
import { acquireTerminal, attachTerminal, detachTerminal, reflowTerminal } from './terminalPool';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  getTerminalFontSize,
  setTerminalFontSize,
  useTerminalFontSize
} from './terminalFontSize';
import { useAppTheme } from '@/design/theme';

// Zoom lives in ./terminalFontSize so anything outside the terminal (the message
// composer) can scale with it too; these aliases keep the call sites below short.
const DEFAULT_FONT_SIZE = DEFAULT_TERMINAL_FONT_SIZE;
const MIN_FONT_SIZE = MIN_TERMINAL_FONT_SIZE;
const MAX_FONT_SIZE = MAX_TERMINAL_FONT_SIZE;

// v0.3.4: the terminal follows the APP-WIDE theme (design/theme.ts, toggled in
// the title bar) instead of keeping its own light/dark switch — one theme for
// chrome, terminal, and (via config.terminalTheme) each agent's TUI palette.
type PtyTheme = 'light' | 'dark';

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
// A single ANSI slot has to serve both roles — coloured *foreground* on cream and
// a coloured *background* under the dark default ink — which no fixed luminance
// can satisfy at once. The terminal's `minimumContrastRatio` (see terminalPool.ts)
// dynamically adjusts the per-cell foreground to keep both roles legible; these
// values are tuned so the colours stay recognisable and read well natively. The
// green/yellow are kept deep enough to read as text on cream (the brighter
// variants are the lighter shades, per terminal convention).
const lightTheme = {
  background: '#FCFAF0',
  foreground: '#1A1320',
  cursor: '#D96A62',
  cursorAccent: '#FCFAF0',
  selectionBackground: '#FFEC99',
  selectionForeground: '#1A1320',
  black:        '#1A1320',
  red:          '#D1453B',
  green:        '#20904B',    // deep green → readable as text on cream
  yellow:       '#9C6B00',    // deep amber → readable as text on cream
  blue:         '#2B6CB0',
  magenta:      '#8A5CF0',
  cyan:         '#1F9C94',
  white:        '#3A2F44',   // default "white" text → dark, so it's visible
  brightBlack:  '#6B5878',
  brightRed:    '#E0584E',
  brightGreen:  '#2E9E54',
  brightYellow: '#B8860B',
  brightBlue:   '#3B7DC4',
  brightMagenta:'#9B72F2',
  brightCyan:   '#2BA89F',
  brightWhite:  '#1A1320'
};

// Dark theme — mirrors the app's dark surface ramp (tokens.css
// data-cth-theme='dark'). xterm takes literal colours and cannot read CSS
// custom properties, so these values are RE-STATED rather than referenced, and
// drift the moment the tokens move: this set was still on the pre-readability
// ramp (background #1D1C21, the old paper-100) after tokens.css dropped to
// a softer ground, which would have left every terminal sitting a visible step
// apart from the panel holding it. Muted-professional ANSI: recognizable hues, no
// fluorescing on the dark ground; brights are one legible step up, not pastels.
const darkTheme = {
  background: '#1A1A1F',        // = --cth-paper-100
  foreground: '#DEDBD6',        // = --cth-ink-900
  cursor: '#E08C82',
  cursorAccent: '#1A1A1F',
  selectionBackground: '#37363F',
  selectionForeground: '#DEDBD6',
  black:        '#222229',
  red:          '#E08C82',
  green:        '#74C096',
  yellow:       '#CFAA57',
  blue:         '#6FB3C4',
  magenta:      '#A896E3',
  cyan:         '#6FB3C4',
  white:        '#DEDBD6',
  brightBlack:  '#96919F',
  brightRed:    '#EBA39C',
  brightGreen:  '#96CDA9',
  brightYellow: '#E5C87E',
  brightBlue:   '#8FC5D1',
  brightMagenta:'#C0B3EB',
  brightCyan:   '#8FC5D1',
  brightWhite:  '#EFEDE9'
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
  const fontSize = useTerminalFontSize();
  const fontSizeRef = useRef(fontSize);
  const ptyTheme: PtyTheme = useAppTheme();
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
    // Only the terminal's true first open needs the settle cascade below (the
    // delayed refits + web-font re-measure). Latched before scheduling so a
    // reattach can never replay it — see TerminalEntry.settled.
    const isFirstAttach = !entry.settled;
    entry.settled = true;
    entry.onData = (chunk) => onStreamDataRef.current?.(chunk);
    entry.onPrompt = (text) => onUserPromptRef.current?.(text);

    // Snap to bottom immediately on re-attach before fit settles
    try { entry.term.scrollToBottom(); } catch { /* not yet open */ }

    // `scrollToEnd` is true only for the initial attach (switching agents /
    // toggling fullscreen) so we land on the most recent output. Re-parenting
    // the pooled terminal resets its viewport to the top otherwise. Later
    // resize-driven fits pass false so they don't yank a user who has scrolled
    // up to read history back down to the bottom.
    // Tracks the first fit that actually ran against a real (non-zero) host, so
    // the ResizeObserver below can snap to the bottom on the FIRST effective fit
    // even when the initial rAF/timeout fits no-op (terminal mounted under an
    // inactive tab whose host has no size yet).
    let initialFitDone = false;
    const tryFit = (scrollToEnd = false) => {
      // Never fit while the host has no real size. Fitting a 0×0 host makes
      // xterm propose a tiny grid and resize the pty to it, so the boot banner
      // renders oversized/clipped and only "fixes" on a later manual resize.
      // Wait for real dimensions — the ResizeObserver drives the first fit.
      if (!container.clientWidth || !container.clientHeight) return;
      try {
        const before = { cols: entry.term.cols, rows: entry.term.rows };
        entry.fit.fit();
        // Only poke the pty when the grid ACTUALLY changed: every resize makes
        // the Claude TUI repaint its whole screen, and each repaint pushes the
        // previous frame into scrollback — the attach-time refit cascade (rAF,
        // 60ms, 240ms, font-load) used to stack the boot banner three times
        // before the user ever typed anything.
        if (entry.term.cols !== before.cols || entry.term.rows !== before.rows) {
          window.cth.resizePty(ptyId, entry.term.cols, entry.term.rows);
        }
        entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
        initialFitDone = true;
      } catch { /* host may not be sized yet */ }
      if (scrollToEnd) {
        try {
          // Re-parenting the pooled terminal resets the DOM viewport's
          // scrollTop to 0 while xterm's internal scroll state stays at the
          // bottom — the screen still LOOKS right, but the user's first wheel
          // reads the stale scrollTop≈0 and yanks the view to the top of
          // history. A bare scrollToBottom() can't repair this (the buffer is
          // already at the bottom internally → no state change → no viewport
          // re-sync). Writing the DOM scrollTop from out here is no good
          // either: it races with xterm's ignore-next-scroll-event flag
          // (scroll events coalesce), which can leave the scrollbar pinned at
          // max while the buffer sits ABOVE the bottom — then wheeling down is
          // dead (scrollTop can't exceed max → no event → no re-sync).
          // Instead force a REAL position change through xterm's own state
          // machine: one line up, then back to the bottom. Its Viewport then
          // re-syncs the DOM scrollTop itself, atomically with its flag.
          entry.term.scrollLines(-1);
          entry.term.scrollToBottom();
        } catch { /* noop */ }
      }
    };
    // Fit once layout has settled and again once the web font has loaded —
    // these are the initial-attach fits, so snap to the bottom. They no-op
    // until the host has a real size, so a terminal mounted under an inactive
    // tab simply waits for the ResizeObserver below to fire the first fit.
    requestAnimationFrame(() => requestAnimationFrame(() => tryFit(true)));
    const retries: ReturnType<typeof setTimeout>[] = [];
    if (isFirstAttach) {
      // These retries and the font re-measure below exist to wait out a web
      // font that may still be loading on this terminal's FIRST open. A
      // reattach already has confirmed-correct cell metrics, so redoing this
      // is pure risk: it can race a keystroke or a user's scroll gesture that
      // lands mid-cascade (see TerminalEntry.settled).
      retries.push(setTimeout(() => tryFit(true), 60), setTimeout(() => tryFit(true), 240));
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        document.fonts.ready
          .then(() => {
            // xterm measures the character cell ONCE at open(); if VT323 hadn't
            // loaded yet, that cached cell is the fallback font's size, so every
            // fit() proposes the wrong column count and the WebGL glyph atlas is
            // rastered at the wrong metrics — the banner renders oversized until a
            // manual resize. Re-applying the font + clearing the texture atlas
            // forces a re-measure / re-raster with the real font, then we refit.
            try {
              const fam = entry.term.options.fontFamily;
              entry.term.options.fontFamily = fam;
              entry.term.options.fontSize = fontSizeRef.current;
              entry.term.clearTextureAtlas?.();
            } catch { /* noop */ }
            tryFit(true);
          })
          .catch(() => { /* noop */ });
      }
    }

    // The ResizeObserver is the authoritative trigger: it fires when the host
    // first gets a real size (e.g. its tab becomes visible) and on every later
    // resize. Snap to the bottom on the first effective fit, then never again
    // (so a user who scrolled up to read history isn't yanked back down).
    const ro = new ResizeObserver(() => tryFit(!initialFitDone));
    ro.observe(container);
    const onWinResize = () => tryFit(false);
    window.addEventListener('resize', onWinResize);

    // Self-heal after a display wake. Closing the laptop lid sleeps the GPU,
    // which loses the WebGL context and leaves xterm's cached cell-height (and
    // the viewport scroll-area derived from it) stale — the full buffer is still
    // there but only part is scrollable until a re-measure (the user otherwise
    // has to zoom to force a fit). The ResizeObserver/resize listeners DON'T fire
    // on lid-open because the window's pixel size is unchanged, so we re-fit
    // explicitly when the page becomes visible / regains focus. reflowTerminal
    // re-measures + refits WITHOUT scrolling, so a user reading history isn't
    // yanked to the bottom. rAF lets the waking layout settle first; if the host
    // is still unsized the reflow no-ops and the next focus/visibility catches it.
    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      requestAnimationFrame(() => reflowTerminal(ptyId));
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);

    return () => {
      retries.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      // Detach (but DON'T dispose) the terminal — it keeps running in the pool.
      // detachTerminal also releases the WebGL lease, so a terminal nobody is
      // looking at stops holding a GPU context that an on-screen one needs.
      entry.onData = undefined;
      entry.onPrompt = undefined;
      detachTerminal(entry, container);
    };
  }, [ptyId]);

  // Apply app-theme changes to the pooled terminal (persistence lives in
  // design/theme.ts — the title-bar toggle owns it).
  useEffect(() => {
    acquireTerminal(ptyId, THEMES[ptyTheme], fontSizeRef.current).term.options.theme = THEMES[ptyTheme];
  }, [ptyTheme, ptyId]);

  // Apply font-size (zoom) changes to the pooled terminal and re-fit cols/rows.
  useEffect(() => {
    fontSizeRef.current = fontSize;
    const entry = acquireTerminal(ptyId, THEMES[ptyThemeRef.current], fontSize);
    entry.term.options.fontSize = fontSize;
    try {
      entry.fit.fit();
      window.cth.resizePty(ptyId, entry.term.cols, entry.term.rows);
    } catch { /* host may not be sized yet */ }
  }, [fontSize, ptyId]);

  // Drag-and-drop a file (image, etc.) onto the terminal → inject its absolute
  // path into the pty, exactly like a native terminal's drag-drop. Claude Code
  // detects an image path in the prompt and attaches it. Without this, Electron
  // would treat the drop as navigation and load the file:// URL over the app.
  const onDragOver = (e: React.DragEvent) => {
    // Must preventDefault on dragover too — otherwise `drop` never fires and the
    // window navigates to the dropped file. Only claim it when files are present
    // so text/selection drags fall through to xterm's own handling.
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return; // not a file drop — let xterm handle it
    e.preventDefault();
    const paths = files
      .map((f) => window.cth.pathForFile(f))
      .filter(Boolean)
      // SECURITY: a dropped filename is attacker-controllable; inject it as an
      // INERT single shell token in the NATIVE backslash-escaped style (what macOS
      // Terminal/iTerm emit on drag-drop, and the format Claude Code recognizes to
      // attach a dropped file). (1) Strip ALL control chars first - newline/CR
      // would be delivered as Enter by writePty and AUTO-SUBMIT the line; ESC would
      // inject raw terminal escape sequences. (2) Backslash-escape the backslash
      // itself and every shell metacharacter that could act on Enter (space $ ` " '
      // ; | & < > ( ) { } [ ] * ? ! ~ #) so the path stays one literal token.
      // (String.fromCharCode keeps backslashes/control chars out of this source.)
      .map((p) => {
        const BS = String.fromCharCode(92);
        const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');
        // Backslash is FIRST in the set so escaping each ORIGINAL char exactly once
        // turns a literal backslash into a pair (never forming a new escape).
        const SPECIAL = new Set(
          (BS + ' $' + String.fromCharCode(96) + String.fromCharCode(34) + String.fromCharCode(39) + ';|&<>(){}[]*?!~#')
            .split('').map((c) => c.charCodeAt(0))
        );
        return p.replace(CTRL, '').split('')
          .map((ch) => (SPECIAL.has(ch.charCodeAt(0)) ? BS + ch : ch)).join('');
      });
    if (paths.length === 0) return;
    // Trailing space separates consecutive drops and lets the user keep typing.
    void window.cth.writePty(ptyId, paths.join(' ') + ' ');
  };

  const zoom = (delta: number) => setTerminalFontSize(getTerminalFontSize() + delta);
  const resetZoom = () => setTerminalFontSize(DEFAULT_FONT_SIZE);

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
        fontSize: 12,
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
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          animation: 'cth-pulse 1200ms steps(2, end) infinite'
        }} />
        live · pty {ptyId}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* v0.3.4: the theme + enter-fullscreen buttons moved to the TITLE BAR
              (top right) — more accessible, and the theme now darkens the whole
              app. Only the EXIT affordance stays here, in fullscreen. */}
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
          {fullscreen && onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              title="Exit focus mode (Esc)"
              style={{ ...zoomBtnStyle, width: 22, height: 22, marginLeft: 4 }}
            >
              <Icon name="minimize" />
            </button>
          )}
        </div>
      </div>
      <div ref={hostRef} onDragOver={onDragOver} onDrop={onDrop} style={{
        flex: 1, minHeight: 0,
        padding: embedded ? '0 8px 8px' : 0
      }} />
    </div>
  );
}
