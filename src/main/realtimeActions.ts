/**
 * Realtime Michael — voice ACTION spine (card rt-5, Phase 2).
 *
 * Phase 1 gave voice-Michael READ tools. Phase 2 gives him WRITE access: he can
 * ping/dispatch agents, edit the task board, steer/pause/halt/kill workers, hire
 * new ones, and edit schedules — entirely by voice. Because the confirm surface is
 * VOICE-ONLY (the human declined on-screen confirm cards), the echo-back spine in
 * this file is the ENTIRE safety surface, so ALL of it lives in MAIN (the trusted
 * side) — the renderer tools are thin callers. Defense in depth: even if the model
 * (or stray audio) tries something, MAIN enforces the tiering, the distinct-token
 * confirm, and the hard allowlist.
 *
 * TIERING (locked by the human 2026-06-25, see board.md Phase-2):
 *   • SOFT writes  — ping, create/assign/update task, dispatch, steer — execute
 *     directly (low blast radius; fully reversible / advisory).
 *   • DESTRUCTIVE / expensive — spawn-hire, kill, pause, halt, edit_schedule —
 *     require a two-step VERBAL echo-back: (1) read back exact verb + target
 *     (+ a $ estimate for spawn/hire — STUBBED here; rt-9 wires the real number),
 *     (2) a DISTINCT confirm token (the verb word or "confirm" — NEVER a bare
 *     "yes", so ambient speech can't authorize a kill), (3) mic-idle at the commit
 *     instant (the renderer mutes the mic during the confirm tool-call — see
 *     session.ts agent_tool_start), (4) the circuit-breaker still gates (actions go
 *     through the same control path it owns).
 *   • HARD ALLOWLIST — kill/pause/halt on the god orchestrator, and any mass /
 *     all-agent op, are VOICE-FORBIDDEN even with a valid confirm — rejected
 *     outright, no pending created.
 *
 * Every committed action is attributed to actor `michael-voice` (a log stamp on
 * every verb + `from: michael-voice` on messages). rt-7 deepens this into a live
 * god-PTY cross-notify; rt-5 just needs the attribution present.
 *
 * Thin wrappers ONLY — no new orchestration logic. Each verb maps onto a main fn
 * the god PTY already uses (hive.send / writeTasks / spawnAgentCore /
 * control.pause+steer+halt / pty kill / missions save), injected via deps so this
 * module stays decoupled from index.ts wiring.
 */
import { ipcMain } from 'electron';
import type { HiveMessage, HiveTask, Registry } from './hive';
import type { ScheduledMission } from './config';

export const VOICE_ACTOR = 'michael-voice';

/** A minimal spawn spec — index.ts adapts it to its AgentSpawnOptions + spawnAgentCore. */
export interface RealtimeSpawnSpec {
  id: string;
  cwd: string;
  command: string;
  provider?: string;
  hive?: { id: string; name: string; provider?: string; role?: string; cwd: string };
}

/** Existing main fns the voice actions wrap, injected from index.ts so the security
 *  logic here is unit-testable and index.ts stays a thin adapter. */
export interface RealtimeActionDeps {
  hiveEnabled(): boolean;
  hiveSend(partial: Partial<HiveMessage>, from: string): HiveMessage;
  hiveTasks(): unknown;
  hiveWriteTasks(tasks: HiveTask[]): void;
  hiveRegistry(): Registry;
  hiveLog(event: Record<string, unknown>): void;
  controlPause(agentId: string, on: boolean): void;
  controlSteer(agentId: string, text: string): void;
  controlHalt(agentId: string): void;
  controlSnapshot(agentId: string): { paused?: boolean; halted?: boolean } | null;
  killAgent(agentId: string): { ok: boolean; error?: string };
  spawnAgent(opts: RealtimeSpawnSpec): Promise<{ ok: boolean; error?: string }>;
  listMissions(): ScheduledMission[];
  saveMissions(missions: ScheduledMission[]): void;
}

/** The result every action / confirm / cancel returns to the renderer tool, which
 *  hands `spoken` straight to the model to say. */
export interface ActionResult {
  ok: boolean;
  spoken: string;
  /** true when a destructive op is now PENDING a verbal confirm. */
  needsConfirm?: boolean;
}

type Tier = 'soft' | 'destructive';

/** Per-verb spec: tier + the human-facing word that must appear in a confirm. */
const VERBS: Record<string, { tier: Tier; confirmWord: string; agentTargeted: boolean }> = {
  ping: { tier: 'soft', confirmWord: 'ping', agentTargeted: true },
  create_task: { tier: 'soft', confirmWord: 'create', agentTargeted: false },
  assign_task: { tier: 'soft', confirmWord: 'assign', agentTargeted: false },
  update_task: { tier: 'soft', confirmWord: 'update', agentTargeted: false },
  dispatch: { tier: 'soft', confirmWord: 'dispatch', agentTargeted: true },
  steer: { tier: 'soft', confirmWord: 'steer', agentTargeted: true },
  spawn: { tier: 'destructive', confirmWord: 'spawn', agentTargeted: false },
  kill: { tier: 'destructive', confirmWord: 'kill', agentTargeted: true },
  pause: { tier: 'destructive', confirmWord: 'pause', agentTargeted: true },
  halt: { tier: 'destructive', confirmWord: 'halt', agentTargeted: true },
  edit_schedule: { tier: 'destructive', confirmWord: 'schedule', agentTargeted: false }
};

const PENDING_TTL_MS = 120_000;

const PROVIDER_COMMAND: Record<string, string> = {
  claude: 'claude', codex: 'codex', antigravity: 'antigravity', gemini: 'gemini',
  opencode: 'opencode', crush: 'crush', pi: 'pi', qwen: 'qwen'
};

/** Bare affirmations that must NEVER authorize a destructive op on their own —
 *  ambient speech / a stray "yeah" cannot be allowed to confirm a kill. */
const BARE_AFFIRMATIONS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'k', 'sure', 'go', 'go ahead',
  'do it', 'please', 'fine', 'affirmative', 'uh huh', 'mhm', 'mm hmm', 'right', 'correct'
]);

// ─── helpers ────────────────────────────────────────────────────────────────

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const norm = (s: string): string => s.toLowerCase().replace(/[.!?,;:'"]/g, ' ').replace(/\s+/g, ' ').trim();

function shortId(): string {
  // app code (not a Workflow script) — Math.random is fine here.
  return Math.random().toString(36).slice(2, 8);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
}

/** Is the spoken target a mass / all-agent reference? Those are voice-forbidden for
 *  destructive verbs regardless of confirm. */
function isMassTarget(target: string): boolean {
  const t = norm(target);
  if (!t) return false;
  if (/\b(all|every|everyone|everybody)\b/.test(t)) return true;
  if (t === '*' || t === 'agents' || t === 'the team' || t === 'team' || t === 'fleet' || t === 'everything')
    return true;
  // a comma/and list of multiple targets
  if (/,| and /.test(t)) return true;
  return false;
}

interface ResolvedAgent { id: string; name: string; isGod: boolean }

/** Resolve a spoken target ("jim", "kill oscar", an id) to a single live agent, or
 *  return a spoken disambiguation error. Prefers non-archived matches. */
function resolveAgent(target: string, reg: Registry): ResolvedAgent | { error: string } {
  const t = norm(target);
  if (!t) return { error: 'no agent was named' };
  const entries = Object.entries(reg.agents ?? {});
  const mk = (id: string, m: { name?: string; isGod?: boolean }): ResolvedAgent => ({
    id, name: m.name || id, isGod: !!m.isGod || id === reg.godId
  });
  // exact id
  const byId = entries.find(([id]) => id.toLowerCase() === t);
  if (byId) return mk(byId[0], byId[1]);
  // 'god' / 'michael' alias for the orchestrator
  if ((t === 'god' || t === 'michael' || t === 'the god') && reg.godId)
    return mk(reg.godId, reg.agents[reg.godId] ?? {});
  // exact name, prefer live
  const byName = entries.filter(([, m]) => (m.name || '').toLowerCase() === t);
  const liveName = byName.filter(([, m]) => !m.archived);
  const namePick = liveName.length ? liveName : byName;
  if (namePick.length === 1) return mk(namePick[0][0], namePick[0][1]);
  if (namePick.length > 1)
    return { error: `${namePick.length} agents are named ${target} — say the exact agent id` };
  // partial contains, live only
  const partial = entries.filter(
    ([id, m]) => !m.archived && (id.toLowerCase().includes(t) || (m.name || '').toLowerCase().includes(t))
  );
  if (partial.length === 1) return mk(partial[0][0], partial[0][1]);
  if (partial.length > 1) return { error: `several agents match "${target}" — be more specific or say an id` };
  return { error: `I don't see an agent matching "${target}"` };
}

/** Distinct-token confirm check. Accept only if the phrase carries the verb word or
 *  the literal "confirm"; a bare affirmation ("yes", "ok") is rejected. */
function confirmAccepted(phrase: string, confirmWord: string): boolean {
  const p = norm(phrase);
  if (!p) return false;
  if (BARE_AFFIRMATIONS.has(p)) return false;
  if (/\bconfirm(ed|s)?\b/.test(p)) return true;
  if (new RegExp(`\\b${confirmWord}\\b`).test(p)) return true;
  return false;
}

// ─── pending (single-slot two-phase confirm) ────────────────────────────────

interface Pending {
  verb: string;
  confirmWord: string;
  targetLabel: string;
  createdAt: number;
  commit: () => Promise<string>;
}
let pending: Pending | null = null;

function pendingFresh(): Pending | null {
  if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) pending = null;
  return pending;
}

// ─── soft-write executors (run immediately) ─────────────────────────────────

function attribute(deps: RealtimeActionDeps, verb: string, target: string, extra: Record<string, unknown> = {}): void {
  try {
    deps.hiveLog({ kind: 'voice_action', actor: VOICE_ACTOR, verb, target, ...extra });
  } catch {
    /* attribution is best-effort — never block the action */
  }
}

function findTasks(deps: RealtimeActionDeps): HiveTask[] {
  const data = deps.hiveTasks() as { tasks?: unknown } | null;
  return Array.isArray(data?.tasks) ? (data!.tasks as HiveTask[]) : [];
}

function execPing(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const message = str(a.message) || str(a.text) || 'Checking in.';
  deps.hiveSend({ to: r.id, act: 'inform', subject: 'Voice ping from Michael', body: message }, VOICE_ACTOR);
  attribute(deps, 'ping', r.id);
  return { ok: true, spoken: `Pinged ${r.name}.` };
}

function execDispatch(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const objective = str(a.objective) || str(a.task) || str(a.message);
  if (!objective) return { ok: false, spoken: 'What should I dispatch? I need an objective.' };
  // 4-part contract → the agent's inbox.
  const body =
    `OBJECTIVE: ${objective}\n` +
    `CONTEXT: ${str(a.context) || '(none given)'}\n` +
    `CONSTRAINTS: ${str(a.constraints) || '(use your judgement; respect the guardrails)'}\n` +
    `DONE WHEN: ${str(a.doneWhen) || str(a.done) || 'you report the outcome back to god'}`;
  deps.hiveSend(
    { to: r.id, act: 'request', subject: `Voice dispatch: ${objective.slice(0, 60)}`, body, requires_reply: true },
    VOICE_ACTOR
  );
  attribute(deps, 'dispatch', r.id, { objective: objective.slice(0, 120) });
  return { ok: true, spoken: `Dispatched to ${r.name}: ${objective.slice(0, 80)}.` };
}

function execSteer(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const reg = deps.hiveRegistry();
  const r = resolveAgent(str(a.agentId) || str(a.target) || str(a.name), reg);
  if ('error' in r) return { ok: false, spoken: r.error };
  const text = str(a.text) || str(a.message) || str(a.steer);
  if (!text) return { ok: false, spoken: 'What guidance should I steer them with?' };
  deps.controlSteer(r.id, `[${VOICE_ACTOR}] ${text}`);
  attribute(deps, 'steer', r.id, { text: text.slice(0, 120) });
  return { ok: true, spoken: `Steering ${r.name}: ${text.slice(0, 80)}.` };
}

function execCreateTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const title = str(a.title) || str(a.task) || str(a.name);
  if (!title) return { ok: false, spoken: 'What should the task be titled?' };
  const tasks = findTasks(deps);
  const id = `${slug(title)}-${shortId()}`;
  const card: HiveTask = {
    id,
    title,
    description: str(a.description) || undefined,
    assignee: str(a.assignee) || undefined,
    status: 'todo',
    dependsOn: [],
    priority: typeof a.priority === 'number' ? a.priority : 5,
    createdAt: new Date().toISOString()
  };
  deps.hiveWriteTasks([...tasks, card]);
  attribute(deps, 'create_task', id, { title: title.slice(0, 120), assignee: card.assignee });
  return { ok: true, spoken: `Created task "${title}"${card.assignee ? `, assigned to ${card.assignee}` : ''}.` };
}

function findCard(deps: RealtimeActionDeps, ref: string): { tasks: HiveTask[]; card: HiveTask | null } {
  const tasks = findTasks(deps);
  const t = norm(ref);
  const card =
    tasks.find((c) => c.id.toLowerCase() === t) ||
    tasks.find((c) => (c.title || '').toLowerCase() === t) ||
    tasks.find((c) => (c.title || '').toLowerCase().includes(t) || c.id.toLowerCase().includes(t)) ||
    null;
  return { tasks, card };
}

function execAssignTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  const assignee = str(a.assignee) || str(a.to) || str(a.agentId);
  if (!ref || !assignee) return { ok: false, spoken: 'I need both a task and who to assign it to.' };
  const { tasks, card } = findCard(deps, ref);
  if (!card) return { ok: false, spoken: `I couldn't find a task matching "${ref}".` };
  card.assignee = assignee;
  deps.hiveWriteTasks(tasks);
  attribute(deps, 'assign_task', card.id, { assignee });
  return { ok: true, spoken: `Assigned "${card.title}" to ${assignee}.` };
}

function execUpdateTask(deps: RealtimeActionDeps, a: Record<string, unknown>): ActionResult {
  const ref = str(a.taskId) || str(a.task) || str(a.title);
  if (!ref) return { ok: false, spoken: 'Which task should I update?' };
  const { tasks, card } = findCard(deps, ref);
  if (!card) return { ok: false, spoken: `I couldn't find a task matching "${ref}".` };
  const status = str(a.status);
  const valid = ['todo', 'doing', 'blocked', 'done'];
  if (status && !valid.includes(status)) return { ok: false, spoken: `"${status}" isn't a valid status.` };
  if (status) card.status = status as HiveTask['status'];
  if (str(a.result)) card.result = str(a.result);
  if (str(a.assignee)) card.assignee = str(a.assignee);
  deps.hiveWriteTasks(tasks);
  attribute(deps, 'update_task', card.id, { status: card.status });
  return { ok: true, spoken: `Updated "${card.title}"${status ? ` to ${status}` : ''}.` };
}

// ─── destructive commit builders (run AFTER confirm) ────────────────────────

function buildKill(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    const res = deps.killAgent(r.id);
    attribute(deps, 'kill', r.id);
    return res.ok ? `Killed ${r.name}.` : `Couldn't kill ${r.name}: ${res.error || 'unknown error'}.`;
  };
}

function buildPause(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    deps.controlPause(r.id, true);
    attribute(deps, 'pause', r.id);
    return `Paused ${r.name}.`;
  };
}

function buildHalt(deps: RealtimeActionDeps, r: ResolvedAgent): () => Promise<string> {
  return async () => {
    deps.controlHalt(r.id);
    attribute(deps, 'halt', r.id);
    return `Halted ${r.name}.`;
  };
}

function buildSpawn(deps: RealtimeActionDeps, spec: RealtimeSpawnSpec, label: string): () => Promise<string> {
  return async () => {
    const res = await deps.spawnAgent(spec);
    attribute(deps, 'spawn', spec.id, { provider: spec.provider, role: spec.hive?.role });
    return res.ok ? `Hired ${label}.` : `Couldn't hire ${label}: ${res.error || 'unknown error'}.`;
  };
}

function buildEditSchedule(
  deps: RealtimeActionDeps,
  mission: ScheduledMission,
  action: 'enable' | 'disable' | 'delete'
): () => Promise<string> {
  return async () => {
    const all = deps.listMissions();
    let next: ScheduledMission[];
    if (action === 'delete') next = all.filter((m) => m.id !== mission.id);
    else next = all.map((m) => (m.id === mission.id ? { ...m, enabled: action === 'enable' } : m));
    deps.saveMissions(next);
    attribute(deps, 'edit_schedule', mission.id, { action });
    return `${action === 'delete' ? 'Deleted' : action === 'enable' ? 'Enabled' : 'Disabled'} the "${mission.label}" schedule.`;
  };
}

// ─── propose: classify, allowlist-gate, run-or-stage ────────────────────────

function proposeDestructive(deps: RealtimeActionDeps, verb: string, a: Record<string, unknown>): ActionResult {
  const spec = VERBS[verb];
  const reg = deps.hiveRegistry();

  // Agent-targeted destructive verbs: resolve + hard allowlist (god + mass).
  if (spec.agentTargeted) {
    const rawTarget = str(a.agentId) || str(a.target) || str(a.name);
    if (isMassTarget(rawTarget))
      return { ok: false, spoken: `${verb} on all agents at once is voice-forbidden. Do it agent by agent, or use the UI.` };
    const r = resolveAgent(rawTarget, reg);
    if ('error' in r) return { ok: false, spoken: r.error };
    if (r.isGod)
      return { ok: false, spoken: `${verb} on the god orchestrator is voice-forbidden. That has to be done in the UI.` };

    const commit =
      verb === 'kill' ? buildKill(deps, r) : verb === 'pause' ? buildPause(deps, r) : buildHalt(deps, r);
    const breaker = deps.controlSnapshot(r.id);
    const note = breaker?.halted ? ' (note: already halted)' : breaker?.paused ? ' (note: already paused)' : '';
    pending = { verb, confirmWord: spec.confirmWord, targetLabel: r.name, createdAt: Date.now(), commit };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `You asked me to ${verb} ${r.name}${note}. That's destructive. To go ahead, say "confirm" or "${spec.confirmWord}". Say "cancel" to stop.`
    };
  }

  // spawn / hire — expensive; stubbed $ estimate (rt-9 wires the real number).
  if (verb === 'spawn') {
    const provider = (str(a.provider) || 'claude').toLowerCase();
    const role = str(a.role) || str(a.job);
    const name = str(a.name) || (role ? role.replace(/\b\w/g, (c) => c.toUpperCase()) : provider) || 'Worker';
    const godCwd = reg.godId ? reg.agents[reg.godId]?.cwd : undefined;
    const cwd =
      str(a.cwd) || godCwd || Object.values(reg.agents).find((m) => m.cwd)?.cwd || '';
    if (!cwd) return { ok: false, spoken: 'I need a working directory to hire into — none is configured.' };
    const command = str(a.command) || PROVIDER_COMMAND[provider] || 'claude';
    const id = `${slug(name)}-${shortId()}`;
    const spec2: RealtimeSpawnSpec = { id, cwd, command, provider, hive: { id, name, provider, role: role || undefined, cwd } };
    pending = { verb, confirmWord: 'spawn', targetLabel: name, createdAt: Date.now(), commit: buildSpawn(deps, spec2, `${name} on ${provider}`) };
    return {
      ok: true,
      needsConfirm: true,
      // STUB estimate — rt-9 replaces "roughly a few dollars an hour" with a real figure.
      spoken: `You want to hire a new ${provider} agent${role ? ` as ${role}` : ''}, named ${name}. Estimated cost is pending real numbers from the cost guard — roughly a few dollars an hour while it runs. To hire, say "confirm" or "spawn". Say "cancel" to stop.`
    };
  }

  // edit_schedule
  if (verb === 'edit_schedule') {
    const missions = deps.listMissions();
    if (!missions.length) return { ok: false, spoken: 'There are no scheduled missions to edit.' };
    const ref = norm(str(a.missionId) || str(a.schedule) || str(a.label) || str(a.target));
    const m =
      missions.find((x) => x.id.toLowerCase() === ref) ||
      missions.find((x) => (x.label || '').toLowerCase() === ref) ||
      missions.find((x) => (x.label || '').toLowerCase().includes(ref) || x.id.toLowerCase().includes(ref));
    if (!m) return { ok: false, spoken: ref ? `I couldn't find a schedule matching "${str(a.label) || ref}".` : 'Which schedule should I edit?' };
    const raw = norm(str(a.action) || str(a.op));
    const action: 'enable' | 'disable' | 'delete' =
      raw.includes('delete') || raw.includes('remove') ? 'delete' : raw.includes('disable') || raw.includes('off') || raw.includes('pause') ? 'disable' : 'enable';
    pending = {
      verb,
      confirmWord: 'schedule',
      targetLabel: m.label,
      createdAt: Date.now(),
      commit: buildEditSchedule(deps, m, action)
    };
    return {
      ok: true,
      needsConfirm: true,
      spoken: `You want to ${action} the "${m.label}" schedule. To go ahead, say "confirm" or "schedule". Say "cancel" to stop.`
    };
  }

  return { ok: false, spoken: `I don't know how to ${verb}.` };
}

/** Top-level propose/execute for one verb. Soft writes run now; destructive ones
 *  stage a pending and ask for verbal confirm. */
function runAction(deps: RealtimeActionDeps, verb: string, a: Record<string, unknown>): ActionResult {
  if (!deps.hiveEnabled()) return { ok: false, spoken: 'The hive is not configured, so I can\'t take that action.' };
  const spec = VERBS[verb];
  if (!spec) return { ok: false, spoken: `I don't have an action called "${verb}".` };
  // Any new proposal supersedes a stale pending.
  pending = null;
  if (spec.tier === 'soft') {
    switch (verb) {
      case 'ping': return execPing(deps, a);
      case 'dispatch': return execDispatch(deps, a);
      case 'steer': return execSteer(deps, a);
      case 'create_task': return execCreateTask(deps, a);
      case 'assign_task': return execAssignTask(deps, a);
      case 'update_task': return execUpdateTask(deps, a);
      default: return { ok: false, spoken: `I don't know how to ${verb}.` };
    }
  }
  return proposeDestructive(deps, verb, a);
}

// ─── IPC registration ───────────────────────────────────────────────────────

/** rt-5 live-bug instrumentation: write the REAL error + stack to the console AND
 *  the hive log so the NEXT voice repro is self-diagnosing (the model only ever sees
 *  a friendly 'spoken' string, which hides the true failure). Best-effort. */
function logActionFailure(deps: RealtimeActionDeps, channel: string, verb: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[realtime-action] ${channel} verb=${verb} FAILED:`, err.stack || err.message);
  try {
    deps.hiveLog({
      kind: 'voice_action_error',
      actor: VOICE_ACTOR,
      channel,
      verb,
      error: err.message,
      stack: (err.stack || '').slice(0, 800)
    });
  } catch {
    /* never let logging throw into the handler */
  }
}

/**
 * Wire the voice-action IPC. Called once from index.ts with the existing main fns.
 * Channels:
 *   realtime:action          {verb, ...args}  → ActionResult (soft runs now;
 *                                                destructive stages a pending)
 *   realtime:action:confirm  {phrase}         → ActionResult (commits the pending
 *                                                iff the distinct token matches)
 *   realtime:action:cancel   {}               → ActionResult (drops the pending)
 */
export function registerRealtimeActionIpc(deps: RealtimeActionDeps): void {
  ipcMain.handle('realtime:action', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const verb = norm(str(p.verb)).replace(/\s+/g, '_');
    try {
      const res = runAction(deps, verb, p);
      // A non-ok result is an EXPECTED friendly rejection (bad target, hive off, etc.) —
      // log it quietly so a live repro can still be correlated, but it is not an error.
      if (!res.ok) console.warn(`[realtime-action] verb=${verb} rejected: ${res.spoken}`);
      return res;
    } catch (e) {
      logActionFailure(deps, 'realtime:action', verb, e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      return { ok: false, spoken: `That action failed: ${msg}.` } satisfies ActionResult;
    }
  });

  ipcMain.handle('realtime:action:confirm', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const cur = pendingFresh();
    if (!cur) return { ok: false, spoken: 'There\'s nothing waiting to confirm.' } satisfies ActionResult;
    const phrase = str(p.phrase) || str(p.confirm) || str(p.text);
    if (!confirmAccepted(phrase, cur.confirmWord)) {
      return {
        ok: false,
        spoken: `I won't ${cur.verb} ${cur.targetLabel} on that — for safety I need you to say "confirm" or "${cur.confirmWord}", not just yes. Say it clearly, or say cancel.`
      } satisfies ActionResult;
    }
    const commit = cur.commit;
    const verb = cur.verb;
    pending = null; // consume before running so a failure can't be re-confirmed
    try {
      const spoken = await commit();
      return { ok: true, spoken } satisfies ActionResult;
    } catch (e) {
      logActionFailure(deps, 'realtime:action:confirm', verb, e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      return { ok: false, spoken: `That action failed: ${msg}.` } satisfies ActionResult;
    }
  });

  ipcMain.handle('realtime:action:cancel', async () => {
    const had = pendingFresh();
    pending = null;
    return { ok: true, spoken: had ? `Cancelled the ${had.verb}.` : 'Nothing to cancel.' } satisfies ActionResult;
  });
}
