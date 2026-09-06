// 镜像 src/main/config.ts。作为渲染端只类型的模块保留，这样我们不必伸手
// 进 preload 包来做类型检查。
import {
  AGENT_PROVIDER_PRESETS,
  providerPreset,
  inferAgentProvider,
  isClaudeProvider,
  type AgentProvider
} from '@shared/agentProvider';
import type {
  ContextTriggerConfig,
  OrgTriggerConfig,
  WebhookTrigger
} from '@shared/triggers';
import { isNewer } from '@shared/updateState';
import modelCatalog from '@shared/modelCatalog.json';

export {
  AGENT_PROVIDER_PRESETS,
  providerPreset,
  inferAgentProvider,
  isClaudeProvider,
  type AgentProvider
};

/** 周期性自动派发的任务（镜像 src/main/config.ts）。 */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  quietThresholdMs?: number;
}

/** 熔断器阈值（镜像 src/main/config.ts 的 CircuitBreakerConfig）。 */
export interface CircuitBreakerConfig {
  enabled?: boolean;
  hardStop?: boolean;
  repeatedToolLimit?: number;
  errorStormLimit?: number;
  tokenVelocityPerMin?: number;
}

/** 企业知识图谱配置（镜像 src/main/config.ts 的 KnowledgeGraphConfig）。 */
export interface KnowledgeGraphConfig {
  enabled?: boolean;
  rootPath?: string;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  /** 首个 onboarding 屏幕自报的受众（'technical' 对 'non-technical'）——
   *  驱动整个 onboarding 的文案语气。镜像 src/main/config.ts。 */
  audience?: 'technical' | 'non-technical';
  harnessHome: string | null;
  /** 最近打开的 hive 主目录（最近的在前），供启动选择器使用。
   *  镜像 src/main/config.ts。 */
  recentHives?: string[];
  registeredRepos: string[];
  autoMode: boolean;
  /** 编排者（“Michael”）能否自行拉起 agent？默认 FALSE，所以缺省值读作
   *  关闭。镜像 src/main/config.ts。 */
  orchestratorMaySpawn?: boolean;
  defaultCommand: string;
  /** 新 spawn agent 的默认模型（例如 'claude-sonnet-4-6[1m]'）；未设置 =
   *  CLI 默认。 */
  defaultModel?: string;
  /** 哪个 provider+model 为 GOD 编排者（“Michael”）供电。默认
   *  'claude' / 'claude-opus-4-8'。镜像 src/main/config.ts。 */
  godProvider?: AgentProvider;
  godModel?: string;
  /** 默认 MCP 捆绑的按服务器同意，以目录 id 为键（镜像 src/main/config.ts；
   *  由 MCP_CATALOG 播种）。 */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  missions?: ScheduledMission[];
  opsStandupSeeded?: boolean;
  heartbeatSeeded?: boolean;
  notifications?: boolean;
  /** 选用的“强力保活”：把应用内电源阻止器升级为阻止显示器睡眠，让定时
   *  任务/终端在你离开时也能准点触发（耗电；最好插电）。默认关闭 =
   *  恢复后补跑。镜像主进程字段（src/main/config.ts）。 */
  strongKeepalive?: boolean;
  /** 从 GitHub releases 自动更新（默认开；设置 → 通用）。 */
  autoUpdate?: boolean;
  /** 匿名产品分析（默认开，可退出；见 TELEMETRY.md）。
   *  镜像主进程字段（src/main/config.ts）。 */
  telemetryEnabled?: boolean;
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackPort?: number;
  /** 选用的应用/语音发起主动 Slack 发帖（默认关）。镜像
   *  src/main/config.ts；Slack 来源的完成回复往返永不被门控。 */
  slackProactivePosting?: boolean;
  /** Free Flow 语音听写（镜像 src/main/config.ts）。 */
  freeflowEnabled?: boolean;
  groqApiKey?: string;
  freeflowModel?: string;
  /** 实时语音空闲自动断开（毫秒）；默认 180000（3 分钟），0 = 永不。
   *  在 设置 → 实时 Michael 中调；成本上限仍是失控守卫。 */
  realtimeIdleDisconnectMs?: number;
  costCapUsd?: number;
  /** 跨活跃 agent 的硬性总 token 上限（面向用户的预算）。 */
  costCapTokens?: number;
  /** 按 agent 的 token 总上限，以 agent id 为键。覆盖该 agent 计量表的
   *  楼层预算，并只为它触发熔断器。 */
  agentTokenCaps?: Record<string, number>;
  autoDeliveryPausedAgents?: string[];
  maxTurns?: number;
  circuitBreaker?: CircuitBreakerConfig;
  /** 企业知识图谱（面向 agent 的多模态上下文）。默认关。 */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** 电视剧主题办公室功能开关（设置选择器 + 切换流程）。默认关。 */
  tvShowOffices?: boolean;
  /** 活跃办公室地图/角色主题（仅 tvShowOffices 开启时生效）。 */
  officeTheme?: 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
  /** 每个 CLI provider 的本地/自托管基础 URL（Ollama/LM Studio/vLLM 等），
   *  用于 OpenCode/Crush/pi/qwen 引擎；spawn 时应用。API 密钥不存这里——
   *  它们只写在 secret broker 中。 */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** 每个 CLI provider 的默认模型 slug，用于预填模型选择器。 */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
  /** 旧版单 webhook 字段（镜像 src/main/config.ts，其中它们已废弃、
   *  改用 `webhookTriggers`，但在服务器重新接线前仍会被读取）。在此声明，
   *  好让展示它们的界面可以停止在本地加宽此类型。
   *  @deprecated 使用 `webhookTriggers`。 */
  webhookEnabled?: boolean;
  /** @deprecated 使用 `webhookTriggers[].secret`。 */
  webhookSecret?: string;
  /** @deprecated 端口属于共享服务器，不属于任何一个触发器。 */
  webhookPort?: number;
  /** agent 终端上下文的自动压缩 / 自动清空。主进程读取时深度填充两半，
   *  渲染端可以把子键当作存在（镜像 src/main/config.ts）。 */
  contextTrigger?: ContextTriggerConfig;
  /** 入站 HTTP 端点，每个调用方一个——取代上面的旧版三元组。 */
  webhookTriggers?: WebhookTrigger[];
  /** 队友克隆节点之间的对等消息（仅持久化 + UI）。 */
  orgTrigger?: OrgTriggerConfig;
  /** 主进程触发器迁移的一次性守卫；这里只读。 */
  triggersMigratedV1?: boolean;
}

/** 1M-token 上下文窗口的 Sonnet 模型——用于 Michael 的预备助手（廉价、
 *  大上下文的信息收集）。镜像 src/main/assistant.ts 的 ASSISTANT_MODEL；
 *  两者要保持同步。 */
export const ASSISTANT_MODEL = 'claude-sonnet-4-6[1m]';

export interface ModelOption {
  /** undefined = 使用 CLI 默认（不带 --model 标志） */
  id?: string;
  label: string;
}

/** 模型目录的一行。`minAppVersion` / `maxAppVersion` 是 INCLUSIVE 的应用
 *  版本边界：当运行中的构建落在它们内部时该模型被提供，null（或缺失键）
 *  表示该方向无界。这正是一个版本可以在不改代码的情况下引入或退役一个
 *  模型的方式。
 *
 *  预发布版按其发布版计。比较只做 major.minor.patch（`isNewer` 丢弃
 *  `-rc.N` 后缀），因此 `minAppVersion: '0.4.6'` 在 `0.4.6-rc.1` 上也提供。
 *  这是刻意且已裁决的：一个版本的 rc 应算作那个版本，它与更新徽章自身的
 *  比较一致，反之会把新模型藏起来不让本应测试它的测试者看到。把模型绑定
 *  到发布版，而不是它的 rc。 */
interface CatalogModel {
  /** 缺失 = 使用 CLI 默认（不带 --model 标志） */
  id?: string;
  label: string;
  minAppVersion?: string | null;
  maxAppVersion?: string | null;
}

interface ModelCatalog {
  version: number;
  providers: Record<string, CatalogModel[]>;
}

/** 每个 provider 选择器提供的模型预设。
 *
 *  这些曾经是本文件里一打硬编码的 `ModelOption[]` 数组，发版一个模型——
 *  一个字符串——意味着编辑、类型检查并重建渲染端源码。现在它们住在
 *  src/shared/modelCatalog.json，构建时导入（无 fs、无网络、离线安全），
 *  并按运行版本过滤，因此加一个模型就是一行 JSON 编辑，模型还可以指名
 *  它所属的版本，而不是出现在从未随该版本一起发过它的 CLI 的构建里。
 *
 *  这些数组以前想说的——保留下来，因为它解释条目为什么长这样：
 *
 *  - claude: `[1m]` 选择 1M-token 上下文窗口变体。列表刻意没有
 *    “不传 --model 标志”的条目：每个选项都指名一个真实模型，因为打开这个
 *    选择器的全部理由就是知道 agent 在用哪个模型，而无标志选项会解析成
 *    Claude Code 碰巧选的任何东西——UI 显示不了、用户也无法预测。harness
 *    默认改用 ` · default` 标记，而且它指名一个真实模型。
 *  - 多个 provider 携带的前导 `CLI default` 条目意味着完全没有 `--model`
 *    标志——CLI 自身默认什么就是什么。那不是 harness 的
 *    `config.defaultModel`；选择器单独标记后者，把两者都标成 "default" 正是
 *    让它们无法区分的原因。
 *  - codex: Codex 提供的当前 OpenAI 模型。command 字段保持可编辑，
 *    `codex --model <id>` 是事实来源。
 *  - antigravity: agy 的 `--model` 接受 DISPLAY-NAME LABEL，与 `agy models`
 *    打印的一模一样（已验证：agy 记录 `Propagating selected model override
 *    … label="…"`），不是 slug——所以这些 id 就是标签，含空格和括号；
 *    buildSpawnCommand 引用它们，命令分词器保持其完整。`agy models` 是
 *    实时列表的事实来源。
 *  - gemini: 官方 Google Gemini CLI 接受的稳定别名。它们跟随 CLI 而不是
 *    钉住会漂移的预览模型 id。
 *  - qwen: qwen-code (`qwen`)，驱动 OpenAI 兼容端点的代理桥 CLI。仅为
 *    起始建议。 // TODO-verify the live list.
 *  - kimi: `kimi --model <alias>` 接受的托管 Kimi Code 别名。
 *  - custom: 完全没有预设；命令字段就是整个界面。
 */
const CATALOG: ModelCatalog = modelCatalog;

declare const __APP_VERSION__: string | undefined;

/** 运行中构建的版本。electron-vite 在构建时把 `__APP_VERSION__` 替换成
 *  package.json 的版本——与更新徽章显示的同一个值——因此渲染端可以同步
 *  得知它，无需往返 main。构建外（单元测试）该 define 缺失，也没有可比较
 *  的版本；见 `offeredAtVersion` 上的 fail-open 说明。 */
export function runningAppVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

/** 目录条目是否属于本构建的选择器。两个边界都包含其所指名的版本。任何
 *  无法解析的——缺失的边界、格式错误、未知应用版本——都被忽略而不是隐藏
 *  模型：一个静默丢失所有模型的选择器，远比一个提供了本构建 CLI 跑不了
 *  的模型（命令字段可编辑，CLI 会报出坏 slug）要糟糕得多。 */
function offeredAtVersion(model: CatalogModel, appVersion: string): boolean {
  if (model.minAppVersion && isNewer(model.minAppVersion, appVersion)) return false;
  if (model.maxAppVersion && isNewer(appVersion, model.maxAppVersion)) return false;
  return true;
}

/** 某个 provider 的选择器在给定应用版本下的模型预设列表。
 *  `providers` 可注入，让版本过滤能对有界条目做验证——发版目录刻意全部
 *  无界。 */
export function modelsForProviderAtVersion(
  provider: AgentProvider,
  appVersion: string,
  providers: Record<string, CatalogModel[]> = CATALOG.providers
): ModelOption[] {
  // 未知 provider 回退到 Claude 列表，与硬编码分派过去的行为一致。
  // 'custom' 是持有空列表的真实键，不是缺失键。
  const entries = providers[provider] ?? providers.claude ?? [];
  return entries
    .filter((model) => offeredAtVersion(model, appVersion))
    .map((model) => (model.id === undefined ? { label: model.label } : { id: model.id, label: model.label }));
}

// tokenizeCommand 移到 src/shared/commandLine.ts，让 main 的 spawn-request
// 路径用与渲染端 spawn 流程相同的规则切分命令行（过去它们是逐字节相同的
// 副本）。在这里重新导出，让既有导入方保持路径。
export { tokenizeCommand } from '@shared/commandLine';

/** 某个 provider 的选择器在本构建上的模型预设列表。 */
export function modelsForProvider(provider: AgentProvider): ModelOption[] {
  return modelsForProviderAtVersion(provider, runningAppVersion());
}

/** Claude 预设，供只提供 Claude 模型的界面使用。 */
export const AGENT_MODELS: ModelOption[] = modelsForProvider('claude');

/** 指挥中心跨 provider 模型选择器里显示的 provider。
 *  God 必须留在 inbox 排空可用的 provider 上；否则切到纯终端 provider 会
 *  静默禁用编排。 */
export function modelProvidersForAgent(isGod = false) {
  return AGENT_PROVIDER_PRESETS.filter((preset) =>
    preset.supportsModel && (!isGod || preset.canReceiveInbox || preset.id === 'kimi')
  );
}

/** 原生 <select> 的值必须同时携带 provider 和 model，因为每个 provider 有
 *  自己的 "default" 选项和模型命名空间。 */
export function encodeProviderModel(provider: AgentProvider, model?: string): string {
  return `${provider}:${encodeURIComponent(model ?? '')}`;
}

export function decodeProviderModel(value: string): {
  provider: AgentProvider;
  model?: string;
} | null {
  const split = value.indexOf(':');
  if (split < 1) return null;
  const provider = value.slice(0, split);
  if (!AGENT_PROVIDER_PRESETS.some((preset) => preset.id === provider)) return null;
  try {
    const model = decodeURIComponent(value.slice(split + 1));
    return { provider: provider as AgentProvider, model: model || undefined };
  } catch {
    return null;
  }
}

/** 构建要喂给 spawnPty 的命令行，遵循 provider 的标志、autoMode，以及可选
 *  的按 agent 模型覆盖。Claude 保留用户配置的 `defaultCommand`；其他
 *  provider 使用其预设二进制，让应用在没有安装 Claude 时也能工作。 */
export function buildSpawnCommand(
  config: Pick<HarnessConfig, 'defaultCommand' | 'autoMode'>,
  model?: string,
  provider: AgentProvider = inferAgentProvider(config.defaultCommand)
): string {
  const preset = providerPreset(provider);
  // Claude 保留用户配置的 defaultCommand；custom 也回退到它；
  // 其他每个 provider（codex, grok, kimi, agy）用其预设二进制，让应用
  // 在未安装 Claude 时也能工作。
  const base =
    provider === 'claude'
      ? config.defaultCommand || preset.defaultCommand
      : provider === 'custom'
        ? config.defaultCommand || ''
        : preset.defaultCommand;
  let cmd = base;
  if (preset.supportsModel && model && preset.modelFlag) {
    // 引用含空格的模型值（agy 标签如 "Gemini 3.1 Pro (High)"），让命令
    // 分词器把它们保持为一个参数。
    const m = /\s/.test(model) ? `"${model}"` : model;
    cmd = `${cmd} ${preset.modelFlag} ${m}`;
  }
  // Auto（跳过权限）模式追加每个 provider 自己的标志——Claude 的
  // bypassPermissions、Codex 的 dangerous bypass、Grok 的 always-approve、
  // Kimi 的 auto、或 agy 的 skip 标志。
  if (config.autoMode && preset.autoFlag) cmd = `${cmd} ${preset.autoFlag}`;
  return cmd;
}
