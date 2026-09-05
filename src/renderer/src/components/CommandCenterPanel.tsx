import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { MessageQueueComposer } from './MessageQueueComposer';
import { TasksKanban } from './TasksKanban';
import { AskMeTab } from './AskMeTab';
import { TriggersTab } from './triggers/TriggersTab';
import { TriggerHistoryTab } from './triggers/TriggerHistoryTab';
import { WorkersTab } from './WorkersTab';
import { SkillsTab } from './SkillsTab';
import { acquireTerminal, disposeTerminal, resetTerminal } from './terminalPool';
import { terminalInstanceKey } from './terminalRecovery';
import { Icon } from './Icon';
import { MemoryGraphPanel } from './MemoryGraphPanel';
import { useFleetTelemetry } from '@/hooks/useTelemetry';
import { COMMAND_GROUPS } from '@shared/claudeCommands';
import { roleForHiveSpawn } from '@shared/agentRole';
import { useStore, triggerHistoryVisible, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import {
  buildSpawnCommand,
  decodeProviderModel,
  encodeProviderModel,
  inferAgentProvider,
  isClaudeProvider,
  modelProvidersForAgent,
  modelsForProvider,
  providerPreset,
  tokenizeCommand,
  AGENT_PROVIDER_PRESETS,
  type AgentProvider
} from '@/store/config';
import { canReceiveInbox } from '@shared/agentProvider';
import { isComposingKey } from '@shared/imeGuard';
import { useRtl } from '@/i18n/useDirection';

/** Michael 的控制面板。当选中 god agent 时，替代普通终端/文件面板显示：
 *  终端 + 队列、底层花名册（含每个 agent 的模型 + 分发 + 助手访问）、
 *  记忆视图，以及实时活动流 / 看板 / 用量表。 */

// AskMe（#human）标签页和 Triggers 标签页都在这里。Triggers 取代了
// 旧的 Schedules 标签页：schedule 现在只是四种触发器类型之一，
// 整个界面位于 ./triggers（契约见 src/shared/triggers.ts）。
type CCTab = 'terminal' | 'floor' | 'tasks' | 'human' | 'triggers' | 'trigger-history'
  | 'memory' | 'graph' | 'activity' | 'skills' | 'workers';

/** 当未配置底层 token 预算时，每个 agent token 表的回退分母——
 *  这样进度条读作"预算估算（已用 + 剩余）"，而不会因为某个
 *  agent 烧 token 最多就被钉死在 100%。 */
const DEFAULT_TOKEN_CAP = 1_000_000;

/** `window.cth.githubIssues` 返回的 GitHub issue（labels/assignees 已扁平化）。 */
interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** 规范标签页顺序。并非每个条目始终显示——见 `visibleTabs`。 */
const TABS: { key: CCTab; labelKey: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'terminal', labelKey: 'commandCenter.tabs.terminal', icon: 'terminal' },
  { key: 'floor', labelKey: 'commandCenter.tabs.floor', icon: 'mcp' },
  { key: 'tasks', labelKey: 'commandCenter.tabs.tasks', icon: 'check' },
  { key: 'human', labelKey: 'commandCenter.tabs.human', icon: 'bell' },
  { key: 'triggers', labelKey: 'commandCenter.tabs.triggers', icon: 'clock' },
  { key: 'trigger-history', labelKey: 'commandCenter.tabs.history', icon: 'ledger' },
  { key: 'memory', labelKey: 'commandCenter.tabs.memory', icon: 'sparkle' },
  { key: 'graph', labelKey: 'commandCenter.tabs.graph', icon: 'web' },
  { key: 'activity', labelKey: 'commandCenter.tabs.activity', icon: 'bell' },
  { key: 'skills', labelKey: 'commandCenter.tabs.skills', icon: 'sparkle' },
  { key: 'workers', labelKey: 'commandCenter.tabs.workers', icon: 'gear' }
];

/** @param fullscreen 此实例就是全屏遮罩，因此它拥有 pty
 *  并渲染真实终端。停靠实例渲染"在全屏中打开"占位符——
 *  一个 pty 上两个实时 xterm 会争夺它的 cols/rows 并破坏显示。 */
export function CommandCenterPanel({ agent, fullscreen = false }: { agent: Agent; fullscreen?: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CCTab>('terminal');
  // 在外部一方能触达我们之前，触发器历史台账没什么可显示的，
  // 所以只有当存在 org key 或 webhook 时它的标签页才出现。这是
  // 面板里第一个受配置门控的标签页：TABS 保持规范顺序，
  // 门在渲染时应用，因此其他任何地方都不用知道它。
  // 规则本身放在 store（`triggerHistoryVisible`）里，与它所读的
  // 两面镜子相邻——这里再抄一份会与 Settings 脱节。
  const showHistory = useStore(triggerHistoryVisible);
  // 绝不让面板停留在一个刚刚被隐藏的标签页上。
  useEffect(() => {
    if (!showHistory && tab === 'trigger-history') setTab('terminal');
  }, [showHistory, tab]);
  const visibleTabs = TABS.filter((t) => t.key !== 'trigger-history' || showHistory);

  // 外部标签页请求（办公室任务看板 → 'tasks'，老板办公室的
  // 日历 → 'triggers'）。按 seq 键控，这样即使标签页已被请求过，
  // 再次点击仍会重新打开它。
  const ccTabRequest = useStore((s) => s.ccTabRequest);
  useEffect(() => {
    if (!ccTabRequest) return;
    const key = ccTabRequest.tab as CCTab;
    if (!TABS.some((t) => t.key === key)) return;
    // 实时读取门而不是依赖它——把它当作依赖的话，
    // 会在标签页出现的那一刻重新触发一个过期的请求。
    if (key === 'trigger-history' && !triggerHistoryVisible(useStore.getState())) return;
    setTab(key);
  }, [ccTabRequest]);
  // 任务详情的"assign"会预填 Floor 分发框并跳转到它。
  // 通过 store 的一次性投递播种（详情浮层现在全应用范围共用）；
  // { seq } 让每次 assign 都互不相同，因此相同的文本也能重新播种。
  const [dispatchSeed, setDispatchSeed] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const dispatchSeedRequest = useStore((s) => s.dispatchSeedRequest);
  useEffect(() => {
    if (!dispatchSeedRequest) return;
    setDispatchSeed({ text: dispatchSeedRequest.text, seq: dispatchSeedRequest.seq });
  }, [dispatchSeedRequest]);
  // 提升到这里，让记忆图标签页能跳到某个特定 agent 的记忆文件。
  const [selectedMemoryAgent, setSelectedMemoryAgent] = useState<string | null>(null);
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const onPtyStream = usePtyParser(agent.id);
  // 仅在遮罩持有此 agent 时的 DOCKED 面板中为 true。
  const isFullscreenedHere = fullscreenAgentId === agent.id && !fullscreen;
  // v0.3.4: 单个全大厅自动投递开关，从逐 agent 控制条上移到这里——
  // 切换会对每个在线 agent 生效，god 也包括在内。
  // 从 god 自身的控制状态播种（大厅由这个单一控件保持同步，
  // 因此任何 agent 的状态都反映大厅的状态）。
  const [floorDeliveryPaused, setFloorDeliveryPaused] = useState(false);
  useEffect(() => {
    let alive = true;
    window.cth.controlSnapshot(agent.id)
      .then((s) => { if (alive && s) setFloorDeliveryPaused(s.autoDeliveryPaused); })
      .catch(() => { /* 无 */ });
    return () => { alive = false; };
  }, [agent.id]);
  const toggleFloorDelivery = async () => {
    const next = !floorDeliveryPaused;
    setFloorDeliveryPaused(next);
    const all = useStore.getState().agents;
    await Promise.all(all.map((a) => window.cth.controlAutoDelivery(a.id, next).catch(() => null)));
  };

  return (
    <PixelPanel
      variant="default"
      noPadding
      style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0, overflow: 'hidden' }}
    >
      {/* 头部 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32, background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        {/* 标题 + 副标题截断；控件簇永不收缩。在侧边栏宽度下，
            旧头部把 24 字符的 display 字体标题折成三行，并在两个
            宽按钮下面把"runs the floor"逐词断行——这里的一切
            构造上都是单行。 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-900)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>{t('commandCenter.title')}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1, minWidth: 0 }}>
            <PixelBadge status={agent.status} />
            <span style={{
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>{t('commandCenter.runsTheFloor', { name: agent.name })}</span>
          </div>
        </div>
        {/* v0.3.4: 全大厅自动投递就在这里（每个 agent 队列共用一个开关），
            IDE 从 agent 层级打开，而不是工具栏。
            短标签——tooltip 承载完整说明。 */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <PixelButton
            variant={floorDeliveryPaused ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => { void toggleFloorDelivery(); }}
          >
            <span
              className="cth-tip cth-tip-wrap"
              data-tip={floorDeliveryPaused
                ? t('commandCenter.deliveryPausedTitle')
                : t('commandCenter.deliveryOnTitle')}
              aria-label={floorDeliveryPaused
                ? t('commandCenter.deliveryResumeAria')
                : t('commandCenter.deliveryHoldAria')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name={floorDeliveryPaused ? 'pause' : 'play'} />
              {floorDeliveryPaused ? t('commandCenter.deliveryPaused') : t('commandCenter.deliveryAuto')}
            </span>
          </PixelButton>
          {/* 无自身 agent 的大厅级界面：诚实的对象是当前选中的那个，
              显式写出而不是留给 IDE 的回退逻辑，
              这样意图在调用处就可见。 */}
          <PixelButton variant="secondary" size="sm" onClick={() => {
            const s = useStore.getState();
            s.setIdeOpen(true, s.selectedId);
          }}>
            <span
              className="cth-tip cth-tip-wrap"
              data-tip={t('commandCenter.ideTitle')}
              aria-label={t('commandCenter.openIdeAria')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name="code" /> {t('commandCenter.ide')}
            </span>
          </PixelButton>
        </div>
      </div>

      {/* 标签栏——单行，标签按自然宽度排列，仅在面板
          确实窄到放不下所有标签时才滚动。

          这曾是一个等宽单元格的自动适配网格，等宽正是它的失败模式：
          每列都按最宽的标签取宽，于是轨道数量由最长的标签决定，
          而不是标签实际需要的总宽度。加入第 12 个标签后，
          它在全屏宽度下被挤爆，把 `setup` 丢到第二行，
          而第一行还有大量空间没用——这些标签需要约 1320px 内容，
          当时却有约 1610px。

          按内容定宽的标签能把全部十二个放进一行还有富余，而且
          global.css 里的 `.cth-tabbar` 规则（scrollbar-width: none,
          ::-webkit-scrollbar { height: 0 }）正是为此而存在：
          一行、滚动、滚动条隐藏。网格从不滚动，
          所以这些规则自它落地以来就是死代码。

          权衡是刻意的：在窄的停靠面板里，最右侧的标签现在会
          滚出视野，而不是折成可见的第二行。一行（偶尔需要滚动）
          胜过两行其中一行几乎全空——而且网格存在的理由本身
          （让折行后的行对齐）在只有一行的时候就不再适用。 */}
      <div className="cth-tabbar" style={{
        display: 'flex', gap: 4,
        // 停靠在侧边栏时面板很窄，所以标签会换行：第二行
        // 只花去高列的几个像素，而横向滚动会把一半标签藏在一个
        // 毫无提示的手势后面。
        // 焦点模式下面板很宽，垂直空间才是稀缺资源，
        // 所以保持一行并改为滚动。global.css 里的 `.cth-tabbar`
        // 已经隐藏了那条滚动条。
        flexWrap: fullscreen ? 'nowrap' : 'wrap',
        overflowX: fullscreen ? 'auto' : 'visible',
        padding: '6px 8px', background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        {visibleTabs.map((tabDef) => (
          <button
            key={tabDef.key}
            onClick={() => setTab(tabDef.key)}
            style={{
              whiteSpace: 'nowrap',
              // 增长以分摊多余宽度（这样条带仍像旧网格那样
              // 恰好横跨面板），但绝不缩到标签以下（被压扁的
              // 标签不可读——溢出到滚动里即可）。
              flex: '1 0 auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '4px 8px 3px', border: 'none', cursor: 'pointer',
              background: tab === tabDef.key ? `var(--cth-${agent.accent})` : 'var(--cth-cream-200)',
              // 选中标签用 agent 的强调色填充，它在两个主题下都是
              // 浅色。ink-900 在深色模式下翻转为近白色，所以活动标签
              // 的文字曾因浅上加浅而几乎看不清——而那正是你最需要
              // 读的那个标签。on-accent 文字在两个主题下都是深色。
              color: tab === tabDef.key ? 'var(--cth-on-accent)' : 'var(--cth-ink-900)',
              boxShadow: tab === tabDef.key
                ? 'inset 0 0 0 1px var(--cth-ink-300)'
                : 'inset 0 0 0 1px var(--cth-ink-100)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13
            }}
          >
            <Icon name={tabDef.icon} /> {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      {/* 主体 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'terminal' && (
          isFullscreenedHere ? (
            <Centered>{t('commandCenter.terminalFullscreen')}</Centered>
          ) : agent.ptyId ? (
            <>
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <PtyTerminalView
                  key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                  ptyId={agent.ptyId}
                  onStreamData={onPtyStream}
                  onUserPrompt={(t) => {
                    updateAgent(agent.id, { lastPrompt: t });
                    if (t.trim().toLowerCase() === '/clear') {
                      updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                    }
                    void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                  }}
                  onToggleFullscreen={() => setFullscreen(fullscreen ? null : agent.id)}
                  fullscreen={fullscreen}
                  embedded={!fullscreen}
                />
              </div>
              <MessageQueueComposer agent={agent} />
            </>
          ) : (
            <Centered>{t('commandCenter.noTerminal', { name: agent.name })}</Centered>
          )
        )}
        {tab === 'floor' && <FloorTab seed={dispatchSeed} />}
        {tab === 'tasks' && <TasksKanban />}
        {tab === 'human' && <AskMeTab />}
        {tab === 'triggers' && <TriggersTab />}
        {tab === 'trigger-history' && <TriggerHistoryTab />}
        {tab === 'memory' && (
          <MemoryTab godId={agent.id} who={selectedMemoryAgent ?? undefined} onWho={setSelectedMemoryAgent} />
        )}
        {tab === 'graph' && (
          <MemoryGraphPanel
            godId={agent.id}
            onJumpToMemory={(id) => { setSelectedMemoryAgent(id); setTab('memory'); }}
          />
        )}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'skills' && <SkillsTab agentCwd={agent.cwd} />}
        {tab === 'workers' && <WorkersTab />}
      </div>
    </PixelPanel>
  );
}

// ─── Floor 标签页 — 花名册、模型、分发、目录、助手 ────────────────────

function FloorTab({ seed }: { seed: { text: string; seq: number } }) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const agents = useStore((s) => s.agents);
  const godName = agents.find((a) => a.isGod)?.name ?? 'the orchestrator';
  const select = useStore((s) => s.select);
  const updateAgent = useStore((s) => s.updateAgent);
  const toolCounts = useStore((s) => s.toolCounts);
  // 每个 agent 的实时 OpenTelemetry——合并到下面每个 agent 卡片中
  // （旧的独立 Fleet 标签页并入此处，让花名册在一个地方同时展示
  // 身份 + 控件 AND 实时成本/用量）。
  const { samples, spark, rate, lastTool, breakers } = useFleetTelemetry();
  const [repos, setRepos] = useState<string[]>([]);
  // 全大厅 token 预算（驱动熔断器）；也是 token 表的分母。
  const [tokenCap, setTokenCap] = useState<number | undefined>(undefined);
  // 每个 agent 的 token 上限（覆盖该 agent 的大厅预算），按 id 键控。
  const [agentTokenCaps, setAgentTokenCaps] = useState<Record<string, number>>({});
  const [restarting, setRestarting] = useState<string | null>(null);
  const [engineProvider, setEngineProvider] = useState<AgentProvider>('claude');
  const [engineModel, setEngineModel] = useState<string | undefined>(undefined);
  const [restartErrors, setRestartErrors] = useState<Record<string, string>>({});
  // harness 自身的默认模型（设置 → 默认模型）。Michael 和每个新 agent
  // 都用它 spawn，因此选择器要标记它——否则唯一显示"默认"的条目
  // 是 CLI 的那个，而那完全是另一回事。
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [dispatchTo, setDispatchTo] = useState<string>(''); // '' = 由 Michael 决定
  const [dispatchText, setDispatchText] = useState('');
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  // ── ISSUES 区块状态 ──
  const [issueRepo, setIssueRepo] = useState<string>('');
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  useEffect(() => {
    window.cth.getConfig().then((c) => {
      setRepos(c.registeredRepos ?? []);
      setTokenCap(c.costCapTokens);
      setAgentTokenCaps(c.agentTokenCaps ?? {});
      setEngineProvider(c.godProvider ?? 'claude');
      setEngineModel(c.godModel);
      setDefaultModel(c.defaultModel);
    }).catch(() => { /* 空操作 */ });
  }, []);

  // 从任务卡片的"assign"播种分发框（按 seq 键控，重复 assign
  // 会重新预填）。seq === 0 是未触碰的初始状态——跳过它。
  useEffect(() => {
    if (seed.seq > 0) setDispatchText(seed.text);
  }, [seed.seq, seed.text]);

  // 原地重启一个 agent 的 PTY。`resume:true` 会重新挂接它之前的 Claude
  // 会话（`--resume <sessionId>`，由主进程从 hive registry 按 agent id
  // 解析）——这就是"Restart & Continue"：在一个全新进程里干净地
  // 重绘 TUI，且不丢失线索，这是损坏/花屏终端的逃生舱
  // （例如把窗口拖到不同尺寸的显示器之间导致的 xterm 重排）。
  // 当 `resume` 未设置时是旧行为：一次启动全新会话的模型变更。
  const restartWithModel = async (
    a: Agent,
    model: string | undefined,
    opts: {
      resume?: boolean;
      provider?: AgentProvider;
      /** 能续则续，不能续就从新开始，而不是拒绝。
       *  "Restart & Continue"要的是硬失败——续上才是全部意义所在，
       *  默默开一个空白会话比报错更糟。模型变更要的是软失败：
       *  用户要的是换模型，而没有记录会话的 agent 也仍然必须
       *  得到一个会话。 */
      resumeOptional?: boolean;
    } = {}
  ) => {
    if (!a.ptyId) return;
    setRestarting(a.id);
    setRestartErrors((errors) => ({ ...errors, [a.id]: '' }));
    try {
      const cfg = await window.cth.getConfig();
      // 在这个 agent 已在运行的同一个 CLI 上重生（若未显式标记，
      // 则从其 command 推断），这样 Antigravity/Codex worker 就
      // 留在自己的二进制上。tokenizeCommand 让带引号的模型标签
      // 保持为一个参数。opts.provider 覆盖推断出的 provider——
      // 用于更换 GOD 的引擎。
      const previousProvider = inferAgentProvider(a.command, a.provider);
      const provider = opts.provider ?? previousProvider;
      let resume = opts.resume === true && provider === previousProvider;
      if (opts.resume && !resume && !opts.resumeOptional) {
        throw new Error('无法通过不同的提供商续接会话。');
      }
      let resumeSessionId: string | undefined;
      if (resume) {
        // 前置不满足对显式"continue"是致命的，对机会式的续接
        // 则只意味着"重新开始"（见 resumeOptional）。
        const giveUpOnResume = (reason: string) => {
          if (!opts.resumeOptional) throw new Error(reason);
          resume = false;
          resumeSessionId = undefined;
        };
        const registry = await window.cth.hiveRegistry();
        resumeSessionId = registry.agents[a.id]?.sessionId;
        if (!resumeSessionId) {
          giveUpOnResume('没有记录的会话 ID；当前进程仍在运行。');
        } else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeSessionId))) {
          giveUpOnResume('找不到会话转录；当前进程仍在运行。');
        }
      }
      // 在替换任何东西之前捕获实时网格。Restart & Continue
      // 只重建这个 agent 的 xterm；模型变更保留旧的
      // 原地重置行为。
      const oldEntry = acquireTerminal(a.ptyId);
      let cols = oldEntry.term.cols || 100;
      let rows = oldEntry.term.rows || 30;
      try {
        oldEntry.fit.fit();
        cols = oldEntry.term.cols;
        rows = oldEntry.term.rows;
      } catch { /* 宿主尚未完成尺寸设置 */ }

      const killed = await window.cth.killPty(a.ptyId);
      // 已经消失的 pty 正是这次 kill 想要达到的状态，
      // 所以它不是失败。这是到达"Restart & Continue"最常见的方式：
      // 会话自己死了——一次崩溃，或连按两次 Ctrl-C——主进程把它
      // 从会话表中移除，kill 于是回答 `no pty: <id>`。
      // 把它当作致命错误会在重生之前就中断，
      // 把这个按钮存在的唯一情形变成死路。
      if (!killed.ok && !/^no pty:/.test(killed.error ?? '')) {
        throw new Error(killed.error ?? '无法停止当前进程。');
      }
      if (resume) {
        // 空白的 xterm 即使在 PTY 健康之后也可能保留损坏的
        // renderer/DOM/订阅状态。把这个终端扔掉，在 spawn 之前
        // 获取它的替代品（这样启动输出就有监听者），然后
        // 提升 key，让 React 只重新挂载这个 agent 的终端卡片。
        disposeTerminal(a.ptyId);
        acquireTerminal(a.ptyId);
        updateAgent(a.id, {
          terminalGeneration: (a.terminalGeneration ?? 0) + 1,
          status: 'idle',
          action: '正在重建终端…'
        });
      } else {
        resetTerminal(a.ptyId);
      }
      const command = buildSpawnCommand(cfg, model, provider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const hive = {
        id: a.id,
        name: a.name,
        cwd: a.cwd,
        provider,
        isGod: a.isGod,
        isAssistant: a.isAssistant,
        role: roleForHiveSpawn(a)
      };
      const res = await window.cth.spawnPty({
        id: a.ptyId,
        cwd: a.cwd,
        command: exe,
        args,
        provider,
        cols,
        rows,
        hive,
        resume,
        resumeSessionId,
        requireResume: resume
      });
      if (!res.ok) throw new Error(res.error ?? 'Restart failed.');
      if (resume && res.resumed !== true) {
        throw new Error('恢复被拒绝；未接受任何替代会话。');
      }
      if (res.ok) {
        // 即使在续接时也记录模型。同 provider 的模型变更现在会
        // 续接会话（这正是重点——你保留对话、只换模型），
        // 所以"续接 ⇒ 模型不变"不再成立。跳过这个 patch 会让
        // 实时进程用着新模型，而选择器与持久化 agent 还留着旧模型，
        // 下一次恢复就会重新启动旧命令。`command` 在上面从所选
        // 模型重建，因此在真正的无变化重启时这是一个无操作。
        const patch = resume
          ? {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: '继续中…'
            }
          : {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: provider === previousProvider ? '重启中…' : `正在切换到 ${providerPreset(provider).label}…`
            };
        updateAgent(a.id, patch);
      }
    } catch (error) {
      setRestartErrors((errors) => ({
        ...errors,
        [a.id]: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setRestarting(null);
    }
  };

  // 所有人工分发都经 god 流转——从不直接进入 worker 的
  // inbox。直接分发绕过了编排器的整个职责：没有 4 部分
  // 契约、tasks.json 里没有卡片、看板无感知——而且旧的
  // 'broadcast' 默认值会把同一条任务同时发给每个 worker。
  // 在下拉框中选中的 worker 会作为 god 可以采纳的 SUGGESTION 转发。
  const dispatch = async () => {
    const body = dispatchText.trim();
    if (!body) return;
    const suggested = dispatchTo ? agents.find((a) => a.id === dispatchTo) : undefined;
    const full = suggested
      ? `${body}\n\n${t('commandCenter.dispatchSuggestion', { name: suggested.name, id: suggested.id })}`
      : body;
    const res = await window.cth.hiveSend(
      { to: 'god', act: 'request', subject: t('commandCenter.taskFromHuman'), body: full },
      'human'
    );
    setDispatchText('');
    setDispatchMsg(res.ok
      ? suggested
        ? t('commandCenter.sentToWithSuggestion', { godName, name: suggested.name })
        : t('commandCenter.sentToMichael', { godName })
      : t('commandCenter.dispatchFailed', { error: res.error ?? '?' }));
    setTimeout(() => setDispatchMsg(null), 4000);
  };

  const fetchIssues = async () => {
    const repo = issueRepo || repos[0];
    if (!repo) { setIssuesError('No repo selected.'); return; }
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      const res = await window.cth.githubIssues(repo);
      if (res.ok) {
        setIssues((res.issues ?? []).slice(0, 10));
      } else {
        setIssues([]);
        setIssuesError(res.error ?? '获取议题失败。');
      }
    } catch (e) {
      setIssues([]);
      setIssuesError(e instanceof Error ? e.message : String(e));
    } finally {
      setIssuesLoading(false);
    }
  };

  const assignIssue = (issue: GHIssue) => {
    const body = (issue.body ?? '').slice(0, 200);
    setDispatchText(`GitHub Issue #${issue.number}: ${issue.title}\n\n${body}\n\nURL: ${issue.url}`);
    setDispatchTo(''); // Michael 拆解并分配——不再有广播轰炸
  };

  // 在主进程中原子地设置/清除一个 agent 的 token 上限。renderer 的
  // 配置对象是快照，所以持久化整张表可能会覆盖本面板加载之后
  // 由雇佣流程新增的上限。
  const setAgentCap = (id: string, tokens: number | undefined) => {
    setAgentTokenCaps((current) => {
      const optimistic = { ...current };
      if (tokens && tokens > 0) optimistic[id] = tokens;
      else delete optimistic[id];
      return optimistic;
    });
    void window.cth.setAgentTokenCap(id, tokens).then((updated) => {
      setAgentTokenCaps(updated.agentTokenCaps ?? {});
    }).catch(() => {
      // 用持久化的真相来源调和失败的乐观编辑。
      void window.cth.getConfig().then((current) => {
        setAgentTokenCaps(current.agentTokenCaps ?? {});
      }).catch(() => { /* 空操作 */ });
    });
  };

  // token 表在设置了 agent 自身上限时按其缩放，否则按大厅
  // token 预算——这样每条都读作"已用 token vs 预算"，剩余
  // 余量可见，绝不会钉死在无意义的 100%。
  const floorCap = tokenCap && tokenCap > 0 ? tokenCap : DEFAULT_TOKEN_CAP;
  // 花名册上的舰队总量（用于 AGENTS 汇总带）。
  let sumTokens = 0, sumInput = 0, sumCacheRead = 0, sumRate = 0;
  for (const a of agents) {
    const s = samples[a.id];
    if (s) {
      sumTokens += s.input + s.output + s.cacheRead + s.cacheCreation;
      sumInput += s.input + s.cacheRead + s.cacheCreation;
      sumCacheRead += s.cacheRead;
    }
    sumRate += rate[a.id] ?? 0;
  }
  const fleetCachePct = sumInput > 0 ? Math.round((sumCacheRead / sumInput) * 100) : 0;

  return (
    <Scroll>
      <Section title={t('commandCenter.dispatchViaMichael', { godName: godName.toUpperCase() })}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
            {t('commandCenter.suggestedOwner')}
          </span>
          <Select value={dispatchTo} onChange={setDispatchTo}>
            <option value="">{t('commandCenter.michaelDecides', { godName })}</option>
            {agents.filter((a) => !a.isGod).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </div>
        <textarea
          dir={rtl ? 'auto' : undefined}
          value={dispatchText}
          onChange={(e) => setDispatchText(e.target.value)}
          rows={2}
          placeholder={t('commandCenter.dispatchPlaceholder', { godName })}
          style={textareaStyle}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <PixelButton variant="primary" size="sm" onClick={dispatch} disabled={!dispatchText.trim()}>
            {t('commandCenter.dispatch')}
          </PixelButton>
          {dispatchMsg && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{dispatchMsg}</span>}
        </div>
      </Section>

      <Section title={t('commandCenter.agents')}>
        {agents.map((a) => {
          const agentProvider = inferAgentProvider(a.command, a.provider);
          const agentPreset = providerPreset(agentProvider);
          const sample = samples[a.id];
          const breaker = breakers[a.id];
          const armed = !!breaker && (breaker.level === 'constrained' || breaker.level === 'stopped');
          const tokens = sample ? sample.input + sample.output + sample.cacheRead + sample.cacheCreation : 0;
          const agentCap = agentTokenCaps[a.id]; // 每个 agent 的上限（若已设置）
          const denom = agentCap && agentCap > 0 ? agentCap : floorCap;
          const pct = Math.min(100, Math.round((tokens / denom) * 100));
          const meterColor = armed || pct >= 90 ? 'var(--cth-coral)' : pct >= 60 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
          // 只有当 agent 真的在烧 token 时才显示迷你图；否则
          // 平坦的基线只是一条神秘线条。用实时速率标注它。
          const sparkSeries = spark[a.id] ?? [];
          const hasSpark = sparkSeries.some((v) => v > 0);
          const rateVal = Math.round(rate[a.id] ?? 0);
          const rateLabel = rateVal > 0 ? `${fmtTokens(rateVal)}/m` : 'rate';
          const currentModelKnown = modelsForProvider(agentProvider)
            .some((model) => model.id === a.model);
          return (
          <div key={a.id} style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            padding: 6, marginBottom: 6,
            background: armed ? 'var(--cth-coral-light)' : 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
              }}>
                <SpritePortrait character={a.character} scale={1} />
              </div>
              <button
                onClick={() => select(a.id)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              >{a.name}{a.isGod ? t('commandCenter.godTag') : ''}</button>
              <PixelBadge status={armed ? 'looping' : a.status} />
              {armed && <span title={breaker?.reason} style={{ color: 'var(--cth-coral)', fontSize: 12 }}>⚠</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {t('commandCenter.toolCalls', { count: toolCounts[a.id] ?? 0 })}
              </span>
              <TokenLimitEditor value={agentCap} onSet={(t) => setAgentCap(a.id, t)} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
            {/* 实时遥测（自旧 Fleet 标签页并入） */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {hasSpark ? (
                <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{rateLabel}</span>
                  <Sparkline series={sparkSeries} />
                </span>
              ) : (
                <span style={{ flex: 1 }} />
              )}
              {lastTool[a.id] && (
                <span style={{
                  fontSize: 10, lineHeight: '14px', padding: '0 5px', flexShrink: 0,
                  background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-700)'
                }}>{lastTool[a.id]}</span>
              )}
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-300)', flexShrink: 0 }}>{t('commandCenter.budget')}</span>
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>{fmtTokens(tokens)}</span>
              <div
                title={t('commandCenter.meterTitle', {
                  used: tokens.toLocaleString(),
                  limit: denom.toLocaleString(),
                  note: agentCap ? t('commandCenter.agentLimit') : t('commandCenter.floorBudget')
                })}
                style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
              >
                <div style={{ width: `${pct}%`, height: '100%', background: meterColor }} />
              </div>
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>{pct}%</span>
            </div>
            {/* 上下文窗口——与头像卡片仪表完全相同的、由 statusLine 提供的
                数字（当前窗口中的 token vs 真实的 200k/1M 大小）。
                与上面的累计预算表不同：那个会永远增长并钉在 100%——
                那是开销；这个是压缩前的剩余余量。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-300)', flexShrink: 0 }}>{t('commandCenter.ctx')}</span>
              {a.contextTokens !== undefined && a.contextLimit ? (() => {
                const cpct = Math.min(100, Math.round((a.contextTokens! / a.contextLimit!) * 100));
                const ccolor = cpct >= 88 ? 'var(--cth-coral)' : cpct >= 75 ? 'var(--cth-lemon)' : `var(--cth-${a.accent})`;
                return (
                  <>
                    <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>
                      {fmtTokens(a.contextTokens!)}
                    </span>
                    <div
                      title={t('commandCenter.contextTitle', {
                        used: a.contextTokens!.toLocaleString(),
                        limit: a.contextLimit!.toLocaleString(),
                        pct: cpct
                      })}
                      style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
                    >
                      <div style={{ width: `${cpct}%`, height: '100%', background: ccolor }} />
                    </div>
                    <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>{cpct}%</span>
                  </>
                );
              })() : (
                <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-300)' }}>
                  {t('commandCenter.noStatusTick')}
                </span>
              )}
            </div>
            {/* 非 god agent 在这里获得跨 provider 的模型选择器和重启控件。
                GOD agent 的模型在下面的引擎行（provider+model+apply）里，
                所以我们不为它渲染这第二个选择器——一个模型选择器，
                而不是两个。 */}
            {!a.isGod && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Select
                value={encodeProviderModel(agentProvider, a.model)}
                disabled={restarting === a.id}
                onChange={(value) => {
                  const choice = decodeProviderModel(value);
                  if (!choice) return;
                  // 在同一 provider 内切换模型会续接对话——这正是
                  // 任务中途切换的全部意义（"这变难了，升一档"），
                  // 而重新开始会丢掉让切换变得必要的那份上下文。
                  // `resume` 是尽力而为：restartWithModel 已经会在
                  // 跨 provider 时拒绝它，并在没有记录会话 id 或
                  // transcript 时回退到全新会话。
                  void restartWithModel(a, choice.model, {
                    provider: choice.provider,
                    resume: choice.provider === agentProvider,
                    resumeOptional: true
                  });
                }}
              >
                {(!agentPreset.supportsModel || !currentModelKnown) && (
                  <option value={encodeProviderModel(agentProvider, a.model)}>
                    {agentPreset.label} · {a.model ?? 'current'}
                  </option>
                )}
                {modelProvidersForAgent(a.isGod).map((preset) => (
                  <optgroup key={preset.id} label={preset.label}>
                    {modelsForProvider(preset.id).map((model) => {
                      // `defaultModel` 是 Claude 模型 id，所以它只能标记
                      // Claude 组里的条目。
                      const isHarnessDefault = preset.id === 'claude'
                        && !!defaultModel && model.id === defaultModel;
                      return (
                        <option
                          key={`${preset.id}:${model.id ?? 'cli-default'}`}
                          value={encodeProviderModel(preset.id, model.id)}
                        >
                          {model.label}{isHarnessDefault ? ' · default' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </Select>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {restarting === a.id
                  ? t('common.restarting')
                  : t('commandCenter.modelRestarts', { provider: agentPreset.label })}
              </span>
              {/* Restart & Continue —— 保持 SAME 模型杀掉并重生，
                  并续接之前会话（--resume）。用它重绘一个花屏的
                  TUI（例如把窗口拖过不同显示器之后）
                  而不丢失线索。 */}
              {(agentProvider === 'claude' || agentPreset.resumeFlag || agentPreset.resumeSubcommand) && <>
                <span style={{ flex: 1 }} />
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={() => restartWithModel(a, a.model, { resume: true })}
                >
                  <span title={t('commandCenter.restartContinueTitle')}>
                    {t('commandCenter.restartContinue')}
                  </span>
                </PixelButton>
              </>}
            </div>
            )}
            {restartErrors[a.id] && (
              <div style={{ fontSize: 11, color: 'var(--cth-coral)' }}>
                {restartErrors[a.id]}
              </div>
            )}
            {a.isGod && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{t('commandCenter.engine')}</span>
                <Select
                  value={engineProvider}
                  disabled={restarting === a.id}
                  onChange={(v) => {
                    const p = v as AgentProvider;
                    setEngineProvider(p);
                    const preset = AGENT_PROVIDER_PRESETS.find((x) => x.id === p);
                    setEngineModel(preset?.recommendedOrchestratorModel);
                  }}
                >
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id) || p.id === 'kimi').map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}{p.id === 'claude' ? ' ★' : ''}
                    </option>
                  ))}
                </Select>
                <Select
                  value={engineModel ?? ''}
                  disabled={restarting === a.id}
                  onChange={(v) => setEngineModel(v || undefined)}
                >
                  {modelsForProvider(engineProvider).map((m) => (
                    <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                  ))}
                </Select>
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={async () => {
                    const currentProvider = inferAgentProvider(a.command, a.provider);
                    if (engineProvider !== currentProvider) {
                      if (!window.confirm(t('commandCenter.confirmRestartEngine', { name: a.name }))) return;
                    }
                    await window.cth.updateConfig({ godProvider: engineProvider, godModel: engineModel });
                    await restartWithModel(a, engineModel, { provider: engineProvider, resume: false });
                  }}
                >
                  {restarting === a.id ? t('common.restarting') : t('commandCenter.apply')}
                </PixelButton>
                {/* 重绘花屏终端而不丢失线索（续接 SAME engine+model）。
                    放在这里是因为 god 在上方没有逐 agent 行。 */}
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={() => restartWithModel(a, a.model, { resume: true })}
                >
                  <span title={t('commandCenter.restartContinueTitle', { name: a.name })}>
                    {t('commandCenter.restartContinue')}
                  </span>
                </PixelButton>
              </div>
            )}
          </div>
          );
        })}
        {/* 舰队汇总带 */}
        <div style={{
          display: 'flex', gap: 14, marginTop: 2, padding: '6px 8px',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)', flexWrap: 'wrap'
        }}>
          <span>Σ <strong>{fmtTokens(sumTokens)}</strong> {t('costHud.tok')}</span>
          <span style={{ color: 'var(--cth-ink-700)' }}>{t('commandCenter.fleetInputs', { value: fmtTokens(sumInput), pct: fleetCachePct })}</span>
          <span style={{ color: 'var(--cth-ink-700)' }}>{t('commandCenter.fleetRate', { value: Math.round(sumRate).toLocaleString() })}</span>
        </div>
        <div style={{ marginTop: 6 }}>
          <Muted>
            {t('commandCenter.telemetryNote', { cap: fmtTokens(floorCap) })}
            {tokenCap && tokenCap > 0 ? '' : t('commandCenter.defaultBudgetNote')}
          </Muted>
        </div>
      </Section>

      <ArchivedSection />


      <Section title={t('commandCenter.directories')}>
        {repos.length === 0 && <Muted>{t('commandCenter.noRepos')}</Muted>}
        {repos.map((r) => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)', wordBreak: 'break-all' }}>{r}</span>
            <button
              onClick={() => window.cth.openTerminalAt(r)}
              title={t('commandCenter.openInTerminal')}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)' }}
            ><Icon name="terminal" /></button>
          </div>
        ))}
      </Section>

      <Section title={t('commandCenter.issues')}>
        {repos.length === 0 && <Muted>{t('commandCenter.noRepos')}</Muted>}
        {repos.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <Select value={issueRepo || repos[0]} onChange={setIssueRepo}>
                {repos.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </Select>
              <PixelButton variant="primary" size="sm" onClick={fetchIssues} disabled={issuesLoading}>
                {issuesLoading ? t('commandCenter.fetching') : t('commandCenter.fetchIssues')}
              </PixelButton>
            </div>
            {issuesError && (
              <div style={{
                fontSize: 12, color: 'var(--cth-ink-700)', marginBottom: 6,
                padding: 6, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                wordBreak: 'break-word'
              }}>{issuesError}</div>
            )}
            {!issuesError && !issuesLoading && issues.length === 0 && <Muted>{t('commandCenter.noIssues')}</Muted>}
            {issues.map((issue) => (
              <div key={issue.number} style={{
                display: 'flex', flexDirection: 'column', gap: 4,
                padding: 6, marginBottom: 6,
                background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-900)', flex: 1, wordBreak: 'break-word' }}>
                    <strong>#{issue.number}</strong> {issue.title}
                  </span>
                  <PixelButton variant="secondary" size="sm" onClick={() => assignIssue(issue)}>
                    {t('commandCenter.assign')}
                  </PixelButton>
                </div>
                {issue.labels.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {issue.labels.map((label) => (
                      <span key={label} style={{
                        fontSize: 10, lineHeight: '14px', padding: '0 5px',
                        background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        color: 'var(--cth-ink-700)'
                      }}>{label}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </Section>
    </Scroll>
  );
}

// ─── 已归档 agents — 保留并标记，留在大厅之外 ────────────────

function ArchivedSection() {
  const { t } = useTranslation();
  const archivedAgents = useStore((s) => s.archivedAgents);
  const removeArchivedAgent = useStore((s) => s.removeArchivedAgent);
  const [open, setOpen] = useState(false);
  if (archivedAgents.length === 0) return null;
  return (
    <Section title={t('commandCenter.archived', { count: archivedAgents.length })}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
          marginBottom: open ? 6 : 0
        }}
      >{open ? '▾' : '▸'} {open ? t('commandCenter.hideClosed') : t('commandCenter.showClosed')}</button>
      {open && archivedAgents.map((a) => (
        <div key={a.id} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: 6, marginBottom: 6, opacity: 0.7,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <div style={{
            width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
          }}>
            <SpritePortrait character={a.character} scale={1} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>{a.name}</div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
          </div>
          <button
            onClick={() => removeArchivedAgent(a.id)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)', flexShrink: 0 }}
          ><Icon name="x" /></button>
        </div>
      ))}
    </Section>
  );
}

// ─── 记忆标签页 ──────────────────────────────────────────────────────────────

function MemoryTab({ godId, who: controlledWho, onWho }: { godId: string; who?: string; onWho?: (id: string) => void }) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  // 选择可由图形标签页控制；回退到本地状态。
  const [internalWho, setInternalWho] = useState<string>(godId);
  const who = controlledWho ?? internalWho;
  const setWho = onWho ?? setInternalWho;
  const [mem, setMem] = useState('');
  const [query, setQuery] = useState('');
  const [searchOut, setSearchOut] = useState('');
  const [busy, setBusy] = useState(false);
  // 跨 hive 文件（board、tasks、memory）的全文本搜索——纯增量。
  const [textQuery, setTextQuery] = useState('');
  const [textResults, setTextResults] = useState<Array<{ source: string; excerpt: string }>>([]);
  const [textSearched, setTextSearched] = useState(false);
  const [textBusy, setTextBusy] = useState(false);

  useEffect(() => {
    window.cth.hiveMemory(who).then(setMem).catch(() => setMem(''));
  }, [who]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await window.cth.searchMemory(query.trim());
      setSearchOut(res.ok ? (res.output || t('commandCenter.searchNoMatch')) : `${t('commandCenter.dispatchFailed', { error: res.error })}`);
    } finally { setBusy(false); }
  };

  const textSearch = async () => {
    if (!textQuery.trim()) return;
    setTextBusy(true);
    try {
      const res = await window.cth.textSearch(textQuery.trim());
      setTextResults(res.ok ? res.results.slice(0, 10) : []);
    } catch { setTextResults([]); }
    finally { setTextBusy(false); setTextSearched(true); }
  };

  return (
    <Scroll>
      <Section title={t('commandCenter.textSearch')}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={textQuery}
            onChange={(e) => setTextQuery(e.target.value)}
            onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter') textSearch(); }}
            placeholder={t('commandCenter.textSearchPlaceholder')}
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={textSearch} disabled={textBusy || !textQuery.trim()}>
            {textBusy ? '…' : t('common.search')}
          </PixelButton>
        </div>
        {textResults.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {textResults.map((r, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{r.source}</div>
                <Pre>{r.excerpt}</Pre>
              </div>
            ))}
          </div>
        )}
        {textSearched && textResults.length === 0 && <Muted>{t('commandCenter.nothingMatched')}</Muted>}
      </Section>

      <Section title={t('commandCenter.semanticSearch')}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter') search(); }}
            placeholder={t('commandCenter.semanticPlaceholder')}
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={search} disabled={busy || !query.trim()}>
            {busy ? '…' : t('common.search')}
          </PixelButton>
        </div>
        {searchOut && <Pre>{searchOut}</Pre>}
      </Section>

      <Section title={t('commandCenter.memoryFile')}>
        <Select value={who} onChange={setWho}>
          {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </Select>
        <Pre>{mem || t('commandCenter.noMemory')}</Pre>
      </Section>
    </Scroll>
  );
}

// ─── 舰队遥测位（并入 Floor AGENTS 卡片） ───────────────────────

/** 近期 token 增量的方块字符迷你图——新粗野主义等宽风格。 */
function Sparkline({ series }: { series: number[] }) {
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(1, ...series);
  const text = series.length
    ? series.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('')
    : '▁▁▁▁▁▁';
  return (
    <span style={{ flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '12px', color: 'var(--cth-sky)', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0 }}>
      {text}
    </span>
  );
}

/** 紧凑的 token 计数：1K / 10K / 100K / 1M / 100M / 1B（去掉尾部 .0）。 */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 每个 agent 的 token 上限控件（每个 agent 卡片的右上角）。把当前
 *  上限显示为柠檬色小片，或显示"set limit"；点击编辑 token 数字。
 *  Enter / ✓ / blur 提交；Escape 取消。 */
function TokenLimitEditor({ value, onSet }: { value?: number; onSet: (tokens: number | undefined) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value != null ? String(value) : '');
  const skipBlur = useRef(false);
  const commit = () => {
    const raw = text.trim();
    const n = raw === '' ? undefined : Number(raw);
    onSet(typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        onClick={() => { setText(value != null ? String(value) : ''); setEditing(true); }}
        title={t('commandCenter.tokenLimitTitle')}
        style={{
          flexShrink: 0, padding: '1px 6px', border: 'none', cursor: 'pointer',
          background: value && value > 0 ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
          boxShadow: `inset 0 0 0 1px ${value && value > 0 ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
        }}
      >{value && value > 0
        ? <>{t('commandCenter.tokenLimit', { value: fmtTokens(value) })}</>
        : t('commandCenter.setLimit')}</button>
    );
  }
  return (
    <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <input
        type="number" min="0" step="100000" value={text} autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { skipBlur.current = true; setEditing(false); }
        }}
        onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } commit(); }}
        placeholder={t('common.tokens')}
        style={{
          width: 84, padding: '2px 4px', background: 'var(--cth-paper-100)', border: 'none',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-mono)',
          fontSize: 11, color: 'var(--cth-ink-900)', outline: 'none'
        }}
      />
      <button
        onMouseDown={(e) => e.preventDefault()} onClick={commit} title={t('commandCenter.saveLimit')}
        style={{ flexShrink: 0, padding: '1px 5px', border: 'none', cursor: 'pointer', background: 'var(--cth-mint)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 11, color: 'var(--cth-ink-900)' }}
      >✓</button>
    </span>
  );
}

// ─── Activity 标签页 — hive 事件日志 + 看板 ───────────────────────

interface LogEntry { ts?: number; kind?: string; [k: string]: unknown }

function ActivityTab() {
  const { t } = useTranslation();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [board, setBoard] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try { setLog((await window.cth.hiveLog(60)) as LogEntry[]); } catch { /* noop */ }
      try { setBoard(await window.cth.hiveBoard()); } catch { /* noop */ }
    };
    refresh();
    timer.current = setInterval(refresh, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const fmt = (e: LogEntry): string => {
    switch (e.kind) {
      case 'spawn': return t('commandCenter.logSpawn', { name: e.name ?? e.agentId });
      case 'message': return t('commandCenter.logMessage', { from: e.from, to: e.to, subject: e.subject || e.act });
      case 'drain': return t('commandCenter.logDrain', { agent: e.agentId, count: e.count });
      case 'escalate': return t('commandCenter.logEscalate', { subject: e.subject ?? '' });
      case 'approval': return e.approve ? t('commandCenter.logApprovalGranted') : t('commandCenter.logApprovalDenied');
      default: return JSON.stringify(e);
    }
  };

  return (
    <Scroll>
      <Section title={t('commandCenter.activity')}>
        {log.length === 0 && <Muted>{t('commandCenter.nothingYet')}</Muted>}
        {[...log].reverse().map((e, i) => (
          <div key={i} style={{ fontSize: 12, color: 'var(--cth-ink-700)', padding: '2px 0', display: 'flex', gap: 6 }}>
            <span style={{ color: 'var(--cth-ink-300)', flexShrink: 0 }}>{e.kind ?? '·'}</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(e)}</span>
          </div>
        ))}
      </Section>

      <Section title={t('commandCenter.board')}>
        <Pre>{board || t('commandCenter.boardEmpty')}</Pre>
      </Section>
    </Scroll>
  );
}


// ─── 小型共享组件 ───────────────────────────────────────────────────────

function Scroll({ children }: { children: React.ReactNode }) {
  // minWidth:0 + overflowX:hidden 防止宽子元素（原生 select、长路径、
  // 预算行）在窄侧边栏里撑出横向滚动条——它们改为换行/收缩。
  // 纵向滚动保留。
  return <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 10, background: 'var(--cth-paper-200)' }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', color: 'var(--cth-ink-700)', fontSize: 13, background: 'var(--cth-paper-200)' }}>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}

function Pre({ children }: { children: React.ReactNode }) {
  const rtl = useRtl();
  return (
    <pre style={{
      margin: '6px 0 0', padding: 8, maxHeight: 200, overflow: 'auto',
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
      color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
    }} dir={rtl ? 'auto' : undefined}>{children}</pre>
  );
}

const textareaStyle: React.CSSProperties = {
  flex: 1, width: '100%', resize: 'none', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

function Select({ value, onChange, disabled, children }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '3px 6px', background: 'var(--cth-paper-100)',
        border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer',
        // 绝不让长选项名把侧边栏撑得比它本身还宽。
        minWidth: 0, maxWidth: '100%'
      }}
    >{children}</select>
  );
}
