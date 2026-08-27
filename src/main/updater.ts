import { app, ipcMain, shell } from 'electron';
import type { WebContents } from 'electron';
import { request as httpsRequest } from 'node:https';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './config';
import { DEFAULT_DROP_HTML } from '../shared/releaseDrop';
import { reduceStatus, clampPercent, isNewer, installerUrl, shouldShowReleaseDrop, type UpdateStatus } from '../shared/updateState';

/**
 * Auto-update from GitHub releases.
 *
 * Primary path: electron-updater against the `publish` block in
 * electron-builder.yml — the release workflow uploads latest*.yml + zip +
 * blockmaps, macOS builds are Developer ID signed + notarized + stapled, so
 * Squirrel.Mac (zip), NSIS, and AppImage all update natively. Downloads happen
 * in the background; installation is ALWAYS user-initiated ("restart to update"
 * → `update:restartAndInstall`). The app never restarts on its own.
 *
 * Fallback path (win-portable exe, or a genuine updater error): a plain
 * `releases/latest` poll — semver-compare against the running version and show a
 * notify-only state linking the release page.
 *
 * Everything is gated on the `autoUpdate` HarnessConfig flag (default ON,
 * Settings → General) and on `app.isPackaged` — dev runs never poll.
 *
 * ─── v0.3.7: why native updating never actually ran ──────────────────────────
 * electron-updater is CommonJS and exposes `autoUpdater` through a lazy
 * `Object.defineProperty` getter. Node's cjs-module-lexer cannot see through
 * that, so the ESM namespace produced by `await import('electron-updater')` has
 * NO `autoUpdater` named export — only `.default.autoUpdater`. The old code did
 * `const { autoUpdater } = await import('electron-updater')`, got `undefined`,
 * and threw `TypeError: Cannot set properties of undefined (setting
 * 'autoDownload')` on the very first line of setup. That threw into a catch that
 * silently latched notify-only mode, so from v0.3.4 through v0.3.6 EVERY
 * packaged build only ever offered "open the releases page". It never showed up
 * in dev because the whole block is behind `app.isPackaged`.
 *
 * Two rules came out of that and both are load-bearing here:
 *   1. resolve the module through `loadAutoUpdater()` below, which handles the
 *      namespace/default interop and throws a NAMED error if the export is gone;
 *   2. never swallow an updater error — every failure is surfaced to the
 *      renderer AND appended to `updater.log` in userData, and the notify-only
 *      downgrade is per-check, not a permanent latch.
 */

const REPO = 'chaitanyagiri/munder-difflin';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FALLBACK_CACHE_MS = 60 * 60 * 1000;     // 1h between releases/latest polls

export type { UpdateStatus };

let sendTo: (() => WebContents | null) | null = null;
let started = false;
let lastFallbackCheck = 0;
/** Remembered so a status survives a renderer reload and can be re-served. */
let lastStatus: UpdateStatus | null = null;
/**
 * Resolved when a restart-to-install is CALLED OFF.
 *
 * `quitAndInstall()` does not report an outcome. It asks the app to quit, and
 * the app may refuse: with agents running, the quit warning goes up and the user
 * can cancel it. The handler used to return `{ ok: true }` the instant it made
 * that request, so the renderer was told the restart succeeded while the app was
 * still sitting there. Every surface that had disabled its button waiting for a
 * process that was never going to die then had nothing to wait for, and the
 * button stayed "restarting…" with no way back.
 *
 * So the handler now waits on this instead. Exactly one of two things happens:
 * the app really quits and this never settles (the process is gone, nothing is
 * left to tell), or the user cancels and `abortPendingRestart()` settles it and
 * the handler reports the truth.
 */
let pendingRestart: ((outcome: { ok: boolean; error?: string }) => void) | null = null;

/**
 * The user backed out of the quit that a restart-to-install asked for.
 *
 * Called from the cancel path of the quit warning, which is the only place that
 * knows a requested quit was refused. Safe to call when no restart is pending —
 * an ordinary quit the user cancels is not our business.
 */
export function abortPendingRestart(): void {
  if (!pendingRestart) return;
  const resolve = pendingRestart;
  pendingRestart = null;
  logLine('quitAndInstall cancelled by the user at the quit warning');
  resolve({ ok: false, error: 'cancelled' });
}

/**
 * A restart-to-install that the native updater REFUSED (Squirrel emits "The
 * command is disabled and cannot be executed" rather than throwing) reports
 * through the autoUpdater error event, not the handler's try/catch. Without
 * this, the handler's `await` would hang forever, the button would spin, the
 * user would click again, and the repeated quitAndInstall is exactly what keeps
 * Squirrel wedged. Settling here reports the failure back so the UI shows it and
 * stops the user re-clicking. Safe when nothing is pending (an ordinary check
 * error is not our business).
 */
function failPendingRestart(error: string): void {
  if (!pendingRestart) return;
  const resolve = pendingRestart;
  pendingRestart = null;
  resolve({ ok: false, error });
}

/** Append-only breadcrumb trail in userData. The whole point of this file's
 *  existence is that the last failure left no trace anywhere. */
function logLine(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log('[updater]', msg);
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'updater.log'), line);
  } catch { /* logging must never take the app down */ }
}

function emit(status: UpdateStatus): void {
  lastStatus = reduceStatus(lastStatus, status);
  try { sendTo?.()?.send('update:status', lastStatus); } catch { /* window tore down */ }
}

function autoUpdateEnabled(): boolean {
  try {
    return readConfig().autoUpdate !== false; // default ON
  } catch {
    return true;
  }
}

type AutoUpdater = import('electron-updater').AppUpdater;

let autoUpdaterPromise: Promise<AutoUpdater> | null = null;

/**
 * Resolve electron-updater's `autoUpdater` across the CJS/ESM interop seam.
 *
 * See the header note: the named export is invisible to the ESM lexer, so the
 * namespace object only carries it on `.default`. Both shapes are checked so
 * this keeps working if a future electron-updater ships real named exports, and
 * a missing export throws something we can actually read in a log.
 */
async function loadAutoUpdater(): Promise<AutoUpdater> {
  autoUpdaterPromise ??= (async () => {
    const ns = (await import('electron-updater')) as unknown as {
      autoUpdater?: AutoUpdater;
      default?: { autoUpdater?: AutoUpdater };
    };
    const found = ns.autoUpdater ?? ns.default?.autoUpdater;
    if (!found) throw new Error('electron-updater loaded but exposes no `autoUpdater` export');
    return found;
  })();
  try {
    return await autoUpdaterPromise;
  } catch (e) {
    autoUpdaterPromise = null; // let a later attempt retry rather than latch
    throw e;
  }
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

/** The one asset in a release that installs on THIS machine, by the names
 *  electron-builder.yml produces: mac-{arch}.dmg, win-x64-setup.exe,
 *  linux-x86_64.AppImage. Null when the release has no matching asset, and the
 *  caller falls back to the releases page. Download URLs live under
 *  github.com/REPO/releases/download/, so the openRelease prefix guard already
 *  admits them. */
export function pickDownloadAsset(
  assets: ReadonlyArray<{ name?: string; browser_download_url?: string }> | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  if (!Array.isArray(assets)) return null;
  const want = platform === 'darwin' ? new RegExp(`-mac-${arch}\\.dmg$`)
    : platform === 'win32' ? /-win-x64-setup\.exe$/
    : platform === 'linux' ? /-linux-x86_64\.AppImage$/
    : null;
  if (!want) return null;
  const hit = assets.find((a) => typeof a.name === 'string' && want.test(a.name) && typeof a.browser_download_url === 'string');
  return hit?.browser_download_url ?? null;
}

/** Body of the release tagged v{version}, or undefined. Never throws. */
function fetchReleaseBody(version: string, done: (notes: string | undefined) => void): void {
  try {
    const req = httpsRequest(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/tags/v${version}`,
        method: 'GET',
        headers: { 'User-Agent': 'munder-difflin-updater', Accept: 'application/vnd.github+json' },
        timeout: 10_000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 262_144) req.destroy(); });
        res.on('end', () => {
          try {
            const rel = JSON.parse(body) as { body?: string };
            done(typeof rel.body === 'string' ? rel.body : undefined);
          } catch { done(undefined); }
        });
      }
    );
    req.on('error', () => done(undefined));
    req.on('timeout', () => { req.destroy(); done(undefined); });
    req.end();
  } catch { done(undefined); }
}

/** Notify-only check against releases/latest (no download). Never throws. */
function fallbackCheck(reason: string | undefined, force = false): void {
  const now = Date.now();
  if (!force && now - lastFallbackCheck < FALLBACK_CACHE_MS) return;
  lastFallbackCheck = now;
  try {
    const req = httpsRequest(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        method: 'GET',
        headers: { 'User-Agent': 'munder-difflin-updater', Accept: 'application/vnd.github+json' },
        timeout: 10_000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 262_144) req.destroy(); });
        res.on('end', () => {
          try {
            const rel = JSON.parse(body) as { tag_name?: string; html_url?: string; body?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
            const tag = rel.tag_name ?? '';
            if (tag && isNewer(tag, app.getVersion())) {
              emit({
                state: 'available-manual',
                version: tag.replace(/^v/, ''),
                url: rel.html_url ?? `https://github.com/${REPO}/releases/latest`,
                reason,
                downloadUrl: pickDownloadAsset(rel.assets) ?? undefined,
                // Already in the response we just parsed — carrying it costs
                // nothing and lets the notify-only toast show "What's new" too.
                // NOT a new request: see TELEMETRY.md, this app never adds one.
                notes: typeof rel.body === 'string' ? rel.body : undefined
              });
            }
          } catch { /* malformed body — try again next interval */ }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* offline — try again next interval */ });
    req.end();
  } catch { /* never let the fallback take the app down */ }
}

/** electron-updater's checkForUpdates has no timeout of its own. If the feed
 *  request opens but never responds (a stalled connection, a captive portal, a
 *  half-open socket after the machine sleeps), the promise never settles, so
 *  runCheck never leaves 'checking', the badge spins forever, and nothing is
 *  logged. And electron-updater caches its in-flight check promise, so once one
 *  check hangs, every later check returns that same hung promise. A hard cap is
 *  what guarantees the check always reaches a terminal state, and it is why a
 *  wedged updater shows a definite error on every tick instead of a permanent
 *  spinner. Generous, because the feed payload (a few-hundred-byte YAML) is
 *  tiny, so anything past this is hung, not merely slow. */
const CHECK_TIMEOUT_MS = 30_000;

/** Reject after `ms` if `p` has not settled; clears the timer either way so a
 *  slow-but-successful check leaves no dangling handle. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * One check. Native first; on failure, report the real error AND degrade to the
 * notify-only poll for THIS check only — the next tick tries native again, so a
 * single blip no longer costs the session its ability to self-update.
 */
async function runCheck(): Promise<{ ok: boolean; error?: string }> {
  emit({ state: 'checking' });
  try {
    // Hard-capped so a stalled feed request cannot leave the badge on 'checking'
    // forever (see withTimeout above); a timeout falls through to the catch,
    // which logs it, shows an error state, and runs the notify-only fallback.
    const result = await withTimeout(
      loadAutoUpdater().then((autoUpdater) => autoUpdater.checkForUpdates()),
      CHECK_TIMEOUT_MS,
      'update check'
    );
    if (!result || !isNewer(result.updateInfo.version, app.getVersion())) {
      emit({ state: 'not-available' });
    }
    // `update-available` / `download-progress` / `update-downloaded` handlers
    // (wired in initAutoUpdater) carry it from here.
    return { ok: true };
  } catch (e) {
    const message = errText(e);
    logLine(`native check failed: ${message}`);
    emit({ state: 'error', message });
    fallbackCheck(message);
    return { ok: false, error: message };
  }
}

/** Explicitly start (or restart) the download. Safe to call twice. */
async function runDownload(): Promise<{ ok: boolean; error?: string }> {
  try {
    const autoUpdater = await loadAutoUpdater();
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    const message = errText(e);
    logLine(`download failed: ${message}`);
    emit({ state: 'error', message });
    fallbackCheck(message);
    return { ok: false, error: message };
  }
}

/**
 * Start the updater. Call once from app.whenReady with an accessor for the
 * primary window's webContents. Safe to call in dev (registers IPC, no polling).
 */
/** DEV ONLY — a realistic release body for `update:simulate`.
 *
 *  Structurally a copy of the REAL v0.4.4 release body, not of CHANGELOG.md, and
 *  the difference is load-bearing: summarizeReleaseNotes digests the first section
 *  that yields list items, so it must skip a title, a marketing paragraph, a rule
 *  and a `> [!IMPORTANT]` block before reaching the bullets. Fed the CHANGELOG
 *  shape instead (bold lead paragraph, then `### Fixed`) it returns ONE bullet —
 *  the lead paragraph, clipped mid-sentence. Verified against the published
 *  v0.4.4-rc.1 body: this shape yields the same 3 bullets the real toast shows. */
const SIMULATED_NOTES = `# Munder Difflin v9.9.9

**A local hive of Claude Code, Antigravity, Codex, Grok & Copilot agents that run themselves** —
messaging, routing, and remembering, coordinated by your clone, Michael, who you talk to.

---

## What's new in 9.9.9 — *simulated release*

**On Windows, agents were never told they could message each other.** They started, rendered, and
looked perfectly healthy — but a multi-line prompt handed to a CLI through \`cmd.exe\` is cut off at
its first newline.

- **Agent-to-agent messaging works on Windows.** Prompt-carrying spawns now run the CLI's real
  interpreter directly instead of routing through \`cmd.exe\`, so the whole protocol survives.
- **Setup can finish again.** Accepting the suggested \`~/HarnessAgents\` folder wrote a literal
  \`~\`, and the wizard then died on \`ENOENT: mkdir '~/HarnessAgents'\`.
- **Copying from a terminal is clean.** The Edit menu was intercepting ⌘C before the terminal saw it.
- **Agent terminals are UTF-8.** They ran with no locale at all.`;

export function initAutoUpdater(getWebContents: () => WebContents | null): void {
  sendTo = getWebContents;

  // IPC surface is registered unconditionally so the renderer can always call it.
  ipcMain.handle('update:restartAndInstall', async () => {
    // Re-entry guard: a restart is already in flight. Firing quitAndInstall a
    // second time hits a native command Squirrel has already disabled and it
    // throws "The command is disabled and cannot be executed", the recurring
    // wedge behind the six-clicks-to-install reports. Refuse the duplicate and
    // let the caller wait on the one already running instead of starting another.
    if (pendingRestart) return { ok: false, error: 'a restart is already in progress' };
    try {
      const autoUpdater = await loadAutoUpdater();
      logLine('quitAndInstall requested by the user');
      const cancelled = new Promise<{ ok: boolean; error?: string }>((resolve) => { pendingRestart = resolve; });
      autoUpdater.quitAndInstall();
      // Settles ONLY if the quit was called off (abortPendingRestart) or the
      // native updater reported it failed (failPendingRestart, from the error
      // event). If the app is really going, the process exits here and the
      // renderer's promise dies with the window.
      return await cancelled;
    } catch (e) {
      pendingRestart = null;
      const error = errText(e);
      logLine(`quitAndInstall failed: ${error}`);
      emit({ state: 'error', message: error });
      return { ok: false, error };
    }
  });
  ipcMain.handle('update:checkNow', async () => {
    if (!app.isPackaged) return { ok: false, error: 'dev build — updates are only checked in packaged apps' };
    return runCheck();
  });
  ipcMain.handle('update:download', async () => {
    if (!app.isPackaged) return { ok: false, error: 'dev build — updates are only downloaded in packaged apps' };
    return runDownload();
  });
  /** Re-serve the last known status to a freshly loaded window. */
  ipcMain.handle('update:current', () => lastStatus ?? { state: 'idle' });
  /**
   * DEV ONLY — push a synthetic status so the update toast can be seen without a
   * real release. The toast renders for exactly two states ('downloaded' and
   * 'available-manual'), and a dev build can reach NEITHER: the whole polling
   * block below is behind `app.isPackaged`, and checkNow/download refuse above.
   * So the one UI that only ever appears at release time was the one UI nobody
   * could look at while building it.
   *
   * Hard-gated on `!app.isPackaged` — in a shipped build this handler answers
   * `{ok:false}` and can never fabricate an update for a real user.
   */
  ipcMain.handle('update:simulate', (_evt, opts: unknown) => {
    if (app.isPackaged) return { ok: false, error: 'simulate is dev-only' };
    const o = (opts ?? {}) as { state?: string; version?: string; notes?: string; drop?: boolean };
    const version = typeof o.version === 'string' && o.version ? o.version : '9.9.9';
    // `drop: true` previews the centered release page built from the default
    // template; without it you get the corner digest toast. Both paths ship, so
    // both need to be previewable — defaulting to one would leave the other
    // only ever seen by users.
    const notes = typeof o.notes === 'string'
      ? o.notes
      : o.drop === true
        ? `<!-- drop -->\n${DEFAULT_DROP_HTML}\n<!-- /drop -->`
        : SIMULATED_NOTES;
    emit(o.state === 'downloaded'
      ? { state: 'downloaded', version, notes }
      : { state: 'available-manual', version, notes, url: `https://github.com/${REPO}/releases/tag/v${version}`, downloadUrl: installerUrl(version, process.platform, process.arch) });
    logLine(`SIMULATED ${o.state === 'downloaded' ? 'downloaded' : 'available-manual'} ${version} (dev only)`);
    return { ok: true };
  });
  // DEV ONLY — `MD_DROP_PREVIEW=<path to a release body .md>` (see
  // `npm run dev:drop`) feeds that file through the simulate path on boot, so a
  // drop under authoring opens centred the moment the window is up, with no
  // DevTools paste. The renderer pulls `update:current` on mount, so emitting
  // before the window exists is fine. Same hard gate as `update:simulate`.
  const previewPath = process.env.MD_DROP_PREVIEW;
  if (!app.isPackaged && previewPath) {
    try {
      const notes = readFileSync(previewPath, 'utf8');
      const m = notes.match(/what[’']?s\s+new\s+in\s+v?(\d+\.\d+\.\d+)/i) ?? notes.match(/\bv(\d+\.\d+\.\d+)\b/);
      const version = m?.[1] ?? '9.9.9';
      emit({ state: 'available-manual', version, notes, url: `https://github.com/${REPO}/releases/tag/v${version}`, downloadUrl: installerUrl(version, process.platform, process.arch) });
      logLine(`SIMULATED available-manual ${version} from MD_DROP_PREVIEW=${previewPath} (dev only)`);
    } catch (e) {
      logLine(`MD_DROP_PREVIEW unreadable: ${errText(e)}`);
    }
  }
  // First launch after the version moved: show THIS release's page. The stamp
  // is the updater's own (analytics keeps a separate one that only exists when
  // telemetry initialised). Skipped when a preview is being forced, and the
  // fetch failing just means no page, never a broken boot.
  if (!previewPath) {
    try {
      const stampFile = join(app.getPath('userData'), 'last-run-version');
      let previous: string | null = null;
      try { previous = readFileSync(stampFile, 'utf8').trim() || null; } catch { /* first run */ }
      const current = app.getVersion();
      // The stamp write stays UNCONDITIONAL on a version change (it already ran
      // even when `previous` was null), which is what arms every install that
      // boots this version even once. Its own try/catch so an unwritable
      // userData cannot skip the decision below by throwing to the outer catch.
      let stamped = false;
      if (previous !== current) {
        try {
          mkdirSync(app.getPath('userData'), { recursive: true });
          writeFileSync(stampFile, current + '\n', 'utf8');
          stamped = true;
        } catch (e) {
          logLine(`last-run-version stamp failed: ${errText(e)}`);
        }
      }
      // Gated on the stamp having LANDED, not merely been attempted: if the
      // stamp cannot be written, `previous` stays null on every future launch,
      // so firing here would reopen the drop on every single boot forever.
      // Showing it zero times on an unwritable userData is the lesser failure.
      if (stamped && shouldShowReleaseDrop(previous, current)) {
        logLine(`first run of ${current} (previous ${previous ?? 'none'}); fetching its release page`);
        fetchReleaseBody(current, (notes) => {
          emit({ state: 'just-updated', version: current, notes });
          logLine(`just-updated ${current} ${notes ? 'with' : 'without'} release notes`);
        });
      }
    } catch (e) {
      logLine(`post-update check failed: ${errText(e)}`);
    }
  }
  ipcMain.handle('update:openRelease', (_evt, url: unknown) => {
    const href = typeof url === 'string' ? url : `https://github.com/${REPO}/releases/latest`;
    // Only ever open the project's releases page — this is not a generic opener.
    if (!href.startsWith(`https://github.com/${REPO}/`)) return { ok: false };
    // An asset URL means the badge's download click, not the notes link. It is
    // the only positive trace the manual path leaves, and it has to be written
    // by the build being REPLACED, so the version that reads it is the next one
    // — analytics.ts (update_applied.via) picks it up from 0.4.6, and until then
    // this line is here purely so there is something to pick up. Nothing else
    // depends on it and openExternal has already been decided above.
    const asset = /\/releases\/download\/v([0-9][^/]*)\//.exec(href);
    if (asset) logLine(`manual download opened: ${asset[1]}`);
    void shell.openExternal(href);
    return { ok: true };
  });

  if (!app.isPackaged) return;
  if (started) return;
  started = true;

  void (async () => {
    try {
      const autoUpdater = await loadAutoUpdater();
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false; // install ONLY on explicit restart
      autoUpdater.on('update-available', (info) => {
        logLine(`update available: ${info.version}`);
        emit({ state: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined });
      });
      autoUpdater.on('download-progress', (p) => {
        const version = lastStatus && 'version' in lastStatus ? lastStatus.version : app.getVersion();
        emit({ state: 'downloading', version, percent: clampPercent(p.percent) });
      });
      autoUpdater.on('update-downloaded', (info) => {
        logLine(`update downloaded: ${info.version} — waiting for the user to restart`);
        emit({ state: 'downloaded', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined });
      });
      autoUpdater.on('error', (err) => {
        const message = errText(err);
        logLine(`native updater error: ${message}`);
        emit({ state: 'error', message });
        // A restart-to-install that failed reports here, not as a throw. Settle
        // the pending restart (no-op if none) so the handler stops awaiting and
        // the UI shows the error instead of spinning, and so the user does not
        // click again, which is the repeated quitAndInstall that wedges Squirrel.
        failPendingRestart(message);
        // Notify-only for THIS failure; the next tick still tries native.
        fallbackCheck(message);
      });
      logLine(`native updater ready (current v${app.getVersion()})`);
    } catch (e) {
      // Reaching here means the module itself is unusable — the exact class of
      // bug that hid from v0.3.4 to v0.3.6. Say so loudly, in the log and the UI.
      const message = errText(e);
      logLine(`electron-updater unavailable; notify-only mode: ${message}`);
      emit({ state: 'error', message });
    }

    const tick = (): void => { if (autoUpdateEnabled()) void runCheck(); };
    // First check shortly after boot (don't compete with spawn/startup I/O),
    // then every CHECK_INTERVAL_MS.
    setTimeout(tick, 30_000);
    setInterval(tick, CHECK_INTERVAL_MS);
  })();
}
