/**
 * Toolbar version + update control — top-left, right next to the logo.
 *
 * Always shows the running version. When main's updater reports anything
 * interesting it grows a chip that IS the button: "v0.3.7 ready to install"
 * (click → download), "downloading 42%", "restart to update to v0.3.7"
 * (click → quitAndInstall). With nothing pending, clicking the version itself
 * runs a manual check — the old build only ever checked 30s after boot and then
 * every 6h, so there was no way to ask.
 *
 * All of the "what does this state say and do" logic lives in
 * src/shared/updateState.ts so it can be unit-tested without Electron; this file
 * is wiring and pixels.
 */
import { useCallback, useEffect, useState } from 'react';
import { describeUpdate, manualDownloadUrl, manualInstallSteps, pendingVersion, reduceStatus, type UpdateStatus } from '@shared/updateState';
import { PixelButton } from './PixelButton';

declare const __APP_VERSION__: string;

export function UpdateBadge() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  /** The version whose download was just started, for the "now replace the
   *  app" notice. Local state: it is a one-off explanation, not an update state. */
  const [started, setStarted] = useState<string | null>(null);
  /** Brief, positive "checked, you are current" flash after a MANUAL check that
   *  found no update. Without it a successful check settles silently back to the
   *  grey "latest" chip, which is indistinguishable from a click that did
   *  nothing, and that is exactly why the badge read as broken. */
  const [checkedOk, setCheckedOk] = useState(false);

  useEffect(() => {
    // Subscribe first, then pull — main may have emitted before this window
    // finished loading (or before a reload), and `update:current` re-serves it.
    const off = window.cth.onUpdateStatus?.((next) => setStatus((prev) => reduceStatus(prev, next)));
    void window.cth.updateCurrent?.().then((cur) => {
      if (cur) setStatus((prev) => reduceStatus(prev, cur));
    }).catch(() => { /* older main without the handler — the push channel still works */ });
    return off;
  }, []);

  // The acknowledgement is a flash, not a mode: clear it after a few seconds so
  // the badge returns to its quiet resting state.
  useEffect(() => {
    if (!checkedOk) return;
    const t = setTimeout(() => setCheckedOk(false), 3500);
    return () => clearTimeout(t);
  }, [checkedOk]);

  const view = describeUpdate(status, __APP_VERSION__);

  const onClick = useCallback(async () => {
    if (view.action === 'none' || busy) return;
    setBusy(true);
    try {
      if (view.action === 'check') {
        const res = await window.cth.updateCheckNow();
        // A successful "already current" check has to say so out loud. runCheck
        // has settled lastStatus by the time this resolves, so read it back: a
        // no-update result flashes the acknowledgement; an available update is
        // already loud on its own (the chip changes) so it is left alone.
        if (res?.ok) {
          const cur = await window.cth.updateCurrent?.();
          const st = cur?.state;
          if (!st || st === 'not-available' || st === 'idle' || st === 'just-updated') setCheckedOk(true);
        }
      }
      else if (view.action === 'download') await window.cth.updateDownload();
      else if (view.action === 'restart') await window.cth.updateRestartAndInstall();
      else if (view.action === 'manual' && status) {
        // The click IS the download. Auto-update lives in Settings.
        const url = manualDownloadUrl(status, window.cth.platform, window.cth.arch);
        if (url) {
          await window.cth.updateOpenRelease(url);
          setStarted(pendingVersion(status, __APP_VERSION__));
        }
      }
    } catch { /* the emitted status carries the failure — nothing to do here */ }
    setBusy(false);
  }, [view.action, busy, status]);

  const interactive = view.action !== 'none' && !view.busy;
  // The chip only earns colour when it wants something: ready = mint (act on
  // me), warn = amber (something went wrong), busy/idle stay in the titlebar's
  // own greys so a quiet app looks exactly like it did before.
  const chipBg =
    view.tone === 'ready' ? 'var(--cth-mint-light, #d0f0e0)'
      : view.tone === 'warn' ? 'var(--cth-amber-light, #f6e2b3)'
        : 'transparent';

  const pending = pendingVersion(status, __APP_VERSION__);
  const steps = manualInstallSteps(window.cth.platform ?? 'darwin');
  const INK = 'var(--cth-ink-900)';

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
    <button
      className="cth-titlebar-nodrag"
      onClick={() => { void onClick(); }}
      disabled={!interactive}
      title={view.title}
      aria-label={view.label ? `${view.title}` : `Version ${__APP_VERSION__} — check for updates`}
      aria-busy={view.busy || busy}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: view.label && view.tone !== 'idle' ? '2px 8px' : '2px 4px',
        margin: 0,
        background: chipBg,
        border: 'none',
        borderRadius: 2,
        // 'latest' is a quiet word after the version, not a chip asking for a click.
        boxShadow: view.label && view.tone !== 'idle' ? 'inset 0 0 0 1px var(--cth-ink-300)' : 'none',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 13,
        lineHeight: '18px',
        color: view.tone === 'idle' ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
        cursor: interactive ? 'pointer' : 'default'
      }}
    >
      <span>v{__APP_VERSION__}</span>
      {view.label && (
        <>
          <span aria-hidden style={{ color: 'var(--cth-ink-500)' }}>·</span>
          <span style={{ fontWeight: view.tone === 'idle' ? 400 : 600 }}>{view.label}</span>
        </>
      )}
    </button>

    {/* Hover card: what the click does and what to do with the file, for this OS. */}
    {view.action === 'manual' && hover && !started && (
      <div
        role="tooltip"
        className="cth-titlebar-nodrag"
        style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 400,
          width: 340, padding: '10px 12px',
          background: 'var(--cth-paper-100)', color: INK,
          border: `2px solid ${INK}`, boxShadow: `4px 4px 0 ${INK}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: 1.5, textAlign: 'left'
        }}
      >
        <div style={{ fontFamily: 'var(--cth-font-mono, monospace)', fontWeight: 700, fontSize: 12.5 }}>
          Click to download v{pending}
        </div>
        <div style={{ marginTop: 4, color: 'var(--cth-ink-700)' }}>
          Download the latest version and replace the app you have. Prefer the app to update itself? Settings &rarr; Updates.
        </div>
        <div style={{
          marginTop: 8, fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 9,
          letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--cth-ink-500)'
        }}>On {steps.os}</div>
        <ol style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--cth-ink-700)' }}>
          {steps.steps.map((t) => <li key={t}>{t}</li>)}
        </ol>
      </div>
    )}

    {/* After the click: the download is in the browser, here is what to do next. */}
    {started && (
      <div
        role="dialog"
        aria-label="Install the update"
        className="cth-titlebar-nodrag"
        style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 400,
          width: 380, padding: '12px 14px',
          background: 'var(--cth-paper-100)', color: INK,
          border: `2px solid ${INK}`, boxShadow: `4px 4px 0 ${INK}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 12.5, lineHeight: 1.5, textAlign: 'left'
        }}
      >
        <div style={{ fontFamily: 'var(--cth-font-mono, monospace)', fontWeight: 700, fontSize: 13 }}>
          v{started} is downloading in your browser.
        </div>
        <div style={{ marginTop: 6, color: 'var(--cth-ink-700)' }}>
          When it lands, quit this app and install the new version over the current one. Open it and
          pick the same project. Your agents, memory and settings stay where they are.
        </div>
        <ol style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--cth-ink-700)' }}>
          {steps.steps.map((t) => <li key={t}>{t}</li>)}
        </ol>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <PixelButton variant="ghost" size="sm" onClick={() => setStarted(null)}>got it</PixelButton>
        </div>
      </div>
    )}
    {/* A successful "you are already current" check must be visible, or it is
        indistinguishable from a dead click. Shows only for the manual-check
        no-update result, and auto-dismisses. */}
    {checkedOk && !started && (
      <div
        role="status"
        aria-live="polite"
        className="cth-titlebar-nodrag"
        style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 400,
          width: 300, padding: '10px 12px',
          background: 'var(--cth-paper-100)', color: INK,
          border: `2px solid ${INK}`, boxShadow: `4px 4px 0 ${INK}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 12.5, lineHeight: 1.5, textAlign: 'left'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--cth-font-mono, monospace)', fontWeight: 700, fontSize: 13 }}>
          <span aria-hidden style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 18, height: 18, borderRadius: 999,
            background: 'var(--cth-mint-light, #d0f0e0)', color: 'var(--cth-ink-900)', fontSize: 12
          }}>&#10003;</span>
          You are on the latest version.
        </div>
        <div style={{ marginTop: 4, color: 'var(--cth-ink-700)' }}>
          v{__APP_VERSION__} is the newest release. Checked just now.
        </div>
      </div>
    )}
    </span>
  );
}
