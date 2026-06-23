/**
 * Realtime Michael — read-tools (rt-4, Realtime Michael Phase 1).
 *
 * The real function-tools that replace rt-2's placeholder no-op. Each one is a
 * thin, READ-ONLY wrapper over a window.cth bridge that already powers the office
 * floor UI, formatted as short spoken prose — a TTS voice reads these aloud, so
 * there is no markdown, no bullet characters, and no asterisks. Phase 1 is
 * read-only by construction: there is not a single mutating call in this file
 * (action-tools are rt-5, held).
 *
 * SECURITY: tools run in the RENDERER and only touch already-exposed read IPC.
 * The real OpenAI key never appears here (rt-1's mint keeps it main-only). And
 * get_config NEVER dumps HarnessConfig — that object carries secrets
 * (groqApiKey, slack/webhook tokens); we surface a hand-picked, non-sensitive
 * allowlist only.
 *
 * INTEGRATION (rt-2's src/renderer/src/realtime/session.ts — Jim's file):
 *   import { realtimeReadTools, realtimeSessionSummary } from './tools';
 *   ...
 *   tools: realtimeReadTools()            // swap for placeholderTools() at the `tools:` field
 * and optionally prepend `await realtimeSessionSummary()` to the agent instructions
 * for a warm-start orientation. The agent_tool_start / agent_tool_end mic-idle
 * lifecycle in session.ts is tool-agnostic, so it survives the swap unchanged.
 */
import { tool } from '@openai/agents-realtime';

// ─── spoken-prose formatting helpers ────────────────────────────────────────

/** Relative "x ago" for a unix-ms timestamp; voice-safe and defensive. */
function ago(ts: unknown): string {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return 'an unknown time ago';
  const ms = Date.now() - ts;
  if (ms < 5_000) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Humanize an interval in ms into spoken cadence ("every 5 minutes"). */
function every(ms: unknown): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return 'on an unknown cadence';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'every minute or less';
  if (m < 60) return `every ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return `every ${h} hour${h === 1 ? '' : 's'}`;
}

function money(n: unknown): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2));
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Compact a big number for speech (1.2 thousand / 3.4 million). */
function tokens(n: unknown): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} million`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)} thousand`;
  return `${Math.round(v)}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + ' (truncated)' : s;
}

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};

const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** Wrap a tool body so a read failure degrades to a spoken sentence rather than
 *  rejecting the model's tool call. */
async function spoken(fn: () => Promise<string>, what: string): Promise<string> {
  try {
    const out = (await fn()).trim();
    return out || `I could not find any ${what} right now.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'an unknown error';
    return `I could not read the ${what} just now (${msg}).`;
  }
}

// ─── the read-tools ──────────────────────────────────────────────────────────

/**
 * The real Phase-1 read-tools. Returned as an array so rt-2's session can pass it
 * straight to `tools:` in place of placeholderTools().
 */
export function realtimeReadTools(): ReturnType<typeof tool>[] {
  return [
    // ── get_fleet_status ──────────────────────────────────────────────────
    tool({
      name: 'get_fleet_status',
      description:
        'Who is in the agent hive right now: how many agents, which are active versus archived, who the god orchestrator is, and each active agent name, role, and engine. Call this when the user asks who is working, who is on the floor, or for a roster.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const reg = await window.cth.hiveRegistry();
          const entries = Object.entries(obj(reg.agents));
          if (!entries.length) return 'The hive has no registered agents yet.';
          const active = entries.filter(([, a]) => !obj(a).archived);
          const archived = entries.length - active.length;
          const godId = reg.godId;
          const godName = godId ? str(obj(obj(reg.agents)[godId]).name) || godId : null;
          const lines = active
            .filter(([id]) => id !== godId)
            .map(([, a]) => {
              const m = obj(a);
              const name = str(m.name) || 'an unnamed agent';
              const role = str(m.role);
              const provider = str(m.provider) || 'claude';
              const status = str(m.status) || 'unknown';
              return `${name}${role ? `, the ${role},` : ''} on ${provider} (${status})`;
            });
          const head = `There ${active.length === 1 ? 'is' : 'are'} ${plural(active.length, 'agent')} active${
            archived ? ` and ${plural(archived, 'archived agent')}` : ''
          }.`;
          const god = godName ? ` ${godName} is the god orchestrator.` : '';
          const roster = lines.length ? ` Active workers: ${lines.join('; ')}.` : '';
          return head + god + roster;
        }, 'fleet status')
    }),

    // ── get_tasks ─────────────────────────────────────────────────────────
    tool({
      name: 'get_tasks',
      description:
        'The current task board: how many tasks are todo, in progress, blocked, and done, plus the titles and owners of the in-progress and blocked ones. Optionally filter by a single status. Call this when the user asks what the team is working on, what is blocked, or about progress.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['todo', 'doing', 'blocked', 'done'],
            description: 'Optional. Restrict the answer to one status.'
          }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const filter = typeof a.status === 'string' ? a.status : null;
          const raw = await window.cth.hiveTasks();
          const list = Array.isArray(obj(raw).tasks) ? (obj(raw).tasks as unknown[]) : [];
          if (!list.length) return 'The task board is empty.';
          const tasks = list.map(obj);
          const by = (s: string): Record<string, unknown>[] => tasks.filter((t) => str(t.status) === s);
          const counts = `${plural(by('todo').length, 'to do')}, ${by('doing').length} in progress, ${plural(
            by('blocked').length,
            'blocked'
          )}, and ${by('done').length} done`;
          const describe = (t: Record<string, unknown>): string => {
            const who = str(t.assignee);
            return `"${clip(str(t.title) || str(t.id) || 'untitled', 90)}"${who ? ` (${who})` : ''}`;
          };
          if (filter) {
            const sel = by(filter);
            if (!sel.length) return `Nothing is ${filter} right now. Overall: ${counts}.`;
            return `${plural(sel.length, 'task')} ${filter}: ${sel.slice(0, 12).map(describe).join('; ')}.`;
          }
          const doing = by('doing');
          const blocked = by('blocked');
          const detail = [
            doing.length ? `In progress: ${doing.slice(0, 8).map(describe).join('; ')}.` : '',
            blocked.length ? `Blocked: ${blocked.slice(0, 8).map(describe).join('; ')}.` : ''
          ]
            .filter(Boolean)
            .join(' ');
          return `There ${tasks.length === 1 ? 'is' : 'are'} ${plural(tasks.length, 'task')}: ${counts}.${
            detail ? ' ' + detail : ''
          }`;
        }, 'task board')
    }),

    // ── get_cost ──────────────────────────────────────────────────────────
    tool({
      name: 'get_cost',
      description:
        'What the hive is spending this session: total dollars and tokens across all agents, plus the top spenders. Call this when the user asks about cost, spend, budget, or token usage.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const snap = await window.cth.telemetrySnapshot();
          const usage = Array.isArray(snap.usage) ? snap.usage : [];
          if (!usage.length) return 'No spend has been recorded this session yet.';
          let totUsd = 0;
          let totIn = 0;
          let totOut = 0;
          const perAgent = new Map<string, number>();
          for (const s of usage) {
            const m = obj(s);
            const usd = typeof m.usd === 'number' ? m.usd : 0;
            totUsd += usd;
            totIn += typeof m.input === 'number' ? m.input : 0;
            totOut += typeof m.output === 'number' ? m.output : 0;
            const id = str(m.agentId) || 'unknown';
            perAgent.set(id, (perAgent.get(id) ?? 0) + usd);
          }
          const top = [...perAgent.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([id, usd]) => `${id} at ${money(usd)}`);
          return `So far this session the hive has spent ${money(totUsd)} across ${plural(
            perAgent.size,
            'agent'
          )}, using ${tokens(totIn)} input and ${tokens(totOut)} output tokens.${
            top.length ? ` Top spenders: ${top.join(', ')}.` : ''
          }`;
        }, 'cost ledger')
    }),

    // ── get_schedules ─────────────────────────────────────────────────────
    tool({
      name: 'get_schedules',
      description:
        'The recurring scheduled missions the hive fires on a timer: their labels, cadence, recipient, and when each last fired. Call this when the user asks about schedules, recurring jobs, heartbeats, or automations.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const missions = await window.cth.listMissions();
          const list = Array.isArray(missions) ? missions : [];
          if (!list.length) return 'There are no scheduled missions configured.';
          const enabled = list.filter((m) => obj(m).enabled);
          if (!enabled.length) return `There are ${plural(list.length, 'scheduled mission')}, but all are disabled.`;
          const lines = enabled.slice(0, 8).map((m) => {
            const o = obj(m);
            const label = str(o.label) || 'a mission';
            const to = str(o.to);
            const last = o.lastFiredAt ? `, last fired ${ago(o.lastFiredAt)}` : ', not fired yet';
            return `${label} ${every(o.intervalMs)}${to ? ` to ${to}` : ''}${last}`;
          });
          return `There ${enabled.length === 1 ? 'is' : 'are'} ${plural(
            enabled.length,
            'active scheduled mission'
          )}: ${lines.join('; ')}.`;
        }, 'schedules')
    }),

    // ── get_config ────────────────────────────────────────────────────────
    tool({
      name: 'get_config',
      description:
        'The non-sensitive hive settings: autonomy mode, the default model and god engine, budget caps, worker limits, the circuit breaker, and which features are on. Never returns secrets or API keys. Call this when the user asks how the hive is configured, what the limits or budgets are, or whether a feature is enabled.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const c = await window.cth.getConfig();
          // Hand-picked NON-SENSITIVE allowlist. Never iterate the object — it
          // carries groqApiKey, slack/webhook tokens, and signing secrets. Read
          // through obj() so the renderer's HarnessConfig mirror can lag the main
          // one (it is hand-mirrored across three files) without breaking us.
          const cc = obj(c);
          const parts: string[] = [];
          parts.push(`Autonomy mode is ${c.autoMode ? 'on' : 'off'}.`);
          if (c.defaultModel) parts.push(`The default model is ${c.defaultModel}.`);
          if (c.godProvider || c.godModel)
            parts.push(`The god orchestrator runs ${[c.godProvider, c.godModel].filter(Boolean).join(' ')}.`);
          if (typeof cc.maxConcurrentWorkers === 'number')
            parts.push(`Up to ${plural(cc.maxConcurrentWorkers, 'worker')} run concurrently.`);
          const caps: string[] = [];
          if (typeof c.costCapUsd === 'number' && c.costCapUsd > 0) caps.push(`${money(c.costCapUsd)}`);
          if (typeof c.costCapTokens === 'number' && c.costCapTokens > 0) caps.push(`${tokens(c.costCapTokens)} tokens`);
          if (caps.length) parts.push(`Budget caps: ${caps.join(' and ')}.`);
          const breakerOn = obj(c.circuitBreaker).enabled;
          parts.push(`The circuit breaker is ${breakerOn ? 'enabled' : 'off'}.`);
          parts.push(`Desktop notifications are ${c.notifications ? 'on' : 'off'}.`);
          const features = [
            c.slackEnabled && 'Slack',
            c.webhookEnabled && 'webhooks',
            c.freeflowEnabled && 'Free Flow voice',
            c.realtimeVoiceEnabled && 'realtime voice (this session)',
            c.semanticMemory && 'semantic memory',
            obj(c.knowledgeGraph).enabled && 'the knowledge graph'
          ].filter(Boolean);
          if (features.length) parts.push(`Enabled features: ${features.join(', ')}.`);
          return parts.join(' ');
        }, 'configuration')
    }),

    // ── get_memory ────────────────────────────────────────────────────────
    tool({
      name: 'get_memory',
      description:
        'Search the shared team memory, or read one agent saved notes. Pass a query to semantically search everything the hive has learned; pass an agentId to read that agent memory file; pass neither for memory system status. Call this when the user asks what the team learned, remembered, or decided.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional. A natural-language search over the shared memory palace.' },
          agentId: { type: 'string', description: 'Optional. An agent id to read that agent saved memory notes.' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const query = str(a.query).trim();
          const agentId = str(a.agentId).trim();
          if (query) {
            const res = await window.cth.searchMemory(query);
            if (!res.ok) return `Memory search is unavailable right now${res.error ? ` (${res.error})` : ''}.`;
            return res.output.trim() ? clip(res.output.trim(), 1600) : `I found nothing in memory for "${query}".`;
          }
          if (agentId) {
            const mem = await window.cth.hiveMemory(agentId);
            return mem.trim() ? clip(mem.trim(), 1600) : `${agentId} has not recorded any memory yet.`;
          }
          const status = await window.cth.memoryStatus();
          if (!status.available) return 'The semantic memory system is not available in this build.';
          if (!status.active)
            return `Memory is ${status.enabled ? 'enabled but not active' : 'disabled'}. Ask me to search a topic and I will try.`;
          return 'Memory is active. Ask me to search for a topic, or name an agent to read their notes.';
        }, 'memory')
    }),

    // ── get_activity ──────────────────────────────────────────────────────
    tool({
      name: 'get_activity',
      description:
        'The most recent hive activity log: spawns, archives, messages, and other lifecycle events, newest first. Call this when the user asks what just happened, for recent activity, or for a play-by-play.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Optional. How many recent events to summarize (default 12, max 40).' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 12;
          const log = await window.cth.hiveLog(want);
          const list = Array.isArray(log) ? log : [];
          if (!list.length) return 'There is no recorded hive activity yet.';
          const lines = list
            .slice(-want)
            .reverse()
            .map((e) => {
              const o = obj(e);
              const kind = str(o.kind) || str(o.event) || 'event';
              const who = str(o.agentId) || str(o.name) || str(o.from);
              const when = ago(o.ts);
              return `${kind}${who ? ` by ${who}` : ''} ${when}`;
            });
          return `Most recent activity: ${lines.join('; ')}.`;
        }, 'activity log')
    })
  ];
}

/**
 * A short, preloaded orientation Michael can open the session with — the hive
 * size, who god is, and how many tasks are in flight — so the first answer is
 * grounded without a tool round-trip. Best-effort: returns '' if reads fail, so
 * the caller can safely concatenate it onto the agent instructions.
 */
export async function realtimeSessionSummary(): Promise<string> {
  try {
    const [reg, tasksRaw] = await Promise.all([window.cth.hiveRegistry(), window.cth.hiveTasks()]);
    const agents = Object.entries(obj(reg.agents));
    const active = agents.filter(([, a]) => !obj(a).archived).length;
    const godName = reg.godId ? str(obj(obj(reg.agents)[reg.godId]).name) || reg.godId : null;
    const list = Array.isArray(obj(tasksRaw).tasks) ? (obj(tasksRaw).tasks as unknown[]) : [];
    const doing = list.map(obj).filter((t) => str(t.status) === 'doing').length;
    const blocked = list.map(obj).filter((t) => str(t.status) === 'blocked').length;
    return (
      `Current hive snapshot: ${plural(active, 'agent')} active` +
      `${godName ? `, ${godName} orchestrating` : ''}; ` +
      `${doing} task${doing === 1 ? '' : 's'} in progress` +
      `${blocked ? ` and ${plural(blocked, 'blocked')}` : ''}. ` +
      `Use your read-tools for live detail before answering specifics.`
    );
  } catch {
    return '';
  }
}
