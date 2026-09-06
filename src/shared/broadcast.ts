/**
 * 广播扇出目标选择。
 *
 * 保持为纯函数（放在 `hive.ts` 之外），这样该规则可以像
 * `queueDelivery` / `codexRemote` 一样独立测试。
 */

/** 扇出实际关注的 registry agent 子集。 */
export interface BroadcastCandidate {
  /** Michael 的预备助手——仅发送，不排空收件箱。 */
  isAssistant?: boolean;
  /** PTY 标签页已关闭；记录保留，但该 agent 不再存活。 */
  archived?: boolean;
}

/**
 * `to: 'broadcast'` 消息扇出到的目标 agents。
 *
 * 排除：发送者自身、仅发送的预备助手（直接发给它只会无人阅读而腐烂），
 * 以及已归档的 agent（没有存活 PTY）。
 *
 * 不排除：没有 hook/proxy 桥接的 provider。扇出过去以 `canReceiveInbox`
 * 为门禁，这意味着 hookless provider——`custom`，即预设不认识的任何
 * CLI——上的 agent 永远静默地听不到广播，尽管发给同一个 agent 的 DIRECT
 * 消息能正常送达。那个不对称正是 bug：`deliver` 本来就会把 hookless
 * 目标经由 `emitTerminalHandoff`（终端工单）投递，仅在渲染器不可用时
 * 才弹回给 god。扇出现在选择与直接邮件可达的同一批 agents，由那条
 * 既有的逐目标路径决定每个如何被服务。
 *
 * 此处接受的取舍：渲染器宕机时，发给 N 个 hookless agents 的广播
 * 会产生 N 条弹回给 god 的消息而不是沉默，这与 N 条直接消息原本
 * 产生的行为相同，并且这是有声的失败——不会在未告知 god 的情况下
 * 丢弃任何消息。
 */
export function selectBroadcastTargets(
  agents: Record<string, BroadcastCandidate | undefined>,
  fromId: string
): string[] {
  return Object.keys(agents).filter((id) => {
    const agent = agents[id];
    if (!agent) return false;
    if (id === fromId) return false;
    if (agent.isAssistant) return false;
    if (agent.archived) return false;
    return true;
  });
}
