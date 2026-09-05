import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface SidebarSplitterProps {
  /** 当前侧边栏宽度（px）。 */
  width: number;
  /** 以新宽度回调（已在外部钳制到合理范围）。 */
  onChange: (px: number) => void;
  /** 容器视口宽度——用于把增量钳制到合理上限。 */
  viewportWidth: number;
  min?: number;
  max?: number;
}

/**
 * 垂直拖拽手柄。位于 floor 画布（左）与侧边栏（右）之间。
 * 向左拖 → 侧边栏更宽。光标 + 像素条纹的视觉提示。
 */
export function SidebarSplitter({
  width, onChange, viewportWidth, min = 320, max = 1200
}: SidebarSplitterProps) {
  const { t } = useTranslation();
  const startRef = useRef<{ clientX: number; width: number } | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      const delta = startRef.current.clientX - e.clientX; // 向左拖 = 正增量 → 侧边栏变宽
      const clampMax = Math.min(max, Math.max(min, viewportWidth - 360));
      const next = Math.min(clampMax, Math.max(min, startRef.current.width + delta));
      onChange(next);
    };
    const onUp = () => {
      startRef.current = null;
      setActive(false);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    if (active) {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'ew-resize';
    }
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [active, viewportWidth, min, max, onChange]);

  return (
    <div
      onMouseDown={(e) => {
        startRef.current = { clientX: e.clientX, width };
        setActive(true);
        e.preventDefault();
      }}
      onDoubleClick={() => onChange(420)}
      title={t('sidebarSplitter.dragToResize')}
      style={{
        width: 10,
        cursor: 'ew-resize',
        flexShrink: 0,
        position: 'relative',
        background: active ? 'var(--cth-cream-300)' : 'transparent'
      }}
    >
      {/* 中间带井字刻度的可见 2px 竖条 */}
      <div style={{
        position: 'absolute',
        top: 0, bottom: 0, left: 4,
        width: 2,
        background: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'
      }} />
      <div style={{
        position: 'absolute',
        top: '50%', left: 2, transform: 'translateY(-50%)',
        width: 6, height: 24,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between'
      }}>
        <span style={{ height: 2, background: 'var(--cth-ink-900)' }} />
        <span style={{ height: 2, background: 'var(--cth-ink-900)' }} />
        <span style={{ height: 2, background: 'var(--cth-ink-900)' }} />
      </div>
    </div>
  );
}
