import { useEffect, useRef, useState } from 'react';

export type SplitOrientation = 'vertical' | 'horizontal';

export interface SidebarSplitterProps {
  /** Sidebar size along the split's normal axis: width when vertical, height when horizontal. */
  size: number;
  /** Called with the new size (already clamped here against the viewport). */
  onChange: (px: number) => void;
  /** Containing viewport extent on the split's axis, used for a sane maximum. */
  viewportSize: number;
  orientation?: 'vertical' | 'horizontal';
  min?: number;
  max?: number;
}

/**
 * Drag handle between floor and terminal. The default is vertical (floor left,
 * sidebar right); horizontal puts the landscape floor on top and gives the
 * terminal the full window width below it. The same handle flips its cursor and
 * stripe to match whichever divider is active.
 */
export function SidebarSplitter({
  size, onChange, viewportSize, orientation = 'vertical', min = 320, max = 1200
}: {
  size: number;
  onChange: (px: number) => void;
  viewportSize: number;
  orientation?: 'vertical' | 'horizontal';
  min?: number;
  max?: number;
}) {
  const startRef = useRef<{ client: number; size: number } | null>(null);
  const [active, setActive] = useState(false);
  const horizontal = orientation === 'horizontal';
  const minSize = horizontal ? 240 : min;
  const maxSize = horizontal ? Math.max(minSize, Math.min(1000, viewportSize - 360)) : Math.min(max, Math.max(min, viewportSize - 360));

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      // Left/up drag grows the sidebar in vertical; up drag grows it in horizontal.
      const delta = horizontal ? e.clientY - startRef.current.client : startRef.current.client - e.clientX;
      const next = Math.min(maxSize, Math.max(minSize, startRef.current.size + delta));
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
      document.body.style.cursor = horizontal ? 'ns-resize' : 'ew-resize';
    }
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [active, horizontal, viewportSize, minSize, maxSize, onChange]);

  return (
    <div
      onMouseDown={(e) => {
        startRef.current = { client: horizontal ? e.clientY : e.clientX, size };
        setActive(true);
        e.preventDefault();
      }}
      onDoubleClick={() => onChange(horizontal ? 420 : 420)}
      title="Drag to resize · double-click to reset"
      style={{
        [horizontal ? 'height' : 'width']: 10,
        [horizontal ? 'width' : 'height']: 'auto',
        cursor: horizontal ? 'ns-resize' : 'ew-resize',
        flexShrink: 0,
        position: 'relative',
        background: active ? 'var(--cth-cream-300)' : 'transparent'
      }}
    >
      <div style={{
        position: 'absolute',
        ...(horizontal
          ? { top: 4, left: 0, right: 0, height: 2 }
          : { left: 4, top: 0, bottom: 0, width: 2 }),
        background: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'
      }} />
      <div style={{
        position: 'absolute',
        top: horizontal ? 2 : '50%',
        left: horizontal ? '50%' : 2,
        transform: horizontal ? 'translateX(-50%)' : 'translateY(-50%)',
        width: horizontal ? 24 : 6,
        height: horizontal ? 6 : 24,
        display: 'flex',
        flexDirection: horizontal ? 'row' : 'column',
        justifyContent: 'space-between'
      }}>
        <span style={horizontal ? { width: 2, height: 6, background: 'var(--cth-ink-900)' } : { width: 6, height: 2, background: 'var(--cth-ink-900)' }} />
        <span style={horizontal ? { width: 2, height: 6, background: 'var(--cth-ink-900)' } : { width: 6, height: 2, background: 'var(--cth-ink-900)' }} />
        <span style={horizontal ? { width: 2, height: 6, background: 'var(--cth-ink-900)' } : { width: 6, height: 2, background: 'var(--cth-ink-900)' }} />
      </div>
    </div>
  );
}

