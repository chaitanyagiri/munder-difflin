import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { AgentProvider } from '../shared/agentProvider';
import type { HireManifest } from '../shared/hire';
export type { HireManifest } from '../shared/hire';
import type { IntegrationRecord, IntegrationTemplate } from '../shared/integrations';
export type { IntegrationRecord, IntegrationTemplate } from '../shared/integrations';
import type { UpdateStatus } from '../shared/updateState';
export type { UpdateStatus } from '../shared/updateState';
import type { ToolStatus } from '../shared/toolCatalog';
export type { ToolStatus } from '../shared/toolCatalog';
import type { HeroPayload } from '../shared/heroPayload';
export type { HeroPayload } from '../shared/heroPayload';
import type { HookEvent } from '../shared/hookEvents';
export type { HookEvent } from '../shared/hookEvents';
import type { LocalSkill, CatalogSkill } from '../main/skills';
export type { LocalSkill, CatalogSkill } from '../main/skills';
import type {
  ContextRule, ContextTriggerConfig, OrgTriggerConfig, TriggerHistoryEntry, WebhookTrigger
} from '../shared/triggers';
export type {
  ContextRule, ContextTriggerConfig, OrgTriggerConfig, TriggerHistoryEntry, WebhookTrigger
} from '../shared/triggers';

/** 渲染进程可见的集成记录：secretRef 句柄被脱敏为
 *  存在性布尔值。与主进程 `integrations.listRecordsRedacted()` 一致——
 *  只写密钥契约（规范 §2）：密钥值绝不通过 IPC 返回。 */
export type IntegrationRecordView = Omit<IntegrationRecord, 'secretRef'> & { hasSecret: boolean };

// 构建时从 package.json 注入（见 electron.vite.config.ts）。
declare const __APP_VERSION__: string;

/** 渲染进程的花名册，与 `<harnessHome>/roster.json` 保持同步。agent
 *  条目在此保持 `unknown`，与主进程让它们保持不透明同理：存储层拥有该形状，
 *  若在桥接层重复定义，则每次为 agent 新增字段都要改两个文件。 */
export interface RosterSnapshot {
  version: 1;
  savedAt: string;
  agents: unknown[];
  archived: unknown[];
  restorable: unknown[];
  queues: Record<string, unknown[]>;
  selectedId: string | null;
}

export interface HiveAgentMeta {
  id: string;
  name: string;
  /** 该 agent 运行在哪个 CLI 上（claude/codex/grok/antigravity/custom）；默认为 claude。 */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael 的预处理助手——只发送；增强提示词后转发。 */
  isAssistant?: boolean;
}

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** 为语音读取层（`hive:messages`）重塑后的 hive 消息。`subject` 与 `body`
 *  在跨越此边界前已由主进程脱敏——渲染进程永远不会收到原始正文或密钥。
 *  与 src/main/hive.ts 中的 `VoiceMessage` 保持一致。 */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: HiveMessage['act'];
  subject: string;
  body: string;
  requires_reply: boolean;
  direction: 'inbox' | 'outbox';
  owner: string;
  archived: boolean;
  created_at: string;
}

export interface HiveRegistry {
  godId: string | null;
  /** `archived` agent 的终端已关闭——保留并打标记，而不是删除；
   *  只有实时 PTY 的 agent 才是 'active'。 */
  agents: Record<string, HiveAgentMeta & {
    status: string;
    lastSeen: number;
    archived?: boolean;
    sessionId?: string;
  }>;
}

/** 合并后的语音读取层目录（`hive:agentDirectory`）中的一行：办公室楼层侧边栏
 *  与遥测所知的关于某 agent 的全部信息，汇集成一条不含 PII 的记录。
 *  包含已归档的 agent。 */
export interface AgentDirectoryEntry {
  id: string;
  name: string;
  role: string;
  provider: string;
  /** 实时模型 id（已规范化，若记录过任何用量）；否则为 null。 */
  model: string | null;
  status: string;
  cwd: string | null;
  /** `cwd` 是否为绝对路径且真实存在的目录（可用于启动）。 */
  cwdValid: boolean | null;
  archived: boolean;
  isGod: boolean;
  isAssistant: boolean;
  sessionId: string | null;
  /** 该 agent 是否已记录超出种子头部之外的非平凡记忆。 */
  hasMemory: boolean;
  inboxBacklog: number;
  breaker: string;
  tokens: number;
  /** 累计花费；仅为完整性而携带——语音层以 token 为口径。 */
  usd: number;
  lastTool: string | null;
  lastActiveSecAgo: number | null;
  contextTokens: number | null;
  contextLimit: number | null;
  contextPct: number | null;
}

export interface AgentDirectory {
  godId: string | null;
  agents: AgentDirectoryEntry[];
}

/** 与人类的一次问答往来，记录在任务卡片上。 */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
}

/** 任务看板上的一张卡片，持久化到 hive/tasks.json。 */
export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** 第一类人类反馈：god 追加 {q}，harness UI 填写 {a}；
   *  完整历史保留在卡片上。 */
  humanQA?: HumanQA[];
  /** 用于 Slack 完成通知的结果摘要。 */
  result?: string;
  /** Slack 来源任务的原始线程（驱动完成摘要的回复）。 */
  slack?: { channel: string; thread_ts: string };
  /** 通用 Webhook 来源任务的能力令牌的 SHA-256（驱动 GET 状态查询；
   *  原始令牌从不持久化）。 */
  webhook?: { tokenHash: string };
}

/** 路由器刚刚投递的一条消息，带已解析的收件人 id。驱动办公室楼层的信封交接
 *  动画。当发送方以 "human" 为目标（现已路由到 god 代理）时设置 `needsHuman`
 *  ——仅作外观着色；不存在审批队列。 */
export interface HiveRouteEvent {
  id: string;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  targets: string[];
  needsHuman: boolean;
}

/** 发送给无法清空 hive 收件箱的 provider 的直接 hive 消息。
 *  渲染进程将其转换为该 agent 的排队终端工单。 */
export interface HiveTerminalHandoffEvent {
  id: string;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  body: string;
  requiresReply: boolean;
  createdAt: string;
}

export interface SpawnPtyOptions {
  id: string;
  cwd: string;
  command: string;
  /** 要启动哪个 CLI；通常在主进程中从 `command` 推断。 */
  provider?: AgentProvider;
  args?: string[];
  cols?: number;
  rows?: number;
  /** 存在时，agent 在启动时于 hive 中预置。 */
  hive?: HiveAgentMeta;
  /** 为 true（且 cwd 是 git 仓库）时，在 agent 自己的 git worktree 中启动。 */
  isolate?: boolean;
  /** 为 true 且记录过会话时，继续该 agent 之前的 CLI 会话
   *  （按 provider 区分：Claude/Grok `--resume`，Antigravity `--conversation`）。
   *  对于 Claude，主进程从 hive 注册表查找会话 id，并将其转录种子写入
   *  cwd 的项目目录（#1 — 重启时恢复）。 */
  resume?: boolean;
  /** 请求的恢复会话无法挂接时，在启动前失败。 */
  requireResume?: boolean;
  /** 要恢复的显式 Claude 会话 id（#2 — 添加 Agent「恢复会话」）。主进程
   *  将该会话的 `.jsonl` 种子写入目标 cwd 的项目目录（从任意所在位置复制）
   *  并启动 `claude --resume <id>`。 */
  resumeSessionId?: string;
}

export interface PtyExit { exitCode: number; signal?: number | undefined }

/** 由调度器按时间间隔触发的循环自动派发任务。 */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** 任务风格；'heartbeat'（泳道 A #1）是一种感知上下文的自适应心跳。 */
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** 仅限心跳：楼层静默阈值（毫秒）。 */
  quietThresholdMs?: number;
}

/** 熔断器阈值（泳道 A #6.6b）。与 src/main/config.ts 保持一致。 */
export interface KnowledgeGraphConfig {
  enabled?: boolean;
  rootPath?: string;
}

export interface CircuitBreakerConfig {
  enabled?: boolean;
  hardStop?: boolean;
  repeatedToolLimit?: number;
  errorStormLimit?: number;
  tokenVelocityPerMin?: number;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  /** 引导受众（'technical' | 'non-technical'）；决定引导文案。
   *  与 src/main/config.ts 保持一致。 */
  audience?: 'technical' | 'non-technical';
  harnessHome: string | null;
  /** 最近打开的 hive home 文件夹（最新在前）。与 src/main/config.ts 保持一致。 */
  recentHives?: string[];
  registeredRepos: string[];
  autoMode: boolean;
  defaultCommand: string;
  defaultModel?: string;
  /** 为 GOD 编排器（"Michael"）提供能力的 provider+model。默认
   *  'claude' / 'claude-opus-4-8'。与 src/main/config.ts 保持一致。 */
  godProvider?: AgentProvider;
  godModel?: string;
  /** 默认 MCP 集合的按服务器同意配置，以目录 id 为键。与
   *  src/main/config.ts 保持一致。 */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  missions?: ScheduledMission[];
  opsStandupSeeded?: boolean;
  heartbeatSeeded?: boolean;
  notifications?: boolean;
  /** 选择加入的强保活（防止显示器休眠）。与主进程 + 渲染进程
   *  的 HarnessConfig 保持一致，使 updateConfig({ strongKeepalive }) 在桥上带类型。 */
  strongKeepalive?: boolean;
  /** 从 GitHub releases 自动更新（默认开启；设置 → 常规）。 */
  autoUpdate?: boolean;
  /** 匿名产品分析（默认开启，可选择退出；见 TELEMETRY.md）。
   *  与主进程 + 渲染进程的 HarnessConfig 保持一致。 */
  telemetryEnabled?: boolean;
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackPort?: number;
  slackProactivePosting?: boolean;
  webhookEnabled?: boolean;
  webhookSecret?: string;
  webhookPort?: number;
  /** Free Flow 语音听写——总开关（默认关闭）、用户 Groq 密钥、模型。
   *  入口点 B（按住 Option 说话）由渲染进程处理，无快捷键。 */
  freeflowEnabled?: boolean;
  groqApiKey?: string;
  freeflowModel?: string;
  /** Realtime Michael 语音循环——仅当会话持有麦克风时为 true
   *  （渲染进程会话在 start()/stop() 时设置它）；主进程的麦克风权限闸
   *  读取该值。默认关闭。 */
  realtimeVoiceEnabled?: boolean;
  /** 实时语音空闲自动断开（毫秒）；默认 180000（3 分钟），0 = 从不。
   *  在设置 → Realtime Michael 中调节；成本上限始终是失控保护。 */
  realtimeIdleDisconnectMs?: number;
  costCapUsd?: number;
  costCapTokens?: number;
  agentTokenCaps?: Record<string, number>;
  autoDeliveryPausedAgents?: string[];
  maxTurns?: number;
  circuitBreaker?: CircuitBreakerConfig;
  /** 企业知识图谱（面向 agent 的多模态上下文）。默认关闭。 */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** 终端主题，镜像到每个 agent 的会话级 Claude 设置。 */
  terminalTheme?: 'light' | 'dark';
  /** 电视剧办公室主题功能开关（设置选择器 + 切换流程）。默认关闭。 */
  tvShowOffices?: boolean;
  /** 当前的办公室地图/演员主题（仅在 tvShowOffices 开启时生效）。 */
  officeTheme?: 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
  /** 每个 CLI provider 的本地/自托管 base URL（Ollama/LM Studio/vLLM, …），
   *  用于 OpenCode/Crush/pi/qwen 引擎；启动时应用。API 密钥不存储在这里——
   *  它们以只写方式存放在密钥代理中。 */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** 每个 CLI provider 的默认模型 slug，用于预填模型选择器。 */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
}

export interface MemoryStatus {
  available: boolean;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  palacePath: string | null;
  model: 'minilm' | 'embeddinggemma';
  bin: string | null;
}

/** 企业知识图谱——语料状态、单篇文档与一条搜索结果。 */
export interface KnowledgeStatus {
  enabled: boolean;
  root: string;
  docCount: number;
  chunkCount: number;
  byModality: Record<string, number>;
}
export interface KnowledgeDoc {
  id: string;
  title: string;
  source: string;
  modality: string;
  mime: string | null;
  origExt: string;
  bytes: number;
  tags: string[];
  caption: string | null;
  chunkCount: number;
  addedAt: string;
  extractor: string;
  truncated: boolean;
}
export interface KnowledgeHit {
  docId: string;
  title: string;
  source: string;
  modality: string;
  chunkIdx: number;
  score: number;
  snippet: string;
}
export interface KnowledgeIngestResult {
  ok: boolean;
  results: Array<{ ok: boolean; srcPath: string; docId?: string; chunkCount?: number; error?: string }>;
  error?: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number;
  refs: string[];
}
export interface GitStatusEntry { path: string; index: string; worktree: string }
export interface GitStatus { staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: string[] }
/** 单个文件在「工作区 vs HEAD」diff 中的两侧内容（见主进程 git.getDiff）。 */
export interface GitDiff {
  ok: true;
  path: string;
  relPath: string;
  head: string;
  working: string;
  headExists: boolean;
  workingExists: boolean;
  isBinary: boolean;
}

/** v0.3.4 git 可视化——与 src/main/git.ts 的 GitCommit / GitCommitFile 保持一致。 */
export interface GitCommitRow {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number;
  refs: string[];
}
export interface GitFileChange {
  path: string;
  status: string;
  oldPath?: string;
}

/** 从 ~/.claude/projects 下某 agent 的 Claude Code 转录中汇总的真实 token
 *  用量 + 预估 USD 成本。对账/回退路径——现在按模型单独计价
 *  （不再是全民 Sonnet）。实时路径使用 AgentUsageSample。 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  /** 最近见到的模型 id（已规范化，若找到任何计价记录）。 */
  model?: string;
}

/** 来自 OTel 采集器的实时累计成本/token 快照（固定的跨泳道接缝）。
 *  结构上不含 PII。与 telemetry.ts 保持一致。 */
export interface AgentUsageSample {
  agentId: string;
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
  usd: number;
}

/** 单个工具调用，用于按 agent 划分的 span 瀑布图（#7B.2）。临时数据。 */
export interface ToolSpan {
  agentId: string;
  sessionId: string;
  ts: number;
  tool: string;
  success: boolean;
  durationMs: number;
  decision?: 'accept' | 'reject';
  error?: string;
}

/** 电源恢复信号（与 src/main 中的发射器保持一致）。Mac 从睡眠/解锁中
 *  唤醒后触发：`dead` 列出睡眠前存活但在恢复后没有任何输出的 PTY id
 *  （卡死的终端）；`total` 是被检查的数量。渲染进程只自动重生这些 `dead` id。 */
export interface PowerResumeEvent {
  reason: string;
  awayMs: number | null;
  dead: string[];
  total: number;
}

/** 打烊（收尾）进度事件（与 src/main/closingTime.ts 保持一致）。 */
export interface ClosingTimeEvent {
  phase: 'started' | 'progress' | 'complete' | 'timeout' | 'cancelled';
  /** 目前已完成 ACK 的 worker 数 / 正在等待的 worker 总数。 */
  acked: number;
  total: number;
}

/** 每 agent 的操作员控制状态（#7C.1–7C.3）。 */
export interface AgentControlSnapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

/** 熔断器状态（泳道 A #6 → 本泳道的头像/仪表）。 */
export interface BreakerState {
  agentId: string;
  level: 'healthy' | 'steering' | 'constrained' | 'stopped';
  reason: string;
  ts: number;
}

/** 实时遥测推送负载（通道 `telemetry:event`）。 */
export type TelemetryEvent =
  | { kind: 'usage'; sample: AgentUsageSample }
  | { kind: 'tool_result'; span: ToolSpan }
  | { kind: 'api_error'; agentId: string; sessionId: string; ts: number; error: string };

/** 来自采集器的冷启动回填。 */
export interface TelemetrySnapshot {
  usage: AgentUsageSample[];
  spans: Record<string, ToolSpan[]>;
}

/** 从 SQLite 的 command_history 表捕获的一条用户提示。 */
export interface CommandHistoryEntry {
  id: number;
  agentId: string;
  cwd: string | null;
  text: string;
  ts: number;
}

/** 一个 GitHub issue，已为渲染进程规范化（标签/指派者摊平为名称）。 */
export interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** 一次 CI（GitHub Actions）工作流运行，已为渲染进程规范化。 */
export interface CIRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

/** 一个由 god 触发存活的临时 worker，如 Workers 标签页所示。 */
export interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY 已消失
  tokensUsed: number;
  tokenCap: number | null;      // 生效上限；null = 不限（默认）
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working';
}
/** 在拆卸时保留的 worker worktree，等待集成 + GC。 */
export interface PreservedWorktreeSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

const api = {
  version: __APP_VERSION__,

  // ─── 分析 ───────────────────────────────────────────────────────────
  /** 计数一条人类发送的消息（TELEMETRY.md → `message_sent`）。只携带
   *  界面名称，别无其他——无文本、无长度、无 agent id——主进程在此只接受
   *  'terminal' 和 'composer'（steer 和 hive 在主进程各自的处理器中计数）。
   *  调用方从不等待它，也绝不允许它抛出异常：遥测小故障不得破坏发送消息。 */
  trackMessageSent: (surface: 'terminal' | 'composer'): Promise<void> =>
    ipcRenderer.invoke('analytics:messageSent', surface).then(() => undefined, () => undefined),

  // ─── PTY ─────────────────────────────────────────────────────────────────
  /** 结果里的 `cwd` 是主进程实际启动时所在的、已展开波浪号的绝对路径——
   *  渲染进程保存它，而不是用户输入的原始 `~/…`。 */
  spawnPty: (opts: SpawnPtyOptions): Promise<{ ok: boolean; error?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string }> =>
    ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id: string, data: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:write', id, data),
  resizePty: (id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  redrawPty: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:redraw', id),
  killPty: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:kill', id),
  listPtys: (): Promise<Array<{
    id: string;
    cwd: string;
    command: string;
    pid: number;
    lastOutputAt: number;
    hasOutput: boolean;
  }>> =>
    ipcRenderer.invoke('pty:list'),
  /** 将 Claude 会话 id 解析为其最初运行的 cwd（添加 Agent 的
   *  恢复自动填充），若 id 无效/未知则为 null。 */
  resolveSessionCwd: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke('session:resolveCwd', sessionId),
  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const channel = `pty:data:${id}`;
    const listener = (_e: IpcRendererEvent, data: string) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (id: string, cb: (info: PtyExit) => void): (() => void) => {
    const channel = `pty:exit:${id}`;
    const listener = (_e: IpcRendererEvent, info: PtyExit) => cb(info);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** 首次安装引擎 CLI 后，agent 被自动重启并恢复到同一个 pty 时触发。
   *  终端应在原地重新武装（清除「进程已退出」行 + 重新启用输入），
   *  使重启后的 CLI 干净呈现。 */
  onPtyRelaunch: (id: string, cb: () => void): (() => void) => {
    const channel = `pty:relaunch:${id}`;
    const listener = () => cb();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // ─── 对话框 ──────────────────────────────────────────────────────────────
  chooseFolder: (): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('dialog:chooseFolder'),

  // ─── Terminal.app ────────────────────────────────────────────────────────
  openTerminalAt: (cwd: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:openAtFolder', cwd),

  // ─── 剪贴板 ─────────────────────────────────────────────────────────────
  copyToClipboard: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:copyToClipboard', text),
  /** 以纯文本读取系统剪贴板（为空/不可读时为 ''）。 */
  readClipboard: (): Promise<string> =>
    ipcRenderer.invoke('app:readClipboard'),
  /** 剪贴板文本，同步读取。仅用于终端的粘贴快捷键——
   *  在那里，异步读取会输给听写工具的竞态：它们在发送粘贴键
   *  之后立即恢复此前的剪贴板。
   *
   *  权衡，明说如下：sendSync 会阻塞渲染进程直到主进程应答——
   *  本应用有主线程卡顿的历史（iCloud 驱逐的文件卡住 spawnSync git 调用），
   *  而在这种卡顿期间，本调用会冻结粘贴按键而非仅仅延迟。之所以接受，
   *  是因为剪贴板读取是不涉及 I/O 的内存查找，而且异步替代方案
   *  实测是错误的——它会粘贴用户此前的剪贴板。不要以这套理由
   *  在别处使用 sendSync；它由竞态而非便利性所正当化。 */
  readClipboardSync: (): string => {
    try { return ipcRenderer.sendSync('app:readClipboardSync') ?? ''; } catch { return ''; }
  },

  // ─── 配置 ──────────────────────────────────────────────────────────────
  getConfig: (): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:get'),
  updateConfig: (patch: Partial<HarnessConfig>): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:update', patch),
  /** 针对主进程最新配置，设置或清除单个 agent 的 token 上限。 */
  setAgentTokenCap: (agentId: string, tokenCap?: number): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:setAgentTokenCap', agentId, tokenCap),
  ensureHarnessHome: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:ensureHome', path),
  /** 更改 harness home 文件夹。'move' 将现有 hive + palace 复制到新文件夹
   *  （旧目录保留作安全网）；'fresh' 只是重新指向并引导一个空 home。
   *  成功时应用会重启（promise 永不 resolve）；失败时
   *  （如复制错误）返回 { ok: false, error }。 */
  changeHome: (newHome: string, mode: 'move' | 'fresh'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:changeHome', { newHome, mode }),

  // ─── 文件系统（限定于 cwd） ───────────────────────────────────────
  listDir: (root: string, rel: string): Promise<
    { ok: true; entries: DirEntry[]; path: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:listDir', root, rel),
  readFile: (root: string, rel: string): Promise<
    { ok: true; content: string; path: string; size: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:readFile', root, rel),
  /** `readFile` 拒绝读取的文件（如图片）的原始字节。渲染进程无法从磁盘
   *  加载它们——CSP 不允许 `file:` 源，也没有注册 file 协议——因此图片以
   *  字节形式传输，并在渲染进程中变成 `blob:` URL，`img-src` 已允许这种形式。
   *  主进程将其限制在根目录内并设置大小上限；`mime` 由扩展名推导。 */
  readBinary: (root: string, rel: string): Promise<
    // `Uint8Array<ArrayBuffer>`，而不是裸别名：结构化克隆总是
    // 把「普通 ArrayBuffer 上的视图」交给渲染进程，在类型上这样写明，
    // 值才能直接进入 `new Blob([...])`——默认的
    // `ArrayBufferLike` 允许 SharedArrayBuffer，而 BlobPart 会拒绝它。
    { ok: true; bytes: Uint8Array<ArrayBuffer>; mime: string; path: string; size: number }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:readBinary', root, rel),
  writeFile: (root: string, rel: string, content: string): Promise<
    { ok: true; path: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:writeFile', root, rel, content),
  /** v0.3.4：绝对路径的存在性检查（展开 ~）——支撑终端的 ⌘-点击
   *  markdown 流程。仅元数据，绝不涉及内容。 */
  statAbs: (p: string): Promise<{ exists: boolean; isFile: boolean; path: string }> =>
    ipcRenderer.invoke('fs:statAbs', p),
  /** 在系统文件浏览器（Finder / Explorer / Linux 默认）中显示路径。
   *  支撑对终端路径的 ⌘-点击——我们对它没有可用的查看器。仅做揭示——主进程
   *  从不启动文件的默认应用，因为该路径来自 agent 的输出。 */
  revealPath: (p: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:revealPath', p),

  // ─── Git ─────────────────────────────────────────────────────────────────
  gitIsRepo: (cwd: string): Promise<boolean> => ipcRenderer.invoke('git:isRepo', cwd),
  /** `cwd` 所属主工作树（MAIN working tree）的绝对路径——链接的 worktree
   *  解析为原始仓库，而不是自身。非 git 仓库时为 null。 */
  gitMainRepo: (cwd: string): Promise<string | null> => ipcRenderer.invoke('git:mainRepo', cwd),
  gitBranch: (cwd: string) =>
    ipcRenderer.invoke('git:branch', cwd) as Promise<{ current: string | null; detached: boolean } | { error: string }>,
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke('git:status', cwd) as Promise<GitStatus | { error: string }>,
  gitLog: (cwd: string, n?: number) =>
    ipcRenderer.invoke('git:log', cwd, n ?? 50) as Promise<GitCommit[] | { error: string }>,
  gitBranches: (cwd: string) =>
    ipcRenderer.invoke('git:branches', cwd) as Promise<{ local: string[]; remote: string[]; current: string | null } | { error: string }>,
  gitAheadBehind: (cwd: string) =>
    ipcRenderer.invoke('git:aheadBehind', cwd) as Promise<{ ahead: number; behind: number; upstream: string | null } | { error: string }>,
  /** 对单个相对仓库根目录的文件做 diff：其 HEAD 内容 vs 工作区内容。
   *  路径在主进程侧针对 `cwd` 校验；渲染进程只会拿到两侧文本。
   *  支撑 IDE 的 git-diff（Monaco DiffEditor）视图。 */
  gitDiff: (cwd: string, relPath: string) =>
    ipcRenderer.invoke('git:diff', cwd, relPath) as Promise<GitDiff | { ok: false; error: string }>,
  // ── v0.3.4：历史 / 对比 / 检出（git 可视化） ──
  gitLogGraph: (cwd: string, n: number, skip?: number) =>
    ipcRenderer.invoke('git:logGraph', cwd, n, skip ?? 0) as Promise<GitCommitRow[] | { error: string }>,
  gitCommitFiles: (cwd: string, sha: string) =>
    ipcRenderer.invoke('git:commitFiles', cwd, sha) as Promise<GitFileChange[] | { error: string }>,
  gitShowFile: (cwd: string, rev: string, relPath: string) =>
    ipcRenderer.invoke('git:showFile', cwd, rev, relPath) as Promise<
      { ok: true; exists: boolean; isBinary: boolean; content: string } | { ok: false; error: string }
    >,
  gitCompareRefs: (cwd: string, base: string, head: string, mode?: 'two' | 'three') =>
    ipcRenderer.invoke('git:compareRefs', cwd, base, head, mode ?? 'three') as Promise<
      { ahead: number; behind: number; mergeBase: string | null; files: GitFileChange[] } | { error: string }
    >,
  gitWorktrees: (cwd: string) =>
    ipcRenderer.invoke('git:worktrees', cwd) as Promise<
      Array<{ path: string; head: string; branch: string | null }> | { error: string }
    >,
  gitCheckout: (cwd: string, ref: string, detach?: boolean) =>
    ipcRenderer.invoke('git:checkout', cwd, ref, detach === true) as Promise<
      { ok: true; detached: boolean } | { ok: false; error: string }
    >,

  // ─── Hive（多 agent 协调） ─────────────────────────────────────
  hiveRegistry: (): Promise<HiveRegistry> => ipcRenderer.invoke('hive:registry'),
  /** 将招聘/岗位角色持久化到 hive 的 registry.json + identity.md（不重启）。 */
  hivePatchAgentRole: (id: string, role: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:patchAgentRole', id, role),
  /** 重命名 agent 的显示名称。其 id、hive 目录和 PTY 保持不变。 */
  hiveRenameAgent: (id: string, name: string): Promise<{ ok: boolean; name?: string; error?: string }> =>
    ipcRenderer.invoke('hive:renameAgent', id, name),
  /** 让 agent 挂起（人类与它 1:1 对接）或解除挂起。挂起的 agent
   *  继续运行；Michael 被告知停止向它们分派工作。 */
  hiveSetAgentHold: (id: string, hold: boolean): Promise<{ ok: boolean; onHold?: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:setAgentHold', id, hold),
  hiveBoard: (): Promise<string> => ipcRenderer.invoke('hive:board'),
  hiveTasks: (): Promise<unknown> => ipcRenderer.invoke('hive:tasks'),
  hiveLog: (n?: number): Promise<unknown[]> => ipcRenderer.invoke('hive:log', n ?? 200),
  hiveMemory: (id: string): Promise<string> => ipcRenderer.invoke('hive:memory', id),
  hiveInbox: (id: string): Promise<HiveMessage[]> => ipcRenderer.invoke('hive:inbox', id),
  /** 语音读取层：最近的消息内容（收件箱/发件箱正文），已在主进程中
   *  脱敏。传 { id } 获取单条消息，{ agentId } 限定到某个邮箱，或
   *  传 {} 获取整个楼层。支撑 Realtime Michael 的 get_messages。渲染进程
   *  永远不会看到原始正文或密钥——剥离在主进程侧完成。 */
  hiveMessages: (opts?: { agentId?: string; id?: string; limit?: number; includeArchived?: boolean }): Promise<VoiceMessage[]> =>
    ipcRenderer.invoke('hive:messages', opts ?? {}),
  /** 合并后的按 agent 目录（注册表 + 遥测 + 上下文），包含
   *  已归档的 agent。支撑 Realtime Michael 的 get_agent_detail / list_agents。 */
  hiveAgentDirectory: (): Promise<AgentDirectory> => ipcRenderer.invoke('hive:agentDirectory'),

  // ─── 临时 worker（P4 — Slack 触发的隔离 worker） ───────────
  /** 存活的临时 worker + 等待集成/GC 而保留的 worktree。 */
  listWorkers: (): Promise<{ live: WorkerSnapshot[]; preserved: PreservedWorktreeSnapshot[]; maxWorkers: number }> =>
    ipcRenderer.invoke('workers:list'),
  /** 手动停止存活的临时 worker（带安全闸的拆卸；工作成果保留）。 */
  stopWorker: (workerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('workers:stop', workerId),

  // ─── 语义记忆（MemPalace CLI） ─────────────────────────────────────
  memoryStatus: (): Promise<MemoryStatus> => ipcRenderer.invoke('hive:memoryStatus'),
  /** 本机实际存在哪些外部工具（uv、mempalace、git、各 agent 引擎），
   *  并为每个工具给出按平台解析的安装命令。 */
  toolsStatus: (): Promise<ToolStatus[]> => ipcRenderer.invoke('tools:status'),
  /** 设置页 hero 负载——方案 + 赞助商，从仓库获取并缓存。 */
  heroPayload: (force?: boolean): Promise<{ hero: HeroPayload; fetchedAt: number; stale: boolean }> =>
    ipcRenderer.invoke('hero:payload', force),
  /** 已为本机上的编码 agent 安装的技能。 */
  skillsLocal: (cwd?: string): Promise<LocalSkill[]> => ipcRenderer.invoke('skills:local', cwd),
  /** 可浏览的技能目录（已缓存；`force` 重新拉取）。 */
  skillsCatalog: (force?: boolean): Promise<{
    skills: CatalogSkill[]; fetchedAt: number; stale: boolean; error?: string;
  }> => ipcRenderer.invoke('skills:catalog', force),
  /** 将目录技能安装到 ~/.claude/skills。`unsupported` 用于区分
   *  「没有可下载的来源」与「下载失败」。 */
  skillsInstall: (url: string, name: string): Promise<
    { ok: true; path: string } | { ok: false; error: string; unsupported?: boolean }
  > => ipcRenderer.invoke('skills:install', url, name),
  /** 删除已安装的技能。主进程拒绝技能根目录之外的任何路径。 */
  skillsUninstall: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('skills:uninstall', path),
  /** 在系统文件管理器中显示技能的文件夹。 */
  skillsReveal: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('skills:reveal', path),
  searchMemory: (query: string, wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('hive:searchMemory', query, wing),
  memoryWakeUp: (wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('hive:memoryWakeUp', wing),
  mineNow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('hive:mineNow'),
  /** 压缩 agent 的 memory.md 文件（管理员缺失的另一半）。传入 id 时，
   *  按需压缩该 agent；不传时执行完整阈值扫描。返回
   *  每个 agent 的结果（{ id, condensed, reason, oldBytes?, newBytes? }）。 */
  reflectNow: (id?: string): Promise<Array<{ id: string; condensed: boolean; reason: string; oldBytes?: number; newBytes?: number }>> =>
    ipcRenderer.invoke('memory:reflectNow', id),

  // ─── 企业知识图谱（面向 agent 的多模态上下文） ───────────
  kgStatus: (): Promise<KnowledgeStatus> => ipcRenderer.invoke('kg:status'),
  kgList: (): Promise<KnowledgeDoc[]> => ipcRenderer.invoke('kg:list'),
  kgSearch: (query: string, limit?: number): Promise<KnowledgeHit[]> =>
    ipcRenderer.invoke('kg:search', query, limit),
  kgGet: (id: string): Promise<{ meta: KnowledgeDoc; text: string } | null> =>
    ipcRenderer.invoke('kg:get', id),
  kgRemove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('kg:remove', id),
  /** 打开系统文件选择器，并在一次往返中摄取所选工件。 */
  kgAddFiles: (): Promise<KnowledgeIngestResult> => ipcRenderer.invoke('kg:addFiles'),
  /** 摄取显式的文件路径（如拖放）。 */
  kgIngestFiles: (paths: string[], tags?: string[]): Promise<KnowledgeIngestResult> =>
    ipcRenderer.invoke('kg:ingestFiles', { paths, tags }),

  // ─── Composer 附件（图片 + 文件，按路径发给 agent） ─────────
  /** 打开系统图片/文件选择器；返回所选绝对路径 + 名称。 */
  attachFiles: (): Promise<
    { ok: true; files: { path: string; name: string }[] } | { ok: false; error: string }
  > => ipcRenderer.invoke('dialog:attachFiles'),
  /** 解析被拖放 File 的绝对路径（Electron 32 移除了 File.path）。 */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** 将当前剪贴板图片写入临时 PNG 并返回其路径（粘贴即附件）。 */
  saveClipboardImage: (): Promise<
    { ok: true; file: { path: string; name: string } } | { ok: false; error: string }
  > => ipcRenderer.invoke('clipboard:saveImage'),

  // ─── 命令历史（SQLite — 提交给 agent 的每条提示词） ─────────
  /** 记录一条已提交的提示。由提示检测钩子触发，发后即忘。 */
  historyAdd: (entry: { agentId: string; cwd?: string; text: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('history:add', entry),
  /** 最近优先的历史记录，可选择限定到某个 agent。 */
  historyList: (agentId?: string, limit?: number): Promise<CommandHistoryEntry[]> =>
    ipcRenderer.invoke('history:list', agentId, limit),
  /** 对提示文本做子串搜索，最近优先。 */
  historySearch: (query: string, limit?: number): Promise<CommandHistoryEntry[]> =>
    ipcRenderer.invoke('history:search', query, limit),
  hiveSend: (msg: Partial<HiveMessage>, from?: string): Promise<{ ok: boolean; error?: string; message?: HiveMessage }> =>
    ipcRenderer.invoke('hive:send', msg, from),

  onHiveHookEvent: (
    cb: (e: HookEvent) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: HookEvent) => cb(payload);
    ipcRenderer.on('hive:hookEvent', listener);
    return () => ipcRenderer.removeListener('hive:hookEvent', listener);
  },
  /** 来自状态行的推送式上下文计量：实时 token 数 + 该会话
   *  精确的上下文窗口大小。与 onHiveHookEvent 相同的模式。 */
  onHiveContextUpdate: (
    cb: (e: { agentId: string; tokens: number; limit: number }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId: string; tokens: number; limit: number }) => cb(payload);
    ipcRenderer.on('hive:contextUpdate', listener);
    return () => ipcRenderer.removeListener('hive:contextUpdate', listener);
  },
  onHiveMessage: (cb: (e: HiveRouteEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: HiveRouteEvent) => cb(payload);
    ipcRenderer.on('hive:message', listener);
    return () => ipcRenderer.removeListener('hive:message', listener);
  },
  /** 为路由到非 Claude agent（如 Codex）的 hive 任务注册监听器。
   *  主进程发出此事件而非退回；渲染进程将原始文本入队，
   *  使 drain 效果在 agent 空闲时将其键入其 REPL。 */
  onHiveEnqueue: (cb: (e: { targetId: string; text: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { targetId: string; text: string }) => cb(payload);
    ipcRenderer.on('hive:enqueueToAgent', listener);
    return () => ipcRenderer.removeListener('hive:enqueueToAgent', listener);
  },
  /** 主进程发起的 agent 启动（如通过 rt-5 的语音招聘）——渲染进程
   *  根据此描述符添加楼层卡片，因为它没有自行发起招聘。 */
  onHiveAgentSpawned: (
    cb: (rec: {
      id: string; name: string; provider?: string; cwd: string;
      command?: string; role?: string; worktreePath?: string;
      character?: string; accent?: string;
    }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on('hive:agentSpawned', listener);
    return () => ipcRenderer.removeListener('hive:agentSpawned', listener);
  },
  /** 主进程发起的 agent 终止/归档（如通过 rt-5 的语音终止）——渲染进程
   *  归档楼层卡片，因为它没有自行发起终止。 */
  onHiveAgentArchived: (cb: (e: { id: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string }) => cb(payload);
    ipcRenderer.on('hive:agentArchived', listener);
    return () => ipcRenderer.removeListener('hive:agentArchived', listener);
  },
  /** 注册终端工单交接（#53）的监听器——发给无法清空收件箱的
   *  无钩子 provider 的 hive 邮件；渲染进程将其作为工单键入
   *  该 agent 的 REPL。 */
  onHiveTerminalHandoff: (cb: (e: HiveTerminalHandoffEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: HiveTerminalHandoffEvent) => cb(payload);
    ipcRenderer.on('hive:terminalHandoff', listener);
    return () => ipcRenderer.removeListener('hive:terminalHandoff', listener);
  },

  // ─── 可分享的招聘（深链接 / 文件导入） ────────────────────────────
  /** 经 munderdifflin:// 深链接到达已验证的招聘清单时触发。
   *  渲染进程打开预填好的「添加 Agent」模态框——导入
   *  本身从不启动任何东西。 */
  onHireImport: (cb: (manifest: HireManifest) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, manifest: HireManifest) => cb(manifest);
    ipcRenderer.on('hire:import', listener);
    return () => ipcRenderer.removeListener('hire:import', listener);
  },
  /** 深链接清单校验/获取失败时触发。 */
  onHireError: (cb: (info: { error: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: { error: string }) => cb(info);
    ipcRenderer.on('hire:error', listener);
    return () => ipcRenderer.removeListener('hire:error', listener);
  },
  /** 发出就绪信号并拉取任何排队的深链接清单（冷启动链接、
   *  加载期间到达的链接）。resolve 为排队的列表。 */
  drainPendingHires: (): Promise<HireManifest[]> =>
    ipcRenderer.invoke('hire:drainPending'),
  /** 打开多文件选择器并校验每个选中的招聘清单。 */
  importHireFiles: (): Promise<{
    ok: boolean;
    manifests: HireManifest[];
    errors: string[];
    error?: string;
  }> =>
    ipcRenderer.invoke('hire:openFile'),

  // ─── 配置变更 ──────────────────────────────────────────────────────
  /** 每当设置被保存时触发，携带完整更新后的配置。 */
  onConfigChanged: (cb: (config: HarnessConfig) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, config: HarnessConfig) => cb(config);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },

  // ─── 退出确认 ───────────────────────────────────────────────────
  onCloseRequested: (cb: (info: { ptyCount: number }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: { ptyCount: number }) => cb(info);
    ipcRenderer.on('app:closeRequested', listener);
    return () => ipcRenderer.removeListener('app:closeRequested', listener);
  },
  confirmClose: (): Promise<void> => ipcRenderer.invoke('app:confirmClose'),
  cancelClose: (): Promise<void> => ipcRenderer.invoke('app:cancelClose'),

  // ─── 电源 / 唤醒（睡眠/锁屏后自动复活卡死的 PTY） ────────────────
  /** 订阅主进程的电源恢复信号；返回一个取消订阅函数。
   *  主进程在睡眠/解锁后补发，并在 `dead` 中报告跨越其间的
   *  卡死 PTY id——渲染进程只重生这些（空的 `dead[]` = 空操作）。
   *  与 onClosingTime 相同的主进程→渲染进程推送模式。 */
  onPowerResume: (cb: (e: PowerResumeEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: PowerResumeEvent) => cb(payload);
    ipcRenderer.on('power:resume', listener);
    return () => ipcRenderer.removeListener('power:resume', listener);
  },

  // ─── 多窗口楼层 ───────────────────────────────────────────────────
  /** 打开新楼层（独立的办公室窗口）。multiWindow 标志关闭时为空操作。
   *  resolve 出 { ok }，指示窗口是否打开。 */
  newFloor: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:newFloor'),

  // ─── 打烊时间（经 hive 优雅关闭） ─────────────────────────
  /** 启动打烊协议：god 广播关闭，每个 worker 保存记忆并 ACK，
   *  god 总结收尾——然后应用自行退出。
   *  没有 god agent 运行时 resolve 出 ok:false（+ error）。 */
  startClosingTime: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:startClosingTime'),
  /** 中止进行中的打烊，并告知楼层恢复工作。 */
  cancelClosingTime: (): Promise<void> => ipcRenderer.invoke('app:cancelClosingTime'),
  /** 退出对话框的进度事件：started → progress（ACK 计数）→
   *  complete（片刻后应用拆除）| timeout | cancelled。 */
  onClosingTime: (cb: (ev: ClosingTimeEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: ClosingTimeEvent) => cb(ev);
    ipcRenderer.on('app:closingTime', listener);
    return () => ipcRenderer.removeListener('app:closingTime', listener);
  },

  // ─── 重置 ─────────────────────────────────────────────────────────────────
  /** 清空所有 hive 数据 + 记忆宫殿，重置配置，并重新启动应用进入引导。
   *  进程会退出，因此该 promise 永不 resolve。 */
  resetAll: (): Promise<void> => ipcRenderer.invoke('app:resetAll'),

  // ─── Token 遥测（来自 CC 转录的真实用量 + 预估成本） ──────────
  /** 从某个 agent 的 Claude Code 转录中汇总输入/输出/缓存 token +
   *  预估 USD 成本（对账/回退）。cwd 无效时返回 null。 */
  agentUsage: (cwd: string): Promise<AgentUsage | null> =>
    ipcRenderer.invoke('hive:agentUsage', cwd),
  /** agent 实时会话的当前上下文大小（token 数），从其中
   *  转录的最后一条 assistant 消息读取。在 agent 的钩子至少触发一次之前
   *  为 null（转录路径是从钩子学到的）。 */
  agentContext: (agentId: string): Promise<number | null> =>
    ipcRenderer.invoke('hive:agentContext', agentId),

  // ─── 实时遥测（OTel 采集器 — 用量提供者接缝 + spans） ──────
  /** agent 的实时累计用量（优先 OTel，回退转录）。 */
  telemetryUsage: (agentId: string): Promise<AgentUsageSample | null> =>
    ipcRenderer.invoke('telemetry:usage', agentId),
  /** 某个 agent 瀑布图（#7B.2）的近期的工具 spans。 */
  telemetrySpans: (agentId: string): Promise<ToolSpan[]> =>
    ipcRenderer.invoke('telemetry:spans', agentId),
  /** 所有 agent 用量 + 近期 spans 的冷启动回填。 */
  telemetrySnapshot: (): Promise<TelemetrySnapshot> =>
    ipcRenderer.invoke('telemetry:snapshot'),
  /** 订阅实时遥测推送；返回取消订阅函数。 */
  onTelemetryEvent: (cb: (e: TelemetryEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: TelemetryEvent) => cb(payload);
    ipcRenderer.on('telemetry:event', listener);
    return () => ipcRenderer.removeListener('telemetry:event', listener);
  },

  // ─── 熔断器（泳道 A #6 状态 → 头像/仪表） ──────────────────────
  /** 订阅熔断器状态变更；返回取消订阅函数。 */
  onBreakerState: (cb: (s: BreakerState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: BreakerState) => cb(payload);
    ipcRenderer.on('control:breakerState', listener);
    return () => ipcRenderer.removeListener('control:breakerState', listener);
  },
  /** 向渲染进程推送熔断器状态（泳道 A 的策略/临时胶水调用它）。 */
  setBreakerState: (state: BreakerState): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('control:setBreakerState', state),

  // ─── 对 agent 的操作员控制（#7C.1–7C.3） ──────────────────────────────
  /** 暂停/取消暂停 agent——暂停后 → 其工具调用在 PreToolUse 被拒绝。 */
  controlPause: (agentId: string, on: boolean): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:pause', agentId, on),
  /** 暂停/恢复某个 agent 的自动收件箱与排队消息投递。 */
  controlAutoDelivery: (agentId: string, paused: boolean): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:autoDelivery', agentId, paused),
  /** 清除暂停 + 中止，使 agent 可以再次运行。 */
  controlResume: (agentId: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:resume', agentId),
  /** 为某个 agent 开启/关闭特定工具的门（在 PreToolUse 拒绝）。 */
  controlGateTool: (agentId: string, tool: string, on: boolean): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:gateTool', agentId, tool, on),
  /** 排队一条引导备注——在 agent 的下一次钩子（#7C.2）中作为上下文注入。 */
  controlSteer: (agentId: string, text: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:steer', agentId, text),
  /** 请求在下一个钩子边界（#7C.3）优雅停止。 */
  controlHalt: (agentId: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:halt', agentId),
  /** 读取 agent 当前的控制快照。 */
  controlSnapshot: (agentId: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:snapshot', agentId),
  /** 订阅门控/拒绝事件（工具被拦截）；返回取消订阅函数。 */
  onApprovalRequest: (cb: (e: { agentId: string; tool?: string; reason?: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId: string; tool?: string; reason?: string }) => cb(payload);
    ipcRenderer.on('control:approvalRequest', listener);
    return () => ipcRenderer.removeListener('control:approvalRequest', listener);
  },

  // ─── 任务看板（hive/tasks.json） ───────────────────────────────────────
  /** 针对主进程最新账本原子地追加一张卡片。 */
  hiveAddTask: (task: HiveTask): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:addTask', task),
  /** 原子地修补某张指定卡片，而不替换无关的卡片/字段。 */
  hivePatchTask: (
    id: string,
    patch: Partial<Omit<HiveTask, 'id'>>
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('hive:patchTask', id, patch),
  /** 从主进程最新账本中原子地移除某张指定卡片。 */
  hiveDeleteTask: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:deleteTask', id),

  // ─── 定时任务（周期性自动派发） ──────────────────────────
  listMissions: (): Promise<ScheduledMission[]> => ipcRenderer.invoke('missions:list'),
  saveMissions: (missions: ScheduledMission[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('missions:save', missions),
  /** 调度器为某个任务的 lastFiredAt 盖时间戳（一次心跳/派发）时触发，
   *  使「计划」面板无需重载即可刷新「上次触发」。 */
  onMissionsUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('missions:updated', listener);
    return () => ipcRenderer.removeListener('missions:updated', listener);
  },
  /** autoCompact 任务滴答时触发——渲染进程为每个 agent 排队一次 /compact
   *  （去重），并在各 agent 空闲时投递。 */
  onAutoCompact: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('mission:autoCompact', listener);
    return () => ipcRenderer.removeListener('mission:autoCompact', listener);
  },

  // ─── 跨 hive 文件全文搜索（看板、任务、记忆） ─────────────
  textSearch: (q: string): Promise<{ ok: boolean; results: Array<{ source: string; excerpt: string }> }> =>
    ipcRenderer.invoke('hive:textSearch', q),

  // ─── GitHub issue 摄取（gh CLI） ───────────────────────────────────────
  /** 通过 `gh` CLI 列出 `cwd` 处仓库中最多 30 个打开的 issue。若 `gh`
   *  缺失/未认证或 `cwd` 不是仓库，返回 `{ ok: false, error }`。 */
  githubIssues: (cwd: string): Promise<{ ok: boolean; issues?: GHIssue[]; error?: string }> =>
    ipcRenderer.invoke('github:issues', cwd),

  // ─── GitHub CI 状态监视（gh CLI） ─────────────────────────────────────
  /** 通过 `gh` CLI 列出 `cwd` 处仓库中最多 5 次最近的 CI（GitHub Actions）运行。
   *  若 `gh` 缺失/未认证、`cwd` 不是仓库，或仓库没有 Actions，
   *  返回 `{ ok: false, error }`。 */
  githubCIRuns: (cwd: string): Promise<{ ok: boolean; runs?: CIRun[]; error?: string }> =>
    ipcRenderer.invoke('github:ciRuns', cwd),

  // ─── 桌面通知 ───────────────────────────────────────────────────
  /** 切换 agent 生命周期事件的原生桌面通知。 */
  setNotifications: (v: boolean): Promise<HarnessConfig> =>
    ipcRenderer.invoke('app:setNotifications', v),

  // ─── 可靠性 / 系统集成（引导权限步骤） ──────────────
  /** 在系统处理器中打开「系统设置」深链接（或 https URL）。主进程
   *  限制协议；渲染进程只是指向该面板。 */
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:openExternal', url),
  /** 切换 macOS「登录时打开」。resolve 为最终状态（无提示）。 */
  setLoginItem: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setLoginItem', enabled),

  // ─── Agent 生命周期（归档） ─────────────────────────────────────────────
  /** 在注册表中归档/取消归档 hive agent。关闭终端标签页会经由 pty:kill
   *  自动归档；这是显式原语。 */
  hiveSetArchived: (id: string, archived: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:setArchived', id, archived),

  // ─── Slack 集成（Slack 消息 → Michael 的队列） ─────────────────────
  /** 为入站 Slack 消息注册监听器；返回取消订阅函数。
   *  消息携带在线程内回复所需的线程坐标。 */
  onSlackMessage: (cb: (msg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble?: string; files?: { path: string; name: string; mimetype: string }[] }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, msg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble?: string; files?: { path: string; name: string; mimetype: string }[] }) => cb(msg);
    ipcRenderer.on('slack:incomingMessage', listener);
    return () => ipcRenderer.removeListener('slack:incomingMessage', listener);
  },
  /** 启动 Slack webhook 服务器；返回要粘贴到 Slack 应用的
   *  事件订阅 → 请求 URL 的公共隧道 URL。 */
  slackStart: (): Promise<{ ok: boolean; url?: string; error?: string }> =>
    ipcRenderer.invoke('slack:start'),
  /** 停止 Slack webhook 服务器 + 隧道。 */
  slackStop: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('slack:stop'),
  /** 当前连接状态 + 上次的请求 URL（使设置页能填充
   *  「已连接」徽章，并在重新打开时再次显示持久化的隧道 URL）。 */
  slackStatus: (): Promise<{ running: boolean; url?: string }> =>
    ipcRenderer.invoke('slack:status'),
  /** 在 Slack 线程中发布回复（bot token 保留在主进程中）。用于
   *  渲染进程即时的「已排队」确认。 */
  slackReply: (m: { channel: string; thread_ts: string; text: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('slack:reply', m),
  /** 内置回复辅助脚本的绝对路径，供办公室 worker 在运行结束时
   *  「把总结发回 Slack」的指令使用。 */
  slackReplyScriptPath: (): Promise<string> =>
    ipcRenderer.invoke('slack:replyScriptPath'),
  /** 持久化 Slack 设置（若被禁用 / 密钥被清除则停止服务器）。 */
  slackSetConfig: (patch: {
    signingSecret?: string; botToken?: string; channelId?: string; port?: number; enabled?: boolean;
    proactivePosting?: boolean;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('slack:setConfig', patch),

  // ─── 通用 Webhook + 状态 API（POST → 进入工作，GET → 查询状态） ────────────────
  /** 启动通用 webhook 服务器；返回公共端点 URL，调用方
   *  POST（受密钥门控）并 GET 某个 token 的状态。 */
  webhookStart: (): Promise<{ ok: boolean; url?: string; error?: string }> =>
    ipcRenderer.invoke('webhook:start'),
  /** 停止通用 webhook 服务器 + 隧道。 */
  webhookStop: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('webhook:stop'),
  /** 当前状态 + 上次的端点 URL（使设置页能填充徽章/URL）。 */
  webhookStatus: (): Promise<{ running: boolean; url?: string }> =>
    ipcRenderer.invoke('webhook:status'),
  /** 铸造 + 持久化一个新密钥，并返回给用户复制。 */
  webhookGenerateSecret: (): Promise<{ ok: boolean; secret?: string }> =>
    ipcRenderer.invoke('webhook:generateSecret'),
  /** 持久化 webhook 设置（若被禁用 / 密钥被清除则停止服务器）。 */
  webhookSetConfig: (patch: {
    secret?: string; port?: number; enabled?: boolean;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('webhook:setConfig', patch),

  // ─── 触发器：上下文（自动压缩 / 自动清除） ──────────────────────────
  /** 两条上下文规则（节奏 + 压力闸 + 消息），已深度填充。 */
  getContextTrigger: (): Promise<ContextTriggerConfig> =>
    ipcRenderer.invoke('triggers:getContext'),
  /** 持久化两条规则并重新武装主进程的定时器；resolve 为实际存储的值
   *  （主进程会钳制节奏/百分比，因此回显是权威的）。 */
  setContextTrigger: (cfg: ContextTriggerConfig): Promise<ContextTriggerConfig> =>
    ipcRenderer.invoke('triggers:setContext', cfg),
  /** 上下文规则到期时触发。`rule` 一并携带，因为主进程只拥有
   *  节奏——渲染进程应用每个 agent 的压力闸，并为每个符合条件的
   *  agent 排队命令。 */
  onContextTrigger: (cb: (evt: { action: 'compact' | 'clear'; rule: ContextRule }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { action: 'compact' | 'clear'; rule: ContextRule }) => cb(payload);
    ipcRenderer.on('trigger:context', listener);
    return () => ipcRenderer.removeListener('trigger:context', listener);
  },

  // ─── 触发器：Webhook 端点（多端点共用一个服务器 + 隧道） ──────
  /** 每个已配置的端点，无论是否启用。 */
  listWebhooks: (): Promise<WebhookTrigger[]> => ipcRenderer.invoke('webhooks:list'),
  /** 替换整个列表；主进程规范化每一行（空白密钥保留已存密钥，
   *  未知模式保留已存模式），并热切换运行中服务器的端点，
   *  无需重启，因此其他调用方的 URL 不会改变。 */
  saveWebhooks: (list: WebhookTrigger[]): Promise<WebhookTrigger[]> =>
    ipcRenderer.invoke('webhooks:save', list),
  /** 吊销一个端点；resolve 为剩余的列表。 */
  deleteWebhook: (id: string): Promise<WebhookTrigger[]> =>
    ipcRenderer.invoke('webhooks:delete', id),
  /** 为操作员铸造一个 256 位密钥粘贴到其调用方。在携带它的
   *  端点保存之前不会持久化。 */
  generateWebhookSecret: (): Promise<string> => ipcRenderer.invoke('webhooks:generateSecret'),
  /** 服务器状态、隧道根地址，以及每个端点的完整公共 URL（隧道
   *  建立之前 `url` 为 ''）。 */
  webhooksStatus: (): Promise<{ running: boolean; url?: string; endpoints: { id: string; url: string }[] }> =>
    ipcRenderer.invoke('webhooks:status'),

  // ─── 触发器：组织（克隆节点对等消息） ─────────────────────
  /** 仅持久化——对等传输尚不存在，因此设置它只会存储
   *  密钥和模式，不启动任何东西。 */
  getOrgTrigger: (): Promise<OrgTriggerConfig> => ipcRenderer.invoke('org:getTrigger'),
  setOrgTrigger: (cfg: OrgTriggerConfig): Promise<OrgTriggerConfig> =>
    ipcRenderer.invoke('org:setTrigger', cfg),

  // ─── 触发器：历史账本 + 审批闸 ───────────────────────────────
  /** 整个账本，最新在前（两个方向、两个来源）。 */
  listTriggerHistory: (): Promise<TriggerHistoryEntry[]> =>
    ipcRenderer.invoke('triggerHistory:list'),
  /** 答复一条被挂起的消息。'approved' 将其释放到 hive（卡片 + god
   *  请求，与自动放行的消息走相同路径）；'rejected' 只翻转
   *  裁决。对已裁决的条目再次裁决是空操作，绝不会二次派发。
   *  resolve 为更新后的行，id 已不存在时为 null。 */
  decideTriggerHistory: (arg: { id: string; decision: 'approved' | 'rejected' }): Promise<TriggerHistoryEntry | null> =>
    ipcRenderer.invoke('triggerHistory:decide', arg),
  /** 清空账本，或仅清空某个来源的那一半。 */
  clearTriggerHistory: (source?: 'webhook' | 'org'): Promise<void> =>
    ipcRenderer.invoke('triggerHistory:clear', source),
  /** 每当账本变化时触发（入站到达、裁决落定、回复配对），
   *  使历史标签页实时刷新。 */
  onTriggerHistoryUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('triggerHistory:updated', listener);
    return () => ipcRenderer.removeListener('triggerHistory:updated', listener);
  },

  // ─── Free Flow（语音听写 → 消息队列） ─────────────────────────────
  /** 持久化 Free Flow 设置（开关 / Groq 密钥 / 模型）。Groq 密钥存储
   *  在主进程配置中；入口点 B（按住 Option）在渲染进程侧，这里没有快捷键。 */
  freeflowSetConfig: (patch: {
    enabled?: boolean; apiKey?: string; model?: string;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('freeflow:setConfig', patch),
  /** 通过 Groq 转写一段捕获的音频片段（密钥留在主进程；只有
   *  音频字节进入，转录文本返回）。受开关 + 密钥门控。 */
  freeflowTranscribe: (arg: {
    audio: ArrayBuffer | Uint8Array; mimeType?: string; filename?: string; language?: string;
  }): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('freeflow:transcribe', arg),

  // ─── 集成注册表（阶段 2 — 经密钥代理的带标签 REST 端点） ──
  // 为设置 UI 桥接 §6 的 IPC 表面。端到端的只写密钥契约：
  // `integrationsList` 返回 secretRef 脱敏为 `hasSecret` 的记录；
  // `integrationsSetSecret` 单向接收密钥（绝不回显）；任何方法都
  // 绝不向渲染进程返回密钥值。方法名匹配 registryClient 的
  // 特性检测（camelCase ↔ 冒号通道），因此其真实路径按原样激活。
  integrationsList: (): Promise<IntegrationRecordView[]> =>
    ipcRenderer.invoke('integrations:list'),
  integrationsTemplates: (): Promise<IntegrationTemplate[]> =>
    ipcRenderer.invoke('integrations:templates'),
  integrationsUpsert: (record: IntegrationRecord): Promise<{ ok: true; record: IntegrationRecord } | { ok: false; error: string }> =>
    ipcRenderer.invoke('integrations:upsert', record),
  integrationsSetSecret: (req: { id: string; secret: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('integrations:setSecret', req),
  integrationsRemove: (req: { id: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('integrations:remove', req),
  integrationsTest: (req: { id: string; path?: string }): Promise<{ ok: boolean; status?: number; error?: string }> =>
    ipcRenderer.invoke('integrations:test', req),
  // 每个 CLI provider 的 BYOK 密钥——只写。`providerKeySet` 单向存储后端密钥
  // （绝不回显）；`providerKeyHas` 只返回布尔值；任何方法都绝不返回
  // 明文。密钥仅在启动时于主进程中物化。
  providerKeySet: (req: { backend: string; key: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('providerKey:set', req),
  providerKeyHas: (backend: string): Promise<boolean> =>
    ipcRenderer.invoke('providerKey:has', backend),
  providerKeyClear: (backend: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('providerKey:clear', backend),
  // Realtime Michael（语音编排器）——主进程铸造短期临时 token
  // 源自 BYOK OpenAI 密钥；真实密钥绝不跨越 IPC。`realtimeHasOpenAiKey`
  // 只是存在性布尔值（门控语音开关，与 providerKeyHas 相同）。
  realtimeHasOpenAiKey: (): Promise<boolean> =>
    ipcRenderer.invoke('realtime:hasKey'),
  realtimeMintToken: (
    req?: { model?: string }
  ): Promise<
    | { ok: true; token: string; expiresAt: number | null; sessionConfig: { model: string } }
    | { ok: false; error: string; code?: string }
  > => ipcRenderer.invoke('realtime:mintToken', req ?? {}),
  // rt-5 语音动作——渲染进程不持有任何策略；主进程（realtimeActions.ts）拥有
  // 分级、两步口头确认、硬性白名单和 michael-voice
  // 归属。这些只是转发 {verb,...args} 并把 `spoken` 说出来。
  realtimeAction: (
    payload: { verb: string } & Record<string, unknown>
  ): Promise<{ ok: boolean; spoken: string; needsConfirm?: boolean }> =>
    ipcRenderer.invoke('realtime:action', payload),
  realtimeActionConfirm: (
    req: { phrase: string }
  ): Promise<{ ok: boolean; spoken: string; needsConfirm?: boolean }> =>
    ipcRenderer.invoke('realtime:action:confirm', req),
  realtimeActionCancel: (): Promise<{ ok: boolean; spoken: string; needsConfirm?: boolean }> =>
    ipcRenderer.invoke('realtime:action:cancel'),
  // rt-12 完成接缝——一个语音派发的任务已完成。`summary` 是
  // Michael 转述的、可对人类说出的一句话；其余是 toast/日志的上下文。
  onRealtimeCompletion: (
    cb: (evt: { correlationId: string; kind: string; targetAgentId: string; taskId?: string; summary: string; completedAt: number; objective?: string }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on('realtime:completion', listener);
    return () => ipcRenderer.removeListener('realtime:completion', listener);
  },
  /** 告知主进程实时语音会话是否开启（决定完成事件走排队还是推送）。 */
  realtimeSetSessionLive: (live: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('realtime:setSessionLive', live),
  /** 清空在无会话开启时到达的完成事件（热启动追赶）。 */
  realtimeDrainCompletions: (): Promise<
    { correlationId: string; kind: string; targetAgentId: string; taskId?: string; summary: string; completedAt: number; objective?: string }[]
  > => ipcRenderer.invoke('realtime:drainCompletions'),
  /** 阻塞直到被跟踪的任务完成（或超时）——支撑 wait_for 工具。 */
  realtimeWaitFor: (
    taskId: string,
    timeoutMs?: number
  ): Promise<{ summary: string; targetAgentId: string; taskId?: string } | { timedOut: true; taskId: string }> =>
    ipcRenderer.invoke('realtime:waitFor', taskId, timeoutMs),
  /** v0.3.4：语音会话存活期间推送的合并楼层增量——渲染进程
   *  将它们作为静默项注入对话。 */
  onRealtimeFloorDelta: (cb: (evt: { text: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { text: string }) => cb(payload);
    ipcRenderer.on('realtime:floorDelta', listener);
    return () => ipcRenderer.removeListener('realtime:floorDelta', listener);
  },
  /** v0.3.4：主进程暂存的队列插入（语音 clear_context）——渲染进程
   *  入队，使投递经过所有现有安全闸。 */
  onRealtimeEnqueue: (cb: (evt: { agentId: string; text: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId: string; text: string }) => cb(payload);
    ipcRenderer.on('realtime:enqueue', listener);
    return () => ipcRenderer.removeListener('realtime:enqueue', listener);
  },
  /** v0.3.4：应用自我认知——版本 + 最新的更新日志段落。 */
  appInfo: (): Promise<{ version: string; changelog: string }> =>
    ipcRenderer.invoke('app:info'),
  // ─── 花名册镜像（agents + 备注 + 队列，dev ↔ 打包版共享） ─────────
  /** 读取 hive 旁的花名册文件。刻意同步：zustand store 在模块加载时
   *  创建，异步读取会在首次渲染之后才到达，楼层会闪一下空白。
   *  启动时一次阻塞往返。`null` = 无文件（或不可读）——调用方
   *  随后改用 localStorage。 */
  rosterReadSync: (): RosterSnapshot | null => {
    try { return ipcRenderer.sendSync('roster:readSync') ?? null; } catch { return null; }
  },
  /** 同步读取打开的是哪个 hive——与 `rosterReadSync` 相同的启动约束，
   *  并在同一时刻读取：store 必须知道其 localStorage 键属于哪个
   *  hive，才能决定信任它们。 */
  harnessHomeSync: (): string | null => {
    try { return ipcRenderer.sendSync('config:homeSync') ?? null; } catch { return null; }
  },
  /** 将花名册镜像到磁盘。由调用方防抖；主进程保留上一次内容
   *  作为备份，并拒绝会清空完整文件的首次写入。 */
  rosterWrite: (snap: RosterSnapshot): Promise<{ ok: boolean; skipped?: string; error?: string }> =>
    ipcRenderer.invoke('roster:write', snap),

  // ─── 自动更新（v0.3.4；完整状态模型 v0.3.7） ──────────────────────────
  /** 来自主进程更新器的推送通道——管线的每个阶段，使工具栏徽章
   *  能显示「检查中」、下载进度和暂存的「重启以更新」，
   *  而不只是终态。 */
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: UpdateStatus) => cb(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  /** 最后已知的状态——重载的窗口订阅时主进程可能已发出过事件，
   *  因此它拉取当前状态，而不是等待 6 小时。 */
  updateCurrent: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:current'),
  /** 退出并安装已下载的更新——只能从显式的「重启以更新」点击调用。 */
  updateRestartAndInstall: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('update:restartAndInstall'),
  /** 手动重新检查。 */
  updateCheckNow: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('update:checkNow'),
  /** 为已检测到的更新开始下载（autoDownload 通常会先于用户；
   *  这是显式的一键路径）。 */
  updateDownload: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('update:download'),
  /** 为仅通知型更新打开项目的 releases 页面。 */
  updateOpenRelease: (url?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('update:openRelease', url),
  /** 此窗口运行在哪个操作系统上，用于平台特定的文案。 */
  platform: process.platform as string,
  arch: process.arch as string,
  /** 仅开发环境——伪造更新状态，以便不发布版本就能检查 toast。在打包
   *  版本中被拒绝（`{ok:false}`）；见 updater.ts 中的处理器。从开发者
   *  工具控制台调用：
   *    await window.cth.updateSimulate()                       // 仅通知的摘要 toast
   *    await window.cth.updateSimulate({ state: 'downloaded' }) // 重启以更新 toast
   *    await window.cth.updateSimulate({ drop: true })          // 居中显示的发布页
   *    await window.cth.updateSimulate({ notes: '<!-- drop -->…' }) // 你自己的发布页 */
  updateSimulate: (opts?: {
    state?: 'downloaded' | 'available-manual';
    version?: string;
    notes?: string;
    /** 使用默认发布页模板预览居中显示的发布页。 */
    drop?: boolean;
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('update:simulate', opts)
};

contextBridge.exposeInMainWorld('cth', api);

export type CthApi = typeof api;
