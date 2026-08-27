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
import { Trans, useTranslation } from 'react-i18next';
import { summarizeReleaseNotes } from '@shared/releaseNotes';
import { describeUpdateSettings, manualDownloadUrl, manualInstallSteps, pendingVersion, reduceStatus, clampPercent, type UpdateStatus } from '@shared/updateState';
import { PixelButton } from './PixelButton';

declare const __APP_VERSION__: string;

export function UpdatesSection() {
  const { t } = useTranslation();
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

  // The shared describeUpdateSettings() renders English prose (it also feeds the
  // toolbar badge and the toast, which are not i18n'd yet). For THIS block we
  // re-derive the three prose fields from the status through i18n, keeping the
  // shared function as the single source of truth for tone/action/busy.
  const v = __APP_VERSION__;
  const localized: { headline: string; detail: string; button: string | null } = (() => {
    switch (status?.state) {
      case 'checking':
        return { headline: t('updatesSection.onVersion', { v }), detail: t('updatesSection.checkingDetail'), button: null };
      case 'available':
        return {
          headline: t('updatesSection.availableHeadline', { version: status.version }),
          detail: t('updatesSection.availableDetail', { v }),
          button: t('updatesSection.downloadBtn', { version: status.version })
        };
      case 'downloading':
        return {
          headline: t('updatesSection.downloadingHeadline', { version: status.version }),
          detail: t('updatesSection.downloadingDetail', { percent: clampPercent(status.percent) }),
          button: null
        };
      case 'downloaded':
        return {
          headline: t('updatesSection.downloadedHeadline', { version: status.version }),
          detail: t('updatesSection.downloadedDetail', { v }),
          button: t('updatesSection.restartBtn')
        };
      case 'available-manual':
        return {
          headline: t('updatesSection.availableHeadline', { version: status.version }),
          detail: status.reason
            ? t('updatesSection.manualDetailReason', { reason: status.reason })
            : t('updatesSection.manualDetail'),
          button: t('updatesSection.openReleaseBtn')
        };
      case 'error':
        return {
          headline: t('updatesSection.errorHeadline'),
          detail: t('updatesSection.errorDetail', { message: status.message, v }),
          button: t('updatesSection.retryBtn')
        };
      case 'not-available':
        return {
          headline: t('updatesSection.latestHeadline', { v }),
          detail: t('updatesSection.latestDetail'),
          button: t('updatesSection.checkAgainBtn')
        };
      case 'idle':
      default:
        return {
          headline: t('updatesSection.onVersion', { v }),
          detail: t('updatesSection.idleDetail'),
          button: t('updatesSection.checkBtn')
        };
    }
  })();
  const viewText = { ...view, headline: localized.headline, detail: localized.detail, button: localized.button };

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
        {t('updatesSection.title')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)',
            // Only an actionable state earns emphasis; "you're up to date" is
            // information, not a call to action.
            fontWeight: viewText.tone === 'ready' ? 600 : 400
          }}>
            {viewText.headline}
          </span>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            {viewText.detail}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
          {pending && (
            <PixelButton
              variant="secondary"
              size="sm"
              onClick={downloadManually}
              style={{ whiteSpace: 'nowrap' }}
              title={t('updatesSection.downloadManuallyTitle', { version: pending })}
            >
              {t('updatesSection.downloadManually')}
            </PixelButton>
          )}
          {viewText.button && (
            <PixelButton
              variant={viewText.tone === 'ready' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => { void onClick(); }}
              disabled={busy || viewText.busy}
              // The label is a phrase ("Check for updates", "Restart to update"),
              // and this row is a flex line whose left column carries two lines of
              // prose. Without these the button is the flexible item: it gets
              // squeezed, the label wraps to two lines, and because the button's
              // height comes from its size variant the second line prints straight
              // through the bottom border. Refuse to shrink and refuse to wrap —
              // the prose column already has minWidth: 0, so it yields instead.
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {viewText.button}
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
          <Trans i18nKey="updatesSection.manualDownloadingTitle" values={{ version: manualStarted }} components={{ b: <b /> }}>
            v{manualStarted} is downloading in your browser.
          </Trans>{' '}
          <Trans i18nKey="updatesSection.manualDownloadingBody" values={{ os: steps.os }}>
            When it lands, quit this app, install the new version over the current one, open it and
            pick the same project. On {steps.os}:
          </Trans>
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
