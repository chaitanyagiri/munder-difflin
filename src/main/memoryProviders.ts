import { join } from 'node:path';
import type { EmbeddingModel } from './memory';

export type MemoryProviderId = 'mempalace' | 'lumberroom';

export interface MemoryProvider {
  id: MemoryProviderId;
  bin: string;
  env(ctx: { palacePath: string | null; model: EmbeddingModel; device?: string }): Record<string, string>;
  searchArgs(query: string, opts: { scope?: string; results: number }): string[];
  wakeUpArgs(scope?: string): string[];
  mineArgs?(agentDir: string, agentId: string): string[]; // absent = cannot mine markdown
  scopeForAgent(agentId: string): string | undefined; // undefined = no per-agent axis
  localStorePath?(home: string): string; // absent for a remote-backed provider
  auth?: {
    probeArgs: string[];
    unauthenticatedExit: number; // "missing/rejected" exit code, vs. network trouble or a real failure
    loginCommand: string;
  };
  promptLine(): string;
  protocolSection(): string;
}

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
  promptLine: () =>
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

/** argv verified against lumberroom's CLI dispatch: `search` takes `--limit`
 *  (not `--results`) and `--namespace`; `bootstrap` scopes by `--project` only.
 *  No mineArgs — `lumberroom ingest` is a human-approved LLM pipeline over
 *  transcripts, not a directory miner. */
const lumberroom: MemoryProvider = {
  id: 'lumberroom',
  bin: 'lumberroom',
  env: () => ({}),
  searchArgs: (query, opts) => [
    'search', query, '--limit', String(opts.results),
    ...(opts.scope ? ['--namespace', opts.scope] : [])
  ],
  wakeUpArgs: (scope) => ['bootstrap', ...(scope ? ['--project', scope] : [])],
  scopeForAgent: () => undefined, // namespaces are per-subject, not per-agent
  // no localStorePath — store is remote; app reset must not touch it
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
  return (id && Object.hasOwn(MEMORY_PROVIDERS, id)) ? MEMORY_PROVIDERS[id as MemoryProviderId] : mempalace;
}
