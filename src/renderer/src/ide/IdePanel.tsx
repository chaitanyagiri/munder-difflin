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

// v0.3.4 文本预览：每个 md 标签页独立的查看模式，默认取上次的选择。
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

/** 记住 Git 侧栏在 IDE 打开与 App 重启之间的折叠状态。 */
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

/** IDE 正在显示哪个 agent 的工作区，以及我们对它的确信程度。 */
interface IdeTarget {
  agent: Agent | null;
  root: string | null;
  /** 当没有任何人告诉我们这是哪个 agent、而我们只能猜测时为 true。
   *  猜测通常是对的，但标题如实说明，而不是断言一个它无法担保的名字。 */
  inferred: boolean;
}

/** 在挂载时快照一次 IDE 的目标。IDE 是全窗口浮层，因此打开期间用户无法
 *  切换 agent——一个稳定的目标是正确的。
 *
 *  偏好顺序，最可信者优先：
 *   1. `ideAgentId`——打开者明确说了这是为谁打开的。
 *   2. 当前选中项——适合任何从侧边栏打开的内容。
 *   3. god agent，然后是第一个 agent——兜底方案，让 IDE 仍能在*某个*
 *      可浏览的东西上打开，而不是一个空壳。
 *  (1) 之后的一切都标记为 `inferred`，因为这些路径正是可能
 *  与用户实际在看的东西不一致的那些。 */
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
  // v0.3.4 Git 可视化：当前显示哪个侧栏面板，以及仓库的 MAIN
  // 根（worktree 的历史/对比必须针对共享仓库运行）。
  const [railTab, setRailTab] = useState<'changes' | 'history' | 'compare'>('changes');
  // Git 侧栏折叠。默认折叠：历史图天然很高，而大多数 IDE 打开是「读这个文件」，
  // 不是「检查仓库」——一开始就展开会把左侧栏顶部 45% 花在没人要的面板上，
  // 并把文件树挤到折线以下。
  //
  // 存储的值在「两个方向」上都被尊重，所以打开了侧栏的用户在重启后仍保持打开。
  // 注意判断是 `!== '0'` 而不是 `=== '1'`：完全没有存储值时必须落在折叠态，
  // 而 `=== '1'` 会让「从未设置」被当成展开。
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
  // 每个 markdown 标签页的查看模式（code | split | preview）；修改它也会
  // 更新下一个 markdown 文件的固定默认值。
  const [mdViews, setMdViews] = useState<Record<string, MdView>>({});
  const setMdView = useCallback((rel: string, v: MdView) => {
    setMdViews((p) => ({ ...p, [rel]: v }));
    try { window.localStorage.setItem(LS_MD_VIEW, v); } catch { /* noop */ }
  }, []);

  // 使用 Refs 让 window/editor 处理器始终读到当前值，而无需重新绑定。
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeKeyRef = useRef(activeKey); activeKeyRef.current = activeKey;
  const editBuffersRef = useRef(editBuffers); editBuffersRef.current = editBuffers;
  const diffDataRef = useRef(diffData); diffDataRef.current = diffData;

  const activeTab = useMemo(() => tabs.find((t) => t.key === activeKey) ?? null, [tabs, activeKey]);

  // ─── 缓冲区 / diff 加载器 ────────────────────────────────────────────────
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
        const error = 'error' in res && typeof res.error === 'string' ? res.error : '差异失败';
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

  // ─── 标签页操作 ──────────────────────────────────────────────────────────
  const openTab = useCallback((mode: TabMode, rel: string) => {
    const key = tabKey(mode, rel);
    setTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, rel, mode }]));
    setActiveKey(key);
  }, []);

  /** 无论类型如何都把文件强制塞进 Monaco —— 图片预览背后的「查看源码」逃生门。 */
  const openSource = useCallback((rel: string) => { ensureEdit(rel); openTab('edit', rel); }, [ensureEdit, openTab]);

  /** 默认打开方式。图片进入预览而非 Monaco：把图片走 `ensureEdit` 正是产生旧版
   *  「二进制文件（无法显示）」标签的原因，因为文本读取器会拒绝任何含空字节的内容。
   *  SVG 没有空字节，所以过去会以无高亮的纯文本打开——在这里它同样是先当作图片，
   *  而「查看源码」只差一次点击。 */
  const openEdit = useCallback((rel: string) => {
    if (isImagePath(rel)) { openTab('image', rel); return; }
    openSource(rel);
  }, [openSource, openTab]);

  // v0.3.4：rev 固定的 diff 标签页（单提交文件 + 分支对比）。两侧都经由
  // MAIN 根上带元数据保护的 git:showFile IPC 加载。
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
        const error = (!a.ok ? a.error : !b.ok ? (b as { error: string }).error : '差异失败');
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

  // 来自 App 其他位置的入口（文件浮层上的「在 IDE 中打开」）：一旦知道 root
  // 就消费排队的绝对路径，打开它（markdown 走预览），然后清空队列槽，
  // 以便后续的 IDE 打开重新开始。
  useEffect(() => {
    if (!root) return;
    const abs = useStore.getState().ideInitialFile;
    if (!abs) return;
    useStore.getState().setIdeInitialFile(null);
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (!abs.startsWith(prefix)) return; // different workspace — tree still lets them browse
    const rel = abs.slice(prefix.length);
    // 与点击文件树相同的路由——对截图「在 IDE 中打开」必须落到预览上，
    // 而不是落到一个拒绝显示它的标签页上。
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
      // original ← 写入时的精确快照（保存开始时捕获的 buf.content），而不是 p[rel].content：
      // 如果用户在进行中的写入期间继续输入，那些按键会留在 content 中并保持 dirty
      // （content !== original），从而在下一次保存时被持久化，而不会被静默丢弃。
      setEditBuffers((p) => ({ ...p, [rel]: { ...p[rel], original: buf.content, saveState: 'saved' } }));
      setTimeout(() => setEditBuffers((p) => (p[rel] ? { ...p, [rel]: { ...p[rel], saveState: 'idle' } } : p)), 1200);
      void refreshStatus();
    } else {
      setEditBuffers((p) => ({ ...p, [rel]: { ...p[rel], saveState: 'error', error: res.error } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // ─── Git 状态（已变更文件）──────────────────────────────────────────
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

  // ─── 键盘：Cmd/Ctrl+S 保存当前编辑标签页；Esc 关闭（若无未保存内容）──
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

  // ─── 左侧分隔条拖拽 ───────────────────────────────────────────────────
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

  // 图片标签页同样在文件树中高亮——文件树的作用是「我正在看什么」，
  // 而一张图片和文本文件一样是「打开」状态。
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
        {/* 这是谁的工作区。两个 agent 共享一个仓库（worktree 以分支而非 agent 命名）
            或某个 agent 在一个通用命名的目录里工作时，单凭文件夹名就变得含糊——
            「src」完全无法告诉你此刻在哪个 agent（八个之一）底下编辑。
            名字在前、目录在后：名字是身份，路径只是细节。 */}
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
              }}>{t('idePanel.god')}</span>
            )}
            {target.inferred && (
              // 绝不武断断言一个我们只能猜测的名字。一个不起眼的词就足以
              // 阻止别人误信了错误 agent 的目录。
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
          {t('idePanel.noWorkspace')}<br />{t('idePanel.spawnFirst')}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* ── Left: changes + file tree ── */}
          <div style={{
            width: treeWidth, flexShrink: 0, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            borderRight: '1px solid var(--cth-ink-700)', background: 'var(--cth-cream-50)'
          }}>
            {/* Git 侧栏：CHANGES · HISTORY · COMPARE（v0.3.4）。历史/对比
                针对仓库的 MAIN 根运行，这样 worktree 的所有分支都会出现。 */}
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
                  // 把标记 + 箭头放进「一个」控件，而不是装饰性 logo 旁再放一个
                  // 独立开关：一个点击毫无反应的 git 标记，正是目光最先落下的死区。
                  // 标记指明该分区（它默认折叠，所以标签文字是唯一线索），箭头表示
                  // 可折叠，两者合起来比单独的箭头拥有更大的点击目标。
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
                  // 折叠时点某个标签意味着「给我看这个」——展开是那次点击
                  // 唯一不算死路的解读。
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
              {/* `flex: 1` 才让它能滚动。没有它时滚动器的高度等于其内容高度
                  （flex-basis auto），于是它超出父级 maxHeight 直接溢出，
                  永远达不到自己的滚动阈值——一长串变更文件列表在底部被截断，
                  没有任何办法滚到末尾。 */}
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
                  }}>{t('idePanel.nothingOpen')}</div>
                  <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13 }}>
                    {t('idePanel.pickFileToEdit')}
                  </div>
                  <ShortcutHint />
                </div>
              )}

              {activeTab?.mode === 'image' && root && (
                <ImagePreview
                  // 以路径为 key，这样切换图片标签会拆除上一个预览——
                  // 正是那次卸载撤销了它的 blob URL。
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
                      // SVG 往返的返回段：源码 ⇄ 图片。
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
  /** 仅对 markdown 文件设置——渲染 code|split|preview 切换开关。 */
  mdView?: MdView; onMdView?: (v: MdView) => void;
  /** 仅对同时也是图片的文件（SVG）设置——跳回图片视图。 */
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

/** Markdown 预览面板——渲染「实时」编辑缓冲（延迟处理，快速输入永不阻塞编辑器）。
 *  分屏视图里它占据细分割线后的右半部分；预览视图里它填满主体。 */
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
      {/* `root` 正是让报告里的截图能内联渲染、而不是塌缩成占位小片的原因。 */}
      <MarkdownPreview source={deferred} baseRel={rel} root={root} onOpenMarkdownLink={onOpenMarkdownLink} />
    </div>
  );
}

/**
 * IDE 的空状态兼作这些能力的唯一宣传位。
 *
 * Monaco 自带查找/替换、命令面板和跳转到行/符号，这些自编辑器落地起就能用——
 * 但几乎没人知道，因为面板从未提过它们，也没有菜单栏可供发现。
 * 用户一边问「在 IDE 里搜索」，一边 ⌘F 早已绑定。（仓库级搜索确实没有；
 * 这个提示刻意只承诺真实存在的东西。）
 *
 * 以空状态下的低调列表而非横幅呈现：这是面板唯一无话可说的时刻，
 * 它不能和打开的文件抢注意力。
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

/** Electron 在 UA 里报告宿主平台；renderer 中没有平台辅助函数，
 *  给 Linux 用户印出 ⌘ 会比毫无用处更糟。 */
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);

/** Monaco 自身的默认快捷键——不要在这里编造条目。 */
const EDITOR_SHORTCUTS: ReadonlyArray<readonly [string, string]> = IS_MAC
  ? [
      ['⌘F', '在文件中查找'],
      ['⌥⌘F', '替换'],
      ['F1', '命令面板'],
      ['⌃G', '转到行'],
      ['⇧⌘O', '转到符号']
    ]
  : [
      ['Ctrl+F', '在文件中查找'],
      ['Ctrl+H', '替换'],
      ['F1', '命令面板'],
      ['Ctrl+G', '转到行'],
      ['Ctrl+Shift+O', '转到符号']
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
