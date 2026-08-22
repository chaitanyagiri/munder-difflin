import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PixelButton } from '../PixelButton';
import { useStore } from '@/store/store';
import {
  Chip, Field, Hint, IntervalPicker, MiniButton, Muted, Select, SubCard, SubHeader,
  Toggle, fmtInterval, inputStyle, textareaStyle
} from './ui';

/**
 * SCHEDULES — recurring auto-dispatched missions. The oldest trigger type, and
 * until now the whole of this tab.
 *
 * Two gaps closed on the way over: a mission's PROMPT (`body`) is now visible on
 * the row and editable when the row is expanded — the seeded missions used to
 * dispatch text nobody could read — and the frequency is editable on every
 * mission, not just the retired compact one.
 */

/** Mirrors `ScheduledMission` in src/main/config.ts (and preload). Declared here
 *  so this component owns no cross-package import. */
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

const DEFAULT_INTERVAL_MS = 3_600_000;

/** Relative-time label. Needs the translator because the qualifiers ("ago",
 *  "in", "just now") are UI copy, not data. */
function relTime(ms: number, t: TFunction): string {
  const past = ms >= 0;
  const a = Math.abs(ms);
  if (a < 45_000) return t('schedulesSection.justNow');
  const mins = Math.round(a / 60_000);
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return past ? t('schedulesSection.ago', { unit }) : t('schedulesSection.in', { unit });
}

export function SchedulesSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [missions, setMissions] = useState<ScheduledMission[]>([]);
  const [adding, setAdding] = useState(false);
  const [mLabel, setMLabel] = useState('');
  const [mInterval, setMInterval] = useState<number>(DEFAULT_INTERVAL_MS);
  const [mTo, setMTo] = useState<string>('god');
  const [mBody, setMBody] = useState('');

  useEffect(() => {
    const load = () => { window.cth.listMissions().then(setMissions).catch(() => { /* noop */ }); };
    load();
    // Refresh "last fired" when the scheduler stamps a beat/dispatch.
    return window.cth.onMissionsUpdated(load);
  }, []);

  useEffect(() => {
    const on = missions.filter((m) => m.enabled).length;
    onSummary?.(missions.length === 0 ? t('schedulesSection.summaryNone') : t('schedulesSection.summary', { on, total: missions.length }));
  }, [missions, onSummary, t]);

  // Optimistic: the list is the truth on screen the moment you click, and the
  // write is fire-and-forget (the house pattern across the Command Center).
  const persist = (next: ScheduledMission[]) => {
    setMissions(next);
    void window.cth.saveMissions(next).catch(() => { /* noop */ });
  };
  const patch = (id: string, fields: Partial<ScheduledMission>) =>
    persist(missions.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  // The backend merge in missions:save keeps only what the renderer sends back,
  // so deleting is "save the list without it".
  const remove = (id: string) => persist(missions.filter((m) => m.id !== id));

  const add = () => {
    if (!mLabel.trim() || !mBody.trim()) return;
    persist([...missions, {
      id: `m_${Date.now().toString(36)}`,
      label: mLabel.trim(),
      intervalMs: mInterval,
      to: mTo,
      body: mBody.trim(),
      enabled: true
    }]);
    setMLabel(''); setMBody(''); setAdding(false);
  };

  const targetName = (to: string) =>
    to === 'broadcast' ? t('schedulesSection.everyone') : to === 'god' ? 'Michael' : agents.find((a) => a.id === to)?.name ?? to;

  return (
    <>
      {missions.length === 0 && <Muted>{t('schedulesSection.nothingScheduled')}</Muted>}
      {missions.map((m) => (
        <MissionRow
          key={m.id}
          mission={m}
          targetName={targetName}
          agents={agents}
          onPatch={(fields) => patch(m.id, fields)}
          onDelete={() => remove(m.id)}
        />
      ))}

      {!adding && (
        <div style={{ marginTop: 8 }}>
          <PixelButton variant="secondary" size="sm" onClick={() => setAdding(true)}>{t('schedulesSection.addSchedule')}</PixelButton>
        </div>
      )}
      {adding && (
        <SubCard>
          <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>{t('schedulesSection.newSchedule')}</div>
          <Field label={t('schedulesSection.label')}>
            <input
              value={mLabel}
              onChange={(e) => setMLabel(e.target.value)}
              placeholder={t('schedulesSection.labelPlaceholder')}
              style={inputStyle}
            />
          </Field>
          <Field label={t('schedulesSection.goesTo')}>
            <Select value={mTo} onChange={setMTo} style={{ width: '100%' }}>
              <option value="broadcast">{t('schedulesSection.everyone')}</option>
              <option value="god">Michael</option>
              {agents.filter((a) => !a.isGod).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={t('schedulesSection.every')}>
            <IntervalPicker value={mInterval} onChange={setMInterval} />
          </Field>
          <Field label={t('schedulesSection.prompt')}>
            <textarea
              value={mBody}
              onChange={(e) => setMBody(e.target.value)}
              rows={3}
              placeholder={t('schedulesSection.promptPlaceholder')}
              style={textareaStyle}
            />
          </Field>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <PixelButton variant="primary" size="sm" onClick={add} disabled={!mLabel.trim() || !mBody.trim()}>
              {t('common.add')}
            </PixelButton>
            <PixelButton variant="ghost" size="sm" onClick={() => { setAdding(false); setMLabel(''); setMBody(''); }}>
              {t('common.cancel')}
            </PixelButton>
          </div>
        </SubCard>
      )}
    </>
  );
}

/* ─────────────────────────────── one mission ─────────────────────────────── */

interface RosterAgent { id: string; name: string; isGod?: boolean }

function MissionRow({ mission, targetName, agents, onPatch, onDelete }: {
  mission: ScheduledMission;
  targetName: (to: string) => string;
  agents: RosterAgent[];
  onPatch: (fields: Partial<ScheduledMission>) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(mission.label);
  const [to, setTo] = useState(mission.to);
  const [intervalMs, setIntervalMs] = useState(mission.intervalMs);
  const [body, setBody] = useState(mission.body);
  const [saved, setSaved] = useState(false);

  // Seed the draft when the row opens — never on every render, or the scheduler
  // stamping `lastFiredAt` mid-edit would wipe what you are typing.
  useEffect(() => {
    if (!open) return;
    setLabel(mission.label);
    setTo(mission.to);
    setIntervalMs(mission.intervalMs);
    setBody(mission.body);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const heartbeat = mission.kind === 'heartbeat';
  const dirty = label !== mission.label || to !== mission.to
    || intervalMs !== mission.intervalMs || body !== mission.body;

  const fired = mission.lastFiredAt
    ? t('schedulesSection.fired', { time: relTime(Date.now() - mission.lastFiredAt, t) })
    : t('schedulesSection.notFired');
  const next = mission.enabled && mission.lastFiredAt
    ? ` · ${t('schedulesSection.next', { time: relTime(Date.now() - (mission.lastFiredAt + mission.intervalMs), t) })}`
    : '';

  const save = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    // Fold the trim back into the draft too, or the row would read as still
    // dirty against a label that was only ever going to be stored trimmed.
    setLabel(trimmed);
    onPatch({ label: trimmed, to, intervalMs, body });
    setSaved(true);
    setTimeout(() => setSaved(false), 1300);
  };

  return (
    <SubCard>
      <SubHeader
        open={open}
        onToggle={() => setOpen((o) => !o)}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <Chip tone={mission.enabled ? 'on' : 'off'}>
              {heartbeat ? t('schedulesSection.beat') : fmtInterval(mission.intervalMs)}
            </Chip>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {mission.label}
            </span>
          </span>
        }
        sub={<>{`→ ${targetName(mission.to)}`} · {fired}{next}</>}
        right={<Toggle on={mission.enabled} onClick={() => onPatch({ enabled: !mission.enabled })} />}
      />

      {/* The prompt is the mission. Closed, you get the first line of it; open,
          you get the whole thing in an editor. It used to be invisible. */}
      {!open && (
        <div style={{
          marginTop: 6, padding: '4px 6px',
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '15px',
          color: 'var(--cth-ink-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>{mission.body.trim() || t('schedulesSection.noPrompt')}</div>
      )}

      {open && (
        <div style={{ marginTop: 4 }}>
          <Field label={t('schedulesSection.label')}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
          </Field>
          <Field label={t('schedulesSection.goesTo')}>
            <Select value={to} onChange={setTo} style={{ width: '100%' }}>
              <option value="broadcast">{t('schedulesSection.everyone')}</option>
              <option value="god">Michael</option>
              {agents.filter((a) => !a.isGod).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={t('schedulesSection.every')}>
            <IntervalPicker value={intervalMs} onChange={setIntervalMs} />
            {heartbeat && <Hint>{t('schedulesSection.beatHint')}</Hint>}
          </Field>
          <Field label={t('schedulesSection.prompt')}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder={t('schedulesSection.promptPlaceholder')}
              style={textareaStyle}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <PixelButton variant="primary" size="sm" onClick={save} disabled={!dirty || !label.trim()}>
              {saved && !dirty ? t('schedulesSection.saved') : t('common.save')}
            </PixelButton>
            <span style={{ flex: 1 }} />
            <MiniButton tone="danger" onClick={onDelete}>{t('common.delete')}</MiniButton>
          </div>
        </div>
      )}
    </SubCard>
  );
}
