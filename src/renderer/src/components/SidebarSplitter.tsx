import { useEffect, useRef, useState } from 'react';
import { clampSidebarSize, SIDEBAR_DEFAULT, type SplitOrientation } from '@/store/splitLayout';

export interface SidebarSplitterProps {
  /** Current sidebar size in px — width when vertical, height when horizontal. */
  size: number;
  /** Called with the new size. Clamping happens here AND in the store, because
   *  the store is also reached by the orientation flip and the persisted restore. */
  onChange: (px: number) => void;
  /** Which axis divides the panes. See `splitLayout.SplitOrientation`. */
  orientation: SplitOrientation;
  /** Containing viewport extent along the SPLIT axis — window width when
   *  vertical, window height when horizontal. Used to reserve the floor's room. */
  viewport: number;
}

/**
 * Drag handle between the floor canvas and the agent sidebar.
 *
 * One component serves both axes rather than two near-identical ones: the drag
 * maths is the same subtraction on a different coordinate, and splitting it in
 * two is how the two copies drift. Everything axis-dependent is resolved from
 * `orientation` up front and then used symmetrically.
 *
 * The sidebar is the pane AFTER the handle in both orientations (right when
 * vertical, below when horizontal), so dragging back toward the origin — left,
 * or up — always grows it. That keeps the gesture's meaning identical across a
 * flip, which is what stops the flip feeling like a different app.
 */
export function SidebarSplitter({ size, onChange, orientation, viewport }: SidebarSplitterProps) {
  const horizontal = orientation === 'horizontal';
  const startRef = useRef<{ pos: number; size: number } | null>(null);
  const [active, setActive] = useState(false);
  // App passes an inline closure (it forwards the viewport), so `onChange` is a
  // fresh function on every render — and a drag re-renders on every frame. Held
  // in a ref so the listener effect below depends only on primitives and does
  // not tear down / re-register the window listeners mid-gesture.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      // Drag toward the origin (left / up) = positive delta = grow the sidebar.
      const pos = horizontal ? e.clientY : e.clientX;
      const delta = startRef.current.pos - pos;
      onChangeRef.current(clampSidebarSize(startRef.current.size + delta, orientation, viewport));
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
  }, [active, horizontal, orientation, viewport]);

  // The 2px rule runs ALONG the handle; the three hash marks run ACROSS it.
  const rule = horizontal
    ? { left: 0, right: 0, top: 4, height: 2 }
    : { top: 0, bottom: 0, left: 4, width: 2 };
  const grip = horizontal
    ? { left: '50%', top: 2, transform: 'translateX(-50%)', width: 24, height: 6, flexDirection: 'row' as const }
    : { top: '50%', left: 2, transform: 'translateY(-50%)', width: 6, height: 24, flexDirection: 'column' as const };
  const mark = horizontal ? { width: 2 } : { height: 2 };

  return (
    <div
      onMouseDown={(e) => {
        startRef.current = { pos: horizontal ? e.clientY : e.clientX, size };
        setActive(true);
        e.preventDefault();
      }}
      onDoubleClick={() => onChange(SIDEBAR_DEFAULT[orientation])}
      title="Drag to resize · double-click to reset"
      style={{
        ...(horizontal ? { height: 10 } : { width: 10 }),
        cursor: horizontal ? 'ns-resize' : 'ew-resize',
        flexShrink: 0,
        position: 'relative',
        background: active ? 'var(--cth-cream-300)' : 'transparent'
      }}
    >
      <div style={{
        position: 'absolute', ...rule,
        background: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'
      }} />
      <div style={{
        position: 'absolute', ...grip,
        display: 'flex', justifyContent: 'space-between'
      }}>
        <span style={{ ...mark, background: 'var(--cth-ink-900)' }} />
        <span style={{ ...mark, background: 'var(--cth-ink-900)' }} />
        <span style={{ ...mark, background: 'var(--cth-ink-900)' }} />
      </div>
    </div>
  );
}
