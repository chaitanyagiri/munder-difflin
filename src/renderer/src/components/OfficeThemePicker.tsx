import { useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { disposeTerminal } from './terminalPool';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { ThemeId } from '@/scene/office/themeRegistry';

// TV-show office themes (Phase 1 = the switch flow infra). Only `office` has a
// real map+cast today; the five shows render via the loader's office fallback
// until their content lands (Phase 2). `built: false` shows a "soon" tag and a
// fallback note on switch, but the destructive switch flow still runs so the
// whole pipeline (modal → delete cast → persist → re-seat) is exercisable now.
interface ThemeMeta { id: ThemeId; label: string; blurb: string; built: boolean; swatch: string; }
const THEME_META: ThemeMeta[] = [
  { id: 'office',        label: 'The Office',         blurb: 'Dunder Mifflin — the original floor', built: true,  swatch: '#6b5a4a' },
  { id: 'friends',       label: 'Friends',            blurb: 'Central Perk coffee house',           built: false, swatch: '#9a5a32' },
  { id: 'brooklyn99',    label: 'Brooklyn Nine-Nine', blurb: 'The 99th precinct bullpen',           built: true,  swatch: '#3a5a7a' },
  { id: 'siliconvalley', label: 'Silicon Valley',     blurb: 'The Hacker Hostel',                   built: false, swatch: '#4a6a4a' },
  { id: 'got',           label: 'Game of Thrones',    blurb: 'The Red Keep throne room',            built: false, swatch: '#6a2630' },
  { id: 'hogwarts',      label: 'Harry Potter',       blurb: 'Hogwarts great hall',                 built: false, swatch: '#39305a' },
];

/** Settings "Office Theme" section: an experimental flag toggle + a 6-card
 *  theme picker with the destructive switch flow (report §E). Self-contained so
 *  it stays out of SettingsModal's bulk. */
export function OfficeThemePicker({ config }: { config: HarnessConfig }) {
  const [enabled, setEnabled] = useState(!!config.tvShowOffices);
  const [current, setCurrent] = useState<ThemeId>((config.officeTheme as ThemeId) ?? 'office');
  const [pending, setPending] = useState<ThemeId | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const archiveAgent = useStore((s) => s.archiveAgent);
  const setOfficeTheme = useStore((s) => s.setOfficeTheme);

  const toggleFlag = async () => {
    const next = !enabled;
    setEnabled(next);
    setNote('');
    try {
      await window.cth.updateConfig({ tvShowOffices: next });
      // Flag off → the office renders regardless of the saved theme; flag on →
      // restore the persisted theme.
      setOfficeTheme(next ? current : 'office');
    } catch {
      setEnabled(!next); // revert optimistic toggle on failure
    }
  };

  const nonGodAgents = () =>
    useStore.getState().agents.filter((a) => !a.isGod && !a.isAssistant);

  const onSelect = (id: ThemeId) => {
    setNote('');
    if (busy || id === current) return;                 // no-op on the current theme
    if (nonGodAgents().length === 0) { void applyTheme(id); return; } // god-only → instant
    setPending(id);                                     // workers exist → confirm modal
  };

  const applyTheme = async (id: ThemeId) => {
    setBusy(true);
    try {
      // Tear down every non-god agent through the EXISTING lifecycle (kill PTY →
      // dispose terminal → archive). god + the prep assistant carry over; god's
      // PTY is never touched. If a PTY won't die, abort the switch (surface the
      // error, don't persist the new theme) rather than leave a half-switched floor.
      const victims = nonGodAgents();
      for (const a of victims) {
        if (a.ptyId) {
          await window.cth.killPty(a.ptyId);
          disposeTerminal(a.ptyId);
        }
      }
      for (const a of victims) archiveAgent(a.id);
      await window.cth.updateConfig({ officeTheme: id });
      setCurrent(id);
      setOfficeTheme(id); // → OfficeFloor rebuilds the scene on the new map/cast
      const meta = THEME_META.find((t) => t.id === id);
      if (meta && !meta.built) setNote(`${meta.label} isn't built yet — showing the office for now.`);
    } catch (e) {
      setNote(`Switch aborted — a terminal wouldn't close: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const pendingMeta = pending ? THEME_META.find((t) => t.id === pending) : null;

  return (
    <div>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        Office Theme
      </div>

      {/* Experimental feature flag */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
            TV-show office themes <span style={{ color: 'var(--cth-ink-500)' }}>(experimental)</span>
          </span>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            Re-skin the pixel office as a TV show. Switching starts a fresh cast.
          </span>
        </div>
        <PixelButton variant={enabled ? 'primary' : 'secondary'} size="sm" onClick={toggleFlag}>
          {enabled ? 'on' : 'off'}
        </PixelButton>
      </div>

      {/* Theme picker grid (only when the flag is on) */}
      {enabled && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {THEME_META.map((t) => {
            const isCurrent = t.id === current;
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                disabled={busy}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                  padding: 8, cursor: busy ? 'default' : 'pointer',
                  background: isCurrent ? 'var(--cth-paper-100)' : 'transparent',
                  boxShadow: isCurrent
                    ? 'inset 0 0 0 2px var(--cth-ink-900)'
                    : 'inset 0 0 0 1px var(--cth-ink-300)',
                  opacity: busy && !isCurrent ? 0.6 : 1,
                }}
              >
                <span style={{
                  width: 28, height: 28, flexShrink: 0, background: t.swatch,
                  boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, lineHeight: '16px', color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.label}
                    </span>
                    {isCurrent && (
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-mint)', textTransform: 'uppercase' }}>
                        current
                      </span>
                    )}
                    {!t.built && !isCurrent && (
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-ink-500)', textTransform: 'uppercase' }}>
                        soon
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {enabled && note && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</div>
      )}

      {pending && pendingMeta && (
        <ThemeSwitchConfirmModal
          label={pendingMeta.label}
          agents={nonGodAgents()}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void applyTheme(pending)}
        />
      )}
    </div>
  );
}

interface VictimAgent { id: string; status?: string; }

/** Destructive confirm for a theme switch with live workers (report §E copy). */
function ThemeSwitchConfirmModal({
  label, agents, busy, onCancel, onConfirm,
}: {
  label: string;
  agents: VictimAgent[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = agents.length;
  const working = agents.filter((a) => a.status && !['idle', 'success', 'error'].includes(a.status)).length;
  const godName = useStore.getState().agents.find((a) => a.isGod)?.name ?? 'the orchestrator';

  return (
    <div
      onClick={busy ? undefined : onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: '92vw' }}>
        <PixelPanel variant="dialog" title={`SWITCH OFFICE TO "${label.toUpperCase()}"?`} noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{
                width: 32, height: 32, flexShrink: 0,
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name="bell" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px',
                  color: 'var(--cth-ink-900)', marginBottom: 4,
                }}>
                  STARTS A FRESH CAST
                </div>
                <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                  Your <strong>{n} current agent{n === 1 ? '' : 's'}</strong> will be deleted — their terminals close and any in-progress work stops. Only <strong>{godName}</strong> carries over.
                  {working > 0 && (
                    <span style={{ display: 'block', marginTop: 6, color: 'var(--cth-coral)' }}>
                      ⚠ {working} agent{working === 1 ? ' is' : 's are'} still working.
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', marginTop: 8 }}>
                  This can't be undone.
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>
                cancel
              </PixelButton>
              <PixelButton variant="destructive" size="md" onClick={onConfirm} disabled={busy}>
                {busy ? 'switching…' : `delete ${n} & switch`}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
