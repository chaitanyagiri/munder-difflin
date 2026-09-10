/**
 * Edit a queued message in place (issue #380).
 *
 * Pure policy, separated from the store so the dangerous parts are testable:
 * the queue row shows `text`, but delivery is `instruction ?? text`, a
 * `precondition` can drop the message at delivery time, and the
 * one-pending-/compact and one-pending-inbox-nudge invariants live in
 * enqueueMessage — an edit is a new write path that would route around them.
 *
 * Decisions, made deliberately rather than by omission:
 *  - The edited text becomes the ONE authoritative payload: `instruction` is
 *    cleared (a box that "saved" while the original override still delivered
 *    would teach the operator to distrust it) and `precondition` is cleared
 *    (someone who just rewrote a message by hand means it to go).
 *  - `id`, `ts`, `slack`, `manual`, and queue POSITION are untouched — an edit
 *    is not a re-queue, and re-stamping `ts` would reorder delivery as a side
 *    effect of a typo fix.
 *  - `compactUsed` survives only while the message still IS a compaction
 *    command; otherwise the stale reading could latch out a compaction that
 *    never ran.
 *  - Editing INTO a `/compact` (or an inbox nudge) while another row already
 *    queues one is refused, mirroring enqueueMessage's dedup exactly — the
 *    row under edit does not count against itself.
 */
import { isCompactionCommand } from '@shared/providerAutomation';
import { isInboxNudge } from '@shared/hiveNudge';
import type { QueuedMessage } from './store';

export type QueueEditRefusal = 'empty' | 'unchanged' | 'not-found' | 'duplicate-compact' | 'duplicate-nudge';

export type QueueEditResult =
  | { ok: true; queue: QueuedMessage[] }
  | { ok: false; reason: QueueEditRefusal };

export function applyQueuedMessageEdit(
  queue: QueuedMessage[],
  messageId: string,
  text: string
): QueueEditResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  const target = queue.find((m) => m.id === messageId);
  if (!target) return { ok: false, reason: 'not-found' };
  if (trimmed === target.text) return { ok: false, reason: 'unchanged' };

  const others = queue.filter((m) => m.id !== messageId);
  if (isCompactionCommand(trimmed) && others.some((m) => isCompactionCommand(m.text))) {
    return { ok: false, reason: 'duplicate-compact' };
  }
  if (isInboxNudge(trimmed) && others.some((m) => isInboxNudge(m.text))) {
    return { ok: false, reason: 'duplicate-nudge' };
  }

  return {
    ok: true,
    queue: queue.map((m) => {
      if (m.id !== messageId) return m;
      const { instruction: _instruction, precondition: _precondition, compactUsed, ...kept } = m;
      return {
        ...kept,
        text: trimmed,
        ...(compactUsed !== undefined && isCompactionCommand(trimmed) ? { compactUsed } : {})
      };
    })
  };
}
