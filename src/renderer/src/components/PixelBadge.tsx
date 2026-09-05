import { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

export type StatusKind =
  | 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'success' | 'ghost'
  // #5C —— 由真实事件驱动的更丰富状态：PreCompact/PostCompact hooks
  // 和 Lane A 熔断器（#6）各自对应一个。
  | 'compacting' | 'looping'
  // 根本不是 agent 状态——是 USER 在该 agent 的 prompt 上有未提交的
  // 文本，它拖住了队列。永不存储在 agent 上（pty parser 会覆盖它）；
  // 渲染时派生，见 `hasTerminalDraft`。没有它，被拖住的队列看起来和
  // 无所事事的 idle agent 毫无区别。
  | 'typing';

export interface PixelBadgeProps {
  status: StatusKind;
  label?: string;
  style?: CSSProperties;
}

const colorByStatus: Record<StatusKind, string> = {
  idle:     'var(--cth-status-idle)',
  thinking: 'var(--cth-status-thinking)',
  working:  'var(--cth-status-working)',
  waiting:  'var(--cth-status-waiting)',
  blocked:  'var(--cth-status-blocked)',
  success:  'var(--cth-status-success)',
  ghost:    'var(--cth-status-ghost)',
  compacting: 'var(--cth-status-compacting)',
  looping:    'var(--cth-status-looping)',
  typing:     'var(--cth-status-typing)'
};

// 每种状态的 i18n key。"blocked" 预留给等 YOU 的 god agent，
// 所以它读作"需要你"；等 god/另一个 agent 的子 agent 用
// "waiting"，这如实反映了他们实际卡在谁身上。
const labelKeyByStatus: Record<StatusKind, string> = {
  idle:     'badge.idle',
  thinking: 'badge.thinking',
  working:  'badge.working',
  waiting:  'badge.waiting',
  blocked:  'badge.blocked',
  success:  'badge.success',
  ghost:    'badge.ghost',
  compacting: 'badge.compacting',
  looping:    'badge.looping',
  // 读作"你在输入"，不是"agent 在输入"——是你的文本坐在 prompt 上，
  // 也正是为什么没有任何东西被送出。
  typing:     'badge.typing'
};

export function PixelBadge({ status, label, style }: PixelBadgeProps) {
  const { t } = useTranslation();
  const key = labelKeyByStatus[status];
  const text = label ?? (key ? t(key) : status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // 与 PixelButton 同样的原因：会缩小的状态 chip 会把文本溢到
        // 旁边的控件底下，而不是守住自己的宽度。
        flexShrink: 0,
        gap: 6,
        padding: '2px 8px 0',
        background: 'var(--cth-cream-100)',
        boxShadow: `inset 0 0 0 1px ${colorByStatus[status]}`,
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 'var(--cth-text-body-sm)',
        lineHeight: '18px',
        color: 'var(--cth-ink-900)',
        userSelect: 'none',
        ...style
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          background: colorByStatus[status],
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}
      />
      {text}
    </span>
  );
}
