import { app, dialog, type BrowserWindow, type WebContents } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Renderer liveness: detection, diagnosis and bounded recovery.
 *
 * Observed live on 2026-09-07 (v0.4.6, packaged AppImage, Hyprland/Wayland):
 * the app ran a five-agent hive for ~25 minutes, then the compositor put up
 * "An application Munder Difflin is not responding — Terminate / Wait". At that
 * point `/proc` held the browser process, both zygotes, the GPU process and the
 * network service — and NO renderer at all. The window stayed mapped, showing
 * the office background of its last painted frame; the main process was still
 * fine, still routing (hive `log.jsonl` was being appended seconds later).
 *
 * The renderer had died and NOTHING in the app noticed: `createWindow` bound no
 * `render-process-gone`, no `unresponsive`, and `app` bound no
 * `child-process-gone`. A dead renderer therefore left a permanently frozen
 * window with no reload path, and the only exit the user is offered is the
 * compositor's "Terminate" — which kills the browser process and takes the
 * whole running hive (every agent PTY is its child) down with it.
 *
 * Nothing was recoverable after the fact either: a packaged launch from a
 * .desktop file has stdout/stderr on /dev/null, so every `console.error` is
 * discarded, and no crashpad handler was attached, so the death left no dump.
 *
 * This module closes that hole:
 *   - it records renderer/child-process deaths and hangs to a file under
 *     userData, the one place a packaged build can actually be read back from;
 *   - it reloads a crashed renderer automatically, under a strict budget, so a
 *     crash loop can never turn into a reload loop;
 *   - once the budget is spent, or while the renderer is merely wedged, it
 *     offers recovery through a native dialog — a route that does not require
 *     killing the process tree the hive lives in.
 */

/** Reasons that mean the renderer died on us and a reload is the right answer.
 *
 *  `killed` belongs here, which is not obvious: Chromium reports it for ANY
 *  signal death, so it covers the kernel OOM killer and an external `kill` —
 *  the very cases a user most needs recovered — not just a deliberate teardown.
 *  Verified against Electron on 2026-09-07: SIGKILL to the render process
 *  reports `{ reason: 'killed', exitCode: 9 }`. Deliberate teardown is already
 *  excluded by `clean-exit` and by the isDestroyed() guard on the window, so
 *  treating `killed` as a crash cannot resurrect a window we meant to close. */
const RECOVERABLE_REASONS = new Set([
  'crashed',
  'oom',
  'killed',
  'abnormal-exit',
  'launch-failed',
  'integrity-failure'
]);

/** Whether a `render-process-gone` reason should be recovered from. Exported so
 *  the classification is testable on its own — it is the single decision that
 *  separates "the window comes back" from "the window is frozen forever". */
export function shouldRecoverFrom(reason: string): boolean {
  return RECOVERABLE_REASONS.has(reason);
}

/** At most this many automatic reloads inside {@link BUDGET_WINDOW_MS}. Past
 *  that we stop and ask, because a renderer that dies immediately on every
 *  load would otherwise spin forever, burning CPU next to a live hive. */
export const BUDGET_LIMIT = 3;
export const BUDGET_WINDOW_MS = 10 * 60 * 1000;

/**
 * Rolling-window allowance for automatic reloads.
 *
 * Pure and clock-injectable so the budget can be tested without Electron: the
 * interesting property (a crash loop is bounded, but a machine left running for
 * hours still recovers from an occasional crash) is a property of this class,
 * not of the event wiring.
 */
export class ReloadBudget {
  private readonly stamps: number[] = [];

  constructor(
    private readonly limit: number = BUDGET_LIMIT,
    private readonly windowMs: number = BUDGET_WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether one more automatic reload is allowed right now. Read-only. */
  allows(): boolean {
    return this.live().length < this.limit;
  }

  /** Consume one reload. Returns false (and consumes nothing) when spent. */
  take(): boolean {
    const live = this.live();
    if (live.length >= this.limit) return false;
    live.push(this.now());
    this.replace(live);
    return true;
  }

  /** Reloads used inside the current window — for the diagnostic record. */
  used(): number {
    return this.live().length;
  }

  private live(): number[] {
    const cutoff = this.now() - this.windowMs;
    return this.stamps.filter((t) => t > cutoff);
  }

  private replace(next: number[]): void {
    this.stamps.length = 0;
    this.stamps.push(...next);
  }
}

/**
 * Windows whose renderer we have SEEN die and not come back.
 *
 * Electron keeps the WebContents object alive after its render process dies, so
 * `isDestroyed()` stays false. `isCrashed()` is meant to report it, but relying
 * on it alone was not enough in practice: measured against Electron 32 on
 * 2026-09-07, a window whose renderer had been killed still passed an
 * isCrashed()-only guard, and the app stayed unquittable. Our own observation of
 * `render-process-gone` is authoritative, so record it and consult that first.
 *
 * A WeakSet, so a closed window is not kept alive by the bookkeeping.
 */
const deadRenderers = new WeakSet<BrowserWindow>();

/** Called from the liveness wiring as the renderer dies and comes back. */
export function markRendererDead(win: BrowserWindow): void { deadRenderers.add(win); }
export function markRendererAlive(win: BrowserWindow): void { deadRenderers.delete(win); }

/**
 * Whether a window still has a renderer that could draw a modal and answer.
 *
 * Both quit paths cancel the quit and ask the renderer to confirm; asking a dead
 * one cancels the quit forever, since nothing ever answers and nothing sets the
 * allow-quit latch. Observed live on 2026-09-07: after the renderer died the
 * frozen window could not be closed by any means short of SIGKILL, SIGTERM
 * included.
 */
export function canPromptRenderer(win: BrowserWindow | null): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false;
  if (deadRenderers.has(win)) return false;
  const wc = win.webContents;
  return !wc.isDestroyed() && !wc.isCrashed();
}

/** The same decision, reported for the log — a quit that does not happen is
 *  otherwise completely silent, which is what made this hard to see. */
export function logQuitPromptDecision(
  win: BrowserWindow | null,
  where: string
): win is BrowserWindow {
  const ok = canPromptRenderer(win);
  logHealthEvent('quit-prompt', {
    where,
    willPrompt: ok,
    hasWindow: !!win,
    marked: !!win && !win.isDestroyed() && deadRenderers.has(win),
    crashed: !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents.isCrashed()
  });
  return ok;
}

/** Where the diagnostics land. Under userData because that is the only
 *  directory a packaged build reliably owns AND the user can be pointed at. */
export function healthLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'renderer-health.log');
}

/** Append one line of diagnostics. Best-effort in every sense: this runs on
 *  paths that are already degraded, so it must never throw and never block on
 *  anything that could itself be wedged. */
export function logHealthEvent(event: string, detail: Record<string, unknown> = {}): void {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
  // Still echo to the console: a `npm run dev` session has a real stdout, and
  // that is where a developer looks first.
  console.error(`[renderer-health] ${line.trimEnd()}`);
  try {
    const file = healthLogPath();
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, line);
  } catch { /* diagnostics must never be the thing that breaks */ }
}

/** How long a window may stay unresponsive before we stop assuming it is a
 *  passing hitch and offer the user a way out. Chromium fires 'unresponsive'
 *  well before a compositor does, so this is deliberately patient. */
const HANG_PROMPT_AFTER_MS = 20_000;

interface WindowHealthOptions {
  /** Label for the record — the primary window and floors are worth telling
   *  apart when reading the log back. */
  label: string;
  /** Re-attached after a reload by the caller that owns the routing tables. */
  onReloaded?: (wc: WebContents) => void;
}

/**
 * Wire liveness handling onto one window. Idempotent per window: call it once,
 * from createWindow, right after the BrowserWindow exists.
 */
export function installWindowHealth(win: BrowserWindow, opts: WindowHealthOptions): void {
  const { label } = opts;
  const budget = new ReloadBudget();
  let hangTimer: NodeJS.Timeout | null = null;
  let hangPromptOpen = false;

  const clearHangTimer = (): void => {
    if (hangTimer) { clearTimeout(hangTimer); hangTimer = null; }
  };

  const reload = (why: string): void => {
    if (win.isDestroyed()) return;
    logHealthEvent('reload', { label, why, used: budget.used() });
    try {
      win.webContents.reload();
      opts.onReloaded?.(win.webContents);
    } catch (e) {
      logHealthEvent('reload-failed', { label, why, error: String(e) });
    }
  };

  // A renderer that is gone can no longer be asked anything — recover it, or
  // record precisely why we chose not to.
  win.webContents.on('render-process-gone', (_e, details) => {
    clearHangTimer();
    markRendererDead(win);
    const { reason, exitCode } = details;
    logHealthEvent('render-process-gone', { label, reason, exitCode });

    if (!shouldRecoverFrom(reason)) return;             // deliberate teardown
    if (win.isDestroyed()) return;

    if (budget.take()) { reload(`render-process-gone:${reason}`); return; }

    // Budget spent: the renderer is dying faster than it can load. Stop the
    // loop and hand the decision over, WITHOUT taking the hive down.
    logHealthEvent('reload-budget-exhausted', { label, reason, exitCode });
    void dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['Reload window', 'Leave it'],
      defaultId: 0,
      cancelId: 1,
      message: 'The Munder Difflin window keeps crashing.',
      detail:
        `The interface crashed ${BUDGET_LIMIT} times in a row (${reason}). Your agents are ` +
        'still running — this window is the only thing affected.\n\n' +
        `Diagnostics: ${healthLogPath()}`
    }).then(({ response }) => { if (response === 0) reload('user:after-budget'); });
  });

  // A wedged renderer is still alive, so give it room to come back on its own;
  // only a hang long enough for the compositor to flag it gets a prompt.
  win.on('unresponsive', () => {
    logHealthEvent('unresponsive', { label });
    clearHangTimer();
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (win.isDestroyed() || hangPromptOpen) return;
      hangPromptOpen = true;
      logHealthEvent('unresponsive-prompt', { label, afterMs: HANG_PROMPT_AFTER_MS });
      void dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Reload window', 'Keep waiting'],
        defaultId: 1,
        cancelId: 1,
        message: 'The Munder Difflin window has stopped responding.',
        detail:
          'Your agents keep running either way — reloading only rebuilds the ' +
          'interface. Closing the window from the desktop instead would stop ' +
          'every running agent.\n\n' +
          `Diagnostics: ${healthLogPath()}`
      }).then(({ response }) => {
        hangPromptOpen = false;
        if (response === 0) reload('user:unresponsive');
      }).catch(() => { hangPromptOpen = false; });
    }, HANG_PROMPT_AFTER_MS);
  });

  // A renderer that finished loading is alive again — whether it was reloaded
  // by us, by the user, or by a navigation.
  win.webContents.on('did-finish-load', () => { markRendererAlive(win); });
  win.webContents.on('did-start-loading', () => { markRendererAlive(win); });

  win.on('responsive', () => {
    clearHangTimer();
    logHealthEvent('responsive', { label });
  });

  win.on('closed', clearHangTimer);
}

/**
 * Record deaths of the processes a window depends on but does not own — the GPU
 * process and the utility services. These do not freeze the UI by themselves
 * (Chromium respawns them), but when the renderer dies shortly afterwards the
 * order of events is the whole diagnosis, and it is currently unrecorded.
 */
export function installProcessHealth(): void {
  app.on('child-process-gone', (_e, details) => {
    logHealthEvent('child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name
    });
  });
}
