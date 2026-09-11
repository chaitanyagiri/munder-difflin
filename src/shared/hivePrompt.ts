/**
 * The hive identity/protocol brief — the block the harness injects at spawn so a
 * fresh CLI knows who it is and how the hive works, and the predicate that
 * recognises it again later.
 *
 * For a hiveAware provider (Claude) the brief rides in as
 * `--append-system-prompt`, so it never appears as a conversation turn. Every
 * other provider takes it through `initialPromptFlag` (`--prompt`, `-p`, …),
 * which makes it the session's FIRST USER MESSAGE — indistinguishable, in the
 * transcript, from something the human typed. The Chat tab shows what people
 * said to each other, so it has to be able to tell them apart; that is what the
 * marker below is for.
 *
 * Shared between main and renderer; keep it dependency-free.
 */

/** Fixed header of the protocol section, present in every brief the harness
 *  builds (`buildIdentity` in main/hive.ts composes the block around it). It is
 *  the recognition anchor, so the builder MUST take it from here rather than
 *  spelling it out again — a drifted copy would silently unhide the brief. */
export const HIVE_PROTOCOL_HEADING = 'HIVE PROTOCOL — follow it every task:';

/**
 * Is this text the harness's own identity brief rather than a human prompt?
 *
 * Matches the protocol heading anywhere in the text: the lines around it carry
 * the agent's name, workspace paths and duty, so they differ per agent and per
 * spawn, while the heading is fixed. Mirrors `isInboxNudge` / `isCompactionCommand`
 * — recognise the app's COMMAND, not one instance of it.
 */
export function isHiveIdentityPrompt(text: string): boolean {
  return text.includes(HIVE_PROTOCOL_HEADING);
}
