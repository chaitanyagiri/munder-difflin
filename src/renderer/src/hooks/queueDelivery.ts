/** 运行一条排队的投递，且仅当发送方 resolve 后才确认。
 * 拒绝会刻意保留队列项，留给下一次重试。 */
export async function deliverWithAcknowledgement(
  send: () => Promise<void>,
  acknowledge: () => void
): Promise<boolean> {
  try {
    await send();
    acknowledge();
    return true;
  } catch {
    return false;
  }
}

/**
 * 现在是否允许把队列内容输入该 agent 的终端？
 *
 * 之前的门控是单纯的 `status === 'idle'`，这会让邮件无限滞留。
 * `looping` 不是 agent 能自行恢复的终态——它是熔断器的 PIN，只要 agent
 * 处于 `constrained` 或 `stopped` 状态，就会在每个心跳上重新断言。
 * PTY 静默回退只会解除 `working` 的 PIN，因此挂上熔断的 agent 永远回不到
 * `idle`，其队列也永远排不空。线上观察到的现象：一个超出 token 上限的
 * agent 被钉住，而消息落地两秒后入队的 nudge 投递不了，一直等到应用外
 * 的什么东西把它唤醒，延误了好几分钟。
 *
 * 这是弄巧成拙的，因为熔断器的 STEER 方式就是给它所熔断的 agent 发邮件
 * （“停下来，写个计划，发给 god”）。在旧门控下，那个本意用来解开
 * 卡死 agent 的消息，恰恰是永远无法送达的那一条。
 *
 * 所以：被钉住的 agent 只要其终端已静默 `quiesceMs` 就允许投递——这与
 * idle 回退用来判断一轮是否结束所依赖的证据相同。PIN 仍保留在头像和
 * 徽章上，只是不再兼任投递锁。
 *
 * 其余状态依然拦住提示符输入：
 *   - `working` / `thinking`：回合进行中。静默回退会把真正结束的回合翻转为
 *     `idle`，然后走常规门控。
 *   - `waiting` / `blocked`：屏幕上有一个交互提示符。排空流程每次投递都
 *     以 Enter 结尾，那会“回答”它——这也是单次 TUI 种子在这两个状态下
 *     拒绝输入的原因。
 *
 * 当 `ptyQuietMs` 未知时按“关闭”安全处理（没有读取，或 PTY 从未输出）：
 * 无法测量的静默不能当作静默的证据。
 */
export function canDeliverToAgent(
  status: string,
  ptyQuietMs: number | null,
  quiesceMs: number
): boolean {
  if (status === 'idle') return true;
  if (status !== 'looping') return false;
  return ptyQuietMs !== null && ptyQuietMs >= quiesceMs;
}

/** 本模块所需的 QueuedMessage 子集。保持结构化，以便门控逻辑可以不依赖
 *  store（以及 zustand）即可测试。 */
export interface DeliveryGateMessage {
  precondition?: 'inbox-nonempty';
}

export type PreconditionVerdict = 'send' | 'drop';

/** 在投入 PTY 之前，立即重新检查队列消息投递时的前置条件。
 *
 *  队列项在入队时做出决策，而实际投递时间可能间隔任意长，因此某些消息所
 *  描述的世界状态到它轮到时可能已不存在。inbox 唤醒 nudge 就是典型场景：
 *  一个已经醒着的 agent 通常会在 nudge 入队的同一个回合内排空整个 inbox，
 *  之后再投递该 nudge 会白白浪费一个回合去发现没什么可读的。
 *
 *  返回 'drop' 而不是 'defer'：一条过期消息留在队首会永远阻塞它后面的
 *  所有消息。
 *
 *  失败时开放放行。如果读不到 inbox 就发送，因为一次多余的 nudge 只浪费
 *  一个回合，而一次被吞掉的消息可能让真正的邮件无限期无法阅读。 */
export async function checkPrecondition(
  message: DeliveryGateMessage,
  readInbox: () => Promise<{ id?: string }[]>
): Promise<PreconditionVerdict> {
  if (message.precondition !== 'inbox-nonempty') return 'send';
  try {
    return (await readInbox()).length > 0 ? 'send' : 'drop';
  } catch {
    return 'send';
  }
}
