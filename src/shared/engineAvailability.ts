/**
 * 用户即将选择的引擎在这台机器上真的能启动吗？
 *
 * 引导向导会记录 Michael 的引擎，但在第一次 spawn 之前没有任何东西
 * 检查它。spawnAgentCore 随后运行安装阶梯（cliInstall.ts），
 * 对于没有 `installCommand` 也没有 `nativeInstallCommand` 的提供商，
 * 该阶梯止步于 `manual` 这一级：终端里打印一句提示，
 * 编排器永远不会启动。本模块把设置目录探测
 * （`tools:status`，它已经解析了 PATH 上的每个引擎二进制）
 * 转成每个提供商一个答案，这样向导可以在选择被提交之前就说明情况。
 *
 * 刻意保持纯净且不依赖 electron，以便可以用 node --test 测试。
 */
import type { AgentProvider } from './agentProvider';
import type { ToolStatus } from './toolCatalog';

export type EngineAvailabilityState =
  /** 二进制在这台机器上能解析到。 */
  | 'installed'
  /** 这里还没有，但提供商带有应用在首次 spawn 时会运行的安装器。 */
  | 'installs-on-first-run'
  /** 这里没有，而且也没有我们能运行的东西：用户得先手动安装它。 */
  | 'not-installable'
  /** 探测没有运行或没有覆盖这个提供商。绝不因此阻塞。 */
  | 'unknown';

export interface EngineAvailability {
  state: EngineAvailabilityState;
  /** 已安装时的绝对路径。 */
  path: string | null;
  /** 应用会运行（或用户可粘贴）来安装它的命令。 */
  installCommand: string;
  docsUrl?: string;
}

/** 从目录探测结果分类一个提供商。`statuses` 是
 *  `window.cth.toolsStatus()` 返回的内容；undefined 表示它（尚未）运行。 */
export function classifyEngineAvailability(
  statuses: readonly ToolStatus[] | undefined,
  provider: AgentProvider
): EngineAvailability {
  const row = statuses?.find((s) => s.id === `engine:${provider}`);
  if (!row) return { state: 'unknown', path: null, installCommand: '' };
  const installCommand = row.installCommand ?? '';
  if (row.found) return { state: 'installed', path: row.path, installCommand, docsUrl: row.docsUrl };
  return {
    state: installCommand ? 'installs-on-first-run' : 'not-installable',
    path: null,
    installCommand,
    docsUrl: row.docsUrl
  };
}

/** 向导在选中这个引擎时是否必须拒绝继续？只有
 *  已被证明的死路会阻塞；未知的探测绝不会把用户锁在外面。 */
export function engineBlocksOnboarding(a: EngineAvailability): boolean {
  return a.state === 'not-installable';
}

/** 每个引擎行徽章上的一句话。 */
export function engineAvailabilityBadge(a: EngineAvailability): string | null {
  switch (a.state) {
    case 'installed': return 'INSTALLED';
    case 'installs-on-first-run': return 'INSTALLS ON FIRST RUN';
    case 'not-installable': return 'NOT INSTALLED';
    default: return null;
  }
}

/** 选中引擎无法启动时，选择器下方显示的解释。
 *  写给不了解 CLI 引擎是什么的人：先说明发生了什么，
 *  再说明接下来该做什么。 */
export function engineAvailabilityMessage(a: EngineAvailability, label: string): string | null {
  if (a.state !== 'not-installable') return null;
  return `${label} is not installed on this computer and the app has no installer for it, ` +
    `so Michael could not start. Install it first, then press "check again". ` +
    `Or pick Claude Code, which installs itself on first run.`;
}
