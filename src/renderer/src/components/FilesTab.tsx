import { useEffect, useRef, useState } from 'react';
import { FileTree } from './FileTree';
import { CodeEditor } from './CodeEditor';
import { useStore } from '@/store/store';

export interface FilesTabProps {
  cwd: string;
}

function joinAbs(cwd: string, rel: string): string {
  return rel ? `${cwd}/${rel}` : cwd;
}

export function FilesTab({ cwd }: FilesTabProps) {
  const openFileInIde = useStore(s => s.openFileInIde);
  const [active, setActive] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState<number>(200);
  const dragRef = useRef<{ x: number; w: number } | null>(null);

  // Drag the inner splitter
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.x;
      setTreeWidth(Math.min(420, Math.max(140, dragRef.current.w + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onCopyPath = (rel: string) => {
    const abs = joinAbs(cwd, rel);
    navigator.clipboard.writeText(abs).catch(() => { /* noop */ });
  };

  const onOpenInIde = () => {
    if (!active) return;
    openFileInIde(joinAbs(cwd, active));
  };

  return (
    <div style={{ flex: 1, minWidth: 0, height: '100%', minHeight: 0, display: 'flex', background: 'var(--cth-paper-100)' }}>
      <div style={{
        width: treeWidth, flexShrink: 0,
        height: '100%', minHeight: 0, overflow: 'hidden',
        borderRight: '1px solid var(--cth-ink-700)'
      }}>
        <FileTree
          root={cwd}
          activeRel={active ?? undefined}
          onOpenFile={(rel) => setActive(rel)}
          onCopyPath={onCopyPath}
        />
      </div>
      {/* Inner divider */}
      <div
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, w: treeWidth };
          document.body.style.cursor = 'ew-resize';
          const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            const delta = ev.clientX - dragRef.current.x;
            setTreeWidth(Math.min(420, Math.max(140, dragRef.current.w + delta)));
          };
          const onUp = () => {
            dragRef.current = null;
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
          e.preventDefault();
        }}
        style={{
          width: 4, cursor: 'ew-resize', flexShrink: 0,
          background: 'var(--cth-ink-300)'
        }}
      />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <CodeEditor
          root={cwd}
          filePath={active}
          onOpenInIde={onOpenInIde}
          onCopyPath={active ? () => onCopyPath(active) : undefined}
        />
      </div>
    </div>
  );
}
