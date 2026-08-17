/**
 * Auto-update toast (v0.3.4) — the visual half of the background updater.
 *
 * Main's updater (src/main/updater.ts) downloads a new release in the
 * background and pushes ONE of two states over `update:status`:
 *   - 'downloaded'        → the update is staged; offer "restart to update".
 *   - 'available-manual'  → this install can't self-update (win-portable,
 *                           updater error); offer a link to the release page.
 *
 * Mirrors CompletionToast: self-contained + self-subscribing, mounted once in
 * App.tsx, renders nothing when idle. Installation is ALWAYS user-initiated —
 * "later" just hides the toast until the next app start (or the 6h re-check).
 */
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import type { UpdateStatus } from '@shared/updateState';
import { PRIMARY_APP_NAME } from '@shared/theme';

/** The toast is the LOUD half — it only interrupts for the two states a user has
 *  to act on. Everything else (checking, available, download progress, errors)
 *  lives quietly in the toolbar badge next to the logo. */
type ToastStatus = Extract<UpdateStatus, { state: 'downloaded' | 'available-manual' }>;

function toastable(s: UpdateStatus): ToastStatus | null {
  return s.state === 'downloaded' || s.state === 'available-manual' ? s : null;
}

export function UpdateToast() {
  const [status, setStatus] = useState<ToastStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => window.cth.onUpdateStatus?.((next) => {
    const t = toastable(next);
    // A non-toastable state (a re-check, say) must not erase a toast the user
    // hasn't answered yet — only a new actionable state replaces it.
    if (t) setStatus(t);
  }), []);

  if (!status) return null;

  const restart = async () => {
    setBusy(true);
    try {
      const res = await window.cth.updateRestartAndInstall();
      if (!res.ok) setBusy(false); // stayed alive — let the user retry
    } catch { setBusy(false); }
  };

  const buttonStyle: React.CSSProperties = {
    padding: '3px 10px 1px',
    background: 'var(--cth-mint-light, #d0f0e0)',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
    fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
  };

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 400,
      maxWidth: 340,
      background: 'var(--cth-cream-50)',
      boxShadow: '0 0 0 2px var(--cth-ink-900), 4px 5px 0 0 rgba(26,19,32,0.25)',
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 8,
      fontFamily: 'var(--cth-font-ui)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="sparkle" />
        <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontWeight: 600 }}>
          {status.state === 'downloaded'
            ? `Update v${status.version} downloaded`
            : `v${status.version} is available`}
        </span>
      </div>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
        {status.state === 'downloaded'
          ? `Restart ${PRIMARY_APP_NAME} whenever you like to apply it - nothing restarts on its own.`
          : 'This install can’t update itself — grab the new build from the releases page.'}
      </span>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => setStatus(null)}
          style={{ ...buttonStyle, background: 'var(--cth-cream-100)' }}
        >
          later
        </button>
        {status.state === 'downloaded' ? (
          <button onClick={restart} disabled={busy} style={buttonStyle}>
            {busy ? 'restarting…' : 'restart to update'}
          </button>
        ) : (
          <button
            onClick={() => { void window.cth.updateOpenRelease(status.url); }}
            style={buttonStyle}
          >
            open releases
          </button>
        )}
      </div>
    </div>
  );
}
