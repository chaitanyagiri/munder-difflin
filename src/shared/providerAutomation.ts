import type { AgentProvider } from './agentProvider';
import { DEFAULT_COMPACTION_FOCUS } from './triggers';

/**
 * 向后兼容别名。压缩焦点（compaction focus）曾是这里的私有常量；
 * 现在它作为用户可编辑的 `ContextRule.message` 的默认值位于 shared/triggers.ts，
 * 因此 Triggers UI 与本模块不会分叉。
 * 为仍在引用它的消费者保留旧名称导出。
 */
export const COMPACTION_FOCUS = DEFAULT_COMPACTION_FOCUS;

/** 某个 provider 的交互式 TUI 为每个上下文动作接受什么。 */
export interface ProviderContextCommands {
  /** 就地摘要（summarise-in-place）。`null` = 没有我们敢敲入的命令。 */
  compact: string | null;
  /** 丢弃并重启。`null` = 同理。 */
  clear: string | null;
  /**
   * TUI 是否把 compact 命令之后的文本解析为焦点指令。
   * 为 false 时焦点被丢弃（DROPPED）而非敲入：斜杠解析器忽略余下部分的
   * CLI 是无害的，但若它把余下内容当作新的 prompt 重新读取，就会静默地把
   * 一次压缩变成整整额外一轮对话。
   */
  compactTakesFocus: boolean;
}

const NO_CONTEXT_COMMANDS: ProviderContextCommands = {
  compact: null,
  clear: null,
  compactTakesFocus: false
};

/**
 * 每个 provider 的上下文命令表（唯一的权威）。
 *
 * 刻意做成总表 `Record<AgentProvider, …>` 而非带 `default:` 分支的 switch——
 * 之前的 switch 在十一个 provider 中悄悄为七个返回 `null`，导致自动压缩对
 * 大部分 fleet 静默无效而无人察觉。总表会让编译器阻止下一个添加 provider
 * 的人，直到他真的查过它的命令。
 *
 * `null` 表示"我们无法确立一条信任的命令"，而非"我们没查过"。
 * 在活跃终端敲错斜杠命令比没有命令更糟：最好情况是模型回答的无效文本，
 * 最坏会触发别的动词。下面每条都注明了在哪里验证——多数通过阅读每个 CLI
 * 的随附二进制（其内嵌命令表/文档），它不可能落后于已装版本，因此优先级
 * 高于网络文档。
 */
const CONTEXT_COMMANDS: Record<AgentProvider, ProviderContextCommands> = {
  // claudeCommands.ts:34,37（本仓库自带的目录）：`/compact` 接受一个焦点
  // （"usage: /compact keep the auth decisions"），`/clear` 开启一段全新
  // 对话并回收窗口。
  claude: { compact: '/compact', clear: '/clear', compactTakesFocus: true },

  // Codex 0.137.0 二进制、TUI 斜杠命令描述表：
  //   "summarize conversation to prevent hitting the context limit"  → /compact
  //   "clear the terminal and start a new chat"                      → /clear
  // 注意这与 codexCommands.ts 矛盾，后者列出了 /clear 但没有 /compact。
  // 二进制是对的，那个目录不全（见报告）。
  // compactTakesFocus 保持 FALSE：codex 自己的 `Usage: /…` 字符串为每个带
  // 参数的命令都拼出了一个参数（/goal、/raw、/mcp、/keymap、/ide、
  // /sandbox-add-read-dir），而 /compact 没有。
  codex: { compact: '/compact', clear: '/clear', compactTakesFocus: false },

  // Moonshot kimi-cli 斜杠命令参考：`/compact` 接受追加的
  // 自定义指令（"/compact preserve database-related discussions"）；
  // `/clear`（别名 /reset）"Clear the current session's context and start a
  // new conversation"。注意那里的 `/new` 是派生一个会话而非丢弃。
  kimi: { compact: '/compact', clear: '/clear', compactTakesFocus: true },

  // qwen-code 自带的 cli.js，逐字引用：
  //   compressCommand = { name:"compress", altNames:["summarize"],
  //     description "Compresses the context by replacing it with a summary." }
  //   其 action 把 `context.invocation?.args` 读作 `customInstructions`
  //   （上限 2000 字符）→ 它确实接受一个焦点。
  //   clearCommand    = { name:"clear", altNames:["reset","new"],
  //     description "Clear conversation history and free up context." }
  // 它是 `/compress`，而不是 `/compact`：qwen 丢弃了上游 gemini-cli 的
  // `compact` 别名，因此 `/compact` 在这里只会落成纯文本。
  qwen: { compact: '/compress', clear: '/clear', compactTakesFocus: true },


  // 任意用户二进制。我们无法知道它的命令表面，猜测意味着
  // 往某个未知的 REPL 里敲斜杠。
  custom: NO_CONTEXT_COMMANDS
};

/** 某 provider 的完整上下文命令条目（未知 id 降级为 none）。 */
export function contextCommandsForProvider(provider: AgentProvider): ProviderContextCommands {
  return CONTEXT_COMMANDS[provider] ?? NO_CONTEXT_COMMANDS;
}

/**
 * 要敲入的压缩命令；当该 provider 没有时返回 null。
 *
 * `message` 是用户可编辑的 `ContextRule.message`（默认
 * `DEFAULT_COMPACTION_FOCUS`），并且只在该 provider 的解析器真正读取它的
 * 地方追加——参见 `compactTakesFocus`。
 */
export function compactionCommandForProvider(
  provider: AgentProvider,
  message: string = DEFAULT_COMPACTION_FOCUS
): string | null {
  const { compact, compactTakesFocus } = contextCommandsForProvider(provider);
  if (!compact) return null;
  const focus = message.trim();
  return compactTakesFocus && focus ? `${compact} ${focus}` : compact;
}

/** 本 harness 跨所有 provider 能敲出的每个不同压缩动词。
 *  从 CONTEXT_COMMANDS 派生而非手工列出，因此添加进那张表的 provider
 *  在这里自动被覆盖，无需任何可能被忘记的第二次编辑。 */
const COMPACT_VERBS: ReadonlySet<string> = new Set(
  Object.values(CONTEXT_COMMANDS)
    .map((c) => c.compact)
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
);

/**
 * 这段排队文本是不是压缩命令？
 *
 * 只匹配前导动词（VERB），因此 `/compact keep the auth decisions` 算数，
 * 而只是提及压缩的人类句子不算——队列里两者都有，把散文误认为命令会
 * 静默丢弃真实工作。
 *
 * 刻意与 provider 无关：队列按 agent 而不是 provider 键控，无论将由哪个
 * CLI 接收，重复的 `/compact` 都值得丢弃。
 */
export function isCompactionCommand(text: string): boolean {
  return COMPACT_VERBS.has(text.trim().split(/\s+/)[0]);
}

/**
 * 要敲入的清空上下文命令；当没有任何可敲入内容能触达该 provider 时为 null。
 *
 * 按照 `ContextRule.message`，CLEAR 规则上的非空消息是"要发送的字面命令"——
 * 是一个覆盖，而不是后缀。与 compact 的这种不对称是刻意且有意的：它是操作者
 * 针对本表对某些 provider 回答 `null`、以及针对在版本间给动词改名的 CLI 的
 * 逃生舱。空消息 = 该表自身的裸命令。
 */
export function clearCommandForProvider(
  provider: AgentProvider,
  message: string = ''
): string | null {
  const override = message.trim();
  if (override) return override;
  return contextCommandsForProvider(provider).clear;
}

/** Claude 把远程控制暴露为斜杠命令；Codex 使用其守护进程，而
 * Kimi 没有等价的斜杠命令。 */
export function remoteControlCommandForProvider(
  provider: AgentProvider,
  sessionName?: string
): string | null {
  if (provider !== 'claude') return null;
  const name = sessionName?.trim();
  return name ? `/remote-control ${name}` : '/remote-control';
}

/** 初始 TUI 输出在敲入前需要一段短暂、provider 专属的稳定时间。 */
export function terminalReadySettleMs(provider: AgentProvider): number {
  switch (provider) {
    case 'kimi': return 650;
    case 'codex': return 500;
    default: return 400;
  }
}

/**
 * 一个存活的 TUI 在产生初始帧并经过短暂稳定期后即为就绪。
 * 不要要求输出变安静：Codex 会不断重绘其状态行，这曾让排队的消息一直被
 * 阻塞，直到每次就绪尝试都超时。
 *
 * 接受 `undefined` 以兼容一个热重载的 renderer 对应尚未暴露 `hasOutput`
 * 的旧版 main 进程。
 */
export function terminalReadyToReceive(
  hasOutput: boolean | undefined,
  elapsedMs: number,
  provider: AgentProvider
): boolean {
  return hasOutput !== false && elapsedMs >= terminalReadySettleMs(provider);
}
