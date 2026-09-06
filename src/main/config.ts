import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  autoModeFlagForProvider,
  defaultCommandForProvider,
  inferAgentProvider,
  providerPreset,
  type AgentProvider
} from '../shared/agentProvider';
import { defaultMcpDefaults } from '../shared/mcpCatalog';
import { MAX_AGENT_TOKEN_CAP } from '../shared/tokenCaps';
import { expandTilde, normalizeHiveHome } from './fs';
import type { IntegrationRecord } from '../shared/integrations';
import {
  DEFAULT_CONTEXT_TRIGGER,
  DEFAULT_ORG_TRIGGER,
  DEFAULT_TRIGGER_MODE,
  DEFAULT_WEBHOOK_SCHEMA,
  type ContextTriggerConfig,
  type OrgTriggerConfig,
  type WebhookTrigger
} from '../shared/triggers';

/** 由调度器按间隔自动派发的周期性任务。 */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  /** 星期几 + 一天中时刻的排程。当其存在且有效时，将完全取代 `intervalMs`——
   *  间隔无法表达"工作日上午"，因为它会随时间漂移：例如 15:00 启动的 24 小时
   *  间隔会永远在 15:00 触发。`intervalMs` 有意保留在记录中，这样切换回来即可
   *  恢复用户原先的节奏。参见 shared/weeklySchedule.ts。 */
  weekly?: { days: number[]; minute: number };
  to: string;
  body: string;
  enabled: boolean;
  /** 为 true 时，调度器会在该任务触发时要求渲染器压缩活动的终端——但只压缩
   *  上下文已填满超过 `contextTrigger.compact` 中阈值（默认 60%，约 1M token
   *  窗口为 40%）的代理，因此小/空闲会话会被放过，而不是每次触发都压缩。
   *
   *  这个闸门过去只在这里被描述、从未真正实现：每个活动代理每次触发都会被
   *  压缩。现在它是真实生效的，阈值位于 `ContextTriggerConfig` 中，操作者可
   *  自行编辑，所以不要在别处重复这些数字——它们会漂移。 */
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** 任务风味。缺省 ⇒ 'dispatch'（经典的间隔派发任务，如运维站会）。
   *  'heartbeat'（Lane A #1）是一种感知上下文的节拍：它观察实时楼层状态，
   *  重新接洽安静的 god，并拨动熔断器——采用自适应节奏，而非固定的
   *  setInterval。 */
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** 仅 heartbeat：当所有被追踪的信号（log.jsonl 的 mtime、inbox/outbox 的
   *  mtime、任何 PTY 输出）在此毫秒数内都没有变动时，楼层即为"安静"。
   *  默认约 5 分钟。不取自 registry.status（它在 main 中从不变化）。 */
  quietThresholdMs?: number;
}

/** 内置的每小时运维站会：god 检查谁在做什么 + 任务是否按计划推进、代理是否
 *  在运行，并压缩每个终端的上下文。默认启用；用户可在 Command Center 中
 *  关闭它。 */
export const OPS_STANDUP_MISSION: ScheduledMission = {
  id: 'ops-standup',
  label: '每小时运维站会',
  intervalMs: 3_600_000,
  to: 'god',
  body:
    '每小时运维站会。逐一检查每个代理：谁在做什么，并确认每个代理 ' +
    '仍在正常运行（未卡死、未闲置过久）。查看任务看板——进行中的任务是否 ' +
    '按计划推进，是否有被阻塞或无主的任务？标记停滞的代理和风险任务，并 ' +
    '保持看板准确。（作为站会的一部分，每个工作中的代理都被要求总结其当前 ' +
    '任务和下一步，然后压缩并从同一位置继续——这样终端上下文保持有限而不会 ' +
    '丢失工作。压缩会被排队，在代理空闲时执行，绝不会打断进行中的工作。）',
  enabled: true
  // 没有 autoCompact。压缩只属于 contextTrigger.compact，别无其他。
  // 这个标志过去也住在这里，意味着默认安装会在两个节奏上要求压缩——本站会
  // 每小时一次、触发器每两小时一次——这正是下方 maint-1 退役要终结的
  // "两个互不一致的控制"。站会自己的文案仍然描述压缩，这一点依然成立：
  // 由触发器来做，只是不在该任务的时钟上。
};

/** 内置的心跳任务（Lane A #1）。一种感知上下文的节拍，每次跳动都会观察实时
 *  楼层状态，并且——仅在楼层安静下来时——向 god 的收件箱投放摘要，并在
 *  god 的 PTY 确实空闲时轻推它去重新接洽任何停滞者。同一节拍也拨动熔断器。
 *
 *  默认以 DISABLED 状态发货（选择启用）：与仅发送 hive 消息的站会不同，
 *  心跳会向 god 的 PTY 键入内容，因此用户想主动重新接洽时，会在 Command
 *  Center 中显式开启。`intervalMs` 是正常节奏的基础；当代理看起来卡住时，
 *  调度器会推导出更紧凑的节拍，而在重新接洽之后则使用较慢的节拍。 */
export const HEARTBEAT_MISSION: ScheduledMission = {
  id: 'heartbeat',
  label: '楼层心跳',
  intervalMs: 120_000,
  to: 'god',
  body:
    '楼层心跳：团队已安静下来。请查看收件箱中的摘要，重新接洽任何停滞或 ' +
    '被阻塞的成员，并保持看板准确——如果工作确实完成了，就休息吧。',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 300_000
};

/** 专用的自动压缩 MAINTENANCE 排程（maint-1）。与运维站会解耦，这样编辑或
 *  替换站会再也不会悄悄禁用压缩（这正是本修复要解决的 bug）。它只触发
 *  auto-compact 信号——`kind:'compact'` 让 syncMissions 跳过 hive.send 派发
 *  （to/body 为空）。默认以 DISABLED 发货（v0.3.4 创始人决定）：定时压缩为
 *  选择启用。可在 Settings → General 或 Schedules 标签页中开启；Schedules
 *  警告面板解释了长期运行代理不开启压缩的风险。它是压缩的唯一事实来源，且
 *  具有持久性：删除它会让它以 DISABLED 状态重新出现。
 *  现有安装保留用户已有的 enabled 状态（compactMaintenanceSeeded 防止重新播种）。 */
export const COMPACT_MAINTENANCE_MISSION: ScheduledMission = {
  id: 'compact-maintenance',
  label: '自动压缩（维护）',
  // 2 小时，与 DEFAULT_CONTEXT_TRIGGER.compact.everyMs 一致。两个节奏必须
  // 相同：该任务是上下文触发器现在所拥有的同一行为的排程一半，这里若播种
  // 1 小时，无论触发器怎么说都会以旧节奏不断打断代理。
  intervalMs: 7_200_000,
  to: '',
  body: '',
  enabled: false,
  autoCompact: true,
  kind: 'compact'
};

/** `compact-maintenance` 在 Triggers 将其加倍之前播种的 1 小时节奏。
 *  `migrateTriggersV1` 只升级仍停留在这个精确值上的任务，因此用户手动调整的
 *  间隔会原样保留在他们设定的位置。 */
const LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS = 3_600_000;

/** 熔断器阈值（Lane A #6.6b）。熔断器运行在心跳节拍内部，因此只有心跳启用时
 *  它才会拨动。触发条件默认基于行为；`costCapUsd` 是唯一以 $ 计量的，默认不
 *  设置（硬编码的美元默认值将是任意的）。默认值刻意保守且以引导优先——
 *  `hardStop` 默认关闭，除非用户选择启用，因此熔断器绝不会自动杀死健康的
 *  长期运行者。 */
export interface CircuitBreakerConfig {
  /** 节拍内熔断器评估的主开关。默认 true。 */
  enabled?: boolean;
  /** 允许阶梯顶端（杀死 PTY + 归档）。默认 false = 熔断器可以引导/约束，但在用户选择启用之前绝不硬停。 */
  hardStop?: boolean;
  /** 触发前允许的连续相同工具调用（同名+同输入）。 */
  repeatedToolLimit?: number;
  /** 触发前允许的连续 api_error / retry 事件。 */
  errorStormLimit?: number;
  /** 触发前的输出 token 速率（token/分钟，跨节拍差分）。 */
  tokenVelocityPerMin?: number;
}

/** Enterprise Knowledge Graph（多模态上下文存储 + 代理访问工具）。
 *  用户摄入自己的文档/图片/PDF；代理按需通过 `kg` CLI 查询它们。与
 *  heartbeat/Slack 功能一样为选择启用——`enabled` 门控一切（关闭时不注入
 *  env、不加提示行、不触碰存储）。参见 docs/design/knowledge-graph.md。 */
export interface KnowledgeGraphConfig {
  /** 主开关。默认 false = 零行为变化（该功能保持暗置）。 */
  enabled?: boolean;
  /** 覆盖存储位置。未设置 = <userData>/knowledge。 */
  rootPath?: string;
}

export interface HarnessConfig {
  /** 用户是否已完成首次运行引导？ */
  onboardingComplete: boolean;
  /** 用户在首次引导界面自选的受众类型。驱动引导文案的所有措辞：'technical'
   *  显示 CLI / 参数术语，'non-technical' 用平实语言解释每个概念。未设置 =
   *  尚未选择（任何附带文案按 technical 处理）。 */
  audience?: 'technical' | 'non-technical';
  /** harness 保存自身状态的文件夹（代理元数据、日志）。 */
  harnessHome: string | null;
  /** 最近打开的 hive home 文件夹（最近的在前），由启动时的 hive 选择器展示。
   *  每当 harnessHome 被设置（引导完成、changeHome）时由 writeConfig 维护。
   *  上限为少量几个。 */
  recentHives?: string[];
  /** 用户在引导期间注册的文件夹（用作快速选择）。 */
  registeredRepos: string[];
  /** 为 true 时，新代理以 --permission-mode bypassPermissions 派生。 */
  autoMode: boolean;
  /** 编排器（"Michael"）能否自行派生代理？
   *
   *  默认 FALSE。派生一个代理是花费（SPEND）决策，因此不应在未被提示时发生。
   *  该能力本身在 v0.4.4 中毫无门控地发货，所以这里关闭的是一个已有的默认
   *  开启行为，而非给新功能加门控：想要它的操作者现在必须明确表态。
   *
   *  关闭并不会使排队的派生请求失败，而是拒绝消费它。请求停留在
   *  HIVE_ROOT/spawn-requests 中，直到该开关被打开。 */
  orchestratorMaySpawn: boolean;
  /** 派生新代理时运行的命令。 */
  defaultCommand: string;
  /** 新派生代理的默认模型（如 'claude-sonnet-4-6[1m]'）；未设置 = CLI 默认。 */
  defaultModel?: string;
  /** 哪个 provider 驱动 GOD 编排器（"Michael"）。人设恒定；只有其引擎可选。
   *  默认 'claude'。合格的 provider 是那些能接收 inbox 的
   *  （claude/codex/antigravity/qwen）。 */
  godProvider?: AgentProvider;
  /** GOD 运行的模型。未设置时回退到 provider 预设的
   *  `recommendedOrchestratorModel`，然后是 MODEL_GOD。默认 'claude-opus-4-8'。 */
  godModel?: string;
  /** 默认 MCP 套件的按服务器同意状态，以 catalog id 为键。从 MCP_CATALOG
   *  播种（safe-readonly ON，write/secret OFF）；用户可在 Settings 中切换。
   *  只有当此处启用时，服务器才会被接入代理。 */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  /** 启用语义记忆（MemPalace CLI）。若未安装 mempalace 则为空操作。 */
  semanticMemory: boolean;
  /** 宫殿的 embedding 模型：轻量 'minilm' 或多语言 'embeddinggemma'。 */
  embeddingModel: 'minilm' | 'embeddinggemma';
  /** 由调度器处理的周期性自动派发任务。 */
  missions?: ScheduledMission[];
  /** 一次性守卫：内置的每小时运维站会是否已被播种进现有安装的任务中？
   *  防止用户在删除它之后被重新添加。 */
  opsStandupSeeded?: boolean;
  /** 内置心跳任务的一次性守卫（镜像 opsStandupSeeded，这样删除心跳的用户
   *  不会每次启动都看到它被重新添加）。 */
  heartbeatSeeded?: boolean;
  /** 专用自动压缩维护任务的 maint-1 守卫。与上面两个不同，它不会永远抑制
   *  重新添加：一旦播种（标志已设置），之后删除会让任务在下一次启动时以
   *  DISABLED 状态重新出现（压缩是必需的，因此它绝不会被悄悄丢失——只会被
   *  用户禁用）。 */
  compactMaintenanceSeeded?: boolean;
  /** DEPRECATED (v0.3.4)：仅存在于配置文件中，任何地方都没有 UI。所有活动
   *  代理的硬性美元上限。若存在仍会强制执行，以便旧配置保留其守卫，但 token
   *  上限（costCapTokens）才是真正的预算——计划在下个版本移除。 */
  costCapUsd?: number;
  /** 熔断器触发前的硬性 TOKEN 上限（所有活动代理的总 token）。面向用户的
   *  预算——在 Settings 中设置。与 $ 上限一样为选择启用；total = input +
   *  output + cacheRead + cacheCreation，跨整个楼层求和（最大的 token
   *  消耗者会被问责）。 */
  costCapTokens?: number;
  /** 按代理的 total-token 上限，以 agent id 为键。当某个代理自身的总 token
   *  超过其上限时，熔断器单独触发该代理（独立于楼层预算）。在 Command Center
   *  中从每个代理的卡片设置。 */
  agentTokenCaps?: Record<string, number>;
  /** 暂停了自动 inbox/队列投递的代理 id。待处理消息保持持久，直到操作者显式
   *  恢复投递。 */
  autoDeliveryPausedAgents?: string[];
  /** 设置时以 `--max-turns <n>` 传给每个派生代理；未设置 = 无上限（Claude
   *  Code 的默认）。一个独立于熔断器的粗略失控守卫。 */
  maxTurns?: number;
  /** god 触发的临时 Slack worker 的最大并发数；多余的 spawn-requests 在队列中
   *  等待（天然背压，作为资源后盾）。默认 4。 */
  maxConcurrentWorkers?: number;
  /** 临时 worker 在收割者杀死它之前可以零输出的分钟数——基于空闲而非墙钟，
   *  因此正在活跃工作的 worker 绝不会被收割。默认 20。 */
  workerIdleTimeoutMinutes?: number;
  /** 已注册的 integrations（Phase 2）——worker 通过回环 secret broker 访问的
   *  带标签 REST 端点。仅元数据：每条记录携带 `secretRef` 句柄，绝不携带
   *  secret 值（secret 通过 Electron safeStorage 加密保存在单独文件中——见
   *  src/main/integrations.ts）。默认 []。 */
  integrations?: IntegrationRecord[];
  /** 应用于每个 god 触发的临时 worker 的默认单 worker TOTAL-token 上限
   *  （input+output+cache）；worker 自身 spawn-request 的 `tokenCap` 会覆盖
   *  它。当有效上限被超出时，worker 被收割（其已提交的工作得以保留）并通知
   *  god。这是为后续预算功能铺设的管线（PLUMBING）：根据人工指令，目前没有
   *  单 worker 上限，因此默认 0 = UNLIMITED——机制已接线但不会限流，除非某人
   *  显式设置正数上限（按请求或在此处）。 */
  defaultWorkerTokenCap?: number;
  /** 熔断器阈值（Lane A #6.6b）。未设置 = 保守默认值。 */
  circuitBreaker?: CircuitBreakerConfig;
  /** Enterprise Knowledge Graph（面向代理的多模态上下文）。默认 OFF。 */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** 在代理生命周期事件（空闲完成 / 等待输入）时触发原生桌面通知。 */
  notifications?: boolean;
  /** 选择启用的"强保活"：当 ≥1 个代理 PTY 活跃时，将电源阻止器从
   *  'prevent-app-suspension' 升级为 'prevent-display-sleep'，在 macOS 上还会
   *  阻止真正的系统睡眠（合盖/空闲），从而在离开期间定时任务和终端仍能准时
   *  触发——代价是耗电（最好接电源）。默认 OFF：诚实的默认是"经受睡眠 +
   *  恢复后一次性追赶"（见 powerMonitor 'resume' 处理器），而非"保持清醒"。 */
  strongKeepalive?: boolean;
  /** 从 GitHub releases 自动更新（v0.3.4）。默认 ON。打包构建在启动时 + 每
   *  ~6 小时检查一次，后台下载，并显示"重启以更新"提示——安装始终由用户
   *  发起。OFF 完全禁用检查。（在 preload + renderer 配置中镜像。） */
  autoUpdate?: boolean;
  /** 多窗口"楼层"：暴露一个 New Floor 操作，打开额外窗口，每个窗口是独立的
   *  办公室，拥有隔离的 renderer 状态（各自的 session partition）和按窗口的
   *  PTY 路由。默认 ON（v0.3.4：代码与注释不一致；已发货行为——启用——胜出）——
   *  窗口/PTY 归属管线始终激活且单窗口安全，但 New Floor 入口（应用菜单项 +
   *  IPC）只在开启时出现。磁盘上的 hive（harnessHome 下的 god 编排）保持进程
   *  全局；各楼层共享它。 */
  multiWindow?: boolean;
  /** 终端主题——派生时镜像到每个代理的每会话 Claude 设置（"theme" 键），使
   *  TUI 的 truecolor 调色板一致。仅作用于 harness 代理；用户的全局 Claude
   *  主题绝不被触碰。 */
  terminalTheme?: 'light' | 'dark';
  /** 匿名产品分析（PostHog）——确切的事件/属性记录在 TELEMETRY.md 中。默认
   *  ON（选择退出，如同 autoUpdate）；没有注入 key 的构建以及设置了
   *  DO_NOT_TRACK 的环境无论此标志如何都绝不发送。（在 preload + renderer
   *  配置中镜像。） */
  telemetryEnabled?: boolean;
  /** 电视剧办公室主题功能的 master 标志（Settings 主题选择器 + 破坏性切换
   *  流程）。默认 false = 选择器隐藏，办公室按现状渲染（零行为变化）。 */
  tvShowOffices?: boolean;
  /** 像素办公室渲染哪个办公室地图/卡司主题。仅当 `tvShowOffices` 开启时生效；
   *  否则使用 office 主题。未构建的剧集主题在 loader 中回退到 'office'。 */
  officeTheme?: 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
  /** OpenCode/Crush/pi/qwen 引擎的按 CLI provider 的本地/自托管 base URL
   *  （Ollama/LM Studio/vLLM, …）；在派生时应用（配置注入或代理上游）。
   *  API KEYS 不存储在此——它们只写存在于 secret broker（integrations.ts）
   *  中，派生时仅 MAIN 读取。 */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** 按 CLI provider 的默认模型 slug，用于预填模型选择器。 */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
  /** Slack → Michael 队列集成的 master 开关。 */
  slackEnabled?: boolean;
  /** Slack 应用签名密钥（Basic Information → Signing Secret）。绝不记录。 */
  slackSigningSecret?: string;
  /** Bot token（xoxb-…）——仅当 bot 需要回复时才需要；目前可选。 */
  slackBotToken?: string;
  /** 将摄取限制为单个 channel id；空/undefined = 任意频道。 */
  slackChannelId?: string;
  /** webhook 服务器绑定的本地 HTTP 端口（默认 3847）。 */
  slackPort?: number;
  /** 选择启用：允许由 APP/语音发起的主动 Slack 发帖（例如 renderer 的
   *  "queued" 确认）。按人工指令"默认停止向 Slack 发帖"默认 OFF。这不会门控
   *  Slack 来源的完成回复往返（用户 @提及 → 任务 → 结果回帖到该线程）或代理
   *  自己在线程内的直接回复——这些始终开启。 */
  slackProactivePosting?: boolean;

  // ─── Free Flow（语音听写 → 消息队列）───────────────────────────
  /** Free Flow 按键通话听写的 master 开关。默认 OFF：关闭时 composer 不显示
   *  麦克风按钮，不运行 getUserMedia，也绝不发起任何 Groq 调用（零行为
   *  变化）。 */
  freeflowEnabled?: boolean;
  /** 用户粘贴的 Groq API key（用户自备免费 key）。仅在主进程用于 Groq STT
   *  调用；绝不记录，也绝不为请求跨 IPC。与 `slackBotToken` 同等对待。 */
  groqApiKey?: string;
  /** Groq Whisper 模型 id。默认 'whisper-large-v3-turbo'（快速、多语言）。 */
  freeflowModel?: string;

  // ─── Realtime Michael（高级语音对语音语音编排器）─────────────────
  /** 仅在 Realtime Michael 语音会话活跃时为 true：renderer 会话在 start() 时
   *  打开它（getUserMedia 之前），在 stop() 时关闭。主进程的麦克风权限闸门
   *  读取它，使 Electron 媒体权限恰好只在语音循环持有麦克风时开放——绝不会
   *  仅仅因为有 OpenAI key 就开放（该 key 与 CLI 引擎共享）。
   *  默认关闭；缺省 ⇒ 麦克风被拒，与 `freeflowEnabled` 一致。 */
  realtimeVoiceEnabled?: boolean;
  /** 实时语音会话在自动断开前可静置多久（ms）（rt-9 空闲守卫）。默认
   *  180000（3 分钟）。0 = 空闲时永不自动断开——花费上限仍是失控守卫。用户
   *  在 Settings → Realtime Michael 中调整。 */
  realtimeIdleDisconnectMs?: number;

  // ─── 通用入站 webhook + 状态 API（LEGACY，单端点）────────────────────────
  // 已被 `webhookTriggers` 取代，后者允许一个服务器和一个隧道承载多个端点。
  // 这三个被保留，因为它们是迁移来源（MIGRATION SOURCE）（`migrateTriggersV1`
  // 将它们折叠进一个 `WebhookTrigger`），也因为 main 进程在服务器被重新接线到
  // 新列表之前仍会读取它们。这里不应再写任何新内容。
  /** @deprecated 使用 `webhookTriggers[].enabled`。 */
  webhookEnabled?: boolean;
  /** 应用生成的共享密钥，调用方在 `x-md-webhook-secret` 中回显。绝不记录，
   *  也绝不转发到被路由的消息/卡片/响应中。
   *  @deprecated 使用 `webhookTriggers[].secret`（每个端点一个密钥，这样撤销
   *  一个调用方绝不会影响其他调用方）。 */
  webhookSecret?: string;
  /** 通用 webhook 服务器绑定的本地 HTTP 端口（默认 3849）。
   *  @deprecated 端口是共享服务器的属性，而非任何一个 trigger 的属性；
   *  `webhookTriggers` 通过 id 在其上多路复用。 */
  webhookPort?: number;

  // ─── Triggers（此处每个类型都由 src/shared/triggers.ts 拥有）──────────────
  /** 代理终端上下文的自动压缩 / 自动清理。两个半部都随
   *  DEFAULT_CONTEXT_TRIGGER 发货；`readConfig` 深度填充它们，因为下面的顶层
   *  合并只有一层深，否则半写入的子对象会以 `undefined` 阈值到达消费者。 */
  contextTrigger?: ContextTriggerConfig;
  /** 入站 HTTP 端点，每个调用方一个条目。取代上面遗留的单个 webhook；多个
   *  可共存于一个端口，通过路径中的 `id` 区分。 */
  webhookTriggers?: WebhookTrigger[];
  /** 队友克隆节点之间的对等消息。目前仅有持久化 + UI——尚无传输服务读取
   *  `apiKey`。 */
  orgTrigger?: OrgTriggerConfig;
  /** `migrateTriggersV1` 的一次性守卫（legacy webhook → webhookTriggers、
   *  1h → 2h 压缩节奏）。迁移完整运行完毕后设置。 */
  triggersMigratedV1?: boolean;

  // ─── Memory reflection（清洁工的压缩半部）───────────────────────
  /** 进程内 MemoryReflector 的 master 开关。默认开启。 */
  reflectEnabled?: boolean;
  /** 多久扫描一次代理的 memory.md 文件以进行压缩（默认 30 分钟）。 */
  reflectIntervalMs?: number;
  /** 当字节数超过 128 KB 预算的这个百分比时进行压缩（与清洁工的 TRIGGER_PCT
   *  一致）。DECIDED: 50。 */
  reflectByteTriggerPct?: number;
  /** ...或当 `## ` 节数超过此值（且字节数 > 下限）时。DECIDED: 50。 */
  reflectSectionTrigger?: number;
  /** 每次压缩时保留最新 K 个逐字的 `## ` 节原封不动。 */
  reflectRecentKeep?: number;
  /** 绝不压缩小于此值的文件；同时也是节触发器的字节下限。DECIDED: 16 KB。 */
  reflectMinBytes?: number;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  recentHives: [],
  registeredRepos: [],
  autoMode: true,
  orchestratorMaySpawn: false,
  defaultCommand: 'claude',
  godProvider: 'claude',
  godModel: 'claude-opus-4-8',
  // 每个未显式选择模型的代理的全局默认模型——在派生处理器中胜过基于角色的
  // 分级（modelForRole），因此所有代理（含 god）都默认使用 Fable 5。
  // 单代理的模型选择仍然覆盖它。
  defaultModel: 'claude-fable-5',
  // 从 MCP catalog 播种，这样同意默认值绝不会与其漂移
  // （safe-readonly ON，write/secret OFF）。
  mcpDefaults: defaultMcpDefaults(),
  maxConcurrentWorkers: 4,
  workerIdleTimeoutMinutes: 20,
  integrations: [],
  defaultWorkerTokenCap: 0, // 0 = 无上限（人工指令：无单 worker 上限）
  semanticMemory: true,
  embeddingModel: 'minilm',
  missions: [OPS_STANDUP_MISSION],
  notifications: false,
  strongKeepalive: false,
  autoUpdate: true,
  telemetryEnabled: true,
  multiWindow: true,
  tvShowOffices: false,
  officeTheme: 'office',
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  slackProactivePosting: false,
  freeflowEnabled: true,
  groqApiKey: undefined,
  freeflowModel: 'whisper-large-v3-turbo',
  realtimeVoiceEnabled: false,
  realtimeIdleDisconnectMs: 180_000,
  webhookEnabled: false,
  webhookSecret: undefined,
  webhookPort: undefined,
  // Triggers。这三个是唯一会被 `readConfig` 原样交还的对象/数组默认值
  // （针对从未持久化它们的配置），因此 `withTriggerDefaults` 在每次读取时
  // 重新复制它们——参见那里的注释。
  contextTrigger: DEFAULT_CONTEXT_TRIGGER,
  webhookTriggers: [],
  orgTrigger: DEFAULT_ORG_TRIGGER,
  triggersMigratedV1: false,
  // Memory reflection——预防性的；目前没人超阈值，因此它保持暗置，直到某个
  // 代理的记忆越过其中一个（verify gate 是 LLM 步骤的安全保障）。阈值于
  // 2026-06-06 由 god DECIDED。
  reflectEnabled: true,
  reflectIntervalMs: 1_800_000,
  reflectByteTriggerPct: 50,
  reflectSectionTrigger: 50,
  reflectRecentKeep: 12,
  reflectMinBytes: 16_384,
  // Enterprise Knowledge Graph——选择启用；在用户启用前保持暗置。
  // v0.3.4 修复：默认 OFF，与该字段自身的文档（"Default OFF / dark until
  // enabled"）一致——真实默认值之前与之矛盾。现有安装保留其持久化的值。
  knowledgeGraph: { enabled: false }
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/**
 * 深度填充 trigger 子对象，并返回它们的副本。
 *
 * 一个修复解决两个问题。其一，`readConfig` 中的合并只有一层深，因此旧构建
 * 持久化的 `contextTrigger`（或只修补了 `compact` 的 `writeConfig`）到达时
 * 缺少 DEFAULTS 本应提供的子键——消费者于是在期望数字的地方读到
 * `undefined`，规则永远不触发。其二，同样的浅合并把字面的
 * DEFAULT_CONTEXT_TRIGGER / DEFAULT_ORG_TRIGGER 实例交给每个未持久化它们的
 * 配置，因此某个调用方修改它读取到的内容，就会重写整个进程的默认值——以及
 * 之后读取的每一个配置。
 *
 * 因此下面的每个分支都构造一个全新对象，包括"未持久化"分支。
 */
function withTriggerDefaults(cfg: HarnessConfig): HarnessConfig {
  return {
    ...cfg,
    contextTrigger: {
      compact: { ...DEFAULT_CONTEXT_TRIGGER.compact, ...cfg.contextTrigger?.compact },
      clear: { ...DEFAULT_CONTEXT_TRIGGER.clear, ...cfg.contextTrigger?.clear }
    },
    orgTrigger: { ...DEFAULT_ORG_TRIGGER, ...cfg.orgTrigger },
    webhookTriggers: Array.isArray(cfg.webhookTriggers)
      ? cfg.webhookTriggers.map((t) => ({ ...t }))
      : []
  };
}

/** 一旦 `migrateTriggersV1` 在当前进程中运行过即被设置。`writeConfig` 在写入
 *  前会先读取，因此没有内存锁存器的话，迁移自身的 persist 会在
 *  `triggersMigratedV1: true` 到达磁盘之前重新进入 `readConfig` 并再次运行
 *  迁移。 */
let triggersMigrationRan = false;

/**
 * 将 pre-Triggers 的配置形态向前折叠，每个安装恰好一次。
 *
 * 从 `readConfig` 运行，因此在任何消费者能观察到配置之前就已完整——不存在
 * 会弄错的启动顺序，也不存在半个应用看到旧形态的窗口。两件事会被迁移：
 *
 *   1. 单个遗留 webhook（`webhookEnabled`/`webhookSecret`）变成一个 id 稳定的
 *      `WebhookTrigger`（`legacy`），这样已持有该密钥的调用方在升级后仍能工作。
 *      当 `webhookTriggers` 已被填充时跳过——用户已经前进，重新添加一个合成
 *      条目会复活已撤销的端点。
 *   2. 已播种的 `compact-maintenance` 任务从旧的 1 小时节奏移到 2 小时，但
 *      仅当它仍精确读取为 1 小时时。用户选择的间隔是一种决定，而非过时的
 *      默认值，会被原样保留。
 *
 * 整体包裹在 try/catch 中：以某种无关方式损坏的配置也必须能让应用启动，
 * 迁移绝不值得一次失败的启动。
 */
function migrateTriggersV1(cfg: HarnessConfig): HarnessConfig {
  if (cfg.triggersMigratedV1 || triggersMigrationRan) return cfg;
  triggersMigrationRan = true;
  try {
    const next: HarnessConfig = { ...cfg, triggersMigratedV1: true };

    const legacySecret = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret.trim() : '';
    if (legacySecret && (cfg.webhookTriggers?.length ?? 0) === 0) {
      next.webhookTriggers = [
        {
          id: 'legacy',
          name: 'Default webhook',
          secret: legacySecret,
          enabled: cfg.webhookEnabled ?? false,
          mode: DEFAULT_TRIGGER_MODE,
          schema: DEFAULT_WEBHOOK_SCHEMA,
          createdAt: Date.now()
        }
      ];
    }

    const missions = Array.isArray(cfg.missions) ? cfg.missions : [];
    const stale = (m: ScheduledMission): boolean =>
      m?.id === COMPACT_MAINTENANCE_MISSION.id
      && m.intervalMs === LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS;
    if (missions.some(stale)) {
      next.missions = missions.map((m) =>
        stale(m) ? { ...m, intervalMs: COMPACT_MAINTENANCE_MISSION.intervalMs } : m
      );
    }

    persistConfig(next);
    return next;
  } catch {
    // 将配置原样保留为读取到的状态。上面的锁存器保持已设置，因此失败的迁移
    // 会在下一次启动时重试，而不是在每次读取时都重试。
    return cfg;
  }
}

export function readConfig(): HarnessConfig {
  const p = configPath();
  // 尚无文件 = 首次运行、无需迁移；默认值就是迁移后的形态。刻意不持久化——
  // 裸读取绝不能在引导写入 config.json 之前凭空变出一个。
  if (!existsSync(p)) return withTriggerDefaults({ ...DEFAULTS });
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeStoredHomes(migrateTriggersV1(withTriggerDefaults({ ...DEFAULTS, ...parsed })));
  } catch {
    return withTriggerDefaults({ ...DEFAULTS });
  }
}

/** (#140，升级路径) 在 `writeConfig` 学会展开 `~` 之前持久化的 config.json，
 *  `harnessHome` / `recentHives` 中仍持有字面的 `~/…` 字符串，且在下一次写入
 *  之前没有任何东西会重写该文件——因此 hive 选择器会渲染原始的 `~` 字符串，
 *  并直接把它喂回 `config:changeHome`，落在 `resolve()` → `<cwd>/~/…` 上，
 *  即一个真实命名为 "~" 的目录。`normalizeHiveHome` 只在进入时清理值；
 *  这个函数在离开时清理，因此无论文件年代如何，任何消费者都看不到 `~` 路径。
 *  展开后的重复项会合并（过时的 "~/X" 与其绝对双胞胎相邻时会变成一个条目）。 */
function normalizeStoredHomes(cfg: HarnessConfig): HarnessConfig {
  if (typeof cfg.harnessHome === 'string' && cfg.harnessHome.trim()) {
    cfg.harnessHome = expandTilde(cfg.harnessHome);
  }
  if (Array.isArray(cfg.recentHives)) {
    const seen = new Set<string>();
    cfg.recentHives = cfg.recentHives
      .filter((h): h is string => typeof h === 'string' && !!h.trim())
      .map((h) => expandTilde(h))
      .filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
  }
  return cfg;
}

/** 广播每次保存的设置，以便展示它的界面可以更新。
 *
 *  Settings、Slack、voice 和 notifications 各自通过自己的路径保存，而它们最终
 *  都会写入下面的文件——因此这里的一个订阅覆盖所有设置，而不只是那些有人
 *  记得接线的设置。 */
type ConfigWriteListener = (next: HarnessConfig) => void;
const configWriteListeners = new Set<ConfigWriteListener>();

export function onConfigWritten(listener: ConfigWriteListener): () => void {
  configWriteListeners.add(listener);
  return () => { configWriteListeners.delete(listener); };
}

function persistConfig(next: HarnessConfig): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  // 保存一个设置只存储那一个设置，所以先把其余部分填回来：订阅者必须看到
  // 与读取一致、完整而非半填充的配置。跳过迁移——它会自行保存，并且已经针对
  // 本次更改所基于的内容运行过了。
  const view = normalizeStoredHomes(withTriggerDefaults({ ...DEFAULTS, ...next }));
  // 更改已经保存，因此一个失败的订阅者不能让其调用方的保存失败，也不能
  // 阻止其后的订阅者。
  for (const listener of configWriteListeners) {
    try { listener(view); } catch { /* 一个损坏的 listener 不等于一次失败的保存 */ }
  }
  return next;
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfig();
  const next: HarnessConfig = { ...current, ...patch };
  // 项目摄入（INGESTION）——注册的 repo 常常是手打的（"~/dev/foo"），与从
  // 文件夹对话框选择一样常见。在此处展开 `~`，使持久化的列表（因此也是每个
  // 代理的默认 cwd）是 ABSOLUTE；Node 的 fs/spawn 会把 `~` 当作字面的目录名，
  // 派生会因 `cwd does not exist` 而死掉。
  if (Array.isArray(patch.registeredRepos)) {
    const seen = new Set<string>();
    next.registeredRepos = patch.registeredRepos
      .map((r) => expandTilde(r))
      .filter((r) => r && !seen.has(r) && (seen.add(r), true));
  }
  // HIVE HOME 需要与上面 registeredRepos 完全相同的处理，多年来它都没有得到
  // 这一处理（#140）。引导程序 SUGGESTS `~/HarnessAgents`，而该字段是自由
  // 文本，因此常见路径——接受默认值、按 Finish——持久化了字面的 `~`。
  // finish 步骤做的第一件事是创建目录，而 Node 的 mkdir 不知道 `~` 是什么：
  // 它试图创建一个实际名为 "~" 的文件夹，结果以
  //   ENOENT: no such file or directory, mkdir '~/HarnessAgents'
  // 失败，把向导卡在最后一步、无路可走。要在值被持久化或复制进 recentHives
  // 之前展开，这样每个下游读取方（mkdir、hive 根、启动选择器）都看到同一个
  // 绝对路径。
  if (typeof patch.harnessHome === 'string' && patch.harnessHome) {
    const { home, recentHives } = normalizeHiveHome(patch.harnessHome, current.recentHives ?? []);
    next.harnessHome = home;
    next.recentHives = recentHives;
  }
  return persistConfig(next);
}

/** 针对磁盘上最新的配置设置或清除单个代理的 token 上限。
 *
 * renderer 的配置对象是快照。从某个快照替换 `agentTokenCaps` 会丢失自快照
 * 读取之后写入的上限（在审核一批导入的 hires 时最为明显）。将读-改-写保留在
 * 同步的 main 进程中，这样每次调用都会在把更新后的配置返回给 renderer 之前
 * 与上一次的结果合并。 */
export function setAgentTokenCap(agentId: unknown, tokenCap: unknown): HarnessConfig {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error('invalid agent token cap');
  }
  if (
    tokenCap !== undefined
    && (
      typeof tokenCap !== 'number'
      || !Number.isInteger(tokenCap)
      || tokenCap <= 0
      || tokenCap > MAX_AGENT_TOKEN_CAP
    )
  ) throw new Error('invalid agent token cap');

  const current = readConfig();
  const agentTokenCaps = { ...(current.agentTokenCaps ?? {}) };
  if (tokenCap === undefined) delete agentTokenCaps[agentId];
  else agentTokenCaps[agentId] = tokenCap;
  return persistConfig({
    ...current,
    agentTokenCaps
  });
}

/** 把持久化的配置擦除回首次运行的默认值，让应用再次引导进入 onboarding。
 *  由"reset & start over"流程使用。 */
export function resetConfig(): HarnessConfig {
  // 与任何其他更改一样被保存，因此重置也会自我广播。
  persistConfig({ ...DEFAULTS });
  // 同时丢弃迁移锁存器：磁盘上的文件已回到 `triggersMigratedV1: false`，
  // 若锁存器保持已设置，该标志将永远不会在本进程中再次被写入。迁移本身对
  // 默认值来说无论如何都是空操作。
  triggersMigrationRan = false;
  return withTriggerDefaults({ ...DEFAULTS });
}

/** 按层级的模型 id（Lane A #6.4）。与 src/renderer/src/store/config.ts 中的
 *  AGENT_MODELS 保持同步。 */
const MODEL_GOD = 'claude-opus-4-8';                  // 编排——最高能力
const MODEL_WORKER = 'claude-sonnet-4-6';             // 通用执行
const MODEL_HELPER = 'claude-haiku-4-5-20251001';     // 狭窄、廉价的辅助

/** 分层所需的最小结构形态——AgentMeta 的一个子集，这样 config.ts 无需引入
 *  hive.ts。 */
export interface RoleHint {
  isGod?: boolean;
  role?: string;
  capabilities?: string[];
}

/** 根据代理角色给出的默认模型（Lane A #6.4）：god 用 Opus，狭窄辅助（triage /
 *  routing / verification / formatting）用 Haiku，通用 worker 用 Sonnet。
 *  返回模型 id（与 AGENT_MODELS 一致）或 undefined 以回退到 CLI 默认。
 *  这只是 DEFAULT——显式的单代理模型选择始终优先。 */
export function modelForRole(
  meta: RoleHint,
  config?: Pick<HarnessConfig, 'godProvider' | 'godModel'>
): string | undefined {
  if (meta.isGod) {
    // GOD 引擎可选：显式的 godModel 优先，否则用所选 provider 推荐的
    // 编排器模型，否则用遗留的 Opus 默认。
    const preset = providerPreset(config?.godProvider ?? 'claude');
    return config?.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD;
  }
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}

/** 确保 harnessHome 在磁盘上存在。先展开 `~`——引导向导允许用户输入路径，
 *  而 mkdir 会把字面的 `~` 当作普通目录名（issue #140 的
 *  `ENOENT: mkdir '~/HarnessAgents'`）。 */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    // 在这里也展开，而不仅仅在写入配置时（#140）。它最先运行——onboarding
    // 在 updateConfig 之前调用它——因此只在写入边界规范化会让真正的 mkdir
    // 仍然收到字面的 `~`。取决于进程 cwd，这要么直接失败，要么更糟：悄悄成功
    // 地在某个没人会看的地方创建了一个真实名为 "~" 的目录，hive 于是住在一个
    // 用户找不到的路径上。这正是 expandTilde 文档要求的"在消费者端纵深防御"：
    // 摄入点规范化，消费者拒绝盲目信任它已规范化。
    mkdirSync(expandTilde(path), { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 幂等地预先接受 Claude Code 的首次运行提示，让以 `--permission-mode
 *  bypassPermissions` 派生的代理干净启动。没有它，全新安装会显示一个交互式
 *  "WARNING: Bypass Permissions mode … 1. No, exit / 2. Yes, I accept" 提示，
 *  PTY 无法及时回答，代理于是自行以 code 1 退出（多位用户反馈）。
 *
 *  两个独立的门，仅在它们尚未满足时才写入（因此我们极少触碰正在运行的
 *  `claude` 也会写的文件）：
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt`——它们门控绕过模式警告（全局）。
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted`——逐文件夹的
 *      "你信任此文件夹中的文件吗？"对话框。 */
export function ensureClaudePermissionsAccepted(cwd?: string): void {
  const home = homedir();
  if (!home) return;
  // 1) 全局绕过模式警告门。
  try {
    const dir = join(home, '.claude');
    const p = join(dir, 'settings.json');
    let s: Record<string, unknown> = {};
    if (existsSync(p)) {
      try { s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { s = {}; }
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch { /* 尽力而为；绝不阻塞派生 */ }
  // 2) 逐文件夹信任对话框门（仅当该 cwd 尚未被信任时）。
  if (cwd) {
    try {
      const p = join(home, '.claude.json');
      let c: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> } = {};
      if (existsSync(p)) {
        try { c = JSON.parse(readFileSync(p, 'utf8')); } catch { c = {}; }
      }
      if (c.projects?.[cwd]?.hasTrustDialogAccepted !== true) {
        c.projects = c.projects ?? {};
        c.projects[cwd] = { ...(c.projects[cwd] ?? {}), hasTrustDialogAccepted: true };
        writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
      }
    } catch { /* 尽力而为 */ }
  }
}
