import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

interface NodeState {
  rel: string;        // relative to root; '' for root
  name: string;
  isDir: boolean;
  expanded: boolean;
  children?: NodeState[]; // loaded lazily
  loading?: boolean;
  error?: string;
}

export interface FileTreeProps {
  root: string;
  /** Active file (relative path, no leading slash) */
  activeRel?: string;
  onOpenFile: (rel: string) => void;
  onCopyPath: (rel: string) => void;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

const HIDE_PATTERNS = [/^\.git$/, /^node_modules$/, /^out$/, /^dist$/];

export function FileTree({ root, activeRel, onOpenFile, onCopyPath }: FileTreeProps) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<NodeState>({
    rel: '', name: 'root', isDir: true, expanded: true
  });

  const loadDir = useCallback(async (rel: string) => {
    const res = await window.cth.listDir(root, rel);
    if (!res.ok) return { error: res.error };
    const filtered = res.entries.filter(e => !HIDE_PATTERNS.some(re => re.test(e.name)));
    return { children: filtered.map((e: DirEntry): NodeState => ({
      rel: rel ? `${rel}/${e.name}` : e.name,
      name: e.name,
      isDir: e.isDir,
      expanded: false
    })) };
  }, [root]);

  // Initial root load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await loadDir('');
      if (cancelled) return;
      setTree(prev => ({ ...prev, ...res }));
    })();
    return () => { cancelled = true; };
  }, [loadDir]);

  /** Update a node deep in the tree by rel path. */
  const updateNode = useCallback((rel: string, patch: Partial<NodeState> | ((n: NodeState) => Partial<NodeState>)) => {
    setTree(prev => {
      const apply = (node: NodeState): NodeState => {
        if (node.rel === rel) {
          const p = typeof patch === 'function' ? patch(node) : patch;
          return { ...node, ...p };
        }
        if (!node.children) return node;
        return { ...node, children: node.children.map(apply) };
      };
      return apply(prev);
    });
  }, []);

  const toggle = useCallback(async (node: NodeState) => {
    if (!node.isDir) {
      onOpenFile(node.rel);
      return;
    }
    if (node.expanded) {
      updateNode(node.rel, { expanded: false });
      return;
    }
    // Expand: load if not already loaded
    if (!node.children) {
      updateNode(node.rel, { expanded: true, loading: true });
      const res = await loadDir(node.rel);
      if ('error' in res && res.error) {
        updateNode(node.rel, { loading: false, error: res.error });
        return;
      }
      updateNode(node.rel, { loading: false, error: undefined, children: res.children });
    } else {
      updateNode(node.rel, { expanded: true });
    }
  }, [loadDir, onOpenFile, updateNode]);

  const renderNode = (node: NodeState, depth: number): React.ReactNode => {
    if (node.rel === '' && depth === 0) {
      // Render children of root only
      return (
        <div>
          {node.children?.map(c => renderNode(c, 0))}
          {node.loading && <div style={{ padding: 8, fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('fileTree.loading')}</div>}
          {node.error && <div style={{ padding: 8, fontSize: 12, color: 'var(--cth-coral)' }}>{node.error}</div>}
        </div>
      );
    }
    const isActive = activeRel === node.rel;
    return (
      <div key={node.rel}>
        <div
          onClick={() => toggle(node)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '2px 6px',
            paddingLeft: 6 + depth * 14,
            background: isActive ? 'var(--cth-lemon-light)' : 'transparent',
            cursor: 'pointer',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            color: 'var(--cth-ink-900)',
            userSelect: 'none'
          }}
        >
          {node.isDir ? (
            <span style={{
              width: 10, display: 'inline-block', textAlign: 'center',
              fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-700)'
            }}>
              {node.expanded ? '▾' : '▸'}
            </span>
          ) : (
            <span style={{ width: 10, display: 'inline-block' }} />
          )}
          <Icon name={node.isDir ? 'folder' : 'code'} />
          <span style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>{node.name}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onCopyPath(node.rel); }}
            title={t('fileTree.copyPathTitle')}
            style={{
              padding: '0 4px',
              fontSize: 10,
              fontFamily: 'var(--cth-font-ui)',
              color: 'var(--cth-ink-500)',
              background: 'transparent', border: 'none', cursor: 'pointer'
            }}
          >{t('common.copy')}</button>
        </div>
        {node.isDir && node.expanded && (
          <div>
            {node.loading && (
              <div style={{ padding: '2px 6px', paddingLeft: 24 + depth * 14, fontSize: 12, color: 'var(--cth-ink-500)' }}>
                {t('fileTree.loading')}
              </div>
            )}
            {node.error && (
              <div style={{ padding: '2px 6px', paddingLeft: 24 + depth * 14, fontSize: 12, color: 'var(--cth-coral)' }}>
                {node.error}
              </div>
            )}
            {node.children?.map(c => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      overflow: 'auto', height: '100%',
      background: 'var(--cth-cream-50)',
      paddingTop: 4
    }}>
      {renderNode(tree, 0)}
    </div>
  );
}
