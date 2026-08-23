import type { AgentProvider } from './agentProvider';
import { DEFAULT_COMPACTION_FOCUS } from './triggers';

/**
 * Back-compat alias. The compaction focus used to be a private constant here;
 * it now lives in shared/triggers.ts as the DEFAULT VALUE of the user-editable
 * `ContextRule.message`, so the Triggers UI and this module cannot drift apart.
 * Kept exported under the old name for any consumer still reaching for it.
 */
export const COMPACTION_FOCUS = DEFAULT_COMPACTION_FOCUS;

/** What one provider's interactive TUI accepts for each context action. */
export interface ProviderContextCommands {
  /** Summarise-in-place. `null` = no command we can type with confidence. */
  compact: string | null;
  /** Discard-and-restart. `null` = same. */
  clear: string | null;
  /**
   * Whether the TUI parses text AFTER the compact command as a focus
   * instruction. When false the focus is DROPPED rather than typed: a CLI whose
   * slash parser ignores the remainder is harmless, but one that re-reads it as
   * a fresh prompt would silently turn a compaction into a whole extra turn.
   */
  compactTakesFocus: boolean;
}

const NO_CONTEXT_COMMANDS: ProviderContextCommands = {
  compact: null,
  clear: null,
  compactTakesFocus: false
};

/**
 * THE per-provider context-command table.
 *
 * Deliberately a total `Record<AgentProvider, …>` and NOT a switch with a
 * `default:` arm — the previous switch silently answered `null` for seven of the
 * eleven providers, so auto-compaction quietly did nothing for most of the fleet
 * and nobody found out. A total record makes the compiler stop the next person
 * who adds a provider until they have actually looked its commands up.
 *
 * `null` means "we could not establish a command we trust", NOT "we didn't
 * check". A wrong slash command typed into a live terminal is worse than no
 * command: at best it is dead text the model answers, at worst it fires some
 * other verb. Every entry below cites where it was verified — mostly by reading
 * the SHIPPED BINARY of each CLI (its own embedded command table / docs), which
 * outranks web docs because it cannot lag the installed version.
 */
const CONTEXT_COMMANDS: Record<AgentProvider, ProviderContextCommands> = {
  // claudeCommands.ts:34,37 (this repo's own catalog): `/compact` takes a focus
  // ("usage: /compact keep the auth decisions"), `/clear` starts a fresh
  // conversation and reclaims the window.
  claude: { compact: '/compact', clear: '/clear', compactTakesFocus: true },

  // Codex 0.137.0 binary, TUI slash-command description table:
  //   "summarize conversation to prevent hitting the context limit"  → /compact
  //   "clear the terminal and start a new chat"                      → /clear
  // NOTE this contradicts codexCommands.ts, which lists /clear but NOT /compact.
  // The binary is right and that catalog is incomplete (see report).
  // compactTakesFocus stays FALSE: codex's own `Usage: /…` strings spell out an
  // argument for every command that takes one (/goal, /raw, /mcp, /keymap,
  // /ide, /sandbox-add-read-dir) and /compact has none.
  codex: { compact: '/compact', clear: '/clear', compactTakesFocus: false },

  // Grok binary ships its own docs inline (04-slash-commands.md):
  //   "/compact [context] — Compress conversation history… Optionally specify
  //    what to preserve", example `/compact keep the auth implementation details`
  //   "/new — Start a new session, clearing the current conversation.
  //    Aliases: /clear"
  // `/new` is the documented spelling (and what grokCommands.ts:13 already
  // records), so prefer it over the alias.
  grok: { compact: '/compact', clear: '/new', compactTakesFocus: true },

  // Moonshot kimi-cli slash-command reference: `/compact` accepts appended
  // custom instructions ("/compact preserve database-related discussions");
  // `/clear` (alias /reset) "Clear the current session's context and start a
  // new conversation". NB `/new` there forks a session rather than discarding.
  kimi: { compact: '/compact', clear: '/clear', compactTakesFocus: true },

  // antigravity.google/docs/cli/reference (Google's own command table):
  //   "/clear  (/new)  — Clear the terminal and reset active conversation
  //    contexts."     ← a REAL context reset, and
  //   "Ctrl+L  cli.clear_screen — Refreshes and clears the visual terminal
  //    buffer."       ← the screen-only one. The two are different things, so
  // the "agy /clear only clears the screen" worry does not hold.
  // That reference lists NO compaction verb at all (zero hits for compact /
  // compress / summarize), and the shipped `agy` binary has no such literal
  // either — agy compacts AUTOMATICALLY when the window fills ("# Resuming from
  // a compaction"). Nothing to type, so: null.
  antigravity: { compact: null, clear: '/clear', compactTakesFocus: false },

  // Google Gemini CLI's command reference documents `/compress` as replacing
  // the chat context with a summary and `/clear` as starting a clean context.
  // `/compress` has no focus-argument contract, so never append user prose.
  gemini: { compact: '/compress', clear: '/clear', compactTakesFocus: false },

  // qwen-code's bundled cli.js, verbatim:
  //   compressCommand = { name:"compress", altNames:["summarize"],
  //     description "Compresses the context by replacing it with a summary." }
  //   and its action reads `context.invocation?.args` as `customInstructions`
  //   (capped at 2000 chars) → it genuinely takes a focus.
  //   clearCommand    = { name:"clear", altNames:["reset","new"],
  //     description "Clear conversation history and free up context." }
  // It is `/compress`, NOT `/compact`: qwen dropped upstream gemini-cli's
  // `compact` altName, so `/compact` would land as plain text here.
  qwen: { compact: '/compress', clear: '/clear', compactTakesFocus: true },

  // opencode binary's command registry, verbatim:
  //   { title:"Compact session", value:"session.compact",
  //     slash:{ name:"compact", aliases:["summarize"] }, run: … }
  // and its own tip text "Run /compact to summarize long sessions near context
  // limits". That `run()` calls session.summarize({sessionID,model}) and never
  // looks at the invocation args → the focus would be silently dropped, so
  // compactTakesFocus is false.
  // `/clear` does NOT exist in the binary (zero literals); the fresh-session
  // verb is `/new` — matched exactly (`t.trim().toLowerCase()==="/new"`).
  opencode: { compact: '/compact', clear: '/new', compactTakesFocus: false },

  // Crush has NO typed slash commands at all. Its own binary strings show
  // "Summarize Session" / "New Session" as ctrl+p COMMAND-PALETTE rows, and the
  // hint "/ or ctrl+p" means a leading `/` OPENS that palette rather than
  // submitting a command. Typing "/compact" would filter a modal and leave it
  // open, swallowing everything queued behind it. Nothing safe to type: null.
  // (Crush's compact/clear are reachable only over its HTTP API.)
  crush: NO_CONTEXT_COMMANDS,

  // pi's dist/core/slash-commands.js, verbatim:
  //   { name:"compact", description:"Manually compact the session context" }
  //   { name:"new",     description:"Start a new session" }
  // and docs/compaction.md: "trigger manually with `/compact [instructions]`,
  // where optional instructions focus the summary". There is no `/clear`.
  pi: { compact: '/compact', clear: '/new', compactTakesFocus: true },

  // Copilot's INTERACTIVE mode does have `/compact [FOCUS-INSTRUCTIONS]` and
  // `/clear` — but this app never runs it interactively. The preset spawns it in
  // print mode (`initialPromptFlag: '-p'`, `canReceiveInbox: false`), which runs
  // one prompt and EXITS. There is no prompt left alive to type a slash command
  // into, so both are null by construction rather than by ignorance.
  copilot: NO_CONTEXT_COMMANDS,

  // Cursor Agent CLI (`agent`) is interactive in this preset, but its slash /
  // command surface is not yet verified against a frozen binary catalog in-repo.
  // Prefer null over guessing — wrong slashes into a live TUI are worse than no
  // auto-compact. Revisit when a shipped command table is transcribed.
  cursor: NO_CONTEXT_COMMANDS,

  // An arbitrary user binary. We cannot know its command surface, and guessing
  // means typing slashes into someone's unknown REPL.
  custom: NO_CONTEXT_COMMANDS
};

/** The full context-command entry for a provider (unknown ids degrade to none). */
export function contextCommandsForProvider(provider: AgentProvider): ProviderContextCommands {
  return CONTEXT_COMMANDS[provider] ?? NO_CONTEXT_COMMANDS;
}

/**
 * The compaction command to type, or null when this provider has none.
 *
 * `message` is the user-editable `ContextRule.message` (default
 * `DEFAULT_COMPACTION_FOCUS`) and is appended only where the provider's parser
 * actually reads it — see `compactTakesFocus`.
 */
export function compactionCommandForProvider(
  provider: AgentProvider,
  message: string = DEFAULT_COMPACTION_FOCUS
): string | null {
  const { compact, compactTakesFocus } = contextCommandsForProvider(provider);
  if (!compact) return null;
  const focus = message.trim();
  return compactTakesFocus && focus ? `${compact} ${focus}` : compact;
}

/** Every distinct compaction verb this harness can type, across all providers.
 *  Derived from CONTEXT_COMMANDS rather than hand-listed, so a provider added to
 *  that table is covered here without a second edit anyone could forget. */
const COMPACT_VERBS: ReadonlySet<string> = new Set(
  Object.values(CONTEXT_COMMANDS)
    .map((c) => c.compact)
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
);

/**
 * Is this queued text a compaction command?
 *
 * Matches the leading VERB only, so `/compact keep the auth decisions` counts
 * while a human sentence that merely mentions compaction does not — the queue
 * carries both, and mistaking prose for a command would silently drop real work.
 *
 * Provider-agnostic on purpose: the queue is keyed by agent, not provider, and a
 * duplicate `/compact` is worth dropping regardless of which CLI is going to
 * receive it.
 */
export function isCompactionCommand(text: string): boolean {
  return COMPACT_VERBS.has(text.trim().split(/\s+/)[0]);
}

/**
 * The context-clearing command to type, or null when nothing typed can reach
 * this provider.
 *
 * Per `ContextRule.message`, a non-empty message on the CLEAR rule is "the
 * literal command to send" — an override, not a suffix. That asymmetry with
 * compact is deliberate and useful: it is the operator's escape hatch for the
 * providers this table answers `null` for, and for a CLI that renames its verb
 * between releases. Empty message = the table's own bare command.
 */
export function clearCommandForProvider(
  provider: AgentProvider,
  message: string = ''
): string | null {
  const override = message.trim();
  if (override) return override;
  return contextCommandsForProvider(provider).clear;
}

/** Claude exposes remote control as a slash command; Codex uses its daemon and
 * Kimi has no equivalent slash command. */
export function remoteControlCommandForProvider(
  provider: AgentProvider,
  sessionName?: string
): string | null {
  if (provider !== 'claude') return null;
  const name = sessionName?.trim();
  return name ? `/remote-control ${name}` : '/remote-control';
}

/** Initial TUI output needs a short provider-specific settle before typing. */
export function terminalReadySettleMs(provider: AgentProvider): number {
  switch (provider) {
    case 'kimi': return 650;
    case 'grok': return 500;
    case 'gemini': return 500;
    case 'codex': return 500;
    default: return 400;
  }
}

/**
 * A live TUI is ready after it has produced an initial frame and had a short
 * settle period. Do not require output to become quiet: Codex can continuously
 * repaint its status line, which previously kept queued messages blocked until
 * every readiness attempt timed out.
 *
 * `undefined` is accepted for compatibility with a renderer hot-reloaded
 * against an older main process that does not yet expose `hasOutput`.
 */
export function terminalReadyToReceive(
  hasOutput: boolean | undefined,
  elapsedMs: number,
  provider: AgentProvider
): boolean {
  if (provider === 'antigravity') {
    return elapsedMs >= terminalReadySettleMs(provider);
  }
  return hasOutput !== false && elapsedMs >= terminalReadySettleMs(provider);
}
