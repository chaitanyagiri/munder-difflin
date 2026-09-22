import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { HarnessConfig } from '@/store/config';

export interface HivePickerProps {
  config: HarnessConfig;
  /** Open the CURRENT harness home in-place (no relaunch). */
  onOpenCurrent: () => void;
}

function folderName(path: string): string {
  // Split on BOTH separators: a Windows home ("D:\work\hive") contains no
  // forward slash, so a '/'-only split renders the whole path as its own name.
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * HivePicker — the launch-time workspace selector. A "hive" is a harness home
 * folder: its own agents, memory, tasks, and history. On reopen the user can open
 * the hive they were in (fast, in-place), jump to a recent one, browse to an
 * existing folder, or start a new one. A DIFFERENT home opens as its OWN app
 * instance (`--hive=<path>`): the hive is process-global, so a second project
 * needs a second process. Nothing here restarts or closes the current window.
 */
export function HivePicker({ config, onOpenCurrent }: HivePickerProps) {
  const current = config.harnessHome;
  const recents = (config.recentHives ?? []).filter((h) => h && h !== current);
  const [busy, setBusy] = useState<string | undefined>();
  /** Hive just launched in another window — confirms the spawn, since nothing
   *  visibly changes in THIS window when a second instance comes up. */
  const [opened, setOpened] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Open a hive. Same folder as the current one → just enter it, in place. A
  // DIFFERENT folder → a second app instance on that project, running beside this
  // one. This window is never torn down, so open as many projects as you like.
  const openHive = async (path: string) => {
    if (!path) return;
    if (current && path === current) { onOpenCurrent(); return; }
    setError(undefined);
    setOpened(undefined);
    setBusy(path);
    try {
      const res = await window.cth.openInNewInstance(path);
      if (res.ok) setOpened(path);
      else setError(res.error ?? 'Could not open that folder.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const browse = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) void openHive(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-200)',
      backgroundImage:
        `repeating-linear-gradient(45deg, rgba(232, 217, 160, 0.4) 0 1px, transparent 1px 8px)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
      padding: 32
    }}>
      <div style={{ width: 560, maxWidth: '94vw' }}>
        <PixelPanel variant="dialog" title="SELECT A HARNESS CONFIG" noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--cth-ink-700)' }}>
              A <strong>harness config</strong> is the folder where the app keeps everything for one
              workspace — its settings, your agents and their memory, tasks, triggers, and history.
              Each config opens in its own window, so you can keep several projects running side by
              side. Open the one you were working in, or start another.
            </p>

            {/* CURRENT — the last-used home, the one-click default. */}
            {current && (
              <div>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>
                  CURRENT
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 2px var(--cth-mint)'
                }}>
                  <Icon name="folder" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '15px' }}>
                      {folderName(current)}
                    </div>
                    <div style={{
                      fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left'
                    }}>{current}</div>
                  </div>
                  <PixelButton variant="primary" size="md" onClick={onOpenCurrent} disabled={!!busy}>
                    open
                  </PixelButton>
                </div>
              </div>
            )}

            {/* RECENTS — other homes this install has opened before. */}
            {recents.length > 0 && (
              <div>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>
                  RECENT
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                  {recents.map((h) => (
                    <button
                      key={h}
                      onClick={() => openHive(h)}
                      disabled={!!busy}
                      title={`Open ${h} in a new window`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        border: 'none', cursor: busy ? 'default' : 'pointer', textAlign: 'left',
                        opacity: busy && busy !== h ? 0.5 : 1
                      }}
                    >
                      <Icon name="folder" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                          {folderName(h)}
                        </div>
                        <div style={{
                          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left'
                        }}>{h}</div>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
                        {busy === h ? 'opening…' : 'open →'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div style={{
                padding: '6px 10px', background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}>{error}</div>
            )}

            {busy && (
              <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                Opening {folderName(busy)} in a new window…
              </div>
            )}

            {opened && (
              <div style={{
                padding: '6px 10px', background: 'var(--cth-mint-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-mint)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}>
                <strong>{folderName(opened)}</strong> opened in a new window. This one is untouched.
              </div>
            )}

            {/* OPEN / CREATE — both browse to a folder; "fresh" mode re-points at it
                (bootstrapping an empty one, or reusing existing hive data in place). */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <PixelButton variant="secondary" size="md" onClick={browse} disabled={!!busy}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="folder" /> open existing config…
                </span>
              </PixelButton>
              <PixelButton variant="secondary" size="md" onClick={browse} disabled={!!busy}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> create new config…
                </span>
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
