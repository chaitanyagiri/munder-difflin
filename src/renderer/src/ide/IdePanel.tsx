import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { FileTree } from '@/components/FileTree';
import { Icon } from '@/components/Icon';
import { MonacoEditor } from './MonacoEditor';
import { MonacoDiff } from './MonacoDiff';

// ─── Local mirrors of the main-side git shapes (kept renderer-local like GitTab) ──
interface GitStatusEntry { path: string; index: string; worktree: string }
interface GitStatusT { staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: string[] }

type TabMode = 'edit' | 'diff';
interface Tab { key: string; rel: string; mode: TabMode }

interface EditBuffer {
  content: string;
  original: string;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
}
interface DiffData {
  status: 'loading' | 'ready' | 'binary' | 'error';
  head: string;
  working: string;
  error?: string;
}

const tabKey = (mode: TabMode, rel: string) => `${mode}::${rel}`;
const basename = (rel: string) => rel.split('/').pop() || rel;

function statusColor(code: string): string {
  if (code === 'M') return 'var(--cth-lemon)';
  if (code === 'A') return 'var(--cth-mint)';
  if (code === 'D') return 'var(--cth-coral)';
  if (code === 'R') return 'var(--cth-lilac)';
  if (code === '?') return 'var(--cth-ink-300)';
  return 'var(--cth-ink-500)';
}

/** Snapshot the workspace root once at mount: the selected agent's cwd, else the
 *  god agent's cwd, else the first agent's. The IDE is a full-window overlay, so
 *  the user can't switch agents while it's open — a stable root is correct. */
function pickRoot(): string | null {
  const s = useStore.getState();
  const sel = s.selectedId ? s.agents.find((a) => a.id === s.selectedId) : null;
  return sel?.cwd ?? s.agents.find((a) => a.isGod)?.cwd ?? s.agents[0]?.cwd ?? null;
}

export function IdePanel() {
  const setIdeOpen = useStore((s) => s.setIdeOpen);
  const [root] = useState<string | null>(pickRoot);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [editBuffers, setEditBuffers] = useState<Record<string, EditBuffer>>({});
  const [diffData, setDiffData] = useState<Record<string, DiffData>>({});

  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [status, setStatus] = useState<GitStatusT | null>(null);
  const [treeWidth, setTreeWidth] = useState(300);

  // Refs so window/editor handlers always see current values without rebinding.
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeKeyRef = useRef(activeKey); activeKeyRef.current = activeKey;
  const editBuffersRef = useRef(editBuffers); editBuffersRef.current = editBuffers;
  const diffDataRef = useRef(diffData); diffDataRef.current = diffData;

  const activeTab = useMemo(() => tabs.find((t) => t.key === activeKey) ?? null, [tabs, activeKey]);

  // ─── Buffer / diff loaders ────────────────────────────────────────────────
  const ensureEdit = useCallback((rel: string) => {
    if (!root || editBuffersRef.current[rel]) return;
    setEditBuffers((p) => ({ ...p, [rel]: { content: '', original: '', status: 'loading', saveState: 'idle' } }));
    window.cth.readFile(root, rel).then((res) => {
      setEditBuffers((p) => ({
        ...p,
        [rel]: res.ok
          ? { content: res.content, original: res.content, status: 'ready', saveState: 'idle' }
          : { content: '', original: '', status: 'error', error: res.error, saveState: 'idle' }
      }));
    });
  }, [root]);

  const ensureDiff = useCallback((rel: string, force = false) => {
    if (!root) return;
    const cur = diffDataRef.current[rel];
    if (!force && cur && cur.status !== 'error') return;
    setDiffData((p) => ({ ...p, [rel]: { status: 'loading', head: '', working: '' } }));
    window.cth.gitDiff(root, rel).then((res) => {
      if (!('ok' in res) || res.ok !== true) {
        const error = 'error' in res && typeof res.error === 'string' ? res.error : 'diff failed';
        setDiffData((p) => ({ ...p, [rel]: { status: 'error', head: '', working: '', error } }));
        return;
      }
      setDiffData((p) => ({
        ...p,
        [rel]: res.isBinary
          ? { status: 'binary', head: '', working: '' }
          : { status: 'ready', head: res.head, working: res.working }
      }));
    });
  }, [root]);

  // ─── Tab actions ──────────────────────────────────────────────────────────
  const openTab = useCallback((mode: TabMode, rel: string) => {
    const key = tabKey(mode, rel);
    setTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, rel, mode }]));
    setActiveKey(key);
  }, []);

  const openEdit = useCallback((rel: string) => { ensureEdit(rel); openTab('edit', rel); }, [ensureEdit, openTab]);
  const openDiff = useCallback((rel: string) => { ensureDiff(rel, true); openTab('diff', rel); }, [ensureDiff, openTab]);

  const closeTab = useCallback((key: string) => {
    const remaining = tabsRef.current.filter((t) => t.key !== key);
    setTabs(remaining);
    setActiveKey((curr) => (curr !== key ? curr : (remaining.length ? remaining[remaining.length - 1].key : null)));
  }, []);

  const onEditChange = useCallback((rel: string, value: string) => {
    setEditBuffers((p) => (p[rel] ? { ...p, [rel]: { ...p[rel], content: value, saveState: 'idle' } } : p));
  }, []);

  const save = useCallback(async (rel: string) => {
    if (!root) return;
    const buf = editBuffersRef.current[rel];
    if (!buf || buf.status !== 'ready' || buf.content === buf.original || buf.saveState === 'saving') return;
    setEditBuffers((p) => ({ ...p, [rel]: { ...p[rel], saveState: 'saving' } }));
    const res = await window.cth.writeFile(root, rel, buf.content);
    if (res.ok) {
      // original ← the exact snapshot written (buf.content captured at save-start), NOT p[rel].content:
      // if the user typed during the in-flight write, those keystrokes stay in content and remain dirty
      // (content !== original) so they're persisted on the next save instead of being silently dropped.
      setEditBuffers((p) => ({ ...p, [rel]: { ...p[rel], original: buf.content, saveState: 'saved' } }));
      setTimeout(() => setEditBuffers((p) => (p[rel] ? { ...p, [rel]: { ...p[rel], saveState: 'idle' } } : p)), 1200);
      void refreshStatus();
    } else {
      setEditBuffers((p) => ({ ...p, [rel]: { ...p[rel], saveState: 'error', error: res.error } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // ─── Git status (changed files) ───────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    if (!root) { setIsRepo(false); return; }
    const repo = await window.cth.gitIsRepo(root);
    setIsRepo(repo);
    if (!repo) { setStatus(null); return; }
    const s = await window.cth.gitStatus(root);
    if (!('error' in s)) setStatus(s as GitStatusT);
  }, [root]);

  useEffect(() => {
    refreshStatus();
    const id = window.setInterval(refreshStatus, 4000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const changedFiles = useMemo(() => {
    if (!status) return [];
    const map = new Map<string, string>();
    for (const e of status.unstaged) map.set(e.path, e.worktree);
    for (const e of status.staged) if (!map.has(e.path)) map.set(e.path, e.index);
    for (const p of status.untracked) if (!map.has(p)) map.set(p, '?');
    return [...map.entries()].map(([path, code]) => ({ path, code })).sort((a, b) => a.path.localeCompare(b.path));
  }, [status]);

  const anyDirty = useMemo(
    () => Object.values(editBuffers).some((b) => b.status === 'ready' && b.content !== b.original),
    [editBuffers]
  );
  const anyDirtyRef = useRef(anyDirty); anyDirtyRef.current = anyDirty;

  // ─── Keyboard: Cmd/Ctrl+S saves active edit tab; Esc closes (if nothing dirty) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        const t = tabsRef.current.find((x) => x.key === activeKeyRef.current);
        if (t && t.mode === 'edit') { e.preventDefault(); void save(t.rel); }
        return;
      }
      if (e.key === 'Escape' && !anyDirtyRef.current) { setIdeOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, setIdeOpen]);

  // ─── Left splitter drag ───────────────────────────────────────────────────
  const startDrag = (e: React.MouseEvent) => {
    const startX = e.clientX; const startW = treeWidth;
    const onMove = (ev: MouseEvent) => setTreeWidth(Math.min(520, Math.max(200, startW + (ev.clientX - startX))));
    const onUp = () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'ew-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  const copyAbs = (rel: string) => {
    if (root) navigator.clipboard.writeText(rel ? `${root}/${rel}` : root).catch(() => { /* noop */ });
  };

  const activeEditRel = activeTab?.mode === 'edit' ? activeTab.rel : undefined;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 290,
      background: 'var(--cth-cream-100)',
      display: 'flex', flexDirection: 'column',
      paddingTop: 36
    }}>
      {/* Title bar */}
      <div
        className="cth-titlebar-drag"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '2px solid var(--cth-ink-900)',
          display: 'flex', alignItems: 'center',
          paddingLeft: 96, paddingRight: 8, gap: 10,
          userSelect: 'none'
        }}
      >
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px', color: 'var(--cth-ink-900)'
        }}>
          MUNDER DIFFLIN · IDE
        </span>
        <span title={root ?? ''} style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 14, color: 'var(--cth-ink-500)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '40vw'
        }}>
          {root ? basename(root) : 'no workspace'}
        </span>
        <button
          className="cth-titlebar-nodrag"
          onClick={() => setIdeOpen(false)}
          title="Close IDE (Esc)"
          aria-label="Close IDE"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-900)',
            border: 'none', borderRadius: 2, cursor: 'pointer', color: 'var(--cth-ink-900)'
          }}
        >
          <Icon name="x" size={1} style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {/* Body */}
      {!root ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)', fontSize: 16
        }}>
          No workspace available.<br />Spawn an agent first — the IDE opens on its working directory.
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* ── Left: changes + file tree ── */}
          <div style={{
            width: treeWidth, flexShrink: 0, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            borderRight: '1px solid var(--cth-ink-700)', background: 'var(--cth-cream-50)'
          }}>
            {/* CHANGES */}
            <div style={{ flexShrink: 0, maxHeight: '45%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <SectionHeader title="changes" right={
                <button onClick={() => refreshStatus()} title="Refresh" style={iconBtn}>
                  <Icon name="web" />
                </button>
              } />
              <div style={{ overflow: 'auto', minHeight: 0 }}>
                {isRepo === false && (
                  <div style={{ padding: '6px 12px', fontSize: 13, color: 'var(--cth-ink-500)' }}>not a git repo</div>
                )}
                {isRepo && changedFiles.length === 0 && (
                  <div style={{ padding: '6px 12px', fontSize: 13, color: 'var(--cth-ink-500)' }}>working tree clean</div>
                )}
                {changedFiles.map((f) => {
                  const active = activeKey === tabKey('diff', f.path);
                  return (
                    <div
                      key={f.path}
                      onClick={() => openDiff(f.path)}
                      title={f.path}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '2px 12px',
                        cursor: 'pointer', fontSize: 13, color: 'var(--cth-ink-900)',
                        background: active ? 'var(--cth-lemon-light)' : 'transparent'
                      }}
                    >
                      <span style={{
                        width: 12, textAlign: 'center', fontFamily: 'var(--cth-font-mono)',
                        fontWeight: 'bold' as const, color: statusColor(f.code)
                      }}>{f.code === ' ' ? '·' : f.code}</span>
                      <span style={{
                        flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        fontFamily: 'var(--cth-font-mono)', direction: 'rtl', textAlign: 'left'
                      }}>{f.path}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* FILES */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--cth-ink-300)' }}>
              <SectionHeader title="files" />
              <div style={{ flex: 1, minHeight: 0 }}>
                <FileTree root={root} activeRel={activeEditRel} onOpenFile={openEdit} onCopyPath={copyAbs} />
              </div>
            </div>
          </div>

          {/* Splitter */}
          <div onMouseDown={startDrag} style={{ width: 4, cursor: 'ew-resize', flexShrink: 0, background: 'var(--cth-ink-300)' }} />

          {/* ── Right: tabs + editor ── */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-100)' }}>
            {/* Tab bar */}
            <div style={{
              display: 'flex', alignItems: 'stretch', overflowX: 'auto', flexShrink: 0,
              background: 'var(--cth-cream-200)', borderBottom: '1px solid var(--cth-ink-700)', minHeight: 30
            }}>
              {tabs.map((t) => {
                const active = t.key === activeKey;
                const buf = editBuffers[t.rel];
                const dirty = t.mode === 'edit' && buf?.status === 'ready' && buf.content !== buf.original;
                return (
                  <div
                    key={t.key}
                    onClick={() => setActiveKey(t.key)}
                    title={t.rel}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 8px', height: 30,
                      cursor: 'pointer', flexShrink: 0, maxWidth: 240,
                      background: active ? 'var(--cth-paper-100)' : 'transparent',
                      boxShadow: active ? 'inset 0 -2px 0 var(--cth-sky)' : 'none',
                      borderRight: '1px solid var(--cth-ink-100)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)'
                    }}
                  >
                    {t.mode === 'diff' && (
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 7, padding: '1px 3px',
                        background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)'
                      }}>DIFF</span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {basename(t.rel)}{dirty ? ' •' : ''}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}
                      title="Close tab"
                      style={{ ...iconBtn, width: 16, height: 16 }}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Editor / diff body */}
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              {!activeTab && (
                <div style={{
                  height: '100%', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--cth-ink-500)'
                }}>
                  <Icon name="code" size={2} />
                  <div style={{
                    fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
                    letterSpacing: 1, color: 'var(--cth-ink-700)'
                  }}>nothing open</div>
                  <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14 }}>
                    Pick a file from the tree to edit, or a changed file to diff.
                  </div>
                </div>
              )}

              {activeTab?.mode === 'edit' && (() => {
                const buf = editBuffers[activeTab.rel];
                if (!buf || buf.status === 'loading') return <Centered>loading…</Centered>;
                if (buf.status === 'error') return <Centered tone="error">{buf.error}</Centered>;
                return (
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <EditorBar
                      rel={activeTab.rel}
                      dirty={buf.content !== buf.original}
                      saveState={buf.saveState}
                      onSave={() => void save(activeTab.rel)}
                      onCopy={() => copyAbs(activeTab.rel)}
                    />
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <MonacoEditor
                        path={activeTab.rel}
                        value={buf.content}
                        onChange={(v) => onEditChange(activeTab.rel, v)}
                        onSave={() => void save(activeTab.rel)}
                      />
                    </div>
                  </div>
                );
              })()}

              {activeTab?.mode === 'diff' && (() => {
                const d = diffData[activeTab.rel];
                if (!d || d.status === 'loading') return <Centered>loading diff…</Centered>;
                if (d.status === 'error') return <Centered tone="error">{d.error}</Centered>;
                if (d.status === 'binary') return <Centered>binary file — no text diff</Centered>;
                return (
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px',
                      background: 'var(--cth-cream-200)', borderBottom: '1px solid var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ color: 'var(--cth-ink-500)' }}>HEAD</span>
                      <Icon name="arrow-right" />
                      <span>working tree</span>
                      <span style={{
                        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        fontFamily: 'var(--cth-font-mono)', textAlign: 'right'
                      }} title={activeTab.rel}>{activeTab.rel}</span>
                      <button onClick={() => ensureDiff(activeTab.rel, true)} title="Refresh diff" style={iconBtn}>
                        <Icon name="web" />
                      </button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <MonacoDiff path={activeTab.rel} original={d.head} modified={d.working} />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 4px',
      fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', textTransform: 'uppercase',
      color: 'var(--cth-ink-700)', background: 'var(--cth-cream-50)', borderBottom: '1px solid var(--cth-ink-100)'
    }}>
      <span style={{ flex: 1 }}>{title}</span>
      {right}
    </div>
  );
}

function EditorBar({ rel, dirty, saveState, onSave, onCopy }: {
  rel: string; dirty: boolean; saveState: EditBuffer['saveState']; onSave: () => void; onCopy: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
      background: 'var(--cth-cream-200)', borderBottom: '1px solid var(--cth-ink-700)',
      fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)'
    }}>
      <Icon name="code" />
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--cth-font-mono)' }} title={rel}>
        {rel}{dirty ? ' •' : ''}
      </span>
      <button onClick={onCopy} title="Copy absolute path" style={textBtn}>copy path</button>
      <button onClick={onSave} disabled={!dirty || saveState === 'saving'} title="Save (Cmd/Ctrl+S)"
        style={{ ...textBtn, opacity: dirty ? 1 : 0.5 }}>
        {saveState === 'saving' ? '...' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'err' : 'save'}
      </button>
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, textAlign: 'center', fontFamily: 'var(--cth-font-ui)', fontSize: 14,
      color: tone === 'error' ? 'var(--cth-coral)' : 'var(--cth-ink-500)'
    }}>{children}</div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: 0, width: 18, height: 18, background: 'transparent', border: 'none',
  cursor: 'pointer', color: 'var(--cth-ink-500)'
};
const textBtn: React.CSSProperties = {
  padding: '0 6px', height: 20, fontFamily: 'var(--cth-font-ui)', fontSize: 12,
  color: 'var(--cth-ink-900)', background: 'var(--cth-cream-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4
};
