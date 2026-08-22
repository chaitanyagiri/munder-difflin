import type { HireManifest } from './hire';

/** Ephemeral renderer state for one human-reviewed run of imported hires. */
export interface HireReviewQueue {
  pending: readonly HireManifest[];
  /** Number already spawned or skipped in this run. */
  reviewed: number;
}

export const EMPTY_HIRE_QUEUE: HireReviewQueue = Object.freeze({
  pending: Object.freeze([]) as readonly HireManifest[],
  reviewed: 0
});

/** Append arrivals without replacing the manifest currently under review. */
export function enqueueHires(
  queue: HireReviewQueue,
  incoming: readonly HireManifest[]
): HireReviewQueue {
  if (incoming.length === 0) return queue;
  return {
    pending: [...queue.pending, ...incoming],
    // A drained queue starts a new review run and therefore new progress.
    reviewed: queue.pending.length === 0 ? 0 : queue.reviewed
  };
}

/** Mark exactly the head item spawned/skipped and reveal the next one. */
export function finishCurrentHire(queue: HireReviewQueue): HireReviewQueue {
  if (queue.pending.length === 0) return queue;
  if (queue.pending.length === 1) return EMPTY_HIRE_QUEUE;
  return { pending: queue.pending.slice(1), reviewed: queue.reviewed + 1 };
}

/** Cancel the current human-review run; unfinished manifests do not resume later. */
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
