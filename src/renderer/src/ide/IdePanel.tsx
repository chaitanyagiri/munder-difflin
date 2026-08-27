import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { FileTree } from '@/components/FileTree';
import { Icon } from '@/components/Icon';
import { MonacoEditor } from './MonacoEditor';
import { MonacoDiff } from './MonacoDiff';
import { ImagePreview } from './ImagePreview';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { HistoryPane, ComparePane } from './GitPanes';
import { isImagePath, isSvgPath } from '@shared/imageTypes';
import { ideBarStyle, ideIconBtn as iconBtn, ideTextBtn as textBtn } from './chrome';

// v0.3.4 markdown preview: per-md-tab view mode, defaulted from the last choice.
type MdView = 'code' | 'split' | 'preview';
const LS_MD_VIEW = 'cth.ide.mdView';
const isMarkdown = (rel: string) => /\.(md|markdown)$/i.test(rel);
function defaultMdView(): MdView {
  try {
    const v = window.localStorage.getItem(LS_MD_VIEW);
    if (v === 'code' || v === 'split' || v === 'preview') return v;
  } catch { /* noop */ }
  return 'split';
}

/** Remembers the git rail collapse across IDE opens and app restarts. */
const GIT_RAIL_COLLAPSED_KEY = 'cth.ide.gitRailCollapsed';

// ─── Local mirrors of the main-side git shapes (kept renderer-local like GitTab) ──
interface GitStatusEntry { path: string; index: string; worktree: string }
interface GitStatusT { staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: string[] }

type TabMode = 'edit' | 'diff' | 'revdiff' | 'image';
interface Tab {
  key: string; rel: string; mode: TabMode;
  /** revdiff only: the two sides + a short human label ("a1b2c3d" / "main…feat"). */
  revA?: string; revB?: string; revLabel?: string;
}

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

/** Which agent's workspace the IDE is showing, and how confidently we know it. */
interface IdeTarget {
  agent: Agent | null;
  root: string | null;
  /** True when NOBODY told us which agent this is and we had to guess. The
   *  guess is usually right, but the title says so rather than asserting a name
   *  it cannot stand behind. */
  inferred: boolean;
}

/** Snapshot the IDE's target once at mount. The IDE is a full-window overlay, so
 *  the user can't switch agents while it's open — a stable target is correct.
 *
 *  Preference order, most-trustworthy first:
 *   1. `ideAgentId` — the opener said exactly who this is for.
 *   2. the current selection — right for anything opened off the sidebar.
 *   3. the god agent, then the first agent — last resorts so the IDE still
 *      opens on *something* browsable instead of an empty shell.
 *  Everything past (1) is marked `inferred`, because those paths are exactly the
 *  ones that can disagree with what the user was actually looking at. */
function pickIdeTarget(): IdeTarget {
  const s = useStore.getState();
  const byId = (id: string | null): Agent | null => (id ? s.agents.find((a) => a.id === id) ?? null : null);
  const named = byId(s.ideAgentId);
  if (named?.cwd) return { agent: named, root: named.cwd, inferred: false };
  const guess = byId(s.selectedId) ?? s.agents.find((a) => a.isGod) ?? s.agents[0] ?? null;
  if (guess?.cwd) return { agent: guess, root: guess.cwd, inferred: true };
  return { agent: null, root: null, inferred: false };
}

export function IdePanel() {
  const { t } = useTranslation();
  const setIdeOpen = useStore((s) => s.setIdeOpen);
  const [target] = useState<IdeTarget>(pickIdeTarget);
  const root = target.root;

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [editBuffers, setEditBuffers] = useState<Record<string, EditBuffer>>({});
  const [diffData, setDiffData] = useState<Record<string, DiffData>>({});

  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [status, setStatus] = useState<GitStatusT | null>(null);
  const [treeWidth, setTreeWidth] = useState(300);
  // v0.3.4 git visualization: which rail pane is showing, and the repo's MAIN
  // root (a worktree's history/compare must run against the shared repo).
  const [railTab, setRailTab] = useState<'changes' | 'history' | 'compare'>('changes');
  // Git rail collapse. COLLAPSED BY DEFAULT: the history graph is tall by
  // nature and most IDE opens are "read this file", not "inspect the repo" —
  // starting expanded spent the top 45% of the left column on a pane nobody
  // asked for and pushed the file tree below the fold.
  //
  // The stored value is still honoured in BOTH directions, so a user who opens
  // the rail keeps it open across restarts. Note the test is `!== '0'` rather
  // than `=== '1'`: with no stored value at all we must land on collapsed, and
  // `=== '1'` would have made "never set" mean expanded.
  const [gitCollapsed, setGitCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(GIT_RAIL_COLLAPSED_KEY) !== '0'; } catch { return true; }
  });
  const toggleGitRail = (): void => {
    setGitCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(GIT_RAIL_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  };
  const [gitRoot, setGitRoot] = useState<string | null>(null);
  useEffect(() => {
    if (!root) return;
    let alive = true;
    void window.cth.gitMainRepo(root).then((r) => { if (alive) setGitRoot(r ?? root); });
    return () => { alive = false; };
  }, [root]);
  // Per-markdown-tab view mode (code | split | preview); changing it also
  // updates the sticky default for the next markdown file.
  const [mdViews, setMdViews] = useState<Record<string, MdView>>({});
  const setMdView = useCallback((rel: string, v: MdView) => {
    setMdViews((p) => ({ ...p, [rel]: v }));
    try { window.localStorage.setItem(LS_MD_VIEW, v); } catch { /* noop */ }
  }, []);

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

  /** Force a file into Monaco regardless of type — the "view source" escape
   *  hatch behind the image preview. */
  const openSource = useCallback((rel: string) => { ensureEdit(rel); openTab('edit', rel); }, [ensureEdit, openTab]);

  /** The default open. Images go to the preview instead of Monaco: routing them
   *  through `ensureEdit` is what produced the old "binary file (not
   *  displayable)" tab, since the text reader rejects anything with a null byte.
   *  SVG has no null bytes and so used to open as unhighlighted plaintext — it
   *  is a picture first here too, with `view source` one click away. */
  const openEdit = useCallback((rel: string) => {
    if (isImagePath(rel)) { openTab('image', rel); return; }
    openSource(rel);
  }, [openSource, openTab]);

  // v0.3.4: rev-pinned diff tabs (per-commit files + branch compare). Both
  // sides load through the metadata-guarded git:showFile IPC at the MAIN root.
  const openRevDiff = useCallback((revA: string, revB: string, rel: string, revLabel: string) => {
    const repo = gitRoot ?? root;
    if (!repo) return;
    const key = `rev::${revA}::${revB}::${rel}`;
    setTabs((prev) => (prev.some((t) => t.key === key)
      ? prev
      : [...prev, { key, rel, mode: 'revdiff', revA, revB, revLabel }]));
    setActiveKey(key);
    if (diffDataRef.current[key] && diffDataRef.current[key].status !== 'error') return;
    setDiffData((p) => ({ ...p, [key]: { status: 'loading', head: '', working: '' } }));
    void Promise.all([
      window.cth.gitShowFile(repo, revA, rel),
      window.cth.gitShowFile(repo, revB, rel)
    ]).then(([a, b]) => {
      if (!a.ok || !b.ok) {
        const error = (!a.ok ? a.error : !b.ok ? (b as { error: string }).error : 'diff failed');
        setDiffData((p) => ({ ...p, [key]: { status: 'error', head: '', working: '', error } }));
        return;
      }
      if (a.isBinary || b.isBinary) {
        setDiffData((p) => ({ ...p, [key]: { status: 'binary', head: '', working: '' } }));
        return;
      }
      setDiffData((p) => ({ ...p, [key]: { status: 'ready', head: a.content, working: b.content } }));
    });
  }, [gitRoot, root]);

  // Entry point from elsewhere in the app ("open in IDE" on the file overlay):
  // consume the queued absolute path once the root is known, open it (preview
  // for markdown), then clear the queue slot so a later IDE open starts fresh.
  useEffect(() => {
    if (!root) return;
    const abs = useStore.getState().ideInitialFile;
    if (!abs) return;
    useStore.getState().setIdeInitialFile(null);
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (!abs.startsWith(prefix)) return; // different workspace — tree still lets them browse
    const rel = abs.slice(prefix.length);
    // Same routing as a tree click — an "open in IDE" on a screenshot must land
    // on the preview, not on a tab that refuses to display it.
    openEdit(rel);
    if (isMarkdown(rel)) setMdViews((p) => ({ ...p, [rel]: 'preview' }));
  }, [root, openEdit]);
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

  // Image tabs highlight in the tree too — the tree's job is "what am I looking
  // at", and an image is as much "open" as a text file is.
  const activeEditRel = activeTab && (activeTab.mode === 'edit' || activeTab.mode === 'image')
    ? activeTab.rel
    : undefined;

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
          borderBottom: '1px solid var(--cth-ink-300)',
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
        {/* WHOSE workspace this is. The folder name alone was ambiguous the
            moment two agents shared a repo (worktrees named for the branch, not
            the agent) or an agent worked in a generically-named directory —
            "src" tells you nothing about which of eight agents you are editing
            under. Name first, directory second: the name is the identity, the
            path is the detail. */}
        {target.agent ? (
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <span
              title={target.inferred
                ? t('idePanel.workspaceInferred', { name: target.agent.name })
                : t('idePanel.workspace', { name: target.agent.name })}
              style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600,
                color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '22vw'
              }}
            >{target.agent.name}</span>
            {target.agent.isGod && (
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 7, padding: '1px 3px',
                background: 'var(--cth-lilac-light)', color: 'var(--cth-ink-900)'
              }}>god</span>
            )}
            {target.inferred && (
              // Never assert a name we had to guess at. One quiet word is enough
              // to stop someone trusting the wrong agent's directory.
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                ({t('idePanel.assumed')})
              </span>
            )}
          </span>
        ) : (
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)' }}>
            {t('idePanel.noAgent')}
          </span>
        )}
        <span title={root ?? ''} style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: 'var(--cth-ink-500)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '30vw'
        }}>
          {root ? basename(root) : t('idePanel.noWorkspace')}
        </span>
        <button
          className="cth-titlebar-nodrag"
          onClick={() => setIdeOpen(false)}
          title={t('idePanel.closeIde')}
          aria-label={t('idePanel.closeIde')}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
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
            {/* Git rail: CHANGES · HISTORY · COMPARE (v0.3.4). History/compare
                run at the repo's MAIN root so worktree branches all appear. */}
            <div style={{
              flexShrink: 0, display: 'flex', gap: 2, padding: '6px 10px 4px',
              background: 'var(--cth-cream-50)', borderBottom: '1px solid var(--cth-ink-100)'
            }}>
              <button
                onClick={toggleGitRail}
                title={gitCollapsed ? t('idePanel.expandGit') : t('idePanel.collapseGit')}
                aria-label={gitCollapsed ? t('idePanel.expandGit') : t('idePanel.collapseGit')}
                aria-expanded={!gitCollapsed}
                style={{
                  ...iconBtn,
                  // Mark + caret in ONE control rather than a decorative logo
                  // beside a separate toggle: a git mark that does nothing when
                  // clicked is a dead spot exactly where the eye lands first.
                  // The mark names the section (it is collapsed by default, so
                  // the tab labels are the only other clue), the caret says it
                  // folds, and together they are a bigger hit target than the
                  // caret alone was.
                  display: 'flex', alignItems: 'center', gap: 3, width: 'auto', padding: '0 3px',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 10, lineHeight: '14px',
                  color: 'var(--cth-ink-700)'
                }}
              >
                <Icon name="git" />
                <span aria-hidden>{gitCollapsed ? '▸' : '▾'}</span>
              </button>
              {(['changes', 'history', 'compare'] as const).map((k) => (
                <button
                  key={k}
                  // Picking a tab while collapsed means "show me this" — expanding
                  // is the only reading of that click that isn't a dead end.
                  onClick={() => { setRailTab(k); if (gitCollapsed) toggleGitRail(); }}
                  style={{
                    padding: '1px 8px', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px',
                    textTransform: 'uppercase', color: 'var(--cth-ink-700)',
                    background: railTab === k && !gitCollapsed ? 'var(--cth-sky-light)' : 'transparent',
                    boxShadow: railTab === k && !gitCollapsed ? 'inset 0 0 0 1px var(--cth-ink-300)' : 'none'
                  }}
                >{t(`idePanel.rail.${k}`)}</button>
              ))}
              <span style={{ flex: 1 }} />
              {railTab === 'changes' && !gitCollapsed && (
                <button onClick={() => refreshStatus()} title={t('idePanel.refresh')} style={iconBtn}>
                  <Icon name="web" />
                </button>
              )}
            </div>
            {railTab === 'changes' && !gitCollapsed && (
            <div style={{ flexShrink: 0, maxHeight: '45%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {/* `flex: 1` is what makes this scroll. Without it the scroller's
                  height is its CONTENT height (flex-basis auto), so it grew past
                  the parent's maxHeight and simply overflowed instead of ever
                  reaching its own scroll threshold — a long changed-file list ran
                  off the bottom with no way to reach the end. */}
              <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                {isRepo === false && (
                  <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('gitTab.notARepo')}</div>
                )}
                {isRepo && changedFiles.length === 0 && (
                  <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('gitTab.clean')}</div>
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
                        cursor: 'pointer', fontSize: 12, color: 'var(--cth-ink-900)',
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
            )}
            {railTab === 'history' && gitRoot && !gitCollapsed && (
              <HistoryPane key={gitRoot} gitRoot={gitRoot} onOpenRevDiff={openRevDiff} />
            )}
            {railTab === 'compare' && gitRoot && !gitCollapsed && (
              <ComparePane key={gitRoot} gitRoot={gitRoot} onOpenRevDiff={openRevDiff} />
            )}
            {/* FILES */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--cth-ink-300)' }}>
              <SectionHeader title={t('idePanel.files')} />
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
              {tabs.map((tab) => {
                const active = tab.key === activeKey;
                const buf = editBuffers[tab.rel];
                const dirty = tab.mode === 'edit' && buf?.status === 'ready' && buf.content !== buf.original;
                return (
                  <div
                    key={tab.key}
                    onClick={() => setActiveKey(tab.key)}
                    title={tab.rel}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 8px', height: 30,
                      cursor: 'pointer', flexShrink: 0, maxWidth: 240,
                      background: active ? 'var(--cth-paper-100)' : 'transparent',
                      boxShadow: active ? 'inset 0 -2px 0 var(--cth-sky)' : 'none',
                      borderRight: '1px solid var(--cth-ink-100)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                    }}
                  >
                    {tab.mode !== 'edit' && (
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 7, padding: '1px 3px',
                        background: tab.mode === 'revdiff' ? 'var(--cth-lilac-light)'
                          : tab.mode === 'image' ? 'var(--cth-peach-light)'
                          : 'var(--cth-sky-light)',
                        color: 'var(--cth-ink-900)'
                      }}>{tab.mode === 'revdiff' ? (tab.revLabel ?? t('idePanel.rev')) : tab.mode === 'image' ? t('idePanel.img') : t('idePanel.diff')}</span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {basename(tab.rel)}{dirty ? ' •' : ''}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.key); }}
                      title={t('idePanel.closeTab')}
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
                  <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13 }}>
                    Pick a file from the tree to edit, or a changed file to diff.
                  </div>
                  <ShortcutHint />
                </div>
              )}

              {activeTab?.mode === 'image' && root && (
                <ImagePreview
                  // Keyed by path so switching image tabs tears the previous
                  // preview down — that unmount is what revokes its blob URL.
                  key={activeTab.key}
                  root={root}
                  rel={activeTab.rel}
                  onCopyPath={() => copyAbs(activeTab.rel)}
                  onViewSource={isSvgPath(activeTab.rel) ? () => openSource(activeTab.rel) : undefined}
                />
              )}

              {activeTab?.mode === 'edit' && (() => {
                const buf = editBuffers[activeTab.rel];
                if (!buf || buf.status === 'loading') return <Centered>loading…</Centered>;
                if (buf.status === 'error') return <Centered tone="error">{buf.error}</Centered>;
                const md = isMarkdown(activeTab.rel);
                const view: MdView = md ? (mdViews[activeTab.rel] ?? defaultMdView()) : 'code';
                return (
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <EditorBar
                      rel={activeTab.rel}
                      dirty={buf.content !== buf.original}
                      saveState={buf.saveState}
                      onSave={() => void save(activeTab.rel)}
                      onCopy={() => copyAbs(activeTab.rel)}
                      mdView={md ? view : undefined}
                      onMdView={md ? (v) => setMdView(activeTab.rel, v) : undefined}
                      // The return leg of the SVG round trip: source ⇄ picture.
                      onViewImage={isImagePath(activeTab.rel) ? () => openTab('image', activeTab.rel) : undefined}
                    />
                    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                      {view !== 'preview' && (
                        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                          <MonacoEditor
                            path={activeTab.rel}
                            value={buf.content}
                            onChange={(v) => onEditChange(activeTab.rel, v)}
                            onSave={() => void save(activeTab.rel)}
                          />
                        </div>
                      )}
                      {md && view !== 'code' && (
                        <MdPane
                          rel={activeTab.rel}
                          root={root}
                          source={buf.content}
                          split={view === 'split'}
                          onOpenMarkdownLink={(link) => {
                            openSource(link);
                            setMdViews((p) => ({ ...p, [link]: 'preview' }));
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })()}

              {activeTab?.mode === 'revdiff' && (() => {
                const d = diffData[activeTab.key];
                if (!d || d.status === 'loading') return <Centered>{t('idePanel.loadingDiff')}</Centered>;
                if (d.status === 'error') return <Centered tone="error">{d.error}</Centered>;
                if (d.status === 'binary') return <Centered>{t('idePanel.binaryDiff')}</Centered>;
                return (
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px',
                      background: 'var(--cth-cream-200)', borderBottom: '1px solid var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-500)' }}>
                        {activeTab.revLabel ?? `${activeTab.revA} → ${activeTab.revB}`}
                      </span>
                      <span style={{
                        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        fontFamily: 'var(--cth-font-mono)', textAlign: 'right'
                      }} title={activeTab.rel}>{activeTab.rel}</span>
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <MonacoDiff path={activeTab.rel} original={d.head} modified={d.working} />
                    </div>
                  </div>
                );
              })()}

              {activeTab?.mode === 'diff' && (() => {
                const d = diffData[activeTab.rel];
                if (!d || d.status === 'loading') return <Centered>{t('idePanel.loadingDiff')}</Centered>;
                if (d.status === 'error') return <Centered tone="error">{d.error}</Centered>;
                if (d.status === 'binary') return <Centered>{t('idePanel.binaryDiff')}</Centered>;
                return (
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px',
                      background: 'var(--cth-cream-200)', borderBottom: '1px solid var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ color: 'var(--cth-ink-500)' }}>HEAD</span>
                      <Icon name="arrow-right" />
                      <span>{t('idePanel.workingTree')}</span>
                      <span style={{
                        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        fontFamily: 'var(--cth-font-mono)', textAlign: 'right'
                      }} title={activeTab.rel}>{activeTab.rel}</span>
                      <button onClick={() => ensureDiff(activeTab.rel, true)} title={t('idePanel.refreshDiff')} style={iconBtn}>
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

function EditorBar({ rel, dirty, saveState, onSave, onCopy, mdView, onMdView, onViewImage }: {
  rel: string; dirty: boolean; saveState: EditBuffer['saveState']; onSave: () => void; onCopy: () => void;
  /** Set only for markdown files — renders the code|split|preview switch. */
  mdView?: MdView; onMdView?: (v: MdView) => void;
  /** Set only for files that are ALSO images (SVG) — jumps back to the picture. */
  onViewImage?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={ideBarStyle}>
      <Icon name="code" />
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--cth-font-mono)' }} title={rel}>
        {rel}{dirty ? ' •' : ''}
      </span>
      {mdView && onMdView && (
        <span style={{ display: 'inline-flex', gap: 0 }}>
          {(['code', 'split', 'preview'] as const).map((v) => (
            <button
              key={v}
              onClick={() => onMdView(v)}
              title={v === 'code' ? t('idePanel.mdSourceOnly') : v === 'split' ? t('idePanel.mdSplit') : t('idePanel.mdPreview')}
              style={{
                ...textBtn,
                background: mdView === v ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
                boxShadow: mdView === v ? 'inset 0 0 0 1px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)'
              }}
            >{v === 'code' ? t('idePanel.code') : v === 'split' ? t('idePanel.split') : t('idePanel.preview')}</button>
          ))}
        </span>
      )}
      {onViewImage && (
        <button onClick={onViewImage} title={t('idePanel.viewImage')} style={textBtn}>{t('idePanel.viewImage')}</button>
      )}
      <button onClick={onCopy} title={t('idePanel.copyPath')} style={textBtn}>{t('idePanel.copyPath')}</button>
      <button onClick={onSave} disabled={!dirty || saveState === 'saving'} title={t('idePanel.saveTitle')}
        style={{ ...textBtn, opacity: dirty ? 1 : 0.5 }}>
        {saveState === 'saving' ? '...' : saveState === 'saved' ? t('idePanel.saved') : saveState === 'error' ? t('agentDetail.err') : t('idePanel.save')}
      </button>
    </div>
  );
}

/** Markdown preview pane — renders the LIVE edit buffer (deferred so fast typing
 *  never blocks the editor). In split view it takes the right half behind a
 *  hairline divider; in preview view it fills the body. */
function MdPane({ rel, root, source, split, onOpenMarkdownLink }: {
  rel: string; root: string; source: string; split: boolean; onOpenMarkdownLink: (rel: string) => void;
}) {
  const deferred = useDeferredValue(source);
  return (
    <div style={{
      flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto',
      background: 'var(--cth-paper-100)',
      borderLeft: split ? '1px solid var(--cth-ink-100)' : 'none'
    }}>
      {/* `root` is what lets a report's screenshots render inline instead of
          collapsing to placeholder chips. */}
      <MarkdownPreview source={deferred} baseRel={rel} root={root} onOpenMarkdownLink={onOpenMarkdownLink} />
    </div>
  );
}

/**
 * The IDE's empty state doubles as the only place these capabilities are
 * advertised.
 *
 * Monaco ships find/replace, a command palette and go-to-line/symbol, all of
 * which have worked here since the editor landed — and essentially nobody knew,
 * because the panel never mentioned them and there is no menu bar to discover
 * them from. People asked for "search in the IDE" while ⌘F was already bound.
 * (Repo-wide search is genuinely absent; this hint deliberately promises only
 * what exists.)
 *
 * Kept as a muted list under the empty state rather than a banner: it is the one
 * moment the pane has nothing to say, and it must not compete with an open file.
 */
function ShortcutHint() {
  return (
    <div style={{
      marginTop: 10, display: 'grid', gap: 2, justifyItems: 'center',
      fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-300)'
    }}>
      {EDITOR_SHORTCUTS.map(([keys, label]) => (
        <div key={label} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span style={{ fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-500)' }}>{keys}</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Electron reports the host platform in the UA; there is no platform helper in
 *  the renderer, and printing ⌘ to a Linux user would be worse than useless. */
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);

/** Monaco's own default bindings — do not invent entries here. */
const EDITOR_SHORTCUTS: ReadonlyArray<readonly [string, string]> = IS_MAC
  ? [
      ['⌘F', 'find in file'],
      ['⌥⌘F', 'replace'],
      ['F1', 'command palette'],
      ['⌃G', 'go to line'],
      ['⇧⌘O', 'go to symbol']
    ]
  : [
      ['Ctrl+F', 'find in file'],
      ['Ctrl+H', 'replace'],
      ['F1', 'command palette'],
      ['Ctrl+G', 'go to line'],
      ['Ctrl+Shift+O', 'go to symbol']
    ];

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, textAlign: 'center', fontFamily: 'var(--cth-font-ui)', fontSize: 13,
      color: tone === 'error' ? 'var(--cth-coral)' : 'var(--cth-ink-500)'
    }}>{children}</div>
  );
}
