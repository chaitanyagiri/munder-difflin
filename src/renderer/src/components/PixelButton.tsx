import { CSSProperties, ReactNode, useState } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'lg';

export interface PixelButtonProps {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: CSSProperties;
  title?: string;
}

const heightBySize: Record<Size, number> = { sm: 24, md: 32, lg: 40 };
const padBySize: Record<Size, string> = { sm: '0 8px', md: '0 12px', lg: '0 16px' };

export function PixelButton({
  variant = 'primary',
  size = 'md',
  children,
  onClick,
  disabled = false,
  fullWidth = false,
  style,
  title
}: PixelButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [hover, setHover] = useState(false);

  const palette = (() => {
    switch (variant) {
      case 'primary':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-ink-700)' : 'var(--cth-ink-900)'),
          text:    'var(--cth-cream-50)',
          border:  'var(--cth-ink-900)',
          shadow:  'var(--cth-ink-900)'
        };
      case 'secondary':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-cream-200)' : 'var(--cth-cream-100)'),
          text:    'var(--cth-ink-900)',
          border:  'var(--cth-ink-900)',
          shadow:  'var(--cth-ink-700)'
        };
      case 'ghost':
        return {
          fill:    hover ? 'var(--cth-cream-200)' : 'transparent',
          text:    'var(--cth-ink-700)',
          border:  'var(--cth-ink-500)',
          shadow:  'var(--cth-ink-500)'
        };
      case 'destructive':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-coral-light)' : 'var(--cth-coral)'),
          text:    'var(--cth-ink-900)',
          border:  'var(--cth-ink-900)',
          shadow:  'var(--cth-ink-900)'
        };
    }
  })();

  return (
    <button
      title={title}
      onClick={disabled ? undefined : onClick}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => { setPressed(false); setHover(false); }}
      onMouseEnter={() => setHover(true)}
      disabled={disabled}
      style={{
        height: heightBySize[size],
        padding: padBySize[size],
        background: palette.fill,
        color: palette.text,
        border: 'none',
        boxShadow: pressed && !disabled
          ? `inset 0 0 0 2px ${palette.border}`
          : `inset 0 0 0 2px ${palette.border}, 0 2px 0 ${palette.shadow}`,
        transform: pressed && !disabled ? 'translateY(2px)' : 'none',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: size === 'lg' ? 'var(--cth-text-body-lg)' : 'var(--cth-text-body-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: fullWidth ? '100%' : 'auto',
        userSelect: 'none',
        ...style
      }}
    >
      {children}
    </button>
  );
}
