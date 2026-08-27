/** God's identity before anyone has customized it — the app's own default,
 *  not a magic string sprinkled at every spawn call site. */
export const DEFAULT_GOD_NAME = 'Michael';

/**
 * Resolve god's display name for a (re)spawn.
 *
 * `renameAgent()` (`store.ts`) persists a rename straight into `registry.json`
 * via `hive.ts`'s `renameAgent()` — but the god-spawn effect used to rebuild
 * god's agent object from scratch with `name: DEFAULT_GOD_NAME` hardcoded in
 * three places, so a custom name reverted to "Michael" on every app restart
 * even though the registry still had it right. Reading the persisted name
 * back here (instead of hardcoding the default) is what keeps a rename from
 * reverting. Falls back to the default only when nothing has been persisted
 * yet — a fresh hive, or a registry not yet written this run.
 */
export function resolveGodName(persistedName: string | undefined | null): string {
  const trimmed = persistedName?.trim();
  return trimmed ? trimmed : DEFAULT_GOD_NAME;
}
