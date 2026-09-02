import type { HireManifest } from './hire';

/** 导入的 hires 经过一轮人工审核的临时渲染器状态。 */
export interface HireReviewQueue {
  pending: readonly HireManifest[];
  /** 本轮已生成或已跳过的数量。 */
  reviewed: number;
}

export const EMPTY_HIRE_QUEUE: HireReviewQueue = Object.freeze({
  pending: Object.freeze([]) as readonly HireManifest[],
  reviewed: 0
});

/** 追加新到达者，而不替换当前正在审核的 manifest。 */
export function enqueueHires(
  queue: HireReviewQueue,
  incoming: readonly HireManifest[]
): HireReviewQueue {
  if (incoming.length === 0) return queue;
  return {
    pending: [...queue.pending, ...incoming],
    // 排空的队列会开启一轮新的审核，因此进度也重新开始。
    reviewed: queue.pending.length === 0 ? 0 : queue.reviewed
  };
}

/** 把头部这一项标记为已生成/已跳过，并揭示下一项。 */
export function finishCurrentHire(queue: HireReviewQueue): HireReviewQueue {
  if (queue.pending.length === 0) return queue;
  if (queue.pending.length === 1) return EMPTY_HIRE_QUEUE;
  return { pending: queue.pending.slice(1), reviewed: queue.reviewed + 1 };
}

/** 取消当前的人工审核流程；未完成的 manifest 之后不会恢复。 */
export function clearHireQueue(_queue: HireReviewQueue): HireReviewQueue {
  return EMPTY_HIRE_QUEUE;
}

export function hireQueueProgress(
  queue: HireReviewQueue
): { current: number; total: number } | null {
  if (queue.pending.length === 0) return null;
  return {
    current: queue.reviewed + 1,
    total: queue.reviewed + queue.pending.length
  };
}
