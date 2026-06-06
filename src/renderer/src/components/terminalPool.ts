/**
 * A process-wide pool of live xterm terminals, one per ptyId.
 *
 * Why: node-pty keeps no scrollback. If we created/disposed an xterm every time
 * the user switched agents (or toggled fullscreen), the new terminal would be
 * empty and stay blank until the TUI happened to repaint — which is exactly the
 * "terminal vanishes until I drag the splitter" bug.
 *
 * Instead each pty gets ONE Terminal for the app's lifetime. It is opened into a
 * detached host <div> and subscribes to the pty stream once, so its buffer is
 * always populated. A view (the sidebar tab or the fullscreen overlay) simply
 * re-parents that host element into itself when it mounts and detaches it on
 * unmount — the rendered content moves with it, so the terminal is always
 * visible immediately, no repaint required.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

export interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  /** The element xterm renders into; views re-parent this in/out of the DOM. */
  host: HTMLDivElement;
  /** xterm is only `open()`ed once its host is first attached to the document. */
  opened: boolean;
  exited: boolean;
  /** Stream subscriptions to tear down on dispose. */
  unsub: Array<() => void>;
  /** Current consumer callbacks — set by whichever view is mounted. */
  onData?: (chunk: string) => void;
  onPrompt?: (text: string) => void;
}

const pool = new Map<string, TerminalEntry>();

type ThemeMap = Record<string, string>;

/** Get (or lazily create) the persistent terminal for a pty. Theme/font are
 *  only used at creation; an attaching view re-applies its own afterwards. */
export function acquireTerminal(ptyId: string, theme?: ThemeMap, fontSize = 14): TerminalEntry {
  const existing = pool.get(ptyId);
  if (existing) return existing;

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';

  const term = new Terminal({
    theme,
    fontFamily: 'VT323, monospace',
    fontSize,
    lineHeight: 1.0,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    // Guarantee legible text no matter what colors a running program sets.
    // When a program paints a coloured cell background (e.g. a git-diff add line
    // with a green bg, or a yellow-highlighted line) while leaving the default
    // foreground, the theme's dark ink would otherwise render dark-on-colour and
    // be unreadable on the light/cream theme. xterm auto-adjusts the foreground
    // per cell to keep at least this contrast ratio (WCAG AA = 4.5) against the
    // actual background — so it also rescues low-contrast coloured *text* on the
    // cream paper. Untouched for already-high-contrast cells (the dark theme).
    minimumContrastRatio: 4.5,
    allowProposedApi: true
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // NOTE: don't open() yet — xterm needs its host connected to the document to
  // measure correctly. We open on first attach (see attachTerminal).

  const entry: TerminalEntry = { term, fit, host, opened: false, exited: false, unsub: [] };

  // Subscribe to the pty stream ONCE for the terminal's whole lifetime, so the
  // buffer keeps filling even while this terminal isn't mounted in any view.
  entry.unsub.push(window.cth.onPtyData(ptyId, (chunk) => {
    term.write(chunk);
    entry.onData?.(chunk);
  }));
  entry.unsub.push(window.cth.onPtyExit(ptyId, ({ exitCode, signal }) => {
    entry.exited = true;
    term.writeln(`\r\n\x1b[2m─ process exited (code ${exitCode}${signal ? `, signal ${signal}` : ''}) ─\x1b[0m`);
  }));

  // ── Copy / paste ──────────────────────────────────────────────────────────
  // With an accelerated renderer there is no DOM text, so the browser's native
  // copy can't see the terminal — the selection lives inside xterm. Wire the
  // usual terminal conventions:
  //   Ctrl/Cmd+C with a selection → copy (without one it stays SIGINT)
  //   Ctrl/Cmd+Shift+C            → copy ;  Ctrl/Cmd+Shift+V → paste
  //   right-click                 → copy the selection, else paste (console style)
  const copySelection = (): boolean => {
    if (!term.hasSelection()) return false;
    void window.cth.copyToClipboard(term.getSelection());
    return true;
  };
  const pasteClipboard = (): void => {
    if (entry.exited) return;
    void window.cth.readClipboard().then((t) => { if (t) term.paste(t); });
  };
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (!(ev.ctrlKey || ev.metaKey)) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c' && (ev.shiftKey || term.hasSelection())) {
      // Copy-on-Ctrl+C only while a selection exists; clear it after, so a
      // second Ctrl+C still interrupts the agent as usual.
      if (copySelection() && !ev.shiftKey) term.clearSelection();
      ev.preventDefault();
      return false;
    }
    if (key === 'v' && ev.shiftKey) {
      pasteClipboard();
      ev.preventDefault();
      return false;
    }
    return true;
  });
  host.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (copySelection()) { term.clearSelection(); return; }
    pasteClipboard();
  });

  // Keystrokes → pty. A small line buffer surfaces the last submitted prompt.
  let lineBuf = '';
  term.onData((data) => {
    if (entry.exited) return;
    window.cth.writePty(ptyId, data);
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\r' || ch === '\n') {
        const t = lineBuf.trim();
        lineBuf = '';
        if (t.length >= 2) entry.onPrompt?.(t);
      } else if (ch === '\x7f' || ch === '\b') {
        lineBuf = lineBuf.slice(0, -1);
      } else if (ch === '\x1b') {
        break; // skip escape sequences (arrow keys, etc.)
      } else if (ch >= ' ') {
        lineBuf += ch;
      }
    }
  });

  pool.set(ptyId, entry);
  return entry;
}

/** Re-parent a pty's terminal into `container`, opening xterm on first attach. */
export function attachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  container.appendChild(entry.host);
  if (!entry.opened) {
    entry.term.open(entry.host);
    entry.opened = true;
    // Switch from the DOM renderer to WebGL (must load after open()). The DOM
    // renderer assumes a perfectly monospace font, but VT323 is missing glyphs
    // (↔, arrows, some box-drawing) and has no real bold — the browser
    // substitutes fallback glyphs with different advance widths, so box-drawing
    // tables shear apart and the cursor drifts. WebGL draws every glyph into its
    // own fixed cell, keeping the grid aligned. NOT the deprecated canvas addon
    // (its dirty-region tracking garbles scrollback). Best-effort: on init
    // failure or GPU context loss, dispose → fall back to the DOM renderer
    // rather than leave a black terminal.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        console.warn('[terminal] webgl context lost — falling back to DOM renderer');
        try { webgl.dispose(); } catch { /* noop */ }
      });
      entry.term.loadAddon(webgl);
    } catch (e) {
      console.warn('[terminal] webgl renderer unavailable, using DOM renderer:', e);
    }
  }
}

/** Tear down a pty's terminal (call when the agent/pty is gone for good). */
export function disposeTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  entry.unsub.forEach((u) => { try { u(); } catch { /* noop */ } });
  try { entry.term.dispose(); } catch { /* noop */ }
  entry.host.remove();
  pool.delete(ptyId);
}
