import { useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

export interface SettingsModalProps {
  config: HarnessConfig;
  onClose: () => void;
}

/** Clear every renderer-side persisted key so a relaunch starts truly empty. */
function clearLocalState(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('cth.')) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch { /* noop */ }
}

export function SettingsModal({ config, onClose }: SettingsModalProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // `notifications` is an optional field on the main-process config; the renderer
  // mirror type may not declare it yet, so read it defensively.
  const [notifications, setNotifications] = useState<boolean>(
    (config as HarnessConfig & { notifications?: boolean }).notifications === true
  );

  const toggleNotifications = async () => {
    const next = !notifications;
    setNotifications(next); // optimistic
    try { await window.cth.setNotifications(next); }
    catch { setNotifications(!next); /* revert on failure */ }
  };

  const reset = async () => {
    setBusy(true);
    clearLocalState();
    // Wipes hive + palace, resets config, and relaunches into onboarding.
    // The app exits, so this never resolves — no need to clear `busy`.
    await window.cth.resetAll();
  };

  const rows: Array<[string, string]> = [
    ['Home folder', config.harnessHome ?? '—'],
    ['Auto mode', config.autoMode ? 'on' : 'off'],
    ['Semantic memory', config.semanticMemory ? 'on' : 'off'],
    ['Command', config.defaultCommand]
  ];

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '92vw' }}>
        <PixelPanel variant="dialog" title={confirming ? 'RESET EVERYTHING?' : 'SETTINGS'} noPadding>
          {!confirming ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px' }}>
                    <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)' }}>{label}</span>
                    <span style={{
                      color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                      fontFamily: label === 'Home folder' || label === 'Command' ? 'var(--cth-font-mono, monospace)' : undefined
                    }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Desktop notifications toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                    Desktop notifications
                  </span>
                  <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                    Native toasts when an agent finishes or needs your input.
                  </span>
                </div>
                <PixelButton
                  variant={notifications ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={toggleNotifications}
                >
                  {notifications ? 'on' : 'off'}
                </PixelButton>
              </div>

              <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                  color: '#6E1423'
                }}>DANGER ZONE</div>
                <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
                  Reset wipes Michael's memories, the entire hive (every agent, message,
                  task, and the board), the semantic-memory palace, and all settings —
                  then takes you back to onboarding.
                </p>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={onClose}>close</PixelButton>
                <PixelButton variant="destructive" size="md" onClick={() => setConfirming(true)}>
                  reset &amp; start over
                </PixelButton>
              </div>
            </div>
          ) : (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{
                  width: 32, height: 32,
                  background: 'var(--cth-coral-light)',
                  boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0
                }}>
                  <Icon name="bell" />
                </div>
                <div style={{ flex: 1, fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                  This permanently erases all of Michael's memories and the entire hive,
                  and cannot be undone. Any running sessions will be terminated and the app
                  will relaunch into onboarding. Are you sure?
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
                  cancel
                </PixelButton>
                <PixelButton variant="destructive" size="md" onClick={reset} disabled={busy}>
                  {busy ? 'resetting…' : 'erase everything & restart'}
                </PixelButton>
              </div>
            </div>
          )}
        </PixelPanel>
      </div>
    </div>
  );
}
