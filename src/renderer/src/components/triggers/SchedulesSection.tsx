import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PixelButton } from '../PixelButton';
import { useStore } from '@/store/store';
import {
  Chip, Field, Hint, MiniButton, Muted, Select, SchedulePicker, SubCard, SubHeader,
  Toggle, fmtInterval, inputStyle, textareaStyle, weeklyDraft, weeklyIsUsable,
  type WeeklyDraft
} from './ui';
import { formatWeekly, nextWeeklyFireMs } from '@shared/weeklySchedule';
import { useRtl } from '@/i18n/useDirection';

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
  /** Day-of-week + time. Present ⇒ this replaces intervalMs (main/config.ts). */
  weekly?: { days: number[]; minute: number };
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
  const rtl = useRtl();
  const agents = useStore((s) => s.agents);
  const [missions, setMissions] = useState<ScheduledMission[]>([]);
  const [adding, setAdding] = useState(false);
  const [mLabel, setMLabel] = useState('');
  const [mInterval, setMInterval] = useState<number>(DEFAULT_INTERVAL_MS);
  // null ⇒ the interval above is what runs. Non-null ⇒ days and a time do.
  const [mWeekly, setMWeekly] = useState<WeeklyDraft | null>(null);
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
    if (!mLabel.trim() || !mBody.trim() || !whenIsUsable) return;
    persist([...missions, {
      id: `m_${Date.now().toString(36)}`,
      label: mLabel.trim(),
      // The interval rides along even in weekly mode, so flipping back to
      // "every…" later restores the cadence rather than a default.
      intervalMs: mInterval,
      ...(mWeekly ? { weekly: mWeekly } : {}),
      to: mTo,
      body: mBody.trim(),
      enabled: true
    }]);
    setMLabel(''); setMBody(''); setMWeekly(null); setAdding(false);
  };
  /** A weekly draft with no days picked would never fire, so it cannot be saved. */
  const whenIsUsable = !mWeekly || weeklyIsUsable(mWeekly);

  const targetName = (to: string) =>
    to === 'broadcast' ? t('schedulesSection.everyone')
      : to === 'god' ? (agents.find((a) => a.isGod)?.name ?? 'the orchestrator')
        : agents.find((a) => a.id === to)?.name ?? to;

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
              <option value="god">{agents.find((a) => a.isGod)?.name ?? 'the orchestrator'}</option>
              {agents.filter((a) => !a.isGod).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={t('schedulesSection.when')}>
            <SchedulePicker
              intervalMs={mInterval}
              weekly={mWeekly}
              onInterval={setMInterval}
              onWeekly={setMWeekly}
            />
          </Field>
          <Field label={t('schedulesSection.prompt')}>
            <textarea
              dir={rtl ? 'auto' : undefined}
              value={mBody}
              onChange={(e) => setMBody(e.target.value)}
              rows={3}
              placeholder={t('schedulesSection.promptPlaceholder')}
              style={textareaStyle}
            />
          </Field>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <PixelButton variant="primary" size="sm" onClick={add} disabled={!mLabel.trim() || !mBody.trim() || !whenIsUsable}>
              {t('common.add')}
            </PixelButton>
            <PixelButton variant="ghost" size="sm" onClick={() => { setAdding(false); setMLabel(''); setMBody(''); setMWeekly(null); }}>
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
  const rtl = useRtl();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(mission.label);
  const [to, setTo] = useState(mission.to);
  const [intervalMs, setIntervalMs] = useState(mission.intervalMs);
  const [weekly, setWeekly] = useState<WeeklyDraft | null>(weeklyDraft(mission.weekly));
  const [body, setBody] = useState(mission.body);
  const [saved, setSaved] = useState(false);

  // Seed the draft when the row opens — never on every render, or the scheduler
  // stamping `lastFiredAt` mid-edit would wipe what you are typing.
  useEffect(() => {
    if (!open) return;
    setLabel(mission.label);
    setTo(mission.to);
    setIntervalMs(mission.intervalMs);
    setWeekly(weeklyDraft(mission.weekly));
    setBody(mission.body);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const heartbeat = mission.kind === 'heartbeat';
  const storedWeekly = weeklyDraft(mission.weekly);
  // Compare the CANONICAL form, not the raw object: [1,3] and [3,1] mean the
  // same schedule, and a row that reads as dirty after a no-op click is noise.
  const weeklyKey = (w: WeeklyDraft | null) => (w ? `${[...w.days].sort((a, b) => a - b).join(',')}@${w.minute}` : '');
  const dirty = label !== mission.label || to !== mission.to
    || intervalMs !== mission.intervalMs || body !== mission.body
    || weeklyKey(weekly) !== weeklyKey(storedWeekly);
  const whenIsUsable = !weekly || weeklyIsUsable(weekly);

  const fired = mission.lastFiredAt
    ? t('schedulesSection.fired', { time: relTime(Date.now() - mission.lastFiredAt, t) })
    : t('schedulesSection.notFired');
  // A weekly mission's next run comes from the calendar, not from lastFiredAt +
  // interval — and unlike the interval case it is knowable before the first run,
  // so a schedule that has never fired can still say when it will.
  const nextAt = storedWeekly
    ? nextWeeklyFireMs(storedWeekly, Date.now())
    : mission.lastFiredAt ? mission.lastFiredAt + mission.intervalMs : null;
  const next = mission.enabled && nextAt !== null
    ? ` · ${t('schedulesSection.next', { time: relTime(Date.now() - nextAt, t) })}`
    : '';

  const save = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    // Fold the trim back into the draft too, or the row would read as still
    // dirty against a label that was only ever going to be stored trimmed.
    setLabel(trimmed);
    // `weekly: undefined` is the switch back to interval mode. It has to be sent
    // explicitly — the backend merges by id and spreads, so simply omitting the
    // key would leave the old schedule in place and the row would snap back.
    onPatch({ label: trimmed, to, intervalMs, body, weekly: weekly ?? undefined });
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
              {heartbeat ? t('schedulesSection.beat') : storedWeekly ? formatWeekly(storedWeekly) : fmtInterval(mission.intervalMs)}
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
              <option value="god">{agents.find((a) => a.isGod)?.name ?? 'the orchestrator'}</option>
              {agents.filter((a) => !a.isGod).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={t('schedulesSection.when')}>
            {/* The heartbeat has no calendar: it is a cadence that adapts to how
                busy the floor is, so pinning it to Tuesdays would be a lie. */}
            {heartbeat
              ? <SchedulePicker intervalMs={intervalMs} weekly={null} onInterval={setIntervalMs} onWeekly={() => { /* interval only */ }} />
              : <SchedulePicker intervalMs={intervalMs} weekly={weekly} onInterval={setIntervalMs} onWeekly={setWeekly} />}
            {heartbeat && <Hint>{t('schedulesSection.beatCeiling')}</Hint>}
          </Field>
          <Field label={t('schedulesSection.prompt')}>
            <textarea
              dir={rtl ? 'auto' : undefined}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder={t('schedulesSection.promptPlaceholder')}
              style={textareaStyle}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <PixelButton variant="primary" size="sm" onClick={save} disabled={!dirty || !label.trim() || !whenIsUsable}>
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
