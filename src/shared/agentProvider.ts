/**
 * Agent providers——worker 运行所用的 CLI。应用不再只支持 Claude：
 * worker 可以运行 Claude Code、OpenAI Codex CLI（`codex`）、Kimi Code
 * （`kimi`）、Qwen Code（`qwen`）或任意自定义命令。
 * 每个 provider 声明如何构建其 spawn 命令（model/auto-mode 标志），以及
 * 是否接受 hive 专属的 Claude 身份注入
 * （`--append-system-prompt` + `--settings`）。
 *
 * 主进程与渲染进程共享；保持零依赖（无 electron、无 UI）。
 * 与上游 provider-preset 工作的形态对齐（PR #47 / issue #21），
 * 以便与上游 provider-preset 工作干净调和。
 */
import type { CmdGroup } from './claudeCommands';
import { COMMAND_GROUPS as CLAUDE_COMMAND_GROUPS } from './claudeCommands';
import { CODEX_COMMAND_GROUPS } from './codexCommands';

// NOTE: 'claw' (claw-code) 已从可选 provider 中移除——其上游是一个无人维护的
// "博物馆展品" 仓库，而非生产级 CLI。审核通过后在此重新添加受支持的
// fork（连同其 preset/models/logo）。它与 qwen 共享的 proxy-bridge 层级
// 保留给 qwen 使用。
export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'kimi'
  | 'qwen'
  | 'custom';

/** 描述 NON-hiveAware provider 如何获取 hive 生命周期事件（在线状态 +
 *  Stop→收件箱排空 + 成本）的结构化描述符，与遗留的 `hookBridge` 一并引入，
 *  这样调用点无需大爆炸式重写即可根据 `bridge.kind` 分支。两种类型：
 *   - 'hooks'  → 安装配置文件形式的 hook shim（agy/codex）。由 `bridgeOf`
 *               从遗留 `hookBridge` 派生，因此 agy/codex 无需改动预设即可继续工作。
 *   - 'proxy'  → CLI 没有任何 hook 表面（qwen），因此回环反向代理
 *               侧车观察其 LLM 流量并合成 shim 发出的相同 HIVE_SOCK
 *               负载。`api` 选择用量/工具调用形态（OpenAI vs Anthropic），
 *               `baseUrlEnv` 是 CLI 读取其上游 base URL 的环境变量
 *               （侧车的回环 URL 注入于此），`inboxDelivery` 是邮件到达方式
 *               （目前为 'terminal' 工单交接；'serve' 预留给未来的 HTTP 推送路径）。 */
export type BridgeDescriptor =
  | { kind: 'hooks'; shim: 'codex' }
  | {
      kind: 'proxy';
      api: 'openai' | 'anthropic';
      baseUrlEnv: string;
      inboxDelivery: 'terminal' | 'serve';
    };

export interface AgentProviderPreset {
  id: AgentProvider;
  label: string;
  /** 用户未输入自定义命令时生成的二进制。 */
  defaultCommand: string;
  /** 该 provider 的 Slash / CLI 命令参考。 */
  commandGroups: CmdGroup[];
  /** 为抑制非交互 / 首次运行提示而设置的环境变量。 */
  nonInteractiveEnv?: Record<string, string>;
  /** 自动模式启用时追加到命令串的标志。
   *  与 `autoFlag`（同值）并存，供通过 `autoModeFlagForProvider`
   *  读取 `autoModeFlag` 的 HEAD 消费方使用。 */
  autoModeFlag: string;
  /** 显示模型选择器并把模型拼接到命令中。 */
  supportsModel: boolean;
  /** 选择会话模型的标志，例如 `--model`。 */
  modelFlag?: string;
  /** 底层处于 auto（跳过权限）模式时追加的标志。
   *  PR #54 的消费方读取此值；与 `autoModeFlag` 镜像。 */
  autoFlag?: string;
  /** Claude Code 接受 hive 身份注入（`--append-system-prompt`
   *  + hook `--settings`）。其他 CLI 不支持——它们只用共享的 AGENT_*
   *  环境变量生成。在 hive.ensureAgent 中门控 Claude 专属的 spawn 注入。
   *  NOTE：这里专门门控 *Claude-only* 标志路径——它并不等同于
   *  "参与 hive"。非 hiveAware provider 仍可通过 `hookBridge`
   *  成为完整的 hive 成员（在线状态 + 受保护的闲置投递）。 */
  hiveAware: boolean;
  /** NON-hiveAware provider 用哪个配置文件生命周期 hook 桥来获得
   *  Claude 从 `--settings` 获得的那种在线状态：
   *    - 'codex' → installCodexHooks() 写入每 agent 的 CODEX_HOME 配置，
   *                并原样复用 Claude 的 `cth-hook` shim（Codex 的 hook 负载
   *                + 响应契约已经是 Claude 形态）。
   *  Claude 将此项留空（它走原生 `--settings` 路径，由 hiveAware 门控）；
   *  `custom` 也留空（无桥 → 无 hooks）。这是 hive.ensureAgent
   *  分发接线 bridge 的唯一开关。 */
  hookBridge?: 'codex';
  /** 结构化 bridge 描述符（遗留 `hookBridge` 的前瞻性替代）。仅为没有
   *  hook 文件可装的 PROXY 层级 provider（qwen）显式设置；agy/codex 留空，
   *  由 `bridgeOf` 从它们的 `hookBridge` 派生 `{kind:'hooks'}`。claude/custom
   *  留空（无桥）。优先使用 `bridgeOf(provider)`，而非直接读取此字段。 */
  bridge?: BridgeDescriptor;
  /** 该 provider 为 GOD 编排器（"Michael"）供电时默认使用的模型——
   *  作为选择器默认值以及建议 "give Michael a longer-context, higher-capability model"
   *  呈现。`modelForRole` 把 GOD 模型解析为
   *  `config.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD`。
   *  仅建议性，用户可覆盖。 */
  recommendedOrchestratorModel?: string;
  /** 路由是否可以把收件箱邮件 DELIVER 给此 provider（而不是弹回给 god）。
   *  需要生命周期状态，渲染器才能仅在安全的闲置提示点投递：Claude 原生支持，
   *  Antigravity/Codex/Grok 经由 hook 桥。无 hook 的 custom provider 无法暴露
   *  安全闲置状态，因此邮件会弹回。与 hiveAware 不同：
   *  agy/codex/grok 不是 hiveAware（无 Claude 注入），但可以通过它们的
   *  bridge 接收收件箱。 */
  canReceiveInbox: boolean;
  /** 对仍接受 INITIAL prompt 来定向会话的非 hive-aware CLI
   *  （Antigravity 的 `agy -i "<prompt>"`），传入 prompt 所用的标志。
   *  hive 身份+协议作为第一轮输入进入——这是这些 CLI 提供的
   *  最接近 Claude `--append-system-prompt` 的机制。undefined = CLI
   *  以位置参数接收初始 prompt（Codex：`codex "<prompt>"`），
   *  注入分支把它作为带引号的尾部参数追加，而不是用标志。 */
  initialPromptFlag?: string;
  /** 对既不接受标志也不接受位置种子的 CLI，hive 协议种子如何交付。
   *  `'type-into-tui'` = CLI 是裸交互式 TUI，拒绝位置初始 prompt
   *  （Crush：其第一个位置参数被当作 Cobra SUBCOMMAND 解析 →
   *  `Unknown command "You are…"`），因此 harness 绝不能把协议追加到
   *  argv——它生成裸 TUI，并把协议作为 `seedPrompt` 交回，由渲染器在
   *  启动后输入到 TUI 的编辑器（与收件箱唤醒提示共用同一条 per-pty
   *  写链路，因此不会冲突）。缺省/undefined = 现行的标志或位置参数
   *  行为。（ondev-b） */
  seedDelivery?: 'type-into-tui';
  /** 该 CLI 接受把初始 hive prompt 作为尾部位置参数。
   *  Codex 支持；Kimi/custom 不支持，因此没有 prompt 标志时
   *  它们必须裸生成，而不是收到一个无效的位置参数。 */
  positionalInitialPrompt?: boolean;
  /** 重新生成时恢复先前会话所用的标志，给定已记录的会话 id
   *  （Claude `--resume <sid>`、Antigravity `--conversation <id>`）。undefined =
   *  不支持恢复，全新生成。 */
  resumeFlag?: string;
  /** 该 provider 的引擎 CLI 缺失时用于安装它的 shell 命令，
   *  例如 `npm install -g @anthropic-ai/claude-code`。设置后，缺失 CLI 的
   *  路径可在 agent 终端中可见地运行它（在生成前检测之后）；
   *  undefined 时只向用户显示手动说明，不自动运行任何内容。
   *  必须是可信的、硬编码的常量——绝不接受用户/清单输入。 */
  installCommand?: string;
  /** 完全自包含的安装器，按平台提供，完全不需要 Node/npm。
   *
   *  每个 provider 的 `installCommand` 都是 `npm install -g …`，这默许
   *  机器上已有 npm——即 node。没有时，缺失 CLI 的横幅会打印一条
   *  注定失败的命令，用户看到的是安装器失败而不是应用可用。厂商自带
   *  原生安装器时我们改跑它（见 buildMissingCliScript 的阶梯）。
   *
   *  可信的、硬编码的常量——绝不接受用户/清单输入。绝不能包含双引号：
   *  Windows 形态会被原样包裹在 `cmd /d /s /c "…"` 中。 */
  nativeInstallCommand?: { posix: string; win32: string };
  /** 可选的文档 URL，作为手动设置提示显示在缺失 CLI 的横幅中。 */
  docsUrl?: string;
  /** 被视为显式权限姿态的额外 argv 词元（因此不再追加 auto 标志）。
   *  默认为 auto 标志自身的首词元。 */
  autoStanceTokens?: string[];
  resumeSubcommand?: string; // 通过子命令而不是标志来恢复会话的 CLI（Codex：`codex resume [OPTIONS] [SESSION_ID]`）
}

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    commandGroups: CLAUDE_COMMAND_GROUPS,
    autoModeFlag: '--permission-mode bypassPermissions',
    supportsModel: true,
    modelFlag: '--model',
    autoFlag: '--permission-mode bypassPermissions',
    hiveAware: true,
    canReceiveInbox: true,
    // 上下文最长的 Claude 变体——匹配 "give Michael a bigger model"
    // 建议和编排器选择器上的 "Recommended" 标签。
    recommendedOrchestratorModel: 'claude-opus-4-8[1m]',
    resumeFlag: '--resume',
    // Claude Code 官方安装方式（npm 全局）。用于缺失 CLI 的自动安装。
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    // Anthropic 官方原生安装器——独立二进制，不需要 node/npm。
    // 是在完全没有 Node 的机器上唯一可用的阶梯档位。
    nativeInstallCommand: {
      posix: 'curl -fsSL https://claude.ai/install.sh | bash',
      win32: 'powershell -c irm https://claude.ai/install.ps1 ^| iex'
    },
    docsUrl: 'https://docs.claude.com/en/docs/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex · GPT',
    defaultCommand: 'codex',
    commandGroups: CODEX_COMMAND_GROUPS,
    // 自动模式：从不提示（-a never），但保留 codex 的 OS 沙箱。应用过去
    // 仅因一个原因用 `--dangerously-bypass-approvals-and-sandbox` 生成：
    // hive worker 必须写入其位于 <harnessHome>/hive/agents/<id>/ 的
    // agent 文件夹，这是一条与 cwd 不同的路径树，被 workspace-write
    // 沙箱阻止。那是路径布局问题，不是放弃沙箱的理由：codex 文档化的
    // `--add-dir <DIR>` 让额外目录与工作区一同可写，hive 的生成路径
    // （hive.ts，知道 agent 目录）会追加它。
    // NOTE（codex 0.151，Windows）：`-s workspace-write` 会在启动时
    // 拒绝 `--add-dir`（"effective permissions do not allow additional
    // writable roots"）并退出 1——agent PTY 在生成后几秒就死掉。
    // `danger-full-access` 接受 `--add-dir` 并保留命令执行沙箱。
    // 结论：关闭审批，开启沙箱（full-access），hive 的后勤工作仍然有效。
    autoModeFlag: '-a never -s danger-full-access',
    autoFlag: '-a never -s danger-full-access',
    // 命令行上出现其中任何一个都意味着用户已选择了姿态
    // （包括旧的完全绕过）——不要叠加我们的标志。
    autoStanceTokens: ['-a', '--ask-for-approval', '-s', '--sandbox', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'],
    // 抑制首次运行的交互式提示（目录信任门槛、安装器）。
    nonInteractiveEnv: { CODEX_NON_INTERACTIVE: '1' },
    supportsModel: true,
    modelFlag: '--model',
    // 在 Claude 标志意义上，Codex 不是 hiveAware：它没有
    // `--append-system-prompt`/`--settings`。hive 协议作为
    // Codex 的 INITIAL prompt 注入，它以位置参数接收（`codex "<prompt>"`）——
    // 因此 initialPromptFlag 为 undefined，hive.ts 把它作为尾部参数追加。
    hiveAware: false,
    // ……但 Codex 确实暴露了 Claude 风格的 hooks 系统（hooks.json / config.toml
    // [hooks]；PreToolUse/PostToolUse/Stop/……），因此经由 'codex' 桥获得完整的
    // hive 对等地位：每 agent 的 CODEX_HOME/hooks.json 接入 cth-hook shim
    // （见 hive.installCodexHooks）。Stop→排空原生可用（Codex 的 Stop 遵守
    // {decision:'block',reason} = continue-with-prompt，与 Claude 完全相同）。
    hookBridge: 'codex',
    // 收件箱经由 codex-hook 桥的 Stop→排空清空（渲染器的闲置收件箱唤醒
    // 提示仍是闲置 worker 的无害回退）。
    canReceiveInbox: true,
    initialPromptFlag: undefined,
    positionalInitialPrompt: true,
    // Codex 用于编排器角色的长上下文编码模型。 // TODO-verify
    // 确切的 codex CLI 模型 id（因无法安装 codex CLI 未能确认）。
    recommendedOrchestratorModel: 'gpt-5-codex',
    // Codex 通过 SUBCOMMAND 而非标志恢复会话：`codex resume [OPTIONS]
    // [SESSION_ID]`。不存在 `--resume <id>` 标志，这正是重启过去会
    // 静默开启全新会话而不是继续的原因。
    resumeFlag: undefined,
    resumeSubcommand: 'resume',
    // OpenAI Codex CLI 官方安装方式（npm 全局）。用于缺失 CLI 的自动安装。
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex'
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    defaultCommand: 'kimi',
    commandGroups: [],
    // Kimi --auto 处理所有审批且不会停下来提问，
    // 与 Munder Difflin 的自主 Claude/Codex 默认行为一致。
    autoModeFlag: '--auto',
    autoFlag: '--auto',
    supportsModel: true,
    modelFlag: '--model',
    hiveAware: false,
    // Kimi 的交互式 TUI 没有位置形式的初始 prompt。它支持生命周期 hooks，
    // 但 Munder Difflin 尚未安装 Kimi hook 桥，因此邮件必须弹回，
    // 而不是在没有任何排空路径的情况下投递。
    canReceiveInbox: false,
    // Kimi 是裸交互式 TUI，既不接受位置初始 prompt 也不接受 prompt 标志
    // （与 Crush 相同），因此协议以 seedPrompt 交回，由渲染器在启动后键入
    // TUI 编辑器。没有它，kimi 会裸 spawn，god/kimi 智能体收不到 hive 协议。
    seedDelivery: 'type-into-tui'
  },
  {
    // qwen-code——Qwen CLI（gemini-cli 的分支），驱动任何 OpenAI 兼容
    // 端点（OPENAI_BASE_URL）。它没有 hook 表面，因此走 PROXY
    // 桥（bridge.kind==='proxy'），采用 OpenAI 用量/工具调用形态。
    id: 'qwen',
    label: 'Qwen (local available)',
    defaultCommand: 'qwen',
    commandGroups: [],
    // gemini-cli 传承：--yolo 自动批准所有操作。 // TODO-verify
    autoModeFlag: '--yolo',
    supportsModel: true,
    modelFlag: '--model',
    autoFlag: '--yolo',
    hiveAware: false,
    // SPIKE/TODO-verify：确认 qwen-code 读取 OPENAI_BASE_URL 作为其上游
    // （'serve' inboxDelivery 预留给以后的 qwen-serve HTTP 推送路径）。
    bridge: { kind: 'proxy', api: 'openai', baseUrlEnv: 'OPENAI_BASE_URL', inboxDelivery: 'terminal' },
    canReceiveInbox: true,
    // gemini-cli 风格的交互式定向标志。 // TODO-verify
    initialPromptFlag: '-i',
    // Qwen 用于编排器的长上下文编码模型。 // TODO-verify
    recommendedOrchestratorModel: 'qwen3-coder-plus',
    resumeFlag: undefined
  },
  {
    id: 'custom',
    label: 'Custom',
    defaultCommand: '',
    commandGroups: [],
    autoModeFlag: '',
    supportsModel: false,
    autoFlag: '',
    hiveAware: false,
    canReceiveInbox: false // 没有收件箱排空路径 → 邮件弹回给 god
  }
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'kimi' ||
    value === 'qwen' ||
    value === 'custom'
  );
}

export function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  return isAgentProvider(value) ? value : undefined;
}

export function providerPreset(provider: AgentProvider): AgentProviderPreset {
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider) ?? AGENT_PROVIDER_PRESETS[0];
}

export function isClaudeProvider(provider: AgentProvider | undefined): boolean {
  return provider === 'claude';
}

/** 该 provider 是否接受 hive 专属的 Claude 身份注入。 */
export function isHiveAwareProvider(provider: AgentProvider | undefined): boolean {
  return providerPreset(provider ?? 'claude').hiveAware;
}

/** 路由是否可以向该 provider 投递收件箱邮件（否则弹回给 god）。
 * 生命周期状态支持受保护的闲置投递时为 true；无 hook 的自定义
 * 命令时为 false。 */
export function canReceiveInbox(provider: AgentProvider | undefined): boolean {
  return providerPreset(provider ?? 'claude').canReceiveInbox;
}

/** 命令串中的裸可执行文件（'agy --model x' → 'agy'）。 */
function commandBinary(command: string | undefined): string {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? '';
  // 去掉路径和扩展名，让 'C:\...\agy.exe' 与 '/usr/bin/claude' 都能映射
  const leaf = first.split(/[\\/]/).pop() ?? first;
  return leaf.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** 从命令推断 provider（或遵从显式覆盖）。 */
export function inferAgentProvider(command: string | undefined, explicit?: unknown): AgentProvider {
  const normalized = normalizeAgentProvider(explicit);
  if (normalized) return normalized;
  const bin = commandBinary(command);
  if (bin === 'codex') return 'codex';
  if (bin === 'kimi') return 'kimi';
  if (bin === 'qwen') return 'qwen';
  if (bin === 'claude' || !bin) return 'claude';
  return 'custom';
}

/** 描述非 hiveAware provider 如何接收 hive 生命周期事件的结构化
 *  bridge 描述符。设置时返回预设的显式 `bridge`（proxy 层级：qwen）；
 *  否则从遗留 `hookBridge` 派生 `{kind:'hooks', shim}`（agy/codex），
 *  让它们无需改动即可继续工作；否则 undefined（claude 用原生
 *  `--settings` 路径，custom 无桥）。调用点唯一访问器
 *  根据 `bridge.kind` 分支。 */
export function bridgeOf(provider: AgentProvider | undefined): BridgeDescriptor | undefined {
  const preset = providerPreset(provider ?? 'claude');
  if (preset.bridge) return preset.bridge;
  if (preset.hookBridge) return { kind: 'hooks', shim: preset.hookBridge };
  return undefined;
}

export function defaultCommandForProvider(provider: AgentProvider, fallback = ''): string {
  if (provider === 'custom') return fallback;
  return providerPreset(provider).defaultCommand || fallback;
}

/** 返回给定 provider 预设的 auto-mode CLI 标志。空串 = 无标志。 */
export function autoModeFlagForProvider(provider: AgentProvider): string {
  return providerPreset(provider).autoModeFlag ?? '';
}

/** 幂等地把 provider 的 auto-mode 标志追加到 args 数组，尊重用户的
 * 全局 autoMode 开关。渲染器的 Add Agent 流程在 GUI hire 到达共享 spawn
 * 核心（buildSpawnCommand → tokenizeCommand）之前就把同一标志烘焙进
 * 命令 STRING，因此 GUI spawn 的 `args` 到达此处时已包含它——对那条
 * 路径这是空操作。仅主进程的 spawn（临时 worker、语音 hire）不会经过
 * 那个渲染器步骤，因此没有这个函数它既得不到标志也得不到任何等价物，
 * 只能停留在无人能回答的 ask-first 姿态。 */
export function argsWithAutoModeFlag(args: string[], autoMode: boolean, provider: AgentProvider): string[] {
  if (!autoMode) return args;
  const flag = autoModeFlagForProvider(provider);
  if (!flag) return args;
  if (hasAutoModeStance(args, provider)) return args;
  return [...args, ...flag.trim().split(/\s+/)];
}

/** 当 argv 已为该 provider 声明权限姿态时为 true：auto 标志的首词元，
 *  或预设 `autoStanceTokens` 中的任意一个。词元匹配而非子串——
 *  `-s` 开头的标志按词元匹配。 */
export function hasAutoModeStance(args: string[], provider: AgentProvider): boolean {
  const preset = providerPreset(provider);
  const flag = preset.autoModeFlag ?? '';
  const lead = flag.trim().split(/\s+/)[0];
  const stance = new Set([...(lead ? [lead] : []), ...(preset.autoStanceTokens ?? [])]);
  return args.some((a) => stance.has(a));
}

/** 返回 provider 用于非交互 / 首次运行抑制所需的任何环境变量。 */
export function nonInteractiveEnvForProvider(provider: AgentProvider): Record<string, string> {
  return providerPreset(provider).nonInteractiveEnv ?? {};
}

/** 返回给定 provider 的命令参考组。 */
export function commandGroupsForProvider(provider: AgentProvider): CmdGroup[] {
  return providerPreset(provider).commandGroups ?? [];
}

/** provider 引擎 CLI 的安装元数据，由缺失 CLI 的自动安装路径消费。
 *  `command` 是存在时要运行的（可信、硬编码）安装器；undefined 时
 *  调用方只显示手动提示且不运行任何内容。`label` 是友好的 CLI 名称；
 *  `docsUrl` 是可选手动设置链接。 */
export interface ProviderInstallInfo {
  command?: string;
  /** 平台对应的无 Node 安装器，当厂商提供时。 */
  nativeCommand?: string;
  label: string;
  docsUrl?: string;
}

export function installInfoForProvider(
  provider: AgentProvider,
  platform: string = process.platform
): ProviderInstallInfo {
  const p = providerPreset(provider);
  const native = p.nativeInstallCommand;
  return {
    command: p.installCommand,
    nativeCommand: native ? (platform === 'win32' ? native.win32 : native.posix) : undefined,
    label: p.label,
    docsUrl: p.docsUrl
  };
}
