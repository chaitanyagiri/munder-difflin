/**
 * 专注模式：全窗口终端正在显示哪个 agent，以及用户是否默认想要该视图。
 *
 * 放在 store 之外，并且是结构化而非针对 `Agent` 类型化的，这样下面的规则
 * 可以在不把 zustand 拖进单元测试的情况下测试。与 hooks/queueDelivery.ts
 * 的理由相同。
 */

/** 这些规则所需的 agent 子集。 */
export interface FocusCandidate {
  id: string;
  /** agent 有终端时才存在。对合成 agent 以及 PTY 尚未重建的持久化 agent
   *  都缺失。 */
  ptyId?: string;
}

/**
 * 让专注模式始终指向一个仍然存在的 agent。
 *
 * 每条移除 agent 的路径都会重新安置 `selectedId`，但没有一条会重新安置
 * 专注 id，所以关闭你正在专注的那个 agent 会让它指向空。`App.tsx` 随后
 * 找不到可渲染的 agent，把整个窗口丢回侧边栏——看起来像是应用替你决定
 * 退出专注模式。
 *
 * 关闭一个 agent 并不是退出专注模式的请求。所以跟随选中状态走，只有在
 * 最后一个 agent 也消失后才退出。
 *
 * 适用于每条移除路径，包括 `reconcileWithLivePtys`：它在 STARTUP 时运行并
 * 修剪 PTY 未能存活的 agent，没有它，恢复的专注模式偏好会被第一次对账
 * 撤销。
 */
export function refocusAfterRemoval(
  fullscreenAgentId: string | null,
  agents: FocusCandidate[],
  selectedId: string | null
): string | null {
  if (fullscreenAgentId === null) return null;
  if (agents.some((a) => a.id === fullscreenAgentId)) return fullscreenAgentId;
  return selectedId ?? agents[0]?.id ?? null;
}

/**
 * 把持久化的专注模式偏好解析为加载时要专注的 agent。
 *
 * 偏好存为 BOOLEAN，刻意不存被专注 agent 的 id。id 跨重启无意义：那个
 * agent 可能已被关闭，或其 PTY 可能不再回来，恢复一个过期的会直接落入
 * `refocusAfterRemoval` 要防止的悬空引用。偏好意味着“我在专注模式下工作”，
 * 所以它针对当前选中的 agent 解析。
 */
export function focusOnLoad(
  prefersFocusMode: boolean,
  selectedId: string | null
): string | null {
  return prefersFocusMode ? selectedId : null;
}

/**
 * 一旦有可专注的东西就重新进入专注模式。
 *
 * 单独的 `focusOnLoad` 不够，原因是启动顺序问题。store 在构造期间、针对
 * 从磁盘读到的名单一次性解析偏好。名单里的每个 agent 仍带着它在上一个
 * 会话里的 PTY id，而这些 PTY 都还不存在，所以第一次
 * `reconcileWithLivePtys` 正确地修剪掉全部，`refocusAfterRemoval` 也正确地
 * 返回 null。等 god 带着活跃终端重新 spawn 时，偏好已经被读掉并丢弃，
 * 于是应用在 `cth.prefersFocusMode` 仍为 1 的情况下从侧边栏打开。
 *
 * 所以偏好必须在名单每次变化时重新检查，而不是构造时一次。
 *
 * 只恢复到有终端的 agent 上。`FullscreenTerminal` 没有终端就什么都不渲染，
 * 它自己的重新安置 effect 会立刻把我们弹回去——那是循环而非恢复。
 *
 * 无事可做时原样返回当前值，调用方可以按引用比较并跳过状态写入。
 */
export function restoreFocus(
  prefersFocusMode: boolean,
  fullscreenAgentId: string | null,
  agents: FocusCandidate[],
  selectedId: string | null
): string | null {
  if (!prefersFocusMode) return fullscreenAgentId;
  if (fullscreenAgentId) return fullscreenAgentId;
  const selected = agents.find((a) => a.id === selectedId && a.ptyId);
  return selected?.id ?? agents.find((a) => a.ptyId)?.id ?? null;
}
