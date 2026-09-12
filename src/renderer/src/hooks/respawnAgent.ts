/**
 * Respawn ONE agent that has no live terminal.
 *
 * Two screens need this and they must not drift apart:
 *   - "Restore team" (AgentStrip → useRestoreTeam) brings back every agent that
 *     had a terminal open when the app last quit;
 *   - "Reopen" (Command Center → Archived) brings back an agent the user closed
 *     deliberately (#447). Closing a tab retains the agent — the store comment
 *     says so outright ("Retained + flagged, NOT deleted") — but the only button
 *     on an archived row was ✕ permanent-delete, so the retained record had no
 *     way back into the roster.
 *
 * Both want the identical recipe: the ORIGINAL agent id, its own cwd (or the
 * isolated worktree it was working in), and its prior CLI session resumed — the
 * hive workspace (registry entry, memory.md, inbox) then reattaches by id with
 * no memory transplant. Duplicating that in the archived panel would have made
 * a second recipe to keep in sync, so it lives here once.
 *
 * Structural and dependency-injected — no store, no window, no config imports —
 * so the sequence is unit-testable without Electron, the same way
 * queueDelivery.ts keeps its gate testable.
 */
import { roleForHiveSpawn } from '@shared/agentRole';
import type { AgentProvider } from '@shared/agentProvider';

/** The subset of a roster Agent a respawn needs. Structural on purpose: the
 *  test builds one of these rather than a whole store Agent. */
export interface RespawnableAgent {
  id: string;
  name: string;
  cwd: string;
  /** Cleared when an agent is archived; a respawn re-derives it from the id. */
  ptyId?: string;
  /** The isolated `agent/<id>` worktree this agent was working in, if any. */
  worktreePath?: string;
  description?: string;
  isGod?: boolean;
  /** Michael's prep assistant — carries its own durable role. */
  isAssistant?: boolean;
}

/** The spawn recipe, resolved by the caller (which owns the config): the
 *  provider preset and the already-tokenized argv for its CLI. */
export interface RespawnRecipe {
  provider: AgentProvider;
  exe: string;
  args: string[];
}

/** The spawn arguments this module produces — a structural subset of the
 *  preload's SpawnPtyOptions, so the caller can forward it straight through. */
export interface RespawnSpawnOptions {
  id: string;
  cwd: string;
  command: string;
  provider: AgentProvider;
  args: string[];
  cols: number;
  rows: number;
  isolate: boolean;
  resume: boolean;
  hive: { id: string; name: string; provider: AgentProvider; cwd: string; role?: string };
}

/** The two main-process calls this needs, injected so tests can fake them. */
export interface RespawnDeps {
  gitIsRepo: (path: string) => Promise<boolean>;
  spawnPty: (opts: RespawnSpawnOptions) => Promise<{ ok: boolean; error?: string; seedPrompt?: string }>;
}

export type RespawnResult =
  /** A terminal is running again. `worktreeGone` means its isolated checkout has
   *  been removed since, so the agent is back on its base repo. */
  | { outcome: 'respawned'; ptyId: string; cwd: string; worktreeGone: boolean; seedPrompt?: string }
  /** A PTY with this id is ALREADY running — the agent is not missing at all, so
   *  this is not a failure and must not be reported as one. */
  | { outcome: 'already-live' }
  | { outcome: 'failed'; error: string };

/** Terminal size a respawned agent starts at, matching the restore path. */
const COLS = 100;
const ROWS = 30;

/**
 * Bring `agent` back up.
 *
 * The cwd is the subtle part. An isolated agent's worktree SURVIVES on disk
 * across a quit, and (since the teardown fix for #297) across a deliberate
 * close too when it holds unintegrated work — so re-enter that exact checkout
 * rather than re-isolating: `git worktree add` would conflict on the existing
 * path and branch, and a fresh worktree would strand the uncommitted work in
 * the old one. But the user may have pruned it in between, and spawning into a
 * dead path is worse than falling back, so the path is probed first.
 *
 * Never throws: every failure comes back as `{ outcome: 'failed' }` so one
 * agent's bad recipe can never abort a caller looping over several.
 */
export async function respawnAgent(
  agent: RespawnableAgent,
  recipe: RespawnRecipe,
  deps: RespawnDeps
): Promise<RespawnResult> {
  try {
    if (!recipe.exe || !agent.cwd) {
      // An entry persisted before `command` existed, with no config to rebuild
      // one. Say so rather than failing silently — a button that does nothing
      // and explains nothing reads as broken.
      return { outcome: 'failed', error: 'no saved command' };
    }
    const ptyId = agent.ptyId ?? `pty-${agent.id}`;
    let cwd = agent.cwd;
    let worktreeGone = false;
    if (agent.worktreePath) {
      if (await deps.gitIsRepo(agent.worktreePath)) cwd = agent.worktreePath;
      else worktreeGone = true;
    }
    const res = await deps.spawnPty({
      id: ptyId,
      cwd,
      command: recipe.exe,
      provider: recipe.provider,
      args: recipe.args,
      cols: COLS,
      rows: ROWS,
      // The worktree (if any) already exists — cd into it, never create one.
      isolate: false,
      // Continue the prior CLI session when one was recorded; the main process
      // picks the provider's resume flag. A no-op when there is none.
      resume: true,
      hive: { id: agent.id, name: agent.name, provider: recipe.provider, cwd, role: roleForHiveSpawn(agent) }
    });
    if (res.ok) return { outcome: 'respawned', ptyId, cwd, worktreeGone, seedPrompt: res.seedPrompt };
    if ((res.error ?? '').includes('already exists')) return { outcome: 'already-live' };
    return { outcome: 'failed', error: res.error ?? 'spawn failed' };
  } catch (e) {
    return { outcome: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** The real main-process calls, in the shape `respawnAgent` injects. Defined
 *  here so both callers share one wiring; the arrows only touch `window` when
 *  invoked, which keeps this module importable from a plain node test. */
export const rendererRespawnDeps: RespawnDeps = {
  gitIsRepo: (path) => window.cth.gitIsRepo(path),
  spawnPty: (opts) => window.cth.spawnPty(opts)
};
