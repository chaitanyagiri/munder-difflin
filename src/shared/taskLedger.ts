/**
 * Non-destructive edits to the task ledger (`hive/tasks.json`).
 *
 * The ledger is a HAND-WRITTEN file: the god appends whatever fields a card
 * needs — `result` (the verbatim Slack reply posted back to the user), `repo`,
 * `scope`, `origin`, `deliverable`, `commit`, `blockedOn`, `notes` — none of
 * which the renderer's display model knows about. Several UI surfaces write the
 * ledger back after a small edit (answer a question, move a card, dismiss one),
 * and `hive:writeTasks` replaces the file wholesale. So any writer holding a
 * partial model of a card silently DELETED every field it didn't know about,
 * on EVERY card on the board, the moment the user touched one of them.
 *
 * Two rules fix that, and both live here so main and the renderer share them:
 *
 *   - `mergeTaskLedger` — the persistence-side backstop. A card the writer
 *     didn't fully describe keeps the fields it already had on disk.
 *   - `patchTaskInLedger` — the caller-side rule. Edit the RAW ledger entry
 *     rather than re-serializing a display model, so a normalizing parser can't
 *     overwrite a field it coerced (a string `priority` re-emitted as a number).
 *
 * Deletion deliberately still works: a card absent from the incoming list is
 * gone. Merging protects fields, never card membership.
 */

/** One raw ledger entry as it sits on disk — an object of unknown fields. */
type RawTask = Record<string, unknown>;

function isRawTask(value: unknown): value is RawTask {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (!isRawTask(value)) return null;
  return typeof value.id === 'string' && value.id ? value.id : null;
}

/**
 * Fold `incoming` over `existing`, matching cards by `id`.
 *
 * The result is `incoming` — its order, and its membership, so removing a card
 * from the list still deletes it. What survives the fold are the fields on the
 * matching on-disk card that `incoming` does not mention.
 *
 * A field the caller DOES send wins, including an explicit `null` — that's the
 * way to clear one. A shallow merge cannot express "delete this key", and it
 * shouldn't: writers here are partial models, so a missing key means "I don't
 * know about this", never "remove it".
 *
 * Entries without a string `id` (a malformed card the god hand-wrote) pass
 * through untouched — there is no key to merge them on, and dropping them would
 * lose data the same way this function exists to prevent.
 */
export function mergeTaskLedger(existing: unknown, incoming: unknown): unknown[] {
  const incomingList = Array.isArray(incoming) ? incoming : [];
  const existingList = Array.isArray(existing) ? existing : [];
  const byId = new Map<string, RawTask>();
  for (const entry of existingList) {
    const id = idOf(entry);
    if (id && !byId.has(id)) byId.set(id, entry as RawTask);
  }
  return incomingList.map((entry) => {
    const id = idOf(entry);
    if (!id) return entry;
    const prior = byId.get(id);
    return prior ? { ...prior, ...(entry as RawTask) } : entry;
  });
}

/**
 * Apply `patch` to one card in a RAW ledger array, leaving every other card —
 * and every other field of the patched card — byte-identical.
 *
 * This is what a UI edit should write. Re-serializing the display model instead
 * feeds the ledger a normalized card: `parseTasks` coerces a hand-written
 * `priority: "high"` to the number `3` and re-emits `dependsOn: []` for a card
 * that spells the key `deps`, and those coercions are real values, so they beat
 * `mergeTaskLedger` and land on disk. Patching the raw entry never produces
 * them in the first place.
 */
export function patchTaskInLedger(
  rawTasks: unknown,
  id: string,
  patch: Record<string, unknown>
): unknown[] {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  return list.map((entry) => (idOf(entry) === id ? { ...(entry as RawTask), ...patch } : entry));
}
