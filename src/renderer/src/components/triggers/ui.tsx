import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TRIGGER_MODES, type TriggerMode } from '@shared/triggers';
import {
  WEEKDAY_INITIALS, WEEKDAY_LABELS, formatMinute, normalizeWeekly,
  type WeeklySchedule
} from '@shared/weeklySchedule';

/**
 * Triggers 标签页的共享外观。
 *
 * Command Center 自带的 `Section`/`Scroll`/`Muted` 是 `CommandCenterPanel.tsx`
 * 模块私有的，所以这里精确地复刻了它们（同样的内边距、同样的字体、同样的
 * `inset` 细线），并加上本标签页需要的折叠行为——四种密集的配置不适合以扁平
 * 表单的形式塞进一条侧栏。
 */

/* ───────────────────────────── 共享样式 ─────────────────────────────── */

export const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none'
};

export const monoInputStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--cth-font-mono)'
};

export const textareaStyle: CSSProperties = {
  ...monoInputStyle,
  resize: 'vertical'
};

export const selectStyle: CSSProperties = {
  padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
  cursor: 'pointer', minWidth: 0, maxWidth: '100%'
};

/* ───────────────────────────── 文本辅助 ──────────────────────────────── */

export function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{children}</div>;
}

/** 控件下方的一行说明。比 Muted 更小，绝不是 tooltip——侧栏里 tooltip 有一半
 *  时间会被窗口边缘挡住。 */
export function Hint({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)', marginTop: 3 }}>{children}</div>;
}

export function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'on' | 'off' }) {
  const bg = tone === 'on' ? 'var(--cth-lemon)' : tone === 'off' ? 'var(--cth-cream-200)' : 'var(--cth-cream-100)';
  const line = tone === 'on' ? 'var(--cth-ink-900)' : 'var(--cth-ink-100)';
  return (
    <span style={{
      flexShrink: 0, padding: '2px 5px 1px',
      fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
      background: bg, boxShadow: `inset 0 0 0 1px ${line}`, color: 'var(--cth-ink-900)'
    }}>{children}</span>
  );
}

export function Callout({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'note' }) {
  const warn = tone === 'warn';
  return (
    <div style={{
      marginTop: 6, padding: '6px 8px',
      fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-900)',
      background: warn ? 'var(--cth-coral-light)' : 'var(--cth-cream-200)',
      boxShadow: `inset 0 0 0 1px ${warn ? 'var(--cth-coral)' : 'var(--cth-ink-100)'}`
    }}>{children}</div>
  );
}

/* ─────────────────────────────── 控件 ────────────────────────────────── */

export function Toggle({ on, onClick, onLabel, offLabel }: {
  on: boolean; onClick: () => void; onLabel?: string; offLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      style={{
        padding: '2px 8px 1px', border: 'none', cursor: 'pointer', flexShrink: 0,
        background: on ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
        boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
      }}
    >{on ? (onLabel ?? t('common.on')) : (offLabel ?? t('common.off'))}</button>
  );
}

export function MiniButton({ children, onClick, tone = 'plain', disabled }: {
  children: ReactNode; onClick: () => void; tone?: 'plain' | 'danger' | 'good'; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flexShrink: 0, padding: '2px 7px 1px', border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        background: tone === 'good' ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 11,
        color: disabled ? 'var(--cth-ink-300)' : tone === 'danger' ? 'var(--cth-coral)' : 'var(--cth-ink-900)'
      }}
    >{children}</button>
  );
}

export function Select({ value, onChange, children, style }: {
  value: string; onChange: (v: string) => void; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...selectStyle, ...style }}
    >{children}</select>
  );
}

/** 控件上方的标签。纵向堆叠，绝不并排——侧栏太窄，容不下一个不会截断所标注
 *  内容的标签列。 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', marginBottom: 4
      }}>{label}</div>
      {children}
    </div>
  );
}

/* ───────────────────────────── 容器 ───────────────────────────────── */

export function Scroll({ children }: { children: ReactNode }) {
  return (
    <div style={{
      flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
      padding: 10, background: 'var(--cth-paper-200)'
    }}>{children}</div>
  );
}

/**
 * 四种触发器类型之一。折叠时显示标题、一行「这是什么」和一个实时摘要——这样
 * 打开标签页读起来是四种触发器，而不是一面表单墙。
 *
 * 折叠时子元素保持挂载（隐藏而不是卸载），原因有二：摘要 chip 由分区自身供给，
 * 一关闭就会变空白；而且分区自己的展开行在折叠其父级后依然存在。
 */
export function TriggerCard({ title, blurb, summary, defaultOpen = false, children }: {
  title: string; blurb: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'flex-start', gap: 6, textAlign: 'left',
          padding: '8px 10px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}
      >
        <span style={{ flexShrink: 0, width: 8, fontSize: 11, lineHeight: '13px', color: 'var(--cth-ink-500)' }}>
          {open ? '▾' : '▸'}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '13px',
            color: 'var(--cth-ink-900)'
          }}>{title}</span>
          <span style={{ display: 'block', fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', marginTop: 2 }}>
            {blurb}
          </span>
        </span>
        {summary !== undefined && <Chip>{summary}</Chip>}
      </button>
      <div style={{ display: open ? 'block' : 'none', padding: '8px 10px 10px' }}>{children}</div>
    </div>
  );
}

/** 卡片里的卡片——一个 webhook、一条 context 规则。 */
export function SubCard({ children }: { children: ReactNode }) {
  return (
    <div style={{
      marginBottom: 6, padding: '8px 10px 10px',
      background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>{children}</div>
  );
}

/** SubCard 内部的标题行：展开箭头、标题和控件。 */
export function SubHeader({ open, onToggle, title, sub, right }: {
  open: boolean; onToggle: () => void; title: ReactNode; sub?: ReactNode; right?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={onToggle}
        style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left',
          padding: 0, border: 'none', background: 'transparent', cursor: 'pointer'
        }}
      >
        <span style={{ flexShrink: 0, width: 8, fontSize: 11, color: 'var(--cth-ink-500)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: 'block', fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
            color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>{title}</span>
          {sub !== undefined && (
            <span style={{
              display: 'block', fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>{sub}</span>
          )}
        </span>
      </button>
      {right}
    </div>
  );
}

/* ──────────────────────────── 触发器模式 ───────────────────────────────── */

/** 共享的 `strict / allow-all / communication-only` 门。标签和说明来自
 *  `TRIGGER_MODES`，这样 webhooks 和 org 永远不会分道扬镳。 */
export function ModePicker({ value, onChange }: { value: TriggerMode; onChange: (m: TriggerMode) => void }) {
  const current = TRIGGER_MODES.find((m) => m.value === value) ?? TRIGGER_MODES[0];
  return (
    <>
      <Select value={value} onChange={(v) => onChange(v as TriggerMode)} style={{ width: '100%' }}>
        {TRIGGER_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </Select>
      <Hint>{current.blurb}</Hint>
    </>
  );
}

/* ──────────────────────────── 间隔选择器 ────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

export const INTERVAL_OPTS: { ms: number; label: string }[] = [
  { ms: 15 * MINUTE, label: '15m' },
  { ms: 30 * MINUTE, label: '30m' },
  { ms: HOUR, label: '1h' },
  { ms: 2 * HOUR, label: '2h' },
  { ms: 6 * HOUR, label: '6h' },
  { ms: 12 * HOUR, label: '12h' },
  { ms: DAY, label: '24h' },
  { ms: WEEK, label: 'weekly' }
];

/** 针对任意已存间隔的真实标签，无论是否预设。任意间隔现在也会被持久化，所以
 *  标签是计算出来的而不是查表——回退到最近预设的下拉框会悄悄地谎报存储值。 */
export function fmtInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'off';
  if (ms === WEEK) return 'weekly';
  if (ms % WEEK === 0) return `${ms / WEEK}w`;
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / 1000)}s`;
}

const CUSTOM = '__custom';

/**
 * @param minMs/maxMs MAIN 实际会存储的范围。context 规则在进入时被钳制在
 * 1 分钟 … 24 小时之间，所以如果在那里提供 "weekly" 选项，屏幕上显示的标签
 * 就会与保存的值不符。Schedules 接受任意间隔并传入默认范围。
 */
export function IntervalPicker({ value, onChange, minMs = MINUTE, maxMs = Number.POSITIVE_INFINITY }: {
  value: number; onChange: (ms: number) => void; minMs?: number; maxMs?: number;
}) {
  const { t } = useTranslation();
  const opts = INTERVAL_OPTS.filter((o) => o.ms >= minMs && o.ms <= maxMs);
  const preset = opts.some((o) => o.ms === value);
  const [custom, setCustom] = useState(!preset);
  const showCustom = custom || !preset;
  const clamp = (ms: number) => Math.min(maxMs, Math.max(minMs, ms));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Select
        value={showCustom ? CUSTOM : String(value)}
        onChange={(v) => {
          if (v === CUSTOM) { setCustom(true); return; }
          setCustom(false);
          onChange(Number(v));
        }}
      >
        {!preset && <option value={CUSTOM}>{fmtInterval(value)} ({t('triggersUi.custom')})</option>}
        {opts.map((o) => <option key={o.ms} value={String(o.ms)}>{o.label}</option>)}
        {preset && <option value={CUSTOM}>{t('triggersUi.customEllipsis')}</option>}
      </Select>
      {showCustom && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            min={Math.max(1, Math.round(minMs / MINUTE))}
            max={Number.isFinite(maxMs) ? Math.round(maxMs / MINUTE) : undefined}
            value={Math.max(1, Math.round(value / MINUTE))}
            onChange={(e) => {
              const mins = Number(e.target.value);
              if (Number.isFinite(mins) && mins > 0) onChange(clamp(Math.round(mins) * MINUTE));
            }}
            style={{ ...monoInputStyle, width: 68, padding: '3px 5px' }}
          />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('triggersUi.min')}</span>
        </span>
      )}
    </div>
  );
}

/* ───────────────────────────── 百分比字段 ─────────────────────────────── */

export function PctField({ value, onChange }: { value: number; onChange: (pct: number) => void }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);
        }}
        style={{ ...monoInputStyle, width: 60, padding: '3px 5px' }}
      />
      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>%</span>
      <div style={{
        flex: 1, minWidth: 40, height: 8,
        background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct === 0 ? 'var(--cth-ink-300)' : 'var(--cth-lemon)' }} />
      </div>
    </div>
  );
}

/* ────────────────────────────── 密钥字段 ─────────────────────────────── */

/** 默认遮蔽；仅在需要时揭示。值绝不进入 `title`/tooltip——那些会泄漏到截图和
 *  无障碍树中。 */
export function SecretField({ value, revealed, onReveal, onCopy, copied, placeholder, onChange, onBlur }: {
  value: string;
  revealed: boolean;
  onReveal: () => void;
  onCopy?: () => void;
  copied?: boolean;
  placeholder?: string;
  onChange?: (v: string) => void;
  onBlur?: () => void;
}) {
  const { t } = useTranslation();
  const readOnly = !onChange;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={onBlur}
        style={{ ...monoInputStyle, flex: 1, minWidth: 0, padding: '4px 6px' }}
      />
      <MiniButton onClick={onReveal}>{revealed ? t('common.hide') : t('common.show')}</MiniButton>
      {onCopy && <MiniButton onClick={onCopy} tone={copied ? 'good' : 'plain'}>{copied ? `${t('common.copy')} ✓` : t('common.copy')}</MiniButton>}
    </div>
  );
}

/* ──────────────────────────── 每周计划 ────────────────────────────── */

/** 选择器在编辑中途可以持有的一份每周计划。用户取消选择时天可能为空，
 *  而 `normalizeWeekly` 会拒绝这种状态——所以草稿类型比存储类型更宽松，
 *  需要有效的是「保存」这个动作。 */
export type WeeklyDraft = { days: number[]; minute: number };

export const DEFAULT_WEEKLY: WeeklyDraft = { days: [1, 2, 3, 4, 5], minute: 9 * 60 };

/** 这份草稿是否可以安全存储。所有调用点共享的那一道门。 */
export function weeklyIsUsable(w: WeeklyDraft): boolean {
  return normalizeWeekly(w) !== null;
}

/**
 * 星期几 + 一天中时刻的选择器。
 *
 * 用七个开关而不是多选下拉框，因为选择「周一 周三 周五」本来就是全部工作，
 * 而原生多选会把它变成修饰键谜题。顺序是星期日在前，与 `Date.getDay()` 一致，
 * 这样点击内容和存储内容之间不需要任何索引运算。
 */
export function WeeklyPicker({ value, onChange }: {
  value: WeeklyDraft; onChange: (w: WeeklyDraft) => void;
}) {
  const { t } = useTranslation();
  const toggle = (d: number) => onChange({
    ...value,
    days: value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d].sort((a, b) => a - b)
  });
  const setDays = (days: number[]) => onChange({ ...value, days });
  const same = (days: number[]) =>
    value.days.length === days.length && days.every((d) => value.days.includes(d));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        {WEEKDAY_INITIALS.map((initial, d) => {
          const on = value.days.includes(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() => toggle(d)}
              title={WEEKDAY_LABELS[d]}
              aria-pressed={on}
              style={{
                width: 26, height: 24, border: 'none', cursor: 'pointer',
                background: on ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
                boxShadow: on
                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                color: on ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
              }}
            >{initial}</button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('triggersUi.at')}</span>
        {/* 原生时间字段，因此输入 0930 即可，值也已经是
            计划存储的 HH:MM 格式。分钟粒度，而非 5 分钟步进：
            "周二 09:47" 是合理需求。 */}
        <input
          type="time"
          value={formatMinute(value.minute)}
          onChange={(e) => {
            const [h, m] = e.target.value.split(':').map(Number);
            if (Number.isFinite(h) && Number.isFinite(m)) onChange({ ...value, minute: h * 60 + m });
          }}
          style={{ ...inputStyle, width: 108, padding: '3px 6px' }}
        />
        <span style={{ flex: 1 }} />
        <MiniButton onClick={() => setDays(same([1, 2, 3, 4, 5]) ? [] : [1, 2, 3, 4, 5])}>{t('triggersUi.weekdays')}</MiniButton>
        <MiniButton onClick={() => setDays(same([0, 1, 2, 3, 4, 5, 6]) ? [] : [0, 1, 2, 3, 4, 5, 6])}>{t('triggersUi.everyDay')}</MiniButton>
      </div>
      {value.days.length === 0 && <Hint>{t('triggersUi.pickDayHint')}</Hint>}
    </div>
  );
}

/**
 * 完整的「它什么时候运行」控件：选择重复间隔，或选择天和时刻。两个调用点
 * （新建计划表单和展开的行）都使用它，这样两者永远不会不一致。
 *
 * `weekly === null` 即间隔模式。把模式保存在值里而不是本地状态中，意味着
 * 从磁盘重新加载的行不会显示错误的标签页。
 */
export function SchedulePicker({ intervalMs, weekly, onInterval, onWeekly }: {
  intervalMs: number;
  weekly: WeeklyDraft | null;
  onInterval: (ms: number) => void;
  onWeekly: (w: WeeklyDraft | null) => void;
}) {
  const { t } = useTranslation();
  const tab = (active: boolean): CSSProperties => ({
    padding: '3px 10px 2px', border: 'none', cursor: 'pointer',
    background: active ? 'var(--cth-cream-100)' : 'transparent',
    boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
    fontFamily: 'var(--cth-font-ui)', fontSize: 11,
    color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" style={tab(!weekly)} onClick={() => onWeekly(null)}>{t('triggersUi.every')}</button>
        <button type="button" style={tab(!!weekly)} onClick={() => onWeekly(weekly ?? DEFAULT_WEEKLY)}>{t('triggersUi.onDays')}</button>
      </div>
      {weekly
        ? <WeeklyPicker value={weekly} onChange={onWeekly} />
        : <IntervalPicker value={intervalMs} onChange={onInterval} />}
    </div>
  );
}

/** 把已存任务的 `weekly` 收窄为草稿；间隔模式则返回 null。由一个地方来决定
 *  「这个任务是每周制的」意味着什么。 */
export function weeklyDraft(w: WeeklySchedule | { days: number[]; minute: number } | undefined): WeeklyDraft | null {
  const n = normalizeWeekly(w);
  return n ? { days: n.days, minute: n.minute } : null;
}
