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
 * SCHEDULES —— 周期性自动派发的任务。最古老的触发器类型，直到现在都是整个
 * 标签页的全部内容。
 *
 * 一路上补上了两个缺口：任务的 PROMPT（`body`）现在在行上可见，并在行展开时
 * 可编辑——过去预置任务派发的是没人读得到的文本——而且频率在每项任务上都可
 * 编辑，不只是那个退役的紧凑任务。
 */

/** 镜像 `ScheduledMission`（src/main/config.ts 与 preload 中）。在此声明，这样
 *  本组件不持有跨包导入。 */
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
  /** 星期几 + 时刻。存在 ⇒ 它取代 intervalMs（见 main/config.ts）。 */
  weekly?: { days: number[]; minute: number };
}

const DEFAULT_INTERVAL_MS = 3_600_000;

/** 相对时间标签。需要翻译器，因为限定词（"ago"、"in"、"just now"）是 UI 文案，
 *  不是数据。 */
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
  // null ⇒ 上面的间隔就是实际运行的。非 null ⇒ 由天和时刻决定。
  const [mWeekly, setMWeekly] = useState<WeeklyDraft | null>(null);
  const [mTo, setMTo] = useState<string>('god');
  const [mBody, setMBody] = useState('');

  useEffect(() => {
    const load = () => { window.cth.listMissions().then(setMissions).catch(() => { /* noop */ }); };
    load();
    // 调度器盖上一次心跳/派发印记时刷新「上次触发时间」。
    return window.cth.onMissionsUpdated(load);
  }, []);

  useEffect(() => {
    const on = missions.filter((m) => m.enabled).length;
    onSummary?.(missions.length === 0 ? t('schedulesSection.summaryNone') : t('schedulesSection.summary', { on, total: missions.length }));
  }, [missions, onSummary, t]);

  // 乐观更新：你点击的瞬间列表就成为屏幕上的真相，写入即发即忘（这是 Command
  // Center 一贯的模式）。
  const persist = (next: ScheduledMission[]) => {
    setMissions(next);
    void window.cth.saveMissions(next).catch(() => { /* 无操作 */ });
  };
  const patch = (id: string, fields: Partial<ScheduledMission>) =>
    persist(missions.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  // missions:save 中的后端合并只保留渲染器发回的内容，所以删除就是「保存
  // 不含它的列表」。
  const remove = (id: string) => persist(missions.filter((m) => m.id !== id));

  const add = () => {
    if (!mLabel.trim() || !mBody.trim() || !whenIsUsable) return;
    persist([...missions, {
      id: `m_${Date.now().toString(36)}`,
      label: mLabel.trim(),
      // 即使在每周模式下间隔也会随行保存，这样以后切回「每隔…」时会恢复
      // 原来的节律，而不是回到默认值。
      intervalMs: mInterval,
      ...(mWeekly ? { weekly: mWeekly } : {}),
      to: mTo,
      body: mBody.trim(),
      enabled: true
    }]);
    setMLabel(''); setMBody(''); setMWeekly(null); setAdding(false);
  };
  /** 没有选任何天的每周草稿永远不会触发，所以不能保存。 */
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

/* ─────────────────────────────── 单个任务 ─────────────────────────────── */

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

  // 行打开时播种草稿——绝不在每次渲染时做，否则调度器在编辑中途盖上
  // `lastFiredAt` 会抹掉你正在输入的内容。
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
  // 比较的是规范形态而不是原始对象：[1,3] 和 [3,1] 表示同一个计划，而一个
  // 在无操作点击后仍显示为「已修改」的行只会制造噪音。
  const weeklyKey = (w: WeeklyDraft | null) => (w ? `${[...w.days].sort((a, b) => a - b).join(',')}@${w.minute}` : '');
  const dirty = label !== mission.label || to !== mission.to
    || intervalMs !== mission.intervalMs || body !== mission.body
    || weeklyKey(weekly) !== weeklyKey(storedWeekly);
  const whenIsUsable = !weekly || weeklyIsUsable(weekly);

  const fired = mission.lastFiredAt
    ? t('schedulesSection.fired', { time: relTime(Date.now() - mission.lastFiredAt, t) })
    : t('schedulesSection.notFired');
  // 每周任务的下次运行来自日历，而不是 lastFiredAt + 间隔——而且与间隔模式
  // 不同，它在首次运行之前就可得知，所以从未触发过的计划也能说出何时触发。
  const nextAt = storedWeekly
    ? nextWeeklyFireMs(storedWeekly, Date.now())
    : mission.lastFiredAt ? mission.lastFiredAt + mission.intervalMs : null;
  const next = mission.enabled && nextAt !== null
    ? ` · ${t('schedulesSection.next', { time: relTime(Date.now() - nextAt, t) })}`
    : '';

  const save = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    // 把修剪后的值也折回草稿，否则这一行会一直显示为「已修改」，而其实那个
    // 标签从一开始就只会以修剪后的形式存储。
    setLabel(trimmed);
    // `weekly: undefined` 是切回间隔模式的开关。必须显式发送——后端按 id 合并
    // 并展开，所以仅仅省略这个键会留下旧的计划，行会弹回原状。
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

      {/* 提示词就是任务本身。收起时你只看到它的第一行；展开时
          你在编辑器里看到全部内容。它以前是完全不可见的。 */}
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
            {/* 心跳没有日历：它是一种随楼层繁忙程度自适应的节奏，
                所以把它固定到周二反而是在说谎。 */}
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
