/**
 * Memory-provider descriptors — the data that makes MemoryManager generic.
 *
 * MemoryManager never speaks a protocol: it resolves a CLI on PATH, spawns it,
 * and reads stdout. Everything provider-specific — the binary name, the env it
 * needs, the argv per operation, whether it can mine a directory of markdown,
 * whether it needs a credential — lives here as data plus argv builders. Adding
 * a backend is adding a table entry, not a code path.
 *
 * No behaviour in this file: nothing here spawns, reads config, or touches the
 * filesystem. That is what lets the argv test pin these values byte-for-byte.
 */
import { join } from 'node:path';
import type { EmbeddingModel } from './memory';

export type MemoryProviderId = 'mempalace' | 'lumberroom';

/** What the CLI needs to know about itself, per operation. */
export interface MemoryProvider {
  id: MemoryProviderId;
  /** Binary basename. Fed to `which`/`where` and to the candidate-dir probe. */
  bin: string;
  /** Env merged into agent spawns AND into this manager's own child spawns. */
  env(ctx: { palacePath: string | null; model: EmbeddingModel; device?: string }): Record<string, string>;
  /** argv for a recall. `scope` is already provider-shaped (mapped through
   *  `scopeForAgent` by the caller). */
  searchArgs(query: string, opts: { scope?: string; results: number }): string[];
  /** argv for the session-start digest. */
  wakeUpArgs(scope?: string): string[];
  /** argv to ingest one agent's directory. ABSENT means the provider cannot
   *  mine from a directory of markdown; the mine loop then never arms. */
  mineArgs?(agentDir: string, agentId: string): string[];
  /** Map a hive agent id to whatever this provider scopes by. `undefined`
   *  means "this provider has no per-agent axis — search store-wide". */
  scopeForAgent(agentId: string): string | undefined;
  /** Where this provider keeps its local store under harnessHome. ABSENT for a
   *  remote-backed provider: there is nothing on disk to initialise, reap, or
   *  delete on app reset — the remote store must never be wiped locally. */
  localStorePath?(home: string): string;
  /** Absent for a local, auth-free provider. */
  auth?: {
    /** Cheap argv whose exit code answers "is this credential good?". */
    probeArgs: string[];
    /** Exit code that means "credential missing or rejected", as opposed to
     *  network trouble (lumberroom: 3) or a real failure (1). */
    unauthenticatedExit: number;
    /** Shown in the UI and the setup checklist when unauthenticated. */
    loginCommand: string;
  };
  /** One sentence for the agent system prompt. Empty means "say nothing". */
  promptLine(): string;
  /** The `## Semantic memory` section of the hive's PROTOCOL.md, markdown. */
  protocolSection(): string;
}

/** Every value copied from the pre-descriptor literals in memory.ts / hive.ts,
 *  so selecting this entry is a no-op refactor. The argv test holds that. */
const mempalace: MemoryProvider = {
  id: 'mempalace',
  bin: 'mempalace',
  env: ({ palacePath, model, device }) => ({
    MEMPALACE_PALACE_PATH: palacePath ?? '',
    MEMPALACE_EMBEDDING_MODEL: model,
    ...(device ? { MEMPALACE_EMBEDDING_DEVICE: device } : {})
  }),
  searchArgs: (query, opts) => [
    'search', query, '--results', String(opts.results),
    ...(opts.scope ? ['--wing', opts.scope] : [])
  ],
  wakeUpArgs: (scope) => ['wake-up', ...(scope ? ['--wing', scope] : [])],
  mineArgs: (agentDir, agentId) => ['mine', agentDir, '--wing', agentId, '--agent', agentId],
  scopeForAgent: (agentId) => agentId,
  localStorePath: (home) => join(home, 'palace'),
  // no `auth` — MemPalace is a local directory
  promptLine: () =>
    // The palace location is named, not spelled as `$MEMPALACE_PALACE_PATH`:
    // `mempalace` reads that env var itself, and the POSIX `$` form was noise
    // (or an empty expansion) for a Windows agent that tried to use it literally.
    'Semantic memory: the whole hive shares a searchable MemPalace at the path in your MEMPALACE_PALACE_PATH environment variable. To recall relevant past knowledge across the team, run `mempalace search "<query>"`; run `mempalace wake-up` at the start of a task for a memory digest. Your notes in memory.md are mined into the palace automatically — write durable facts there.',
  protocolSection: () => `## Semantic memory (optional — when \`mempalace\` is installed)
When \`MEMPALACE_PALACE_PATH\` is set in your environment, the hive shares a
searchable MemPalace and you have the \`mempalace\` CLI:
- \`mempalace search "<query>"\` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`mempalace wake-up\` — a short digest of what matters, good at the start of a task.

Your \`memory.md\` is mined into the palace automatically, so the durable facts you
write there become searchable by every agent. You don't run \`mine\` yourself.`
};

/** argv read off the lumberroom CLI's Rust dispatch, not guessed: `search`
 *  takes `--limit` (not `--results`) and `--namespace`; `bootstrap` scopes by
 *  `--project` only. env() returning {} is correct, not a stub: the CLI reads
 *  ~/.config/lumberroom/config.json itself — the harness holds no credential.
 *
 *  No mineArgs, deliberately: `lumberroom ingest` is a multi-stage LLM pipeline
 *  over transcript corpora ending in a human approval queue, not a directory
 *  ingester — running it from a background timer would spend somebody's
 *  inference budget without asking. Under lumberroom, memory.md is NOT shared
 *  automatically; facts land via `lumberroom write`. */
const lumberroom: MemoryProvider = {
  id: 'lumberroom',
  bin: 'lumberroom',
  env: () => ({}),
  searchArgs: (query, opts) => [
    'search', query, '--limit', String(opts.results),
    ...(opts.scope ? ['--namespace', opts.scope] : [])
  ],
  wakeUpArgs: (scope) => ['bootstrap', ...(scope ? ['--project', scope] : [])],
  // no mineArgs — see above
  scopeForAgent: () => undefined, // namespaces are per-subject, not per-agent
  // no localStorePath — the store is remote; an app reset must not touch it
  auth: { probeArgs: ['whoami'], unauthenticatedExit: 2, loginCommand: 'lumberroom login' },
  promptLine: () =>
    'Semantic memory: the hive shares a lumberroom store. Run `lumberroom search "<query>" [--namespace project:<slug>]` to recall past knowledge; `lumberroom bootstrap` at the start of a task for a digest. Record durable facts with `lumberroom write "<fact>" --namespace <ns>` — your memory.md is NOT shared automatically under lumberroom.',
  protocolSection: () => `## Semantic memory (optional — when \`lumberroom\` is installed)
The hive shares a lumberroom store — durable memory across every machine and
agent, and you have the \`lumberroom\` CLI:
- \`lumberroom search "<query>"\` — recall relevant past knowledge by meaning.
  Add \`--namespace project:<slug>\` to scope, \`--limit N\` to widen.
- \`lumberroom bootstrap\` — a digest of what matters, good at the start of a task.
- \`lumberroom write "<fact>" --namespace <ns>\` — record a durable fact.

Your \`memory.md\` is NOT mined automatically under lumberroom: it is a thin
continuity scratchpad. A fact becomes searchable by the team only when someone
deliberately runs \`lumberroom write\`.`
};

export const MEMORY_PROVIDERS: Record<MemoryProviderId, MemoryProvider> = {
  mempalace,
  lumberroom
};

/** Resolve a config value (possibly absent — pre-existing installs) to a
 *  descriptor. Anything unrecognised falls back to the historic default. */
export function memoryProviderById(id: string | undefined): MemoryProvider {
  return (id && id in MEMORY_PROVIDERS) ? MEMORY_PROVIDERS[id as MemoryProviderId] : mempalace;
}
