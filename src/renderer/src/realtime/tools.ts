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

/** The trailing folder name of a path — speech-friendly (the persona avoids
 *  reading full file paths aloud unless asked). e.g. /a/b/cth-voice-tools → cth-voice-tools. */
function shortDir(p: string): string {
  const parts = (p || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Strip markdown to plain speakable prose (headers, emphasis, bullets, links,
 *  code fences) and collapse whitespace. */
function despan(md: string): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
        'How much the hive is USING this session: total tokens across all agents, plus the top users. Reported in tokens (no dollar figures). Call this when the user asks about usage or token consumption.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const snap = await window.cth.telemetrySnapshot();
          const usage = Array.isArray(snap.usage) ? snap.usage : [];
          if (!usage.length) return 'No token usage has been recorded this session yet.';
          let totIn = 0;
          let totOut = 0;
          const perAgent = new Map<string, number>();
          for (const s of usage) {
            const m = obj(s);
            const inTok = typeof m.input === 'number' ? m.input : 0;
            const outTok = typeof m.output === 'number' ? m.output : 0;
            totIn += inTok;
            totOut += outTok;
            const id = str(m.agentId) || 'unknown';
            perAgent.set(id, (perAgent.get(id) ?? 0) + inTok + outTok);
          }
          const top = [...perAgent.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([id, tok]) => `${id} at ${tokens(tok)} tokens`);
          return `So far this session the hive has used ${tokens(totIn)} input and ${tokens(totOut)} output tokens across ${plural(
            perAgent.size,
            'agent'
          )}.${top.length ? ` Top users: ${top.join(', ')}.` : ''}`;
        }, 'token usage')
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
          // De-monetized: report only the token cap (no dollar cap), and avoid
          // money words. The $ runaway guard still exists + fires; it just isn't spoken.
          if (typeof c.costCapTokens === 'number' && c.costCapTokens > 0)
            parts.push(`Token cap: ${tokens(c.costCapTokens)} tokens.`);
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
        "Read the team's memory. You can ALWAYS answer with this — it never dead-ends. Pass a query to search everything the hive has learned; pass an agentId to read ONE agent's notes (works for any agent, active OR archived); pass BOTH to search within that one agent's notes; pass neither for memory status. Semantic search is used when available, otherwise a direct text search across every agent's memory file. Call this whenever the user asks what the team learned, remembered, decided, or noted.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Optional. What to search for across the team's memory." },
          agentId: { type: 'string', description: "Optional. An agent id to read or scope the search to — any agent, active or archived." }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const query = str(a.query).trim();
          const agentId = str(a.agentId).trim();

          // Direct text fallback across every agent's memory.md (INCLUDING archived
          // agents), the board, and tasks — works with or without the semantic
          // memory CLI, so a query can never dead-end. Optionally narrow to one agent.
          const textFallback = async (q: string, onlyAgent?: string): Promise<string> => {
            const res = await window.cth.textSearch(q);
            if (!res.ok || !res.results.length) return '';
            let hits = res.results;
            if (onlyAgent) hits = hits.filter((r) => r.source.startsWith(`${onlyAgent}/`) || r.source === onlyAgent);
            if (!hits.length) return '';
            const bySource = new Map<string, string[]>();
            for (const r of hits.slice(0, 14)) {
              const who = r.source.replace(/\/memory\.md$/, '');
              if (!bySource.has(who)) bySource.set(who, []);
              bySource.get(who)!.push(r.excerpt);
            }
            const lines = [...bySource.entries()].slice(0, 6).map(([who, ex]) => `${who} noted ${ex.slice(0, 2).join('; ')}`);
            return `From the team's notes — ${lines.join('. ')}.`;
          };

          // query + agentId → search WITHIN one agent (semantic wing first, then text).
          if (query && agentId) {
            const res = await window.cth.searchMemory(query, agentId);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query, agentId);
            if (tf) return clip(tf, 1600);
            const mem = await window.cth.hiveMemory(agentId);
            const ql = query.toLowerCase();
            const matched = mem.split('\n').map((l) => l.trim()).filter((l) => l.toLowerCase().includes(ql)).slice(0, 8);
            if (matched.length) return clip(`From ${agentId}'s memory — ${matched.join(' ')}`, 1600);
            return mem.trim()
              ? `I read ${agentId}'s memory but found nothing about "${query}".`
              : `${agentId} has not recorded any memory yet.`;
          }

          // query alone → semantic across the whole palace, then text fallback across all agents.
          if (query) {
            const res = await window.cth.searchMemory(query);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query);
            if (tf) return clip(tf, 1600);
            return `I searched the team's memory but found nothing about "${query}".`;
          }

          // agentId alone → read that agent's notes directly (any agent, active OR archived).
          if (agentId) {
            const mem = await window.cth.hiveMemory(agentId);
            return mem.trim() ? clip(mem.trim(), 1600) : `${agentId} has not recorded any memory yet.`;
          }

          // neither → status, but make clear search always works.
          const status = await window.cth.memoryStatus();
          const sem = status.active
            ? 'Semantic memory is active'
            : status.available
            ? 'Semantic memory is enabled but idle'
            : 'Semantic memory is offline';
          return `${sem} — but I can always text-search every agent's notes, active or archived. Ask me to search a topic, or name an agent to read their memory.`;
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
    }),

    // ── get_messages ──────────────────────────────────────────────────────
    tool({
      name: 'get_messages',
      description:
        "Read the actual CONTENT of hive messages — what agents have said to each other in their inboxes and outboxes, not just that an event happened. Use this when the user wants to know what a message SAID, what someone asked or reported, or to catch up on the latest traffic. Pass an agentId to focus on one agent's mailbox, pass a messageId to read one specific message in full, or pass neither for the most recent messages across the whole floor. Secrets and keys are always stripped before you see them, so quote bodies freely.",
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: "Optional. Focus on one agent's inbox and outbox (id or, if you have it, the exact id)." },
          messageId: { type: 'string', description: 'Optional. Read one specific message in full by its id.' },
          limit: { type: 'number', description: 'Optional. How many recent messages to summarize (default 8, max 40).' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const agentId = str(a.agentId).trim();
          const messageId = str(a.messageId).trim();
          const limit = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 8;

          // Speak one message's body relative to a perspective. from→to + subject + body.
          const speakOne = (m: { from: string; to: string; subject: string; body: string; created_at: string; requires_reply: boolean }, full: boolean): string => {
            const subj = str(m.subject).trim();
            const body = despan(str(m.body)).trim();
            const head = `${str(m.from) || 'someone'} to ${str(m.to) || 'someone'}${subj ? ` about "${clip(subj, 80)}"` : ''} ${ago(Date.parse(m.created_at))}`;
            if (!body) return `${head}, with no body.`;
            return `${head}: ${clip(body, full ? 700 : 220)}${m.requires_reply ? ' (a reply was requested)' : ''}`;
          };

          if (messageId) {
            const found = await window.cth.hiveMessages({ id: messageId });
            if (!found.length) return `I couldn't find a message with id ${messageId}.`;
            return `That message — ${speakOne(found[0], true)}.`;
          }

          const msgs = await window.cth.hiveMessages(agentId ? { agentId, limit } : { limit });
          if (!msgs.length)
            return agentId ? `I don't see any messages in ${agentId}'s mailbox.` : 'There are no hive messages to read yet.';
          const scope = agentId ? `${agentId}'s mailbox` : 'the floor';
          const lines = msgs.slice(0, limit).map((m) => speakOne(m, false));
          return `${plural(lines.length, 'recent message')} from ${scope}: ${lines.join('. ')}.`;
        }, 'messages')
    }),

    // ── get_agent_detail ──────────────────────────────────────────────────
    tool({
      name: 'get_agent_detail',
      description:
        'Everything known about ONE agent: name, role, the engine and model it runs, its working directory, whether it is active or archived, its live status, how full its context window is, how many tokens it has used, its circuit-breaker state, what it last did, and whether it has recorded memory. Call this when the user asks about a specific agent — where it is working, which directory it is in, how it is doing, or for its full status. Accepts an id or a name.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'The agent id or friendly name to look up (e.g. "kevin-mqpbq43v" or "Kevin").' }
        },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = str(a.agentId).trim().toLowerCase();
          if (!want) return 'Tell me which agent you mean.';
          const dir = await window.cth.hiveAgentDirectory();
          const list = Array.isArray(dir.agents) ? dir.agents : [];
          const e =
            list.find((x) => x.id.toLowerCase() === want) ??
            list.find((x) => x.name.toLowerCase() === want) ??
            list.find((x) => x.id.toLowerCase().startsWith(want) || x.name.toLowerCase().startsWith(want));
          if (!e) return `I don't see an agent matching "${str(a.agentId)}".`;
          const parts: string[] = [];
          const role = e.role ? `, the ${e.role},` : '';
          const where = e.archived
            ? 'archived — its terminal is closed, but its working directory and memory are still here'
            : `active and ${e.status}`;
          parts.push(`${e.name}${role} runs on ${e.provider}${e.model ? ` with model ${e.model}` : ''}, ${where}.`);
          if (e.cwd)
            parts.push(
              `Working directory: ${e.cwd}${e.cwdValid === false ? ', which is not a valid directory — spawning there would fail' : ''}.`
            );
          if (typeof e.contextPct === 'number') parts.push(`Its context window is ${e.contextPct} percent full.`);
          else if (typeof e.contextTokens === 'number') parts.push(`It is carrying ${tokens(e.contextTokens)} tokens of context.`);
          if (e.tokens) parts.push(`It has used ${tokens(e.tokens)} tokens so far.`);
          parts.push(`Circuit breaker: ${e.breaker}.`);
          if (e.lastTool) parts.push(`Last tool was ${e.lastTool}${typeof e.lastActiveSecAgo === 'number' ? `, ${ago(Date.now() - e.lastActiveSecAgo * 1000)}` : ''}.`);
          if (e.inboxBacklog) parts.push(`${plural(e.inboxBacklog, 'message')} waiting in its inbox.`);
          parts.push(e.hasMemory ? "It has recorded memory — ask me to read it." : 'It has not recorded much memory yet.');
          return parts.join(' ');
        }, 'agent detail')
    }),

    // ── list_agents ───────────────────────────────────────────────────────
    tool({
      name: 'list_agents',
      description:
        'The FULL roster, including archived (inactive) agents: each one\'s name, engine, active-or-archived state, working directory, context fill, and breaker state. Use this to enumerate EVERYONE (including inactive agents), or to answer "where is X working", "who is archived", or "who is near their context limit". For live workers only, get_fleet_status is lighter.',
      parameters: {
        type: 'object',
        properties: {
          includeArchived: { type: 'boolean', description: 'Default true. Set false to list only active agents.' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const includeArchived = a.includeArchived !== false;
          const dir = await window.cth.hiveAgentDirectory();
          const all = Array.isArray(dir.agents) ? dir.agents : [];
          if (!all.length) return 'The hive has no registered agents.';
          const active = all.filter((e) => !e.archived);
          const archived = all.filter((e) => e.archived);
          const near = active
            .filter((e) => typeof e.contextPct === 'number' && e.contextPct >= 70)
            .map((e) => `${e.name} at ${e.contextPct} percent`);
          const describe = (e: typeof all[number]): string =>
            `${e.name} on ${e.provider}${e.cwd ? ` in ${shortDir(e.cwd)}` : ''}${
              typeof e.contextPct === 'number' ? `, context ${e.contextPct} percent` : ''
            }`;
          const parts: string[] = [];
          parts.push(
            `${plural(active.length, 'active agent')}${archived.length ? ` and ${plural(archived.length, 'archived agent')}` : ''}.`
          );
          if (active.length) parts.push(`Active: ${active.slice(0, 12).map(describe).join('; ')}.`);
          if (includeArchived && archived.length)
            parts.push(
              `Archived: ${archived
                .slice(0, 12)
                .map((e) => `${e.name}${e.cwd ? ` (last in ${shortDir(e.cwd)})` : ''}`)
                .join('; ')}.`
            );
          if (near.length) parts.push(`Near their context limit: ${near.join(', ')}.`);
          return parts.join(' ');
        }, 'agent roster')
    }),

    // ── get_board ─────────────────────────────────────────────────────────
    tool({
      name: 'get_board',
      description:
        'The hive plan narrative — the human-readable board the orchestrator keeps in prose (the current plan, priorities, and notes). Call this when the user asks about the plan, the strategy, the roadmap, or what the board says.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const board = await window.cth.hiveBoard();
          const text = despan(board || '');
          if (!text) return 'The board is empty right now.';
          return clip(text, 1800);
        }, 'board')
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
    // rt-7: also pull the recent hive log so the warm-start carries what the OTHER
    // orchestrator (god) + the floor have just been doing — dual-orchestrator awareness
    // so voice-Michael doesn't duplicate or contradict god's moves.
    const [reg, tasksRaw, logRaw] = await Promise.all([
      window.cth.hiveRegistry(),
      window.cth.hiveTasks(),
      window.cth.hiveLog(20).catch(() => [] as unknown[])
    ]);
    const agents = Object.entries(obj(reg.agents));
    const active = agents.filter(([, a]) => !obj(a).archived).length;
    const godName = reg.godId ? str(obj(obj(reg.agents)[reg.godId]).name) || reg.godId : null;
    const list = Array.isArray(obj(tasksRaw).tasks) ? (obj(tasksRaw).tasks as unknown[]) : [];
    const doing = list.map(obj).filter((t) => str(t.status) === 'doing').length;
    const blocked = list.map(obj).filter((t) => str(t.status) === 'blocked').length;
    // Last few meaningful events (spawns, messages, voice actions), newest first.
    const events = Array.isArray(logRaw) ? logRaw : [];
    const recent = events
      .slice(-6)
      .reverse()
      .map((e) => {
        const o = obj(e);
        const kind = str(o.kind) || str(o.event) || 'event';
        const who = str(o.actor) || str(o.from) || str(o.agentId) || str(o.name);
        return who ? `${kind} by ${who}` : kind;
      })
      .filter(Boolean);
    const activity = recent.length ? ` Recent floor activity: ${recent.join('; ')}.` : '';
    return (
      `Current hive snapshot: ${plural(active, 'agent')} active` +
      `${godName ? `, ${godName} orchestrating alongside you` : ''}; ` +
      `${doing} task${doing === 1 ? '' : 's'} in progress` +
      `${blocked ? ` and ${plural(blocked, 'blocked')}` : ''}.` +
      activity +
      ` You share the floor with god (the typing orchestrator) — before you dispatch or create work,` +
      ` glance at recent activity so you don't duplicate what god just did. Use your read-tools for live detail.`
    );
  } catch {
    return '';
  }
}
