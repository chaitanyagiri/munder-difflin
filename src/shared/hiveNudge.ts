/**
 * 收件箱唤醒提醒——为有未读 hive 邮件的 agent 排队的文本，
 * 以及消息队列用来只保留其中一条待处理项的判断谓词。
 *
 * 提醒在刚看到新邮件的那一刻被排队（QUEUED），但只在 agent
 * 空闲且脱离冷却期后才被敲出（TYPED），并且它会在持久化队列中
 * 挺过渲染器重载。等它真正落地时，agent 往往已经处理完那批邮件
 * 并归档到 `inbox/.done/` 下了——所以提醒到达时，面对的往往是一个
 * agent 自己刚刚清空了的收件箱。
 */

/** 每个提醒的固定开头；其后的 id 随每个提醒而异。 */
const NUDGE_HEAD = 'You have new hive inbox message(s)';

/**
 * 构建提醒，点名触发它的那些消息。
 *
 * 这些 id 是诊断性的，不是工作清单：它们让 agent 能区分
 * "我上一轮已经处理过了"（该 id 位于 `inbox/.done/`）与
 * "harness 白白叫醒了我"，这是它否则无法做出的区分，
 * 且每次猜测都会浪费一次往返。待处理收件箱始终是权威——
 * 一个提醒被下面的一条待处理规则压制的 agent，仍然会通过
 * 读取目录找到它的邮件，所以文本绝不能在 id 处就停下。
 */
export function inboxNudgeText(ids: string[]): string {
  const named = ids.length ? ` — at least: ${ids.join(', ')}` : '';
  return `${NUDGE_HEAD}${named}. Read your inbox, act on what is pending there, and move handled ones to inbox/.done/. Your inbox directory is authoritative: work everything still pending in it, and if a named id is already in inbox/.done/ you handled it on an earlier turn and can ignore that one. Act autonomously; only message god if you genuinely need a decision.`;
}

/**
 * 这段排队文本是不是收件箱唤醒提醒？
 *
 * 只匹配固定开头，因为每个提醒携带的 id 都不同——关键在于识别
 * 命令本身，而不是它的某个实例。镜像 `isCompactionCommand`，
 * 队列的一条待处理规则同样依赖它。
 */
export function isInboxNudge(text: string): boolean {
  return text.trim().startsWith(NUDGE_HEAD);
}
