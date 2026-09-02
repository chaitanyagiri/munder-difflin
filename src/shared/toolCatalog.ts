/**
 * 安装目录——harness 能使用的每一个 EXTERNAL（外部）工具、它能给用户
 * 带来什么、以及如何在本平台安装。
 *
 * 本文件为何存在：应用作为一个 Electron 包分发，但它的几个最佳特性
 * 只是对包外工具的薄封装——mempalace 提供语义记忆、uv 安装 mempalace、
 * git 提供工作树、每个代理引擎各有一个 CLI。其中任何一个缺失时都会
 * 静默降级（这是刻意设计——没有 mempalace 时 `memory.start()` 是文档化的
 * 空操作），这在用户能区分“关闭”和“损坏”之前都是友好的，
 * 但之后用户就没有单一地方能说明哪个是哪个。本目录就是那个地方。
 *
 * 引擎行是从 AGENT_PROVIDER_PRESETS 派生而来，而不是在这里重述：
 * 那些预设已经携带 `defaultCommand`、`installCommand`、
 * `nativeInstallCommand` 和 `docsUrl`，再来一份手工维护的副本
 * 会在添加提供方的那一刻开始漂移。
 *
 */

import { AGENT_PROVIDER_PRESETS } from './agentProvider';

export type ToolKind = 'prerequisite' | 'memory' | 'engine';

export interface ToolSpec {
  /** 稳定的行 id。对于被探测的二进制，这也是我们要查找的名称。 */
  id: string;
  /** 要在 PATH 上探测的可执行文件；当存在性以其他方式得出时为 null
   *  （mempalace 来自记忆子系统自身的状态）。 */
  bin: string | null;
  label: string;
  kind: ToolKind;
  /** 一行、以收益角度表述：没有它用户会失去什么。 */
  why: string;
  /** 属于“一键设置全部”。其余都是可选的。 */
  essential: boolean;
  /** 按平台的安装命令。空字符串 = 无脚本化安装。 */
  install: { posix: string; win32: string };
  /** 没有脚本化安装时显示，或作为额外上下文。 */
  note?: string;
  docsUrl?: string;
}

/** 基础行——非引擎工具。引擎由 `toolCatalog()` 追加。 */
const BASE_TOOLS: ToolSpec[] = [
  {
    id: 'uv',
    bin: 'uv',
    label: 'uv',
    kind: 'prerequisite',
    why: 'Installs and runs mempalace. A self-contained Python toolchain — it does not touch any Python you already have.',
    essential: true,
    install: {
      posix: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      // 是 PowerShell 而非 cmd.exe：astral 为 Windows 提供 install.ps1，
      // 没有对应的 .bat。加引号以便粘贴到两者中任一个都能生效。
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    },
    docsUrl: 'https://docs.astral.sh/uv/'
  },
  {
    id: 'mempalace',
    bin: null, // 存在性来自 MemoryStatus.available，而非 PATH 探测
    label: 'MemPalace — semantic memory',
    kind: 'memory',
    why: 'Meaning-based recall across everything your agents have learned. Without it they still keep plain markdown notes, but cannot search them by meaning.',
    essential: true,
    install: {
      posix: 'uv tool install mempalace',
      win32: 'uv tool install mempalace'
    },
    note: 'Needs uv first.'
  },
  {
    id: 'git',
    bin: 'git',
    label: 'git',
    kind: 'prerequisite',
    why: "Worktrees let agents work in parallel without fighting over one checkout, and the hive keeps its own history in git.",
    essential: true,
    install: {
      posix: 'xcode-select --install   # macOS · or: sudo apt install git',
      win32: 'winget install --id Git.Git -e'
    },
    docsUrl: 'https://git-scm.com/downloads'
  },
  {
    id: 'node',
    bin: 'node',
    label: 'Node.js',
    kind: 'prerequisite',
    why: 'Runs the npm-installed agent engines (OpenCode, and Claude Code on machines without the native build).',
    essential: false,
    // 刻意不提供脚本化命令：应用已内置一个经校验和验证的
    // Node 安装器（nodeInstall.ts），当某个引擎需要时会自动运行。
    // 在这里打印一个竞品的 curl|sh 会与它竞争。
    install: { posix: '', win32: '' },
    note: 'The app installs this for you when an engine needs it — nothing to do by hand.',
    docsUrl: 'https://nodejs.org'
  }
];

/**
 * 针对某个平台的完整目录。`platform` 是 `process.platform` 值；
 * 只有 win32 与其余所有平台的区别才重要。
 */
export function toolCatalog(): ToolSpec[] {
  const engines: ToolSpec[] = AGENT_PROVIDER_PRESETS
    // `custom` 是用户随意输入的——没有什么可探测或安装的。
    .filter((p) => p.id !== 'custom' && !!p.defaultCommand)
    .map((p) => ({
      id: `engine:${p.id}`,
      bin: p.defaultCommand,
      label: p.label,
      kind: 'engine' as const,
      why: `Agent engine — ${p.defaultCommand}.`,
      // Claude Code 是推荐引擎，也是基线默认假定的唯一引擎，
      // 因此它是“一键设置全部”会安装的那一个。
      essential: p.id === 'claude',
      install: {
        posix: p.installCommand ?? p.nativeInstallCommand?.posix ?? '',
        win32: p.installCommand ?? p.nativeInstallCommand?.win32 ?? ''
      },
      docsUrl: p.docsUrl
    }));
  return [...BASE_TOOLS, ...engines];
}

/** 一条目录行加上我们在本机上找到的内容。 */
export interface ToolStatus extends ToolSpec {
  found: boolean;
  /** 找到时的绝对路径，或 null。 */
  path: string | null;
  /** 额外的实时上下文——例如 “palace initialised”、版本字符串。 */
  detail?: string;
  /** 已按运行平台解析好的 `install`。 */
  installCommand: string;
}

/**
 * “让 Michael 一键设置全部”时交给 Michael 的提示词。
 *
 * 写成一份显式契约而不是一个愿望：点出确切的命令让他不必猜测或搜索，
 * 告诉他去 VERIFY（验证）而不是假定，并把安装顺序依赖（先 uv 后
 * mempalace）写明——先装 mempalace 的编排器只会失败并报告失败。
 *
 */
export function setupPrompt(missing: ToolStatus[]): string {
  if (missing.length === 0) return '';
  const lines = missing.map((t) => {
    const cmd = t.installCommand ? `\n  install: ${t.installCommand}` : '';
    const note = t.note ? `\n  note: ${t.note}` : '';
    return `- ${t.label} (${t.id})${cmd}${note}`;
  });
  return [
    'Set up my missing local tooling. These are the tools this harness uses that are not installed on this machine:',
    '',
    ...lines,
    '',
    'For each one: run the install command in your own terminal, then VERIFY it actually resolves',
    '(`which <bin>`, or `where <bin>` on Windows) before moving on — do not assume an installer that',
    'printed no error succeeded. Install uv BEFORE mempalace; mempalace is installed BY uv and will',
    'fail outright without it.',
    '',
    'If a command needs my password or a decision only I can make, stop and ask me rather than',
    'guessing or working around it. When you are done, report one line per tool: installed, already',
    'present, or failed with the reason.'
  ].join('\n');
}
