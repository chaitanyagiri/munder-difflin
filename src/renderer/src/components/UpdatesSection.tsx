/**
 * Settings → General → "Updates".
 *
 * The toolbar already carries an update chip (UpdateBadge), but a chip that
 * stays blank when everything is fine is not somewhere you go to *ask* — and
 * "is there a new version?" is exactly the question people open Settings with.
 * This block always answers it: the version you're on, whether it's the latest,
 * and one button that names what pressing it does.
 *
 * Same status stream as the badge, same reducer, same states — only the wording
 * differs (`describeUpdateSettings` vs `describeUpdate`), so the two can never
 * disagree about what is installed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { summarizeReleaseNotes } from '@shared/releaseNotes';
import { describeUpdateSettings, manualDownloadUrl, manualInstallSteps, pendingVersion, reduceStatus, type UpdateStatus } from '@shared/updateState';
import { PixelButton } from './PixelButton';

declare const __APP_VERSION__: string;

export function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Subscribe before pulling: main may have emitted while this modal was
    // closed, and `update:current` re-serves the last known state.
    const off = window.cth.onUpdateStatus?.((next) => setStatus((prev) => reduceStatus(prev, next)));
    void window.cth.updateCurrent?.().then((cur) => {
      if (cur) setStatus((prev) => reduceStatus(prev, cur));
    }).catch(() => { /* older main without the handler — the push channel still works */ });
    return off;
  }, []);

  const view = describeUpdateSettings(status, __APP_VERSION__);
  /** The manual path is always on offer next to the automatic one. */
  const pending = pendingVersion(status, __APP_VERSION__);
  const [manualStarted, setManualStarted] = useState<string | null>(null);
  const steps = manualInstallSteps(window.cth.platform ?? 'darwin');
  const downloadManually = () => {
    if (!status) return;
    const url = manualDownloadUrl(status, window.cth.platform, window.cth.arch);
    if (!url) return;
    void window.cth.updateOpenRelease(url);
    setManualStarted(pending);
  };

  // Same digest the update toast renders (src/shared/releaseNotes.ts), for the
  // same reason: the release body is already in hand, and "what would I get?"
  // is the second question anyone asks after "is there a new version?". Only
  // the states that carry notes have any — the rest render nothing extra.
  const notes = useMemo(
    () => summarizeReleaseNotes(status && 'notes' in status ? status.notes : undefined),
    [status]
  );

  const onClick = useCallback(async () => {
    if (view.action === 'none' || busy) return;
    setBusy(true);
    try {
      if (view.action === 'restart') await window.cth.updateRestartAndInstall();
      else if (view.action === 'download') await window.cth.updateDownload();
      else if (view.action === 'check') await window.cth.updateCheckNow();
      else if (view.action === 'open-release') {
        await window.cth.updateOpenRelease(status?.state === 'available-manual' ? status.url : undefined);
      }
    } catch { /* the emitted status carries the failure — nothing to do here */ }
    setBusy(false);
  }, [view.action, busy, status]);

  return (
    <div>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        Updates
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)',
            // Only an actionable state earns emphasis; "you're up to date" is
            // information, not a call to action.
            fontWeight: view.tone === 'ready' ? 600 : 400
          }}>
            {view.headline}
          </span>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            {view.detail}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
          {pending && (
            <PixelButton
              variant="secondary"
              size="sm"
              onClick={downloadManually}
              style={{ whiteSpace: 'nowrap' }}
              title={`Download the v${pending} installer and replace the app yourself`}
            >
              download manually
            </PixelButton>
          )}
          {view.button && (
            <PixelButton
            variant={view.tone === 'ready' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => { void onClick(); }}
            disabled={busy || view.busy}
            // The label is a phrase ("Check for updates", "Restart to update"),
            // and this row is a flex line whose left column carries two lines of
            // prose. Without these the button is the flexible item: it gets
            // squeezed, the label wraps to two lines, and because the button's
            // height comes from its size variant the second line prints straight
            // through the bottom border. Refuse to shrink and refuse to wrap —
            // the prose column already has minWidth: 0, so it yields instead.
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {view.button}
            </PixelButton>
          )}
        </div>
      </div>
      {manualStarted && (
        <div style={{
          marginTop: 10, padding: '10px 12px', fontSize: 12, lineHeight: 1.5,
          color: 'var(--cth-ink-900)', background: 'var(--cth-paper-100)',
          border: '2px solid var(--cth-ink-900)'
        }}>
          <b>v{manualStarted} is downloading in your browser.</b> When it lands, quit this app, install
          the new version over the current one, open it and pick the same project. On {steps.os}:
          <ol style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--cth-ink-700)' }}>
            {steps.steps.map((t) => <li key={t}>{t}</li>)}
          </ol>
        </div>
      )}
      {notes.length > 0 && (
        <ul style={{
          listStyle: 'none', margin: '8px 0 0', padding: 0,
          display: 'flex', flexDirection: 'column', gap: 4
        }}>
          {notes.map((line, i) => (
            <li key={i} style={{
              display: 'flex', gap: 6,
              fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)'
            }}>
              <span aria-hidden style={{ color: 'var(--cth-ink-300)' }}>•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
