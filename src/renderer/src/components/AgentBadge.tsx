import type { CSSProperties } from 'react';
import type { AccentColorName } from '@/design/tokens';

export interface AgentBadgeProps {
  name: string;
  accent?: AccentColorName;
  size?: number;
  style?: CSSProperties;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((word) => word[0]).join('') || 'A').toUpperCase();
}

/** Lightweight DOM identity marker for an agent. */
export function AgentBadge({ name, accent = 'sky', size = 32, style }: AgentBadgeProps) {
  return (
    <span
      aria-label={`${name} agent`}
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: `var(--cth-${accent}-light)`,
        color: 'var(--cth-ink-900)',
        boxShadow: `inset 0 0 0 1px var(--cth-${accent})`,
        fontFamily: 'var(--cth-font-ui)',
        fontWeight: 700,
        fontSize: Math.max(10, Math.round(size * 0.34)),
        lineHeight: 1,
        ...style,
      }}
    >
      {initials(name)}
    </span>
  );
}
