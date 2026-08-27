import { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

export type StatusKind =
  | 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'success' | 'ghost'
  // #5C — richer states driven by real events: PreCompact/PostCompact hooks and
  // the Lane A circuit breaker (#6) respectively.
  | 'compacting' | 'looping'
  // Not an agent state at all — the USER has unsubmitted text on that agent's
  // prompt, which holds its queue. Never stored on the agent (the pty parser
  // would overwrite it); derived at render, see `hasTerminalDraft`. Without it
  // a held queue looked identical to an idle agent doing nothing.
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

// i18n key per status. "blocked" is reserved for the god agent waiting on YOU,
// so it reads as "needs you"; sub-agents waiting on god/another agent are
// "waiting", which is honest about who they're actually stalled on.
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
  // Reads as "you are typing", not "the agent is typing" — it is your text
  // sitting on the prompt, and it is why nothing is being delivered.
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
        // Same reason as PixelButton: a status chip that shrinks spills its text
        // under the controls beside it instead of holding its own width.
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
