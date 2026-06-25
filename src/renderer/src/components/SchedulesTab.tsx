import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';

/**
 * SCHEDULES — recurring auto-dispatched missions, as their own Command-Center
 * tab (they used to be buried in the monitor tab's long scroll). Also the
 * landing spot for the calendar hanging in the boss's office.
 */

interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  quietThresholdMs?: number;
}

const INTERVAL_OPTS: { ms: number; label: string }[] = [
  { ms: 3600000, label: '1h' },
  { ms: 21600000, label: '6h' },
  { ms: 86400000, label: '24h' },
  { ms: 604800000, label: 'weekly' }
];

function relTime(ms: number): string {
  const past = ms >= 0;
  const a = Math.abs(ms);
  if (a < 45_000) return 'just now';
  const mins = Math.round(a / 60_000);
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return past ? `${unit} ago` : `in ${unit}`;
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none'
};

const selectStyle: React.CSSProperties = {
  padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
};

export function SchedulesTab() {
  const agents = useStore((s) => s.agents);
  const [missions, setMissions] = useState<ScheduledMission[]>([]);
  const [mLabel, setMLabel] = useState('');
  const [mInterval, setMInterval] = useState<string>(String(INTERVAL_OPTS[0].ms));
  const [mTo, setMTo] = useState<string>('god');
  const [mBody, setMBody] = useState('');

  useEffect(() => {
    window.cth.listMissions().then(setMissions).catch(() => { /* noop */ });
    // Refresh "last fired" when the scheduler stamps a beat/dispatch (#2.3).
    const off = window.cth.onMissionsUpdated(() => {
      window.cth.listMissions().then(setMissions).catch(() => { /* noop */ });
    });
    return off;
  }, []);

  const persistMissions = async (next: ScheduledMission[]) => {
    setMissions(next);
    await window.cth.saveMissions(next).catch(() => { /* noop */ });
  };
  const toggleMission = (id: string) =>
    persistMissions(missions.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)));
  const updateInterval = (id: string, intervalMs: number) =>
    persistMissions(missions.map((m) => (m.id === id ? { ...m, intervalMs } : m)));
  // The backend merge in missions:save keeps only the missions the renderer
  // sends back, so deletion is just "save the list without it".
  const deleteMission = (id: string) =>
    persistMissions(missions.filter((m) => m.id !== id));
  const addMission = () => {
    if (!mLabel.trim() || !mBody.trim()) return;
    const next: ScheduledMission = {
      id: `m_${Date.now().toString(36)}`,
      label: mLabel.trim(),
      intervalMs: Number(mInterval),
      to: mTo,
      body: mBody.trim(),
      enabled: true
    };
    persistMissions([...missions, next]);
    setMLabel(''); setMBody('');
  };
  const targetName = (to: string) =>
    to === 'broadcast' ? 'everyone' : to === 'god' ? 'Michael' : agents.find((a) => a.id === to)?.name ?? to;
  const intervalLabel = (ms: number) => INTERVAL_OPTS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 3600000)}h`;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {missions.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '12px 0' }}>
          No scheduled missions.
        </div>
      )}
      {missions.map((m) => {
        const hb = m.kind === 'heartbeat';
        const isCompact = m.kind === 'compact' || m.id === 'compact-maintenance';
        const fired = m.lastFiredAt ? `fired ${relTime(Date.now() - m.lastFiredAt)}` : 'not yet fired';
        const next = m.enabled && m.lastFiredAt
          ? ` · next ${relTime(Date.now() - (m.lastFiredAt + m.intervalMs))}` : '';
        return (
        <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: 6,
          background: 'var(--cth-paper-100)',
          boxShadow: `inset 0 0 0 1px ${isCompact && !m.enabled ? 'var(--cth-coral)' : 'var(--cth-ink-300)'}`
        }}>
          <span style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 9, padding: '2px 5px 1px',
            background: hb || isCompact ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
            boxShadow: `inset 0 0 0 1px ${hb || isCompact ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
            color: 'var(--cth-ink-900)', flexShrink: 0
          }}>{isCompact ? '⚙ compact' : hb ? '♥ beat' : intervalLabel(m.intervalMs)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
              {isCompact
                ? `every ${intervalLabel(m.intervalMs)} · keeps every agent's terminal context lean`
                : <>→ {targetName(m.to)}{hb ? ` · adaptive ~${intervalLabel(m.intervalMs)} · auto digest` : ''}</>}
            </div>
            <div style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>{fired}{next}</div>
          </div>
          {isCompact && (
            <select
              value={String(m.intervalMs)}
              onChange={(e) => updateInterval(m.id, Number(e.target.value))}
              title="How often to compact every agent"
              style={selectStyle}
            >
              {INTERVAL_OPTS.map((o) => <option key={o.ms} value={String(o.ms)}>{o.label}</option>)}
            </select>
          )}
          <button
            onClick={() => toggleMission(m.id)}
            style={{
              padding: '2px 8px 1px', border: 'none', cursor: 'pointer', flexShrink: 0,
              background: m.enabled ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
              boxShadow: `inset 0 0 0 1px ${m.enabled ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
              fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
            }}
          >{m.enabled ? 'on' : 'off'}</button>
          <button
            onClick={() => deleteMission(m.id)}
            title={isCompact ? 'Delete (it reappears disabled on next launch — auto-compact is required)' : 'Delete this scheduled mission'}
            style={{
              padding: '2px 6px 1px', border: 'none', cursor: 'pointer', flexShrink: 0,
              background: 'var(--cth-cream-200)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-coral)'
            }}
          >✕</button>
        </div>
        {isCompact && !m.enabled && (
          <div style={{
            fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-900)',
            padding: '6px 8px', background: 'var(--cth-coral-light, #f7dcd6)',
            boxShadow: 'inset 0 0 0 1px var(--cth-coral)'
          }}>
            ⚠ Auto-compact is OFF. Long-running agents need this — without it each
            agent's terminal context grows until it overflows and the agent fails.
            Turn it back on unless you're compacting another way.
          </div>
        )}
        </div>
        );
      })}

      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input
          value={mLabel}
          onChange={(e) => setMLabel(e.target.value)}
          placeholder="mission label"
          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-ui)' }}
        />
        <select value={mInterval} onChange={(e) => setMInterval(e.target.value)} style={selectStyle}>
          {INTERVAL_OPTS.map((o) => <option key={o.ms} value={String(o.ms)}>{o.label}</option>)}
        </select>
        <select value={mTo} onChange={(e) => setMTo(e.target.value)} style={selectStyle}>
          <option value="broadcast">everyone</option>
          <option value="god">Michael</option>
          {agents.filter((a) => !a.isGod).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
      <textarea
        value={mBody}
        onChange={(e) => setMBody(e.target.value)}
        rows={2}
        placeholder="Recurring task body… (dispatched on each interval)"
        style={inputStyle}
      />
      <div>
        <PixelButton variant="primary" size="sm" onClick={addMission} disabled={!mLabel.trim() || !mBody.trim()}>
          add mission
        </PixelButton>
      </div>
    </div>
  );
}
