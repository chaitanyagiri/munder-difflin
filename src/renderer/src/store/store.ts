import { create } from 'zustand';
import type { AccentColorName } from '@/design/tokens';
import type { OfficeCharacterName } from '@/scene/office/cast';
import type { ThemeId } from '@/scene/office/themeRegistry';
import type { StatusKind } from '@/components/PixelBadge';
import type { AgentProvider } from '@shared/agentProvider';
import type { HireManifest } from '@shared/hire';
import {
  EMPTY_HIRE_QUEUE,
  clearHireQueue,
  enqueueHires,
  finishCurrentHire,
  type HireReviewQueue
} from '@shared/hireQueue';
import { DEFAULT_ORG_TRIGGER, type OrgTriggerConfig, type WebhookTrigger } from '@shared/triggers';
import { isCompactionCommand } from '@shared/providerAutomation';
import { preferredAgentRole } from '@shared/agentRole';
import { isInboxNudge } from '@shared/hiveNudge';
import { refocusAfterRemoval, focusOnLoad, restoreFocus } from './focusMode';
import { chooseRosterSource } from './rosterSource';

export type ToolKind =
  | 'Read' | 'Edit' | 'Write' | 'Bash' | 'WebFetch' | 'WebSearch'
  | 'Grep' | 'Glob' | 'TodoWrite' | 'MCP';

export type StationKind =
  | 'shelf' | 'terminal' | 'web' | 'board' | 'mailbox' | 'mcp' | 'desk';

export interface BlockReason {
  summary: string;                 // 横幅上显示的短标题
  detail: string;                  // 更长的解释
  command?: string;                // 待确认的逐字命令（若有）
  actions: Array<{
    label: string;
    kind: 'approve' | 'deny' | 'neutral';
    /** 点击时我们会发给 tmux 窗格的内容 */
    send?: string;
  }>;
}

export interface Agent {
  id: string;
  name: string;
  /** 楼面上哪个 Office 角色代表这个 agent */
  character: OfficeCharacterName;
  accent: AccentColorName;
  /** 持久的职位 / 雇佣一句话——与 hive 注册表 `role` 是同一个字符串。
   *  实时状态属于 `status` / `action`，绝不写在这里。 */
  description: string;
  project: string;
  /** 遗留字段——只为播种的 mock agent 填充 */
  tmuxTarget: string;
  cwd: string;
  goal?: string;
  /** 用户撰写的私有笔记，在名单卡片悬停上显示和编辑。 */
  note?: string;
  status: StatusKind;
  action: string;
  progress: number;
  currentStation?: StationKind;
  carrying?: ToolKind;
  /** 最新的助手消息，在侧边栏逐字符流式显示 */
  recentAssistantText?: string;
  /** 纪元毫秒——用于驱动打字机效果，让相同字符串也能重新播放 */
  recentTextTs?: number;
  /** status === 'blocked' 时填充 */
  blockReason?: BlockReason;
  /** 仅当该 agent 在主进程里有真实 PTY 时才存在 */
  ptyId?: string;
  /** 由 Restart & Continue 递增，用于在不改变该 agent 持久 PTY/会话身份
   * 的情况下重新挂载其 xterm。 */
  terminalGeneration?: number;
  /** 正在 PTY 中运行的命令（例如 'claude' 或 'agy'） */
  command?: string;
  /** 拥有此 PTY 配方的 agent CLI 预设；驱动模型选择器与 spawn 标志。
   *  未设置时默认 'claude'（遗留 agent / 从命令推断）。 */
  provider?: AgentProvider;
  /** 该 agent 运行的模型（例如 'claude-sonnet-4-6[1m]' 或 'gemini-3-pro'）；
   *  驱动模型选择器以及（重新）spawn agent 时所用的 --model 参数 */
  model?: string;
  /** 用户在 Claude Code 中最后提交给该 agent 的提示——
   *  作为坐姿头像上方的卡片显示在楼面上 */
  lastPrompt?: string;
  /** 编排者（“god”）agent——坐在 Michael 的房间里，运行整个楼层 */
  isGod?: boolean;
  /** Michael 的预备助手——只发不收；润色提示并转发给 god。从广播扇出和
   *  可恢复-死亡清扫中排除。 */
  isAssistant?: boolean;
  /** 人类正与该 agent 1:1 交流，Michael 已被告知别打扰它。
   *  镜像 `RegistryAgent.onHold`；记录归 main 管，这里是标题栏据此渲染的
   *  副本。 */
  onHold?: boolean;
  /** 当 git 隔离启用时，agent 运行的专用工作树路径（其自有 `agent/<id>`
   *  分支）；共享 cwd 的 agent 为 undefined。 */
  worktreePath?: string;
  /** agent 的 Claude 会话的实时上下文大小（tokens），从其 transcript 轮询
   *  得到。驱动 agent 卡片上的上下文计量表。 */
  contextTokens?: number;
  /** 为该 agent 的模型假定的上下文窗口上限（tokens）。 */
  contextLimit?: number;
  /** 该 agent 的终端一旦被关闭即为 true。归档 agent 会被保留（在 store 的
   *  `archivedAgents` 列表 + hive 注册表中），但被标记且不上楼面；只有
   *  有活 PTY 的 agent 才是 'active'。 */
  archived?: boolean;
  /** 要在该 agent 的 TUI 中作为其第一回合 TYPE 的 hive 协议，在 spawn 时为
   *  `seedDelivery:'type-into-tui'` provider（Crush）设置，其裸 TUI 拒绝
   *  位置种子。useHive 在启动宽限后输入一次然后清空。瞬时 spawn 状态——
   *  不持久化。(ondev-b) */
  seedPrompt?: string;
}

export interface FeedEntry {
  agentId: string;
  text: string;
  ts: number;
}

/** 用户在 agent 终端忙时为它停靠的消息。排队消息在 agent 下次空闲时
 *  逐条排空（见 useHive 的 flush 循环）。 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** 消息入队的纪元毫秒——驱动排序和 “queued 2m ago” 提示 */
  ts: number;
  /** Slack 来源：线程坐标，让办公室可以在线程内回复。 */
  slack?: { channel: string; thread_ts: string };
  /** 实际输入 agent PTY 文本的可选覆盖。设置时，排空提交 THIS 而不是
   *  `text`，而 UI/卡片界面继续使用 `text`。Slack 来源的工作用它把自治
   *  前言带给 god 的提示，而不污染人类可读的看板卡片标题（= 原始
   *  `text`）。 */
  instruction?: string;
  /** 楼层级自动投递被暂停时用户点了“立即发送”。只绕过排空循环中的
   *  暂停门——idle/草稿/选择器安全仍然生效，所以它在终端真正空闲的瞬间
   *  投递。 */
  manual?: boolean;
  /** 投递时前置条件，由排空在消息输入前立即重新检查；前置条件不再成立的
   *  消息被 DROP 而不是延迟（延迟会让它永久停在队首、饿死它后面的一切）。
   *
   *  它存在是因为排队消息在入队时评估、却在间隔任意长之后投递，而有些
   *  消息只有在其描述的世界仍然存在时才值得发送。'inbox-nonempty' 是
   *  inbox 唤醒 nudge：agent 可以在 nudge 入队的同一回合排空整个 inbox，
   *  之后再投递它要花整整一个回合去发现里面是空的。声明式（字符串而非
   *  闭包），所以能挺过 persistQueues。 */
  precondition?: 'inbox-nonempty';
    /** 为该 agent 入队 /compact 时捕获的 token 数，一路携带到成功投递点，
   *  让 “已在 N tokens 压缩过” 的闩锁（见 useHive）可以写在那里而不是
   *  入队时。入队时间太早：一条卡在不可投递状态后面的 /compact，否则会对
   *  一次从未真正发生的压缩闩死此后所有的压缩尝试。 */
  compactUsed?: number;
}

// 'files' 在 v0.3.4 退役（按 agent 的 IDE 按钮取代了它）——持久化的
// 'files' 选择在加载时回退到 'terminal'。'git' 在 v0.3.4 加入：不打开
// IDE 也能一眼看到分支/状态/日志。
export type SidebarTab = 'terminal' | 'messages' | 'traces' | 'git';

/** 启动时 god agent（“Michael”）引导的生命周期。
 *  在其 PTY 被确认为活跃之前为 'booting'，然后 'ready'（或 spawn 出错时
 *  'failed'）。空楼层 UI 在 'booting' 期间显示加载器，让用户在 Michael
 *  打卡上班之前看不到“添加 agent”提示。 */
export type GodStatus = 'booting' | 'ready' | 'failed';

interface State {
  agents: Agent[];
  /** 终端已被关闭的 agent——保留 + 标记，不上活跃名单/楼层。hive 注册表
   *  持久保留它们；这里为渲染端的 “Archived” 视图做镜像。 */
  archivedAgents: Agent[];
  /** 上一个会话中、终端随应用（退出/崩溃）一起死亡的 worker。带着完整
   *  spawn 配方（id, cwd, model, command）保留，让用户可以用同一个 agent id
   *  一键重启它们——记忆、inbox 与注册表条目自行重新挂接。god/assistant
   *  被排除（它们自动重启）。 */
  restorableAgents: Agent[];
  selectedId: string | null;
  feeds: Record<string, string[]>;
  addAgentOpen: boolean;
  fullscreenAgentId: string | null;
  /** 用户默认是否以专注模式工作？持久化为布尔值，只由显式开关写入。放在
   *  store 里而不是构造时读一次，因为名单在 store 之后才到达。 */
  prefersFocusMode: boolean;
  /** 排队等待 IDE 下次挂载时打开的绝对路径。由 IdePanel 消费并清空，它会
   *  像树点击一样路由（源码用 Monaco，markdown 用预览，图片用查看器）。 */
  ideInitialFile: string | null;
  /** 全窗口 IDE 面板（文件管理器 + Monaco 编辑器 + git diff）是否打开。
   *  由标题栏 IDE 按钮切换；这是一个全局功能面，独立于按 agent 的侧边栏
   *  Files/Git 标签页。 */
  ideOpen: boolean;
  /** IDE 是为 WHICH agent 打开的——由打开它的人设置。
   *
   *  IDE 以前纯粹从 `selectedId` 推断其工作区，那是个通常正确、偶尔错误
   *  的猜测：`setFullscreen` 把一个 agent 的终端放上屏幕却不选中它，所以
   *  从全屏终端按 IDE 可能打开另一个 agent 的目录而不是正在看的那个。
   *  当标题只写 “IDE” 和文件夹名时这不可见；一旦标题指名 agent，就会变成
   *  完全错误的 agent 名字。因此调用方要声明其意图，`selectedId` 作为真正
   *  没有特定 agent 在意的场景的回退。 */
  ideAgentId: string | null;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  godStatus: GodStatus;
  /** 按 agent 的外发消息队列（agent id → 等待投递的消息）。让用户可以对
   *  忙碌的 agent 继续“说话”：消息停在这里，agent 一有空就被逐条排空到
   *  终端。 */
  messageQueues: Record<string, QueuedMessage[]>;
  /** 本会话按 agent 的工具调用次数——一个轻量的活动/用量代理，显示在
   *  指挥中心（交互式会话不暴露计费 $）。 */
  toolCounts: Record<string, number>;
  bumpToolCount: (id: string) => void;
  setGodStatus: (status: GodStatus) => void;
  select: (id: string) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  /** 把持久的 hive 角色复制到名单描述上（名单已有真实职位字符串时，反向
   *  是 no-op）。 */
  syncDescriptionsFromRoles: (roles: Record<string, string>) => void;
  /** 把显示名变更同时持久化到 hive 注册表和渲染端名单。
   *  agent id 及所有由 id 派生的路径保持不变。 */
  renameAgent: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  setAgentNote: (id: string, note: string) => void;
  pushFeed: (id: string, line: string) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  /** 归档一个 agent（其终端已关闭）：把它从活跃名单移入 `archivedAgents`，
   *  清空其 PTY。保留 + 标记，而不是删除。 */
  archiveAgent: (id: string) => void;
  /** 永久遗忘一个归档 agent（只删渲染端条目；hive 注册表保留其记录）。 */
  removeArchivedAgent: (id: string) => void;
  /** 从可恢复列表里移除一个 agent（它已被重启或已关闭）。 */
  removeRestorableAgent: (id: string) => void;
  reorderAgents: (fromId: string, toId: string) => void; // 把 agent fromId 移到 toId 的槽位（AgentStrip 拖拽重排）并持久化新顺序
  /** 一次性请求打开某个指挥中心标签页（例如点办公室任务板 → 'tasks'）。
   *  `seq` 让重复的相同请求可区分。 */
  ccTabRequest: { tab: string; seq: number } | null;
  requestCommandCenterTab: (tab: string) => void;
  /** 详情浮层打开的那个任务（在办公室楼层上方全局渲染——卡片内容会生长：
   *  契约、依赖、人类问答轨迹）。 */
  taskDetailId: string | null;
  openTaskDetail: (id: string) => void;
  closeTaskDetail: () => void;
  /** 指挥中心派发框的一次性预填（从应用任意位置的任务详情 “assign”）。
   *  与 ccTabRequest 一样用 seq 作键。 */
  dispatchSeedRequest: { text: string; seq: number } | null;
  requestDispatchSeed: (text: string) => void;
  /** 未发送的 ASK ME 回答草稿，按任务 id 为键——这样切换标签页（会卸载
   *  ask-me 视图）不会吃掉写到一半的回答。 */
  answerDrafts: Record<string, string>;
  setAnswerDraft: (taskId: string, text: string) => void;
  /** 未发送的输入框草稿，按 agent 为键——这样切换 agent（会重挂载输入框）
   *  不会吃掉用户正在输入的内容。 */
  drafts: Record<string, string>;
  setDraft: (agentId: string, text: string) => void;
  /** 镜像 config.freeflowEnabled，让输入框可以响应式地显示/隐藏 Free Flow
   *  麦克风按钮（由 App 在 config 加载时设置、Settings 在保存时设置）。 */
  freeflowEnabled: boolean;
  setFreeflowEnabled: (on: boolean) => void;
  /** 镜像 `!!config.groqApiKey` ——只表示布尔存在；密钥值绝不进 store。
   *  让输入框显示禁用的语音按钮（带 “添加 Groq 密钥” 提示）而不是隐藏它。
   *  由 App 在 config 加载时设置、Settings 在保存时设置。 */
  hasGroqKey: boolean;
  setHasGroqKey: (has: boolean) => void;
  /** 镜像 BYOK OpenAI 密钥存在性（仅布尔——密钥住在主进程 secret broker，
   *  绝不进 store）。像 hasGroqKey 门控 Free Flow 麦克风那样门控 Realtime
   *  Michael 语音开关。App 加载时经 window.cth.realtimeHasOpenAiKey() 设置。 */
  hasOpenAiKey: boolean;
  setHasOpenAiKey: (has: boolean) => void;
  /** 镜像活跃办公室主题（由 App 在 config 加载时 + Settings 切换时设置）。
   *  OfficeFloor 依赖它并在变化时重建场景。 */
  officeTheme: ThemeId;
  setOfficeTheme: (theme: ThemeId) => void;
  /** 镜像 config.webhookTriggers —— 入站 HTTP 端点。Webhook 在 设置 →
   *  连接 和 Triggers 标签页两处都可编辑，所以任一面都不保留自己的副本：
   *  两者都基于此列表渲染、都在持久化后调用 setter，另一个无需重新拉取
   *  就会重绘。由 App 从 getConfig() 播种（main 每次读取都深度填充该字段）。
   *
   *  持有每个端点的密钥，因为密钥正是 UI 要显示、让 reveal/copy 有意义
   *  的东西。仅渲染端内存——绝不持久化到 localStorage 或名单文件、绝不
   *  记录、在每一个界面里掩码显示。 */
  webhookTriggers: WebhookTrigger[];
  setWebhookTriggers: (list: WebhookTrigger[]) => void;
  /** 镜像 config.orgTrigger（队友克隆节点之间的对等消息）。与
   *  `webhookTriggers` 相同的双向契约，`apiKey` 也同等对待——只在内存里
   *  供两个掩码显示它的界面使用，别处不存。目前只是配置：还没有传输读取
   *  该密钥。 */
  orgTrigger: OrgTriggerConfig;
  setOrgTrigger: (cfg: OrgTriggerConfig) => void;
  /** 为 agent 停靠一条消息。不返回任何东西；flush 循环投递它。
   *  设置 `meta.instruction` 时，它是实际输入 PTY 的内容，而不是 `text`
   *  （UI/卡片界面仍显示 `text`）。 */
    enqueueMessage: (agentId: string, text: string, meta?: { slack?: { channel: string; thread_ts: string }; instruction?: string; precondition?: QueuedMessage['precondition']; compactUsed?: number }) => void;
  /** 丢弃一条已排队的消息（用户移除了它，或它刚被投递）。 */
  removeQueuedMessage: (agentId: string, messageId: string) => void;
  /** 楼层级自动投递被暂停时的 “立即发送”：把消息标记为 manual（排空只为
   *  它绕过暂停门）并移到队首。 */
  releaseQueuedMessage: (agentId: string, messageId: string) => void;
  /** 清空某个 agent 的整个待决队列。 */
  clearQueue: (agentId: string) => void;
  setAddAgentOpen: (open: boolean) => void;
  /** 等待逐个人工审查的已校验清单。 */
  hireQueue: HireReviewQueue;
  enqueuePendingHires: (manifests: readonly HireManifest[]) => void;
  finishPendingHire: () => void;
  clearPendingHires: () => void;
  setFullscreen: (id: string | null) => void;
  /** 移动专注模式而不碰偏好。用于重新安置消失的聚焦 agent 的路径：
   *  应用是在跟随用户，而不是被告知用户想要什么。`setFullscreen` 才是显式
   *  开关。 */
  refocusFullscreen: (id: string | null) => void;
  /** 名单已变化，现在重新应用持久化偏好。 */
  restoreFocusMode: () => void;
  /** 在 IDE 中打开绝对路径——显示文件的唯一方式。
   *
   *  v0.4.5 移除了第二个更差的文件界面（一个包裹裸 Monaco 的全屏浮层）。
   *  它不能滚动、没有标签页、没有树、没有 git，而且它打开的每个文件反正
   *  都离 “在 IDE 中打开” 只有一次点击。以前打开它的所有东西现在都到这里，
   *  所以出现编辑器 bug 时恰好只有一个编辑器要修。 */
  openFileInIde: (absPath: string) => void;
  /** 打开/关闭 IDE。`agentId` 指名要显示其工作区的 agent；只有当调用方
   *  确实没有特定 agent 时才省略（IDE 随后回退到选中项并在标题里说明）。 */
  setIdeOpen: (open: boolean, agentId?: string | null) => void;
  setIdeInitialFile: (path: string | null) => void;
  setSidebarWidth: (px: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** 丢弃主进程中 PTY 已不再存活的持久化 agent。启动时调用一次，让渲染端
   *  重载（例如笔记本睡眠后）恢复仍在运行的 agent、只移除真正死掉的。 */
  reconcileWithLivePtys: (livePtyIds: string[]) => void;
}

const LS_SIDEBAR_WIDTH = 'cth.sidebarWidth';
const LS_SIDEBAR_TAB = 'cth.sidebarTab';
const LS_AGENTS = 'cth.agents';
const LS_ARCHIVED = 'cth.archivedAgents';
const LS_RESTORABLE = 'cth.restorableAgents';
const LS_SELECTED = 'cth.selectedId';
const LS_QUEUES = 'cth.messageQueues';
/** 此 origin 的名单键最近一次是为哪个 hive 写的。见 rosterSource.ts。 */
const LS_ROSTER_HOME = 'cth.rosterHome';
const LS_FOCUS_MODE = 'cth.prefersFocusMode';

// 大或瞬态的字段——不值得跨重载持久化。contextTokens/contextLimit 描述
// 一个 LIVE 会话；持久化它们会在重启后显示死会话的上下文计量表，直到
// 轮询追上。
type PersistedAgent = Omit<Agent, 'recentAssistantText' | 'recentTextTs' | 'blockReason' | 'contextTokens' | 'contextLimit' | 'seedPrompt'>;

// ─── 名单镜像 ──────────────────────────────────────────────────────────────
//
// localStorage 按 ORIGIN 分区，而本应用运行的两种方式并不共享同一个：
// `npm run dev` 从 http://localhost:5173 服务渲染端，打包构建从 file://
// 加载。因此名单——agent、它们的私有笔记、工作树路径、归档条目、停靠的
// 队列——对你当前不在的那一边是不可见的，即使磁盘上的 hive（会话、记忆、
// inbox、任务）全程都是共享且完整的。
//
// 所以我们还把它镜像到 <harnessHome>/roster.json，两边都能按路径到达。
// localStorage 继续逐字节照写：它是还没有文件时的回退，以及之后常驻的
// 备份。Main 在 roster-backups/ 下保留文件的每个旧版本。
const fileRoster = (() => {
  try { return window.cth?.rosterReadSync?.() ?? null; } catch { return null; }
})();

/** 我们打开的是哪个 hive，以及此 origin 的 localStorage 上次是为哪个写的。
 *  两者同步读取，理由与名单相同：store 在模块加载时构建，异步答案会来得
 *  太晚。 */
const currentHome = (() => {
  try { return window.cth?.harnessHomeSync?.() ?? null; } catch { return null; }
})();
const storedHome = (() => {
  try { return window.localStorage.getItem(LS_ROSTER_HOME); } catch { return null; }
})();

const { useFileRoster, useLocalFallback } = chooseRosterSource({
  fileRoster,
  currentHome,
  storedHome
});

/** 为刚打开的 hive 认领此 origin 的名单键。即使什么都没加载也要写：从
 *  现在起 localStorage 描述 THIS hive，我们下次打开的 hive 才知道不要采用
 *  它。 */
try {
  if (currentHome) window.localStorage.setItem(LS_ROSTER_HOME, currentHome);
} catch { /* noop */ }

/** 渲染端持有的“磁盘上应有什么”的运行副本。作为可变镜像逐切片更新，而
 *  不是从 store 读回，因为每次 persist* 调用都发生在 zustand `set()` 内部
 *  ——那里的 `getState()` 仍返回更新前的状态，这样构建的快照可靠地滞后
 *  一次编辑。 */
const rosterMirror: {
  agents: PersistedAgent[];
  archived: PersistedAgent[];
  restorable: PersistedAgent[];
  queues: Record<string, QueuedMessage[]>;
  selectedId: string | null;
} = { agents: [], archived: [], restorable: [], queues: {}, selectedId: null };

let rosterFlush: ReturnType<typeof setTimeout> | null = null;

function flushRosterNow(): void {
  if (rosterFlush) { clearTimeout(rosterFlush); rosterFlush = null; }
  try {
    void window.cth?.rosterWrite?.({
      version: 1,
      savedAt: new Date().toISOString(),
      agents: rosterMirror.agents,
      archived: rosterMirror.archived,
      restorable: rosterMirror.restorable,
      queues: rosterMirror.queues,
      selectedId: rosterMirror.selectedId
    });
  } catch { /* 文件只是镜像——localStorage 已经收下了这次写入 */ }
}

/** 把一次 persist* 突发合并成一次磁盘写入。agent 编辑总是成簇到达
 *  （spawn 在同一 tick 写入 agents + selection + queues）。 */
function scheduleRosterFlush(): void {
  if (rosterFlush) return;
  rosterFlush = setTimeout(flushRosterNow, 500);
}

// 别让去抖窗口内的退出丢掉最后一次编辑。localStorage 仍会保留它，但那只
// 对 THIS origin——而全部意义就在于另一个 origin 也能读到。
try {
  window.addEventListener('beforeunload', flushRosterNow);
} catch { /* 非浏览器上下文（单元测试） */ }

function slimAgents(agents: Agent[]): PersistedAgent[] {
  return agents.map(({ recentAssistantText, recentTextTs, blockReason, contextTokens, contextLimit, seedPrompt, ...rest }) => {
    void recentAssistantText; void recentTextTs; void blockReason; void contextTokens; void contextLimit; void seedPrompt;
    return rest;
  });
}

function persistAgents(agents: Agent[], selectedId: string | null): void {
  const slim = slimAgents(agents);
  try {
    window.localStorage.setItem(LS_AGENTS, JSON.stringify(slim));
    window.localStorage.setItem(LS_SELECTED, selectedId ?? '');
  } catch { /* noop */ }
  rosterMirror.agents = slim;
  rosterMirror.selectedId = selectedId;
  scheduleRosterFlush();
}

/** 每个 reload 时 agent 从其实时 pty 重新计算的运行状态。只由这些组成的
 *  补丁不值得一次 localStorage 写入；其他都值得。刻意列成易变集合而非
 *  持久集合——这样新增的持久字段默认会被持久化，而不是被静默丢弃。 */
const VOLATILE_AGENT_FIELDS = new Set<keyof Agent>([
  'status', 'action', 'progress', 'currentStation', 'carrying',
  'recentAssistantText', 'recentTextTs', 'blockReason',
  'contextTokens', 'contextLimit', 'lastPrompt'
]);

function touchesDurableAgentField(patch: Partial<Agent>): boolean {
  return Object.keys(patch).some((k) => !VOLATILE_AGENT_FIELDS.has(k as keyof Agent));
}

/** 一个切片的持久化列表：有名单时是共享文件，否则是此 origin 的
 *  localStorage——但只有该 localStorage 是为这个 hive 写的。任何格式错误
 *  都返回 []。 */
function persistedSlice(
  key: string,
  fromFile: unknown[] | undefined
): PersistedAgent[] {
  if (useFileRoster) return Array.isArray(fromFile) ? (fromFile as PersistedAgent[]) : [];
  if (!useLocalFallback) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PersistedAgent[]) : [];
  } catch {
    return [];
  }
}

function loadPersistedAgents(): Agent[] {
  try {
    const parsed = persistedSlice(LS_AGENTS, fileRoster?.agents);
    if (!parsed.length) return [];
    // 重置易变运行状态；PTY 流 / mock 循环会重新填充它。
    return parsed.map((a) => ({
      ...a,
      progress: 0,
      status: 'idle',
      action: '正在重连…',
      currentStation: 'desk',
      carrying: undefined,
      recentTextTs: Date.now(),
    }));
  } catch {
    return [];
  }
}

function persistArchived(archived: Agent[]): void {
  const slim = slimAgents(archived);
  try {
    window.localStorage.setItem(LS_ARCHIVED, JSON.stringify(slim));
  } catch { /* noop */ }
  rosterMirror.archived = slim;
  scheduleRosterFlush();
}

function loadPersistedArchived(): Agent[] {
  try {
    const parsed = persistedSlice(LS_ARCHIVED, fileRoster?.archived);
    if (!parsed.length) return [];
    // 归档 agent 没有活进程——强制打上标记并清空运行状态。
    return parsed.map((a) => ({
      ...a,
      archived: true,
      status: 'idle',
      ptyId: undefined,
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

function persistRestorable(restorable: Agent[]): void {
  // 保留 contextTokens/contextLimit，不同于另外两个：可恢复条目是一个尚未
  // 重新进入的会话的 spawn 配方，所以其最后已知的上下文大小仍有意义。
  const slim: PersistedAgent[] = restorable.map(({ recentAssistantText, recentTextTs, blockReason, seedPrompt, ...rest }) => {
    void recentAssistantText; void recentTextTs; void blockReason; void seedPrompt;
    return rest;
  });
  try {
    window.localStorage.setItem(LS_RESTORABLE, JSON.stringify(slim));
  } catch { /* noop */ }
  rosterMirror.restorable = slim;
  scheduleRosterFlush();
}

function loadPersistedRestorable(): Agent[] {
  try {
    const parsed = persistedSlice(LS_RESTORABLE, fileRoster?.restorable);
    if (!parsed.length) return [];
    // 没有活进程——清空运行状态；spawn 配方字段才是要紧的。
    return parsed.map((a) => ({
      ...a,
      status: 'idle',
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

function persistQueues(queues: Record<string, QueuedMessage[]>): void {
  try {
    // 只保留非空队列，让键保持小巧。
    const slim: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(queues)) if (q.length) slim[id] = q;
    window.localStorage.setItem(LS_QUEUES, JSON.stringify(slim));
    rosterMirror.queues = slim;
    scheduleRosterFlush();
  } catch { /* noop */ }
}

function loadPersistedQueues(): Record<string, QueuedMessage[]> {
  try {
    const parsed = useFileRoster
      ? (fileRoster?.queues as Record<string, QueuedMessage[]> | undefined)
      : useLocalFallback
        ? JSON.parse(window.localStorage.getItem(LS_QUEUES) ?? 'null') as Record<string, QueuedMessage[]> | null
        : null;
    if (!parsed || typeof parsed !== 'object') return {};
    // 防御性地只保留结构良好的条目。
    const out: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(parsed)) {
      if (Array.isArray(q)) {
        out[id] = q.filter((m) => m && typeof m.text === 'string' && typeof m.id === 'string');
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadPersistedSelectedId(agents: Agent[]): string | null {
  try {
    const id = useFileRoster
      ? fileRoster?.selectedId
      : useLocalFallback ? window.localStorage.getItem(LS_SELECTED) : null;
    return id && agents.some((a) => a.id === id) ? id : (agents[0]?.id ?? null);
  } catch {
    return agents[0]?.id ?? null;
  }
}
const initialSidebarWidth = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_WIDTH);
    const n = v ? parseInt(v, 10) : NaN;
    if (!Number.isNaN(n) && n >= 320 && n <= 1200) return n;
  } catch { /* noop */ }
  return 420;
})();
const initialSidebarTab: SidebarTab = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_TAB);
    if (v === 'terminal' || v === 'messages' || v === 'traces' || v === 'git') return v;
  } catch { /* noop */ }
  return 'terminal';
})();

/** 用户是否想把专注模式作为默认视图？
 *
 *  持久化为 BOOLEAN，刻意不存被专注 agent 的 id。id 跨重启无意义：那个
 *  agent 可能已被关闭，或其 PTY 可能不再回来，恢复一个过期的会直接落入
 *  `refocusAfterRemoval` 要防止的悬空引用。偏好是“我在专注模式下工作”，
 *  所以加载时我们针对当前选中的 agent 解析它。 */
const initialPrefersFocusMode = (() => {
  try {
    return window.localStorage.getItem(LS_FOCUS_MODE) === '1';
  } catch { /* noop */ }
  return false;
})();


const initialAgents = loadPersistedAgents();
const initialArchivedAgents = loadPersistedArchived();
const initialRestorableAgents = loadPersistedRestorable();
const initialSelectedId = loadPersistedSelectedId(initialAgents);
const initialQueues = loadPersistedQueues();

// 用刚加载的内容给镜像做种子，这样稍后对某一个切片的 persist 会写完整
// 文件，而不是抹掉它没碰到的切片。
rosterMirror.agents = slimAgents(initialAgents);
rosterMirror.archived = slimAgents(initialArchivedAgents);
rosterMirror.restorable = slimAgents(initialRestorableAgents);
rosterMirror.queues = initialQueues;
rosterMirror.selectedId = initialSelectedId;

// 第一次用文件运行：从该 origin 的 localStorage 给它播种。只有当有东西
// 可播种时——在这里写空文件会把空名单交给另一边，而那正是要被设计掉的
// 结果。
if (useLocalFallback && rosterMirror.agents.length + rosterMirror.archived.length + rosterMirror.restorable.length > 0) {
  scheduleRosterFlush();
}

let queuedSeq = 0;
/** 排队消息的进程内唯一 id（时间戳 + 计数器避免同毫秒内入队多条时冲突）。 */
function newQueuedId(): string {
  queuedSeq += 1;
  return `q-${Date.now()}-${queuedSeq}`;
}

export const useStore = create<State>((set, get) => ({
  agents: initialAgents,
  archivedAgents: initialArchivedAgents,
  restorableAgents: initialRestorableAgents,
  selectedId: initialSelectedId,
  feeds: {},
  addAgentOpen: false,
  ccTabRequest: null,
  requestCommandCenterTab: (tab) =>
    set((s) => ({ ccTabRequest: { tab, seq: (s.ccTabRequest?.seq ?? 0) + 1 } })),
  fullscreenAgentId: focusOnLoad(initialPrefersFocusMode, initialSelectedId),
  prefersFocusMode: initialPrefersFocusMode,
  ideInitialFile: null,
  ideOpen: false,
  ideAgentId: null,
  sidebarWidth: initialSidebarWidth,
  sidebarTab: initialSidebarTab,
  godStatus: 'booting',
  messageQueues: initialQueues,
  toolCounts: {},
  bumpToolCount: (id) =>
    set((s) => ({ toolCounts: { ...s.toolCounts, [id]: (s.toolCounts[id] ?? 0) + 1 } })),
  setGodStatus: (status) => set({ godStatus: status }),
  select: (id) => set((s) => { persistAgents(s.agents, id); return { selectedId: id, ccTabRequest: null }; }),
  updateAgent: (id, patch) =>
    set((s) => {
      const agents = s.agents.map(a => a.id === id ? { ...a, ...patch } : a);
      // 只在有 DURABLE 变化时持久化。`updateAgent` 同时也是 pty 解析器的
      // 逐块写入（status/action/progress），无条件持久化会在每次终端输出
      // 突发时重写 localStorage。完全持久化更糟：model 或 command 的变更
      // 只活在内存里，重载后选择器弹回旧 model、restore 重启旧命令。
      if (touchesDurableAgentField(patch)) persistAgents(agents, s.selectedId);
      return { agents };
    }),
  syncDescriptionsFromRoles: (roles) =>
    set((s) => {
      const apply = (list: Agent[]): Agent[] => {
        let changed = false;
        const next = list.map((a) => {
          const description = preferredAgentRole(a.description, roles[a.id], !!a.isGod);
          if (description === a.description) return a;
          changed = true;
          return { ...a, description };
        });
        return changed ? next : list;
      };
      const agents = apply(s.agents);
      const archivedAgents = apply(s.archivedAgents);
      const restorableAgents = apply(s.restorableAgents);
      if (agents === s.agents && archivedAgents === s.archivedAgents && restorableAgents === s.restorableAgents) {
        return s;
      }
      persistAgents(agents, s.selectedId);
      if (archivedAgents !== s.archivedAgents) persistArchived(archivedAgents);
      if (restorableAgents !== s.restorableAgents) persistRestorable(restorableAgents);
      return { agents, archivedAgents, restorableAgents };
    }),
  renameAgent: async (id, name) => {
    try {
      const result = await window.cth.hiveRenameAgent(id, name);
      if (!result.ok || !result.name) return { ok: false, error: result.error ?? '无法重命名 agent' };
      const nextName = result.name;

      set((s) => {
        const rename = (agents: Agent[]): Agent[] =>
          agents.map((agent) => agent.id === id ? { ...agent, name: nextName } : agent);
        const agents = rename(s.agents);
        const archivedAgents = rename(s.archivedAgents);
        const restorableAgents = rename(s.restorableAgents);
        persistAgents(agents, s.selectedId);
        persistArchived(archivedAgents);
        persistRestorable(restorableAgents);
        return { agents, archivedAgents, restorableAgents };
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法重命名 agent' };
    }
  },
  setAgentNote: (id, note) =>
    set((s) => {
      const agents = s.agents.map((a) => a.id === id ? { ...a, note } : a);
      persistAgents(agents, s.selectedId);
      return { agents };
    }),
  pushFeed: (id, line) =>
    set((s) => ({ feeds: { ...s.feeds, [id]: [...(s.feeds[id] ?? []), line] } })),
  addAgent: (agent) =>
    set((s) => {
      // 按 id 幂等：MAIN 发起的 spawn 广播（hive:agentSpawned，如语音雇佣）
      // 和渲染端发起的雇佣（AddAgentModal）可能对同一 id 都调用 addAgent
      // ——绝不渲染重复卡片。第一个写入者（更丰富的本地记录）获胜；广播
      // 对它而言是 no-op。
      if (s.agents.some((a) => a.id === agent.id)) return s;
      // GOD 在队首进入，其他人在队尾。Michael 的位置以前由一个他常输的
      // 竞争决定：useHive 的引导移除恢复的 god 条目，然后异步 spawn 他
      // （一个 setTimeout、一次 listPtys 往返、以及一个先播种 transcript 的
      // --resume），而 useRestoreTeam 并行重启上一会话的 workers。谁先
      // resolve 谁先落地，于是有 worker 要恢复的会话把 BOSS 卡片放到第四
      // 位——persistAgents() 随后把那个顺序写盘，于是它跨重启固定下来，
      // 而不是只闪烁一次。
      //
      // 在插入点修复，而不是在 AgentStrip 里排序：条带有拖拽重排
      // (reorderAgents)，其全部意义就是持久化的人工顺序，渲染时 god-first
      // 排序会每帧静默覆盖用户自己的安排。这里只是让队首成为诚实的默认；
      // 刻意拖拽仍然有效并仍然持久化。
      const agents = agent.isGod ? [agent, ...s.agents] : [...s.agents, agent];
      // 重新 spawn 一个归档 agent 会取消归档：一个 id 要么活跃要么归档。
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== agent.id);
      // 活跃（重新）spawn 也会消费同一 id 的任何可恢复条目。
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== agent.id);
      persistAgents(agents, agent.id);
      persistArchived(archivedAgents);
      if (restorableAgents.length !== s.restorableAgents.length) persistRestorable(restorableAgents);
      return {
        agents,
        archivedAgents,
        restorableAgents,
        selectedId: agent.id,
        feeds: { ...s.feeds, [agent.id]: s.feeds[agent.id] ?? [] }
      };
    }),
  removeAgent: (id) =>
    set((s) => {
      const agents = s.agents.filter(a => a.id !== id);
      const { [id]: _gone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      const fullscreenAgentId = refocusAfterRemoval(s.fullscreenAgentId, agents, selectedId);
      persistAgents(agents, selectedId);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, feeds, selectedId, messageQueues, fullscreenAgentId };
    }),
  archiveAgent: (id) =>
    set((s) => {
      const target = s.agents.find((a) => a.id === id);
      if (!target) return s;
      const agents = s.agents.filter((a) => a.id !== id);
      // 保留一份带标记的副本；PTY 已消失，所以清空所有实时运行状态。
      const archivedEntry: Agent = {
        ...target,
        archived: true,
        ptyId: undefined,
        status: 'idle',
        action: '已归档',
        carrying: undefined,
        currentStation: undefined
      };
      const archivedAgents = [...s.archivedAgents.filter((a) => a.id !== id), archivedEntry];
      const { [id]: _feedGone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      const fullscreenAgentId = refocusAfterRemoval(s.fullscreenAgentId, agents, selectedId);
      persistAgents(agents, selectedId);
      persistArchived(archivedAgents);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, archivedAgents, feeds, selectedId, messageQueues, fullscreenAgentId };
    }),
  removeArchivedAgent: (id) =>
    set((s) => {
      if (!s.archivedAgents.some((a) => a.id === id)) return s;
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== id);
      persistArchived(archivedAgents);
      return { archivedAgents };
    }),
  removeRestorableAgent: (id) =>
    set((s) => {
      if (!s.restorableAgents.some((a) => a.id === id)) return s;
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== id);
      persistRestorable(restorableAgents);
      return { restorableAgents };
    }),
  reorderAgents: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return s;
      const from = s.agents.findIndex((a) => a.id === fromId);
      const to = s.agents.findIndex((a) => a.id === toId);
      if (from === -1 || to === -1) return s;
      const agents = [...s.agents];
      const [moved] = agents.splice(from, 1);
      agents.splice(to, 0, moved);
      // 持久化新名单顺序，让它跨重载存活（与名单其余部分相同的精简键）。
      // 重排不改变 selectedId。
      persistAgents(agents, s.selectedId);
      return { agents };
    }),
  taskDetailId: null,
  openTaskDetail: (id) => set({ taskDetailId: id }),
  closeTaskDetail: () => set({ taskDetailId: null }),
  dispatchSeedRequest: null,
  requestDispatchSeed: (text) =>
    set((s) => ({ dispatchSeedRequest: { text, seq: (s.dispatchSeedRequest?.seq ?? 0) + 1 } })),
  answerDrafts: {},
  setAnswerDraft: (taskId, text) =>
    set((s) => ({ answerDrafts: { ...s.answerDrafts, [taskId]: text } })),
  drafts: {},
  setDraft: (agentId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [agentId]: text } })),
  freeflowEnabled: false,
  setFreeflowEnabled: (on) => set({ freeflowEnabled: on }),
  hasGroqKey: false,
  setHasGroqKey: (has) => set({ hasGroqKey: has }),
  hasOpenAiKey: false,
  setHasOpenAiKey: (has) => set({ hasOpenAiKey: has }),
  officeTheme: 'office',
  setOfficeTheme: (theme) => set({ officeTheme: theme }),
  webhookTriggers: [],
  setWebhookTriggers: (list) => set({ webhookTriggers: list }),
  // 副本，不是共享的 DEFAULT_ORG_TRIGGER 实例——main 也这样小心
  // (withTriggerDefaults)，把模块级默认交出去就是一次粗心改动改写所有人
  // 默认的方式。
  orgTrigger: { ...DEFAULT_ORG_TRIGGER },
  setOrgTrigger: (cfg) => set({ orgTrigger: cfg }),
  enqueueMessage: (agentId, text, meta) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
      // 每个 agent 只有一个待决 COMPACT。压缩在最坏的意义上是幂等的：第一条
      // `/compact` 完成工作，它后面的每一条都回答 “nothing to compact”，所以
      // 累积它们的队列会为每个副本花费一个投递槽和一次模型往返却毫无所得，
      // 并把操作员的真实积压埋在后面。
      //
      // 这个不变量住在 HERE 而不是调用点，因为调用点有好几个——context
      // trigger、god 派发工单、Slack、输入框——而每个自建检查的调用点仍可能
      // 被某人新增的下一条路径绕过。context trigger 自己的检查保留为廉价的
      // 纵深防御，但这里这一个无法被绕开。
      const queued = s.messageQueues[agentId] ?? [];
      if (isCompactionCommand(trimmed) && queued.some((m) => isCompactionCommand(m.text))) {
        return s;
      }
      // 每个 agent 只有一个待决 INBOX NUDGE——同样的性质，同样的理由。
      // 第一个 nudge 让 agent 排空其整个 inbox，所以排在后面的每个 nudge
      // 都落在一个 agent 已经清空的目录上并回答 “nothing new”：每个花费
      // 一个投递槽和一次模型往返，却无话可说。agent 回合中途到达的邮件会
      // 每个轮询排一个 nudge，所以这是常见情形而非罕见情形，楼层把它报告
      // 为重复的空 inbox 唤醒。抑制副本不损失任何东西——幸存的 nudge 把
      // agent 送到同一个权威目录，更新的邮件也等在那里。
      if (isInboxNudge(trimmed) && queued.some((m) => isInboxNudge(m.text))) {
        return s;
      }
            const msg: QueuedMessage = {
        id: newQueuedId(), text: trimmed, ts: Date.now(),
        ...(meta?.slack ? { slack: meta.slack } : {}),
        ...(meta?.instruction ? { instruction: meta.instruction } : {}),
        ...(meta?.precondition ? { precondition: meta.precondition } : {}),
        ...(meta?.compactUsed !== undefined ? { compactUsed: meta.compactUsed } : {})
      };
      const messageQueues = { ...s.messageQueues, [agentId]: [...(s.messageQueues[agentId] ?? []), msg] };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  removeQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      if (!current) return s;
      const next = current.filter((m) => m.id !== messageId);
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  releaseQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      const target = current?.find((m) => m.id === messageId);
      if (!current || !target) return s;
      const next = [
        { ...target, manual: true },
        ...current.filter((m) => m.id !== messageId)
      ];
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  clearQueue: (agentId) =>
    set((s) => {
      if (!s.messageQueues[agentId]?.length) return s;
      const messageQueues = { ...s.messageQueues, [agentId]: [] };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  reconcileWithLivePtys: (livePtyIds) =>
    set((s) => {
      const live = new Set(livePtyIds);
      // 保留没有 PTY（合成）或 PTY 仍存活的 agent。
      const agents = s.agents.filter((a) => !a.ptyId || live.has(a.ptyId));
      if (agents.length === s.agents.length) return s;
      // 终端随上一会话死亡的 worker 变为可恢复（保留完整 spawn 配方）而不是
      // 静默消失。god 与预备助手被排除——它们启动时自动重启。
      const dead = s.agents.filter(
        (a) => a.ptyId && !live.has(a.ptyId) && !a.isGod && !a.isAssistant
      );
      const restorableAgents = [
        ...s.restorableAgents.filter((r) => !dead.some((d) => d.id === r.id)),
        ...dead
      ];
      const feeds: Record<string, string[]> = {};
      for (const a of agents) feeds[a.id] = s.feeds[a.id] ?? [];
      const selectedId = agents.some((a) => a.id === s.selectedId)
        ? s.selectedId
        : (agents[0]?.id ?? null);
      const fullscreenAgentId = refocusAfterRemoval(s.fullscreenAgentId, agents, selectedId);
      persistAgents(agents, selectedId);
      persistRestorable(restorableAgents);
      return { agents, feeds, selectedId, restorableAgents, fullscreenAgentId };
    }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  hireQueue: EMPTY_HIRE_QUEUE,
  enqueuePendingHires: (manifests) => set((s) => ({
    hireQueue: enqueueHires(s.hireQueue, manifests)
  })),
  finishPendingHire: () => set((s) => ({
    hireQueue: finishCurrentHire(s.hireQueue)
  })),
  clearPendingHires: () => set((s) => ({
    hireQueue: clearHireQueue(s.hireQueue)
  })),
  setFullscreen: (id) => {
    // 进入专注模式让它成为默认视图；离开则清除。只有显式开关才写偏好，所以
    // 一个 agent 在你面前关闭绝不会静默改变应用下次打开的方式。每个非显式
    // 的移动者都改走 `refocusFullscreen`。
    try { window.localStorage.setItem(LS_FOCUS_MODE, id ? '1' : '0'); } catch { /* noop */ }
    set({ fullscreenAgentId: id, prefersFocusMode: !!id });
  },
  refocusFullscreen: (id) => set({ fullscreenAgentId: id }),
  restoreFocusMode: () =>
    set((s) => {
      const id = restoreFocus(s.prefersFocusMode, s.fullscreenAgentId, s.agents, s.selectedId);
      return id === s.fullscreenAgentId ? s : { fullscreenAgentId: id };
    }),
  openFileInIde: (absPath) => {
    const s = get();
    // 在这里解析 OWNING agent，而不是在调用方：终端链接或 Files 标签页点击
    // 常常没有选中项，否则 IDE 会回退到选中项并打开错误的工作区。
    const owner = s.agents.find((a) => absPath === a.cwd || absPath.startsWith(a.cwd + '/'));
    set({ ideInitialFile: absPath, ideOpen: true, ideAgentId: owner?.id ?? null });
  },
  // 关闭时 CLEARS 目标：id 的作用域是一次 IDE 会话，留下的过期 id 会在
  // 没有传参的调用方下次打开时静默压过选中项。
  setIdeOpen: (open, agentId) => set({ ideOpen: open, ideAgentId: open ? (agentId ?? null) : null }),
  setIdeInitialFile: (path) => set({ ideInitialFile: path }),
  setSidebarWidth: (px) => {
    const clamped = Math.min(1200, Math.max(320, Math.round(px)));
    try { window.localStorage.setItem(LS_SIDEBAR_WIDTH, String(clamped)); } catch { /* noop */ }
    set({ sidebarWidth: clamped });
  },
  setSidebarTab: (tab) => {
    try { window.localStorage.setItem(LS_SIDEBAR_TAB, tab); } catch { /* noop */ }
    set({ sidebarTab: tab });
  }
}));

export function selectedAgent(s: State): Agent | undefined {
  return s.agents.find(a => a.id === s.selectedId);
}

/** 指挥中心的触发器历史标签页是否已经有事可谈：设置了组织密钥，或至少
 *  存在一个 webhook。由两个镜像推导而来，而不是存在它们旁边，因此它不会
 *  与它所描述的东西脱节。用法：`useStore(triggerHistoryVisible)`。 */
export function triggerHistoryVisible(s: State): boolean {
  return s.webhookTriggers.length > 0 || s.orgTrigger.apiKey.trim() !== '';
}
