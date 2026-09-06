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

  // 禁用文本是它自己的颜色，不是变体的颜色。
  //
  // 每个变体在禁用时把 FILL 换成 `--cth-cream-300`，但变体过去保留
  // 自己启用时的文本 token——而 `primary` 的是 `--cth-cream-50`，这个
  // INVERSE（反相）前景是特意选来坐在 ink-900 按钮上的。在 cream-300
  // 禁用填充上这对组合就崩了：深色模式下是 #1A191E 文本配 #37363E 底
  //（约 1.4:1，几乎看不见），浅色模式下近白 #FFFDF5 配棕黄，也好不到
  // 哪里去。这就是为什么禁用的 Send 或 Dispatch 读起来像一个空盒子。
  //
  // `--cth-ink-500` 是唯一一个在 BOTH 主题下都能在 cream-300 上成立
  // 的前景，因为两个 token 是一起翻转的——而且被压暗的标签本来就是一个
  // 禁用控件应有的样子。
  const disabledText = 'var(--cth-ink-500)';

  const palette = (() => {
    switch (variant) {
      case 'primary':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-ink-700)' : 'var(--cth-ink-900)'),
          text:    disabled ? disabledText : 'var(--cth-cream-50)',
          border:  'var(--cth-ink-900)',
          shadow:  'var(--cth-ink-900)'
        };
      case 'secondary':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-cream-200)' : 'var(--cth-cream-100)'),
          text:    disabled ? disabledText : 'var(--cth-ink-900)',
          border:  'var(--cth-ink-300)',
          shadow:  'var(--cth-ink-100)'
        };
      case 'ghost':
        return {
          fill:    hover ? 'var(--cth-cream-200)' : 'transparent',
          text:    disabled ? disabledText : 'var(--cth-ink-700)',
          border:  'var(--cth-ink-300)',
          shadow:  'var(--cth-ink-100)'
        };
      case 'destructive':
        return {
          fill:    disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-coral-light)' : 'var(--cth-coral)'),
          text:    disabled ? disabledText : 'var(--cth-ink-900)',
          border:  'var(--cth-ink-500)',
          shadow:  'var(--cth-ink-300)'
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
        // 在这里居中内容，而不是信任每个调用点。
        //
        // 固定高度的 <button> 会自己居中裸文本，但子元素本身是
        // `inline-flex` 时（每个 icon+label 调用点都这么用，为了让字形
        // 挨着词）它会按自己的基线对齐。于是一排按钮里有些 label 包了层、
        // 有些是裸文本——比如 `edit` 挨着 `IDE` 和 `terminal`——
        // 坐在明显不同的高度上。在调用点逐个修只修得了今天这一行，
        // 修不了别人以后写的下一行。
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 与已包层调用点用的 gap 一致，这样 icon 不用任何包裹层
        // 就能直接放进 label 旁边。
        gap: 4,
        // 干掉 descender 带来的漂移：上面高度已固定，继承的 line-height
        // 只会把文本推离正中。
        lineHeight: 1,
        // 按钮永不缩得比自己的 label 还小。默认 flex-shrink 是 1，
        // 而配合下面的 `whiteSpace: nowrap`，被挤压的按钮会把全宽文本
        // 画出变窄的盒子——所以在紧凑的一行里，标签会直接画到左边
        // 邻居身上。那不是被裁剪的按钮，而是两个控件叠在一起。
        flexShrink: 0,
        height: heightBySize[size],
        padding: padBySize[size],
        background: palette.fill,
        color: palette.text,
        border: 'none',
        // v0.3.4: 1px 发丝线 + 1px 抬升——2px 的 chrome 读起来像厚重的盒子
        boxShadow: pressed && !disabled
          ? `inset 0 0 0 1px ${palette.border}`
          : `inset 0 0 0 1px ${palette.border}, 0 1px 0 ${palette.shadow}`,
        transform: pressed && !disabled ? 'translateY(1px)' : 'none',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: size === 'lg' ? 'var(--cth-text-body-md)' : 'var(--cth-text-body-sm)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: fullWidth ? '100%' : 'auto',
        userSelect: 'none',
        // 高度由上面的尺寸变体固定，所以换行的 label 不会让按钮变高——
        // 多出的一行只是从底部边框打印出去。这里的每个 label 都是短短语
        //（"Check for updates"、"reset & start over"），所以换行永远是布局
        // bug 而不是想要的行为。真正想要多行按钮的调用方仍可覆盖，
        // 因为 `style` 在这个后面展开。
        whiteSpace: 'nowrap',
        ...style
      }}
    >
      {children}
    </button>
  );
}
