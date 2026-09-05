import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { AgentControlStrip } from './AgentControlStrip';
import { CommandCenterPanel } from './CommandCenterPanel';
import { EditAgentModal } from './EditAgentModal';
import { Icon } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { PORTRAIT_W } from '@/scene/office/portraitArt';
import { RealtimeMichaelToggle } from './RealtimeMichaelToggle';
import { CostHud } from '@/realtime/CostHud';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useTerminalFontSize } from './terminalFontSize';
import { useHasTerminalDraft, disposeTerminal, reflowTerminal, notifyThemeChangeAll } from './terminalPool';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import type { HarnessConfig } from '@/store/config';
import { useRtl } from '@/i18n/useDirection';

/** 花名册侧栏宽度。固定 232px 在 14 寸笔记本上刚好，但在 27 寸
 *  显示器上就显得像一条细缝，名字毫无理由地被截断——所以它在
 *  这两个端点之间跟随视口变化。 */
const SIDEBAR_WIDTH = 'clamp(232px, 14vw, 340px)';
/** 跨全屏会话和应用重启记住花名册的折叠状态。 */
const ROSTER_COLLAPSED_KEY = 'cth.fullscreen.rosterCollapsed';

/** 花名册文字缩放，取自共享的终端缩放，这样 Cmd +/- 会随终端一起
 *  调整整个花名册——整个视图只用一个旋钮，而不是一个只在其调校过的
 *  显示器上才好看的大小。每一项都做了钳制：名字是像素显示字体，
 *  离原生尺寸太远就会糊成一团；而圆点无论终端缩放多远，
 *  都必须始终从属于名字。 */
function rosterScale(zoom: number) {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  // 头像按 SPRITE 步进缩放，而不是自由像素。美术是一枚 18×28 的
  // 像素印章：仅仅加宽贴图只会把它拉胖（这正是旧的
  // `clamp(zoom * 1.2, 18, 40)` 在超过 18px 之后做的事——同一个
  // 小人被放进了更大的框里），而像 1.37× 这样的缩放会让某些像素行
  // 占一个设备像素高、另一些占两个。半步步进让每隔一行干净地翻倍，
  // 这就是尺寸所在的网格。下限是 1.5×——1× 太小，无法一眼区分两个
  // 高清晰度，而这正是贴图存在的全部意义。
  const portraitScale = Math.min(2.5, Math.max(1.5, Math.round(zoom * 0.11 * 2) / 2));
  return {
    name: clamp(zoom * 0.48, 7, 14),
    group: clamp(zoom * 0.45, 7, 13),
    note: clamp(zoom * 0.68, 10, 20),
    portraitScale,
    portrait: Math.round(PORTRAIT_W * portraitScale)
  };
}

function basename(path: string): string {
  // 同时按两种分隔符拆分：`git:mainRepo` 返回平台使用的任意形式，
  // 而 Windows 的 `C:\work\repo` 根本不包含 '/'——所以只按 '/' 拆分
  // 会把整个绝对路径当作该组的"名称"返回。
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** cwd → 主仓库 basename，每个路径只解析一次，由所有挂载共享。
 *  隔离 agent 的 cwd 是它自己的 git worktree（`…/worktrees/<agent-id>`），
 *  因此按该路径命名分组会把每个这样的 agent 归到自己的 id 下，
 *  而不是用户实际选择的仓库。`git:mainRepo` 会顺着链接的 worktree
 *  回到它的主检出。 */
const repoRootByCwd = new Map<string, string | null>();
/** 正在查询中的 cwd，这样一次重渲染不会启动第二次查询。 */
const repoLookupsInFlight = new Set<string>();

/** agent 属于哪个仓库——取 ABSOLUTE 根，所以它是真正的身份标识。
 *  两个无关的检出可能共享同一个 basename（`~/client-a/app` 和
 *  `~/client-b/app`）；按名字给组键控会把它们合并成一个区块，
 *  还允许 agent 在两个不同仓库之间被拖拽。
 *
 *  在异步解析落地之前，以及对于根本不是 git 仓库的目录，
 *  回退到 cwd 本身。 */
function repoKeyOf(agent: Agent): string {
  return repoRootByCwd.get(agent.cwd) || agent.cwd || 'unknown';
}

/** 该组叫什么——basename，或用户选择的项目名。 */
function repoLabelOf(agent: Agent): string {
  const root = repoRootByCwd.get(agent.cwd);
  if (root) return basename(root);
  const project = agent.project?.trim();
  if (project) return project;
  return basename(agent.cwd) || 'unknown';
}

/** 解析每个不同 cwd 的仓库根，然后重新渲染。每个不同路径
 *  恰好只调用一次 git。 */
function useResolvedRepoNames(agents: Agent[]): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const pending = [...new Set(agents.map(a => a.cwd).filter(Boolean))]
      // 用 `has`（而不是真值检查），这样解析结果为 null 的路径——
      // 即不是 git 仓库的 cwd——也算作已回答。只缓存成功意味着
      // 仓库外的每个 agent 每次都会重新询问，而这个 effect 依赖
      // `agents`，pty 解析器会在每块终端输出到达时替换它：
      // 曾经有一个这样的 agent 只要还在说话就持续地 spawn `git rev-parse`。
      // 进行中的路径也会被跳过，因此查找中途的重渲染不会
      // 叠加出第二轮子进程。
      .filter(cwd => !repoRootByCwd.has(cwd) && !repoLookupsInFlight.has(cwd));
    if (pending.length === 0) return;
    pending.forEach(cwd => repoLookupsInFlight.add(cwd));
    void Promise.all(pending.map(async (cwd) => {
      try {
        repoRootByCwd.set(cwd, (await window.cth.gitMainRepo(cwd)) || null);
      } catch {
        // 把失败也记为已回答——重试一个抛错的路径，
        // 正是无界子进程 bug 的成因。
        repoRootByCwd.set(cwd, null);
      } finally {
        repoLookupsInFlight.delete(cwd);
      }
    })).then(() => { if (!cancelled) setVersion(v => v + 1); });
    return () => { cancelled = true; };
  }, [agents]);
  return version;
}

/** agent 所在的花名册区块——god agents 共享一个不分组区块，
 *  其余按仓库分组。 */
function groupKey(agent: Agent): string {
  return agent.isGod ? '__god__' : repoKeyOf(agent);
}

/** 传给每一行的拖拽重排接线。 */
interface RowDrag {
  dragId: string | null;
  overId: string | null;
  start: (id: string) => void;
  over: (id: string) => void;
  leave: (id: string) => void;
  drop: (id: string) => void;
  end: () => void;
}

export interface FullscreenTerminalProps {
  /** 仅用于为早于 `command` 字段保存的可恢复 agent 重建 spawn 命令——
   *  与 AgentStrip 中职责相同。 */
  config?: HarnessConfig | null;
}

export function FullscreenTerminal({ config }: FullscreenTerminalProps) {
  const { t } = useTranslation();
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const setFullscreen = useStore(s => s.setFullscreen);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const addAgentOpen = useStore(s => s.addAgentOpen);
  // 状态归属在这里而非 Header，纯粹是为了让下面的 Esc 处理器能看到它：
  // Esc 关闭对话框时不能顺便把你扔出焦点模式。
  const [editAgentOpen, setEditAgentOpen] = useState(false);
  const setAgentNote = useStore(s => s.setAgentNote);
  const updateAgent = useStore(s => s.updateAgent);
  // 底层条带（连同其中的恢复按钮）被遮罩盖住了，
  // 所以花名册也要承担恢复功能。
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  const appThemeNow = useAppTheme();

  const agent = agents.find(a => a.id === fullscreenAgentId);
  const parser = usePtyParser(agent?.id ?? '__none__');

  const repoVersion = useResolvedRepoNames(agents);
  const scale = rosterScale(useTerminalFontSize());

  // 拖拽重排，与底层条带相同（原生 HTML5 DnD，无依赖）。普通
  // 点击仍会选择——只有移动才开始拖拽。放置被限制在
  // 被拖 agent 自己的组内：仓库头部来自它的 cwd，因此跨组放置
  // 会重排数组，然后行又立刻弹回自己的头部之下，
  // 看起来就像"重排坏了"。
  const reorderAgents = useStore(s => s.reorderAgents);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 花名册折叠。持久化是因为它是一种工作偏好，而非一种模式：
  // 为了阅读宽终端输出而隐藏侧栏的人，希望下次进入全屏时它仍然
  // 隐藏着，而不是每次都要重新隐藏一遍。
  const [rosterCollapsed, setRosterCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(ROSTER_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleRoster = (): void => {
    setRosterCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(ROSTER_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* 隐私模式 */ }
      return next;
    });
  };
  const drag: RowDrag = {
    dragId,
    overId,
    start: (id) => setDragId(id),
    over: (id) => setOverId((prev) => (prev === id ? prev : id)),
    leave: (id) => setOverId((prev) => (prev === id ? null : prev)),
    drop: (id) => {
      if (dragId && dragId !== id) {
        const from = agents.find(a => a.id === dragId);
        const to = agents.find(a => a.id === id);
        if (from && to && groupKey(from) === groupKey(to)) reorderAgents(dragId, id);
      }
      setDragId(null);
      setOverId(null);
    },
    end: () => { setDragId(null); setOverId(null); }
  };

  // 花名册：god agents 排在最前且不分组，其余按仓库分桶。
  // 每个桶内保持插入顺序（这是用户自己在底层条带上
  // 拖拽重排的结果），桶按首次出现顺序排列，
  // 因此列表不会随状态变化而重新洗牌。
  const { gods, groups } = useMemo(() => {
    const godList: Agent[] = [];
    // 按绝对仓库根键控（身份）；标签随行携带，
    // 让两个同名仓库仍是两个组，但仍可按名字阅读。
    const byRepo = new Map<string, { label: string; members: Agent[] }>();
    for (const a of agents) {
      if (a.isGod) { godList.push(a); continue; }
      const key = repoKeyOf(a);
      const bucket = byRepo.get(key);
      if (bucket) bucket.members.push(a);
      else byRepo.set(key, { label: repoLabelOf(a), members: [a] });
    }
    return { gods: godList, groups: [...byRepo.entries()] };
    // repoVersion：异步主仓库查找落地后重新分桶。
  }, [agents, repoVersion]);

  // 焦点模式：添加（或移除）agent 会改变聚焦终端周围的布局，
  // 但没有任何东西重新适配它，所以网格会一直错位，直到用户
  // 切换 agent 再切回来（一次重新挂载，因此重新适配）。
  // 每次花名册变化都重新适配。reflowTerminal 只在 cols/rows
  // 真正变化时才去触碰 pty，且从不滚动，所以一次无操作的花名册
  // 变化不花任何代价。跑两遍：一遍在布局稳定后，一遍在花名册
  // 行绘制完成后。
  const rosterKey = agents.map(a => a.id).join('\n');
  const focusedPtyId = agent?.ptyId;
  useEffect(() => {
    if (!focusedPtyId) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => reflowTerminal(focusedPtyId)));
    const late = setTimeout(() => reflowTerminal(focusedPtyId), 240);
    return () => { cancelAnimationFrame(raf); clearTimeout(late); };
  }, [rosterKey, focusedPtyId]);

  // Esc 退出全屏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 全屏上方的模态框在其关闭前拥有交互权。没有这层
        // 防护，Add Agent 表单中的 Esc 会意外退出全屏。
        if (addAgentOpen || editAgentOpen) return;
        e.preventDefault();
        setFullscreen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addAgentOpen, editAgentOpen, setFullscreen]);

  // 焦点模式正指向某个我们无法渲染的东西。把它重新安置到另一个
  // 在线 agent，而不是把用户直接踢出去；只有什么都不剩时才离开。
  // 放在 effect 里而非 render 中：render 期间 setState 是 React 反模式，
  // 而且在这里硬置 null 会和 onKill 一样破坏 store 的重新安置。
  // 用 `refocusFullscreen` 而不是 `setFullscreen`：这是应用在跟随用户，
  // 而不是用户告诉应用他们想要什么。走这里显式的 toggle 会在每次
  // agent 离开时写入 `prefersFocusMode = false`，这正是那个
  // "修好 store，再从调用处覆盖它"的陷阱，它曾弄坏过焦点模式下
  // 关闭 agent 的功能。
  useEffect(() => {
    if (agent && agent.ptyId) return;
    const s = useStore.getState();
    const next = s.agents.find((a) => a.id !== agent?.id && a.ptyId);
    s.refocusFullscreen(next?.id ?? null);
  }, [agent]);

  if (!agent || !agent.ptyId) return null;

  // 这里刻意不放杀进程按钮。杀 agent 是破坏性操作，
  // 应当与其余生命周期控件一起放在停靠面板中；
  // 把它放在离你点击切换 agent 的标签页几英寸的地方，
  // 它只会是迟早会发生的误点。退出全屏同样已被覆盖了两遍
  // （Esc，以及终端工具栏自己的全屏开关）。
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-100)',
      zIndex: 250,
      display: 'flex',
      flexDirection: 'column',
      paddingTop: 36  // 为 macOS 红绿灯 / 拖拽区留出空间
    }}>
      {/* 标题栏拖拽区（让用户仍能移动窗口） */}
      <div
        className="cth-titlebar-drag"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex', alignItems: 'center',
          paddingLeft: 96, paddingRight: 12, gap: 12,
          userSelect: 'none'
        }}
      >
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px',
          color: 'var(--cth-ink-900)'
        }}>MUNDER DIFFLIN · FOCUS MODE</span>
        {/* 与主标题栏相同的右上角控件——全屏会盖住标题栏，
            所以主题 / 退出全屏 / IDE 也必须在这里。 */}
        <div className="cth-titlebar-nodrag" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={toggleRoster}
            title={rosterCollapsed ? t('fullscreenTerminal.showAgentList') : t('fullscreenTerminal.hideAgentList')}
            aria-label={rosterCollapsed ? t('fullscreenTerminal.showAgentList') : t('fullscreenTerminal.hideAgentList')}
            aria-pressed={rosterCollapsed}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              // 折叠时呈按下状，这样侧栏的消失读起来是这个按钮
              // 保持的一种状态，而不是出了什么毛病。
              background: rosterCollapsed ? 'var(--cth-lemon)' : 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: rosterCollapsed ? 'var(--cth-ink-900)' : 'var(--cth-ink-900)'
            }}
          >
            <Icon name="sidebar" size={1} style={{ width: 16, height: 16 }} />
          </button>
          <button
            onClick={() => {
              const next = toggleAppTheme();
              void window.cth.updateConfig({ terminalTheme: next });
              // 焦点模式有自己的主题按钮，所以只从标题栏开关通知的话，
              // 从这里做出的切换永远到不了正在运行的 TUI。
              // 两个入口都必须告诉它们。
              notifyThemeChangeAll(next === 'dark' ? 'dark' : 'light');
            }}
            title={appThemeNow === 'dark' ? t('fullscreenTerminal.lightTheme') : t('fullscreenTerminal.darkTheme')}
            aria-label={t('fullscreenTerminal.toggleTheme')}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: 'var(--cth-ink-900)', fontSize: 13, lineHeight: 1
            }}
          >
            {appThemeNow === 'dark' ? '☀' : '☾'}
          </button>
          {/* 设置——主标题栏有它，全屏也必须有：一种模式能访问而
              另一种不能的东西都是陷阱。复用 App 现有的
              `cth:open-settings` 事件而不是新增 store action，
              因为这个遮罩层不是 App 的子元素。 */}
          <button
            className="cth-settings-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('cth:open-settings'))}
            title={t('fullscreenTerminal.settingsTitle')}
            aria-label={t('fullscreenTerminal.settingsTitle')}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: 'var(--cth-ink-900)'
            }}
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true" focusable="false"
            >
              <path d="M15.5 3.5a5 5 0 0 0-6.1 6.1l-5.6 5.6a2.3 2.3 0 1 0 3.2 3.2l5.6-5.6a5 5 0 0 0 6.1-6.1l-3 3-2.2-.6-.6-2.2z" />
            </svg>
          </button>
          <button
            onClick={() => setFullscreen(null)}
            title={t('fullscreenTerminal.exitFullscreen')}
            aria-label={t('fullscreenTerminal.exitFullscreen')}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0,
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', borderRadius: 2, cursor: 'pointer',
              color: 'var(--cth-ink-900)'
            }}
          >
            <Icon name="minimize" size={1} style={{ width: 16, height: 16 }} />
          </button>
          {/* v0.3.4: IDE 移到了 agent 层级——它住在每个 agent 的
              头部（见下方 Header），不在这个全局栏里。 */}
        </div>
      </div>

      {/* 主体——左侧花名册，右侧聚焦 agent 的终端。
          垂直列表能扩展到横向标签栏只能显示几个 agent 的数量之上，
          而且按仓库分组正是用户思考整个团队的方式。 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* 折叠时卸载而不是 width:0——花名册为每个 agent 渲染一行
            实时状态，若保留一个隐藏副本挂载着，就会为一条没人看得见的
            侧栏继续做那些工作。重新挂载代价很低；终端活在池子里，
            不受此影响。 */}
        {!rosterCollapsed && (
        <aside style={{
          width: SIDEBAR_WIDTH, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          background: 'var(--cth-cream-200)',
          borderRight: '1px solid var(--cth-ink-300)'
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--cth-ink-300)' }}>
            <button
              onClick={() => setAddAgentOpen(true)}
              title={t('fullscreenTerminal.addAgent')}
              style={{
                width: '100%', height: 32,
                background: 'var(--cth-cream-100)',
                border: 'none',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 'clamp(14px, 0.7vw, 15px)',
                color: 'var(--cth-ink-900)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                cursor: 'pointer'
              }}
            >
              <Icon name="plus" /> {t('agentStrip.addAgent')}
            </button>
          </div>

          <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}>
            {/* god agent 运行整个大厅而不是某个检出，所以它没有
                仓库头部——它独自坐在花名册顶部。 */}
            {gods.map(a => (
              <SidebarRow
                key={a.id}
                agent={a}
                active={a.id === agent.id}
                onClick={() => { select(a.id); setFullscreen(a.id); }}
                onNoteChange={(note) => setAgentNote(a.id, note)}
                drag={drag}
                scale={scale}
              />
            ))}
            {groups.map(([repoKey, { label, members }]) => (
              // 仓库才是花名册真正的结构，所以它们需要真正的
              // 分隔——上方一条发丝线加空隙，而不只是标签。
              <div key={repoKey} style={{ marginTop: 16, paddingTop: 10, borderTop: '1px solid var(--cth-ink-300)' }}>
                <div
                  title={repoKey}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '0 10px 6px',
                    fontFamily: 'var(--cth-font-display)',
                    fontSize: scale.group, lineHeight: 1.5,
                    color: 'var(--cth-ink-500)'
                  }}
                >
                  {/* 原生 16px，绝不用它的几分之一：这是绘制在 16 单位
                      网格上的像素艺术，所以把它压到和 7px 标签一样大
                      会把轮廓糊成一团。用变暗代替缩小。 */}
                  <span style={{ flexShrink: 0, display: 'inline-flex', opacity: 0.7 }}>
                    <Icon name="folder" size={scale.group >= 13 ? 2 : 1} />
                  </span>
                  <span style={{
                    minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>{label.toUpperCase()}</span>
                </div>
                {members.map(a => (
                  <SidebarRow
                    key={a.id}
                    agent={a}
                    active={a.id === agent.id}
                    onClick={() => { select(a.id); setFullscreen(a.id); }}
                    onNoteChange={(note) => setAgentNote(a.id, note)}
                    drag={drag}
                    scale={scale}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* 上一会话的团队，与底层条带相同——固定在底部，
              这样它不会被滚到一长条花名册后面够不着。 */}
          {(restorableAgents.length > 0 || autoRestoring) && (
            <div style={{
              flexShrink: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
              borderTop: '1px solid var(--cth-ink-300)'
            }}>
              {autoRestoring && (
                // 与底层条带相同的横幅：自行打开的终端需要说明原因。
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 8px',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                  color: 'var(--cth-ink-900)',
                  background: 'var(--cth-status-working)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>
                  <Icon name="play" /> restoring your team…
                </div>
              )}
              {!autoRestoring && restorableAgents.length > 0 && (
                <PixelButton
                  variant="primary"
                  size="sm"
                  onClick={restoreTeam}
                  disabled={restoring}
                  style={{ width: '100%' }}
                  title={t('fullscreenTerminal.respawnTitle', { names: restorableAgents.map((a: Agent) => a.name).join(', ') })}
                >
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="play" /> {restoring ? t('agentStrip.restoringTeam') : t('agentStrip.restoreTeam', { count: restorableAgents.length })}
                  </span>
                </PixelButton>
              )}
              {!autoRestoring && restorableAgents.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {restorableAgents.map((a: Agent) => (
                    <span
                      key={a.id}
                      title={`${a.name} — restorable from last session`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                        height: 20, padding: '0 2px 0 6px',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                        color: 'var(--cth-ink-700)', background: 'var(--cth-paper-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                      }}
                    >
                      {a.name}
                      <button
                        onClick={() => useStore.getState().removeRestorableAgent(a.id)}
                        title={`Dismiss ${a.name} — remove permanently from the restore list`}
                        aria-label={`Dismiss ${a.name}`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 14, height: 14, padding: 0, lineHeight: 1,
                          fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                          color: 'var(--cth-ink-500)', background: 'transparent',
                          border: 'none', cursor: 'pointer'
                        }}
                      >✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
        )}

        <div style={{
          flex: 1, minWidth: 0, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          padding: 12, gap: 10
        }}>
          {agent.isGod ? (
            // Michael 从指挥中心运行整个大厅——它的那些标签页（tasks、
            // ask me、triggers、memory、graph…）正是选中他的全部意义所在，
            // 而全屏模式以前会为了一台裸终端把它们全部丢掉。
            // 用列布局，这样面板的 `height: 100%` 能解析出确定的高度，
            // `align-items: stretch` 则给它完整宽度。
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <CommandCenterPanel agent={agent} fullscreen />
            </div>
          ) : (
            <>
              <Header agent={agent} onEdit={() => setEditAgentOpen(true)} />
              {editAgentOpen && (
                <EditAgentModal agent={agent} onClose={() => setEditAgentOpen(false)} />
              )}

              {/* #7C — pause / halt / steer。这些以前只存在于停靠的
                  侧边栏中，所以进入全屏就把操作员控件拿走了。 */}
              <AgentControlStrip key={agent.id} agentId={agent.id} />

              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                  <PtyTerminalView
                    key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                    ptyId={agent.ptyId}
                    onStreamData={parser}
                    onUserPrompt={(t) => {
                      updateAgent(agent.id, { lastPrompt: t });
                      if (t.trim().toLowerCase() === '/clear') {
                        updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                      }
                      void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                    }}
                    onToggleFullscreen={() => setFullscreen(null)}
                    fullscreen
                  />
                </div>
                <MessageQueueComposer agent={agent} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 模型 id 很长且大多是样板文本（"claude-opus-4-8[1m]"、
 *  "anthropic/claude-sonnet-4-5"）。花名册只有约 120px，
 *  所以显示区分不同 agent 的那部分，完整 id 放在 tooltip 里。 */
function shortModel(model?: string): string | null {
  if (!model || !model.trim()) return null;
  const tail = model.split('/').pop() ?? model;
  return tail
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')          // 末尾日期戳
    .replace(/\[(\d+)m\]/i, ' $1m') // [1m] → 1m
    .replace(/-/g, ' ')
    .trim();
}

/** 上下文饱满度，用一条 3px 轨道表示。颜色跟随压力而非身份——
 *  处于 85% 的 agent 即将压缩，这比它的强调色更重要。 */
function ContextBar({ tokens, limit, accent }: { tokens?: number; limit?: number; accent: string }) {
  const { t } = useTranslation();
  if (tokens === undefined || !limit) return null;
  const pct = Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
  const color = pct >= 85 ? 'var(--cth-coral)' : pct >= 65 ? 'var(--cth-lemon)' : `var(--cth-${accent})`;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (
    <div
      title={t('fullscreenTerminal.contextTitle', { used: k(tokens), limit: k(limit), pct })}
      style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
    >
      <span style={{
        flex: 1, minWidth: 0, height: 3,
        background: 'var(--cth-ink-100)', overflow: 'hidden'
      }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
      </span>
      <span style={{ flexShrink: 0, fontSize: 9, color: 'var(--cth-ink-500)' }}>{pct}%</span>
    </div>
  );
}

function SidebarRow({
  agent,
  active,
  onClick,
  onNoteChange,
  drag,
  scale
}: {
  agent: Agent;
  active: boolean;
  onClick: () => void;
  onNoteChange: (note: string) => void;
  drag: RowDrag;
  scale: ReturnType<typeof rosterScale>;
}) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const [notePosition, setNotePosition] = useState<{ left: number; top: number } | null>(null);

  // 编辑器跟随终端的缩放，但设了上限——它是短便条，不是阅读面板，
  // 完全跟随终端缩放会把它变成比花名册还宽的横幅。
  const noteFontSize = Math.min(useTerminalFontSize(), 14);
  const noteLabelSize = Math.max(8, Math.round(noteFontSize * 0.6));
  const noteWidth = Math.min(300, Math.round(noteFontSize * 20));
  const noteHeight = Math.round(noteFontSize * 9);
  // 弹层总高度，仅用于让它贴着底部边缘保持在屏幕内：
  // 便条文本框加上它的标签、提示和内边距。
  const popoverHeight = noteHeight + noteLabelSize * 2 + 40;

  // 便条的一行 = 行上的一个圆点。
  const bullets = (agent.note ?? '').split('\n').map(s => s.trim()).filter(Boolean);

  const typing = useHasTerminalDraft(agent.ptyId);

  /** ✎ 按钮在行旁打开编辑器——行上的圆点是摘要，这里才是书写处。
   *  仅显式打开（v0.3.4）：悬停花名册不再在指针下弹出编辑器。 */
  const toggleEditor = () => {
    if (notePosition) { setNotePosition(null); return; }
    // 拖拽中途弹出一个编辑器只会碍事。
    if (drag.dragId) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 花名册是左侧栏，所以编辑器在其行右侧打开。
    // 钳制让靠近边缘的行也完整保持在屏幕内。
    setNotePosition({
      left: Math.min(rect.right + 6, window.innerWidth - noteWidth - 8),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - popoverHeight - 8))
    });
  };

  return (
    <>
      <button
        ref={buttonRef}
        draggable
        onDragStart={(e) => { drag.start(agent.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(e) => {
          if (!drag.dragId || drag.dragId === agent.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          drag.over(agent.id);
        }}
        onDragLeave={() => drag.leave(agent.id)}
        onDrop={(e) => { e.preventDefault(); drag.drop(agent.id); }}
        onDragEnd={drag.end}
        onClick={onClick}
        aria-label={`${agent.name} · ${agent.project}`}
        aria-current={active ? 'true' : undefined}
        style={{
          width: '100%',
          padding: '6px 8px',
          background: active ? 'var(--cth-cream-100)' : 'transparent',
          border: 'none',
          boxShadow: active
            ? 'inset 3px 0 0 var(--cth-ink-900), inset 0 0 0 1px var(--cth-ink-100)'
            // 悬停放置目标上的插入提示。
            : drag.overId === agent.id && drag.dragId && drag.dragId !== agent.id
            ? 'inset 0 2px 0 var(--cth-ink-900)'
            : 'none',
          opacity: drag.dragId === agent.id ? 0.4 : 1,
          display: 'flex', alignItems: 'flex-start', gap: 8,
          cursor: drag.dragId ? 'grabbing' : 'grab',
          position: 'relative',
          textAlign: 'left',
          fontFamily: 'var(--cth-font-ui)', fontSize: 13,
          color: 'var(--cth-ink-900)',
          transition: 'opacity 120ms ease'
        }}
      >
        <div style={{
          width: scale.portrait, height: Math.round(scale.portrait * 1.3), flexShrink: 0,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          // 锚定精灵图的顶部：画像比这个贴图高，而底部锚定
          // 会裁掉头部——裁脚不裁脸（v0.3.4）。
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          overflow: 'hidden'
        }}>
          {/* 精灵图按恰好等于贴图宽度的尺寸绘制，因此形象
              随贴图一起变大，而不是悬浮在其中。 */}
          <SpritePortrait character={agent.character} scale={scale.portraitScale} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{
              flex: 1, minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              fontFamily: 'var(--cth-font-display)',
              fontSize: scale.name, lineHeight: 1.5
            }}>{agent.name.toUpperCase()}</span>
            {/* 你未发送的文本在这里优先于 agent 自身状态：一个在提示
                框里拖着草稿的 idle agent 不是 idle-and-free，而是
                idle-and-held，而屏幕上没有任何别处这么说。 */}
            <PixelBadge status={typing ? 'typing' : agent.status} />
            {/* 显式备注编辑——一个真正的控件，而不是悬停惊喜。
                用 span 而非 <button>：我们位于该行的按钮元素内部。 */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); toggleEditor(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggleEditor(); }
              }}
              title={agent.note ? t('agentCard.editNote') : t('agentCard.addNote')}
              aria-label={t('agentCard.editNoteAria', { name: agent.name })}
              style={{
                flexShrink: 0, width: 20, height: 20,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, lineHeight: 1, color: 'var(--cth-ink-500)',
                background: notePosition ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                cursor: 'pointer'
              }}
            >✎</span>
          </div>
          {/* 一眼看出这个 agent 是什么。花名册以前只带
              名字、头像和一个状态点——足够区分行与行，却不足以回答
              "这个跑在什么模型上、在哪工作、上下文有多满"，
              而这正是当终端占满整个屏幕、侧边栏是你唯一索引时
              你需要的信息。 */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
            fontSize: Math.max(9, scale.name - 3), lineHeight: 1.4,
            color: 'var(--cth-ink-500)'
          }}>
            <span style={{
              flexShrink: 0, maxWidth: '52%',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }} title={agent.model ? t('fullscreenTerminal.modelTitle', { model: agent.model }) : t('fullscreenTerminal.cliDefault')}>
              {shortModel(agent.model) ?? t('fullscreenTerminal.cliDefault')}
            </span>
            <span style={{ flexShrink: 0, opacity: 0.5 }}>·</span>
            <span style={{
              flex: 1, minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }} title={agent.worktreePath || agent.cwd}>
              {basename(agent.worktreePath || agent.cwd) || agent.project}
            </span>
          </div>
          <ContextBar tokens={agent.contextTokens} limit={agent.contextLimit} accent={agent.accent} />
          {/* 每个 agent 的每一行都常驻屏幕——花名册的职责就是
              无需任何交互就回答"谁在做什么"。 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {bullets.map((line, i) => (
              <span
                key={i}
                title={line}
                style={{
                  display: 'flex', gap: 5, alignItems: 'baseline',
                  fontSize: scale.note, lineHeight: 1.35,
                  color: 'var(--cth-ink-500)'
                }}
              >
                <span style={{ flexShrink: 0, color: 'var(--cth-ink-300)' }}>•</span>
                {/* 每个圆点恰好一行——折行会让花名册的高度
                    在输入备注时来回跳动。全文放在悬停上
                    （title 与旁边的编辑器）。 */}
                <span style={{
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>{line}</span>
              </span>
            ))}
            {bullets.length === 0 && (
              <span style={{
                fontSize: scale.note, lineHeight: 1.35,
                color: 'var(--cth-ink-300)', fontStyle: 'italic'
              }}>{t('fullscreenTerminal.noNote')}</span>
            )}
          </div>
        </div>
      </button>
      {notePosition && createPortal(
        <>
        {/* 点击外部关闭的背景层——编辑器会一直保留，直到刻意关闭 */}
        <div
          onClick={() => setNotePosition(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 449, background: 'transparent' }}
        />
        <div
          ref={noteRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: notePosition.left,
            top: notePosition.top,
            width: noteWidth,
            zIndex: 450,
            padding: 8,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), 4px 4px 0 rgba(26,19,32,0.25)',
            boxSizing: 'border-box'
          }}
        >
          <div style={{
            marginBottom: 6,
            fontFamily: 'var(--cth-font-display)',
            fontSize: noteLabelSize,
            lineHeight: `${Math.round(noteLabelSize * 1.5)}px`,
            color: 'var(--cth-ink-700)'
          }}>{t('fullscreenTerminal.privateNote')}</div>
          {/* 用 textarea 而非 input：备注是项目符号列表，所以 Enter
              必须新建一行而不是什么都不做。autoFocus 现在很安全，
              因为打开是显式点击，不是指针飞掠。 */}
          <textarea
            dir={rtl ? 'auto' : undefined}
            autoFocus
            value={agent.note ?? ''}
            onChange={(e) => onNoteChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation(); // 别让 Esc/输入触达全屏处理器
              if (e.key === 'Escape') {
                setNotePosition(null);
                buttonRef.current?.focus();
              }
            }}
            placeholder={t('agentStrip.notePlaceholder')}
            aria-label={t('agentCard.noteAria', { name: agent.name })}
            style={{
              width: '100%',
              height: noteHeight,
              padding: '5px 7px',
              border: 'none',
              outline: 'none',
              resize: 'vertical',
              boxSizing: 'border-box',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              fontFamily: 'var(--cth-font-mono)',
              fontSize: noteFontSize,
              lineHeight: `${Math.round(noteFontSize * 1.6)}px`,
              color: 'var(--cth-ink-900)'
            }}
          />
          <div style={{
            marginTop: 5, fontSize: 10, color: 'var(--cth-ink-500)'
          }}>{t('fullscreenTerminal.noteHint')}</div>
        </div>
        </>,
        document.body
      )}
    </>
  );
}

function Header({ agent, onEdit }: { agent: Agent; onEdit: () => void }) {
  const { t } = useTranslation();
  const typing = useHasTerminalDraft(agent.ptyId);
  const archiveAgent = useStore((st) => st.archiveAgent);
  const [openState, setOpenState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');

  /** 与停靠面板相同的动作：在这个 agent 的工作目录打开
   *  OS 终端。全屏以前没有途径做到这一点，这很反常——
   *  这正是你最可能想在其旁边开一个 shell 的模式。 */
  const openTerminal = async () => {
    setOpenState('opening');
    try {
      const res = await window.cth.openTerminalAt(agent.worktreePath || agent.cwd);
      setOpenState(res.ok ? 'ok' : 'error');
    } catch { setOpenState('error'); }
    setTimeout(() => setOpenState('idle'), 1500);
  };

  /** 杀掉并归档，与 AgentDetailPanel 一致。需要确认，
   *  因为它会终止一个正在运行的进程。god 豁免：大厅会立即
   *  把它重生，所以那个按钮会读作"重启 Michael"，
   *  却长得像"关闭"。 */
  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(t('agentDetail.killConfirm', { name: agent.name }))) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    // archiveAgent 会把焦点模式重新安置到下一个 agent，并且只有当
    // 最后一个也消失时才离开它。在这里硬置 null 会丢掉那一切，
    // 这正是即使在 store 修复之后，从焦点模式内部关闭 agent
    // 仍会把你丢回侧边栏的原因。
    archiveAgent(agent.id);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '6px 10px',
      background: 'var(--cth-cream-50)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px',
        color: 'var(--cth-ink-900)'
      }}>{agent.name.toUpperCase()}</span>
      {/* 编辑归属在名字旁，而不是右侧的操作簇：它改变的是这个
          agent 是谁，而右侧那组是"对这个 agent 做什么"。仅图标，
          因为它位于身份行内部——那里的 "edit" 一词会把路径挤掉。
          god 被排除在外，与其他各处一致：他的身份属于整个 hive，
          不属于花名册。 */}
      {!agent.isGod && (
        <PixelButton variant="secondary" size="sm" onClick={onEdit}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip={`Edit ${agent.name}: their name and face, which engine they run on, and the briefing that tells them what they are for.`}
            aria-label={`Edit ${agent.name}`}
            style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
          >
            <Icon name="edit" />
          </span>
        </PixelButton>
      )}
      <span style={{
        fontSize: 12, color: 'var(--cth-ink-500)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxWidth: 300
      }}>{agent.cwd}</span>
      <span style={{
        fontSize: 12, color: 'var(--cth-ink-700)',
        fontStyle: 'italic'
      }}>“{agent.description}”</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* v0.3.4: IDE 从 agent 层级打开——这个 agent 工作区上的
            完整 Monaco 编辑器 + git diff。id 是显式传入的：
            全屏不改变选择，所以让 IDE 自己推断 agent 会打开侧边栏里
            恰好被选中的那个，而不是填满屏幕的这个。 */}
        <PixelButton variant="secondary" size="sm" onClick={() => useStore.getState().setIdeOpen(true, agent.id)}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('fullscreenTerminal.ideTip', { name: agent.name })}
            aria-label={t('fullscreenTerminal.openIdeAria')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="code" /> {t('commandCenter.ide')}
          </span>
        </PixelButton>
        {/* 语音开关在全屏中始终可达——它全局控制 Michael（god
            编排器），而不是当前视图里的 agent，因此即使用户在
            worker 的终端占满屏幕时也能开始一次语音会话。成本
            HUD 仍只属于 Michael（它属于他的卡片）。 */}
        <RealtimeMichaelToggle />
        {agent.isGod && <CostHud compact />}
        <PixelButton variant="secondary" size="sm" onClick={openTerminal} disabled={openState === 'opening'}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('fullscreenTerminal.openTerminalTip', { cwd: agent.worktreePath || agent.cwd })}
            aria-label={t('fullscreenTerminal.openTerminalAria')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="terminal" />
            {openState === 'opening' ? t('agentDetail.opening') : openState === 'ok' ? t('agentDetail.ok') : openState === 'error' ? t('agentDetail.err') : t('agentDetail.open')}
          </span>
        </PixelButton>
        {/* 徽章是一种 STATUS，不是按钮，但它和按钮排在一行。
            它自身的盒高是 20px（lineHeight 18 + 2px 内边距），
            而每个 size="sm" 的 PixelButton 都固定在 24px，
            所以这一行读起来参差不齐。通过徽章自身的 style
            属性来定尺寸，而不是用包装器：包装器只是把 20px 的盒
            居中到 24px 里，并不会让可见边框对齐。 */}
        <PixelBadge
          status={typing ? 'typing' : agent.status}
          style={{ height: 24, padding: '0 8px', lineHeight: '24px' }}
        />
        {!agent.isGod && (
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            {/* inline-flex + center：其他按钮持有 TEXT，其行盒由按钮
                免费居中。裸 <Icon> 是替换内容，落在文本基线上，
                所以它会偏下并超出 24px 盒——按钮量起来和邻居一样，
                看起来却比它们高。 */}
            <span
              title={t('fullscreenTerminal.closeAgent', { name: agent.name })}
              style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
            >
              <Icon name="x" />
            </span>
          </PixelButton>
        )}
      </div>
    </div>
  );
}
