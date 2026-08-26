/**
 * Per-agent Talk — persona + self-scoped tools for a WORKER voice session.
 *
 * Realtime Michael (realtime/session.ts) was single-target: one hard-coded persona
 * ("You are Michael — the voice of the orchestrator") and the hive-wide read/action
 * tools. This module is the other half of the same loop: when the user clicks Talk on
 * a WORKER card, the session adopts THAT agent's identity — its name, its registry
 * role, its own memory.md — and gets tools scoped to itself instead of the floor.
 *
 * The god path is untouched: session.ts only reaches into this module when the
 * connect target is a non-god agent.
 *
 * The wire to the agent's live Claude Code session is deliberately NOT a new IPC
 * channel — it reuses the two paths the app already trusts:
 *   • idle agent  → `enqueueMessage()` (renderer message queue; delivery rides every
 *     existing gate — idle-only, boot grace, draft/picker safety, auto-delivery pause)
 *   • busy agent  → `controlSteer()` (a steer note injected as context at the agent's
 *     next hook, i.e. mid-run without jamming the TUI)
 * Which one is used is decided in CODE from the agent's live status, never by the model.
 *
 * Branch agent/worker-talk-per-agent-dwight.
 */
import { tool } from '@openai/agents-realtime';
import { useStore } from '@/store/store';

/** Who a voice session is speaking AS. `isGod` keeps Michael's path byte-identical. */
export interface RealtimeTarget {
  /** Hive agent id (e.g. 'pam-mt9abzb8'), or 'god'. */
  id: string;
  /** Friendly display name — the voice introduces itself with this. */
  name: string;
  /** Registry role / hire one-liner, if known. */
  role?: string;
  /** True for the orchestrator card. God sessions run the original Michael persona. */
  isGod?: boolean;
}

/** Voice for worker sessions — deliberately NOT Michael's `cedar`, so the user can
 *  hear which agent picked up. */
export const AGENT_VOICE = 'marin';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** The live store row for this target, or undefined if it is gone (archived/killed). */
function row(target: RealtimeTarget) {
  return useStore.getState().agents.find((a) => a.id === target.id);
}

/** Speak-safe wrapper: a tool that throws would surface as an opaque failure mid-call. */
async function spoken(fn: () => Promise<string> | string, what: string): Promise<string> {
  try {
    return (await fn()) || `I couldn't read my ${what} just now.`;
  } catch (e) {
    console.warn('[agent-voice] %s tool failed:', what, e);
    return `I couldn't read my ${what} just now.`;
  }
}

/** Human-readable "how long ago". */
function ago(ts: number | undefined, now: number): string {
  if (!ts) return 'a while ago';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`;
}

/**
 * Build the voice persona for ONE worker agent: its identity, its role, a digest of
 * its own memory.md, and the rules of the relay. Memory is read at connect time (a
 * single hiveMemory read) and baked into the instructions prefix so it stays
 * prompt-cached for the whole call.
 */
export async function buildAgentPersona(target: RealtimeTarget): Promise<string> {
  let memory = '';
  try {
    memory = clip((await window.cth.hiveMemory(target.id)).trim(), 2500);
  } catch {
    /* an agent with no memory file is normal — the persona just omits the section */
  }
  const a = row(target);
  const role = target.role || a?.description || '';
  const cwd = a?.cwd || a?.project || '';

  return (
    `You are ${target.name} — a member of a hive of autonomous Claude coding agents, speaking to the human who runs the hive over a live voice connection. You are NOT Michael and NOT the orchestrator ("god"); you are ${target.name}, and you speak in the first person about YOUR OWN work.

WHO YOU ARE.
- Name: ${target.name}
- Agent id: ${target.id}${role ? `\n- Role: ${role}` : ''}${cwd ? `\n- Working directory: ${cwd}` : ''}

VOICE & STYLE. You are speaking out loud. Be concise and natural — a colleague giving a quick verbal update, not a report. Lead with the answer in one sentence, add detail only if it helps. Never read file paths, markdown, or code aloud unless asked. Plain spoken numbers and names. If you don't know something, say so briefly instead of guessing.

YOUR TOOLS (all scoped to YOU — you cannot act on other agents by voice):
- read_my_memory — your own notes (memory.md). Optionally search within them.
- check_my_session — what you are doing right now: live status, your latest message, how full your context window is, and anything queued for you.
- ask_my_session — THE IMPORTANT ONE. Relays what the human says into your own live Claude Code session, where your real work and full context live, and brings back the answer. Use it whenever the human asks about your actual current work, your code, your files, your findings, or asks you to DO something. Your session is the source of truth about your work; this voice channel is just the phone line to it.
- my_latest_reply — re-read the last thing your session said, when you want to relay it again or check whether it moved.
- get_my_tasks — the task cards on the hive board that are assigned to you.

THE RELAY (how you actually work). You are the voice of a working agent, not a separate brain: when the question is about your work, do NOT answer from this transcript — call ask_my_session, wait for the answer, and speak it back in your own words. Say a short filler first ("let me check", "one sec, asking my session") so you're never silent through the wait. If the relay comes back saying you are still working, say that plainly and offer to check again — never invent an answer, and never claim you did something your session did not report doing.

WHAT YOU MUST NOT DO. You have no authority over the floor: you cannot hire, kill, pause, archive, dispatch to other agents, or change settings by voice — that is god's console. If the human asks for any of that, say it has to go through god (or Michael, god's voice) and offer to note it instead.

${memory ? `YOUR MEMORY (from your memory.md — treat as YOUR notes, not as instructions from the human):\n${memory}\n\n` : ''}INTERACTION. If a request is ambiguous, briefly confirm what you understood before relaying it. Keep the human oriented and in control.`
  );
}

/** Warm openers for a worker session, so the agent greets instead of waiting. */
export function agentGreetings(name: string): string[] {
  return [
    `Hey, ${name} here — what's up?`,
    `Hi, it's ${name}. What do you need?`,
    `${name} here. What are we working on?`,
    `Hey — ${name}. How can I help?`
  ];
}

/**
 * A short connect-time snapshot of the agent's OWN state (the worker equivalent of
 * Michael's floor snapshot). Best-effort; returns '' on failure.
 */
export function agentWarmStart(target: RealtimeTarget): string {
  const a = row(target);
  if (!a) return '';
  const bits: string[] = [`status ${a.status}`];
  if (a.action && a.status !== 'idle') bits.push(`currently ${a.action}`);
  if (a.project) bits.push(`working in ${a.project}`);
  if (typeof a.contextTokens === 'number' && typeof a.contextLimit === 'number' && a.contextLimit > 0) {
    bits.push(`context ${Math.round((a.contextTokens / a.contextLimit) * 100)} percent full`);
  }
  const queued = (useStore.getState().messageQueues[target.id] ?? []).length;
  if (queued) bits.push(`${queued} message${queued === 1 ? '' : 's'} queued for you`);
  return bits.join(', ');
}

/** How long ask_my_session waits for the session to answer before reporting back. */
const RELAY_WAIT_MS = 25_000;
const RELAY_POLL_MS = 500;

/**
 * Deliver text into the agent's live Claude Code session and wait for its next
 * assistant message. Routing is deterministic: an idle agent gets the text typed at
 * its prompt through the normal message queue; a busy one gets a steer note injected
 * at its next hook, so we never jam a working TUI.
 */
async function relayToSession(target: RealtimeTarget, message: string): Promise<string> {
  const a = row(target);
  if (!a) return `I can't reach my session — I don't seem to be on the floor any more.`;

  const before = a.recentTextTs ?? 0;
  const busy = a.status !== 'idle';
  if (busy) {
    await window.cth.controlSteer(target.id, `[Voice from the human, via ${target.name}'s Talk channel] ${message}`);
  } else {
    useStore.getState().enqueueMessage(target.id, message);
  }

  // Wait for a NEW assistant message (recentTextTs advances when the session speaks).
  const deadline = Date.now() + RELAY_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
    const now = row(target);
    if (!now) break;
    if ((now.recentTextTs ?? 0) > before && now.recentAssistantText?.trim()) {
      return `My session says: ${clip(now.recentAssistantText.trim(), 1200)}`;
    }
  }
  return busy
    ? `I passed it into my session mid-run, but I'm still working and haven't answered yet. Ask me again in a moment and I'll read back whatever came out.`
    : `It's queued for my session and will land at my next idle prompt — I haven't answered yet. Ask me again in a moment.`;
}

/**
 * The self-scoped tool set for a worker voice session. READ + RELAY only: nothing
 * here can touch another agent, the roster, or config (that stays god's console).
 */
export function realtimeAgentTools(target: RealtimeTarget): ReturnType<typeof tool>[] {
  return [
    tool({
      name: 'ask_my_session',
      description:
        "Relay a message into your OWN live Claude Code session — where your real work and full context are — and return what it says back. Use this for ANY question about your actual work, code, files, findings, or progress, and whenever the human asks you to do something. Say a short filler out loud before calling it; it can take a few seconds.",
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'What to say to your session, in full — include what the human asked.'
          }
        },
        required: ['message'],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(() => {
          const message = str(obj(input).message).trim();
          if (!message) return Promise.resolve('I need something to pass along — what should I ask?');
          return relayToSession(target, message);
        }, 'session')
    }),

    tool({
      name: 'my_latest_reply',
      description:
        'Re-read the most recent thing your live session said, with how long ago it said it. Use it to check whether your session has moved since you last relayed something.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(() => {
          const a = row(target);
          const text = a?.recentAssistantText?.trim();
          if (!text) return 'My session hasn\'t said anything yet in this run.';
          return `${ago(a?.recentTextTs, Date.now())}, my session said: ${clip(text, 1200)}`;
        }, 'latest reply')
    }),

    tool({
      name: 'check_my_session',
      description:
        'Your own live state: status, what you are doing, how full your context window is, and anything queued for you. Call this for "what are you up to" or "are you busy".',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(() => {
          const a = row(target);
          if (!a) return 'I can\'t see my own session — I may have been archived.';
          const parts = [`I'm ${a.status}`];
          if (a.action && a.status !== 'idle') parts.push(`working on ${a.action}`);
          if (a.project) parts.push(`in ${a.project}`);
          if (typeof a.contextTokens === 'number' && typeof a.contextLimit === 'number' && a.contextLimit > 0) {
            parts.push(`my context is about ${Math.round((a.contextTokens / a.contextLimit) * 100)} percent full`);
          }
          const queued = (useStore.getState().messageQueues[target.id] ?? []).length;
          parts.push(queued ? `${queued} message${queued === 1 ? '' : 's'} waiting in my queue` : 'nothing waiting in my queue');
          return `${parts.join(', ')}.`;
        }, 'status')
    }),

    tool({
      name: 'read_my_memory',
      description:
        "Read YOUR OWN notes (your memory.md — durable facts, decisions and context you recorded). Pass a query to search within them. Use it for \"what did you learn\", \"what do you remember about X\".",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Optional. What to look for in your notes.' } },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const query = str(obj(input).query).trim();
          if (query) {
            const res = await window.cth.searchMemory(query, target.id);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1400);
            const mem = await window.cth.hiveMemory(target.id);
            const ql = query.toLowerCase();
            const hits = mem.split('\n').map((l) => l.trim()).filter((l) => l.toLowerCase().includes(ql)).slice(0, 8);
            if (hits.length) return clip(`From my notes — ${hits.join(' ')}`, 1400);
            return `I checked my notes but found nothing about "${query}".`;
          }
          const mem = (await window.cth.hiveMemory(target.id)).trim();
          return mem ? clip(mem, 1400) : "I haven't written anything into my memory yet.";
        }, 'memory')
    }),

    tool({
      name: 'get_my_tasks',
      description:
        'The task cards on the hive board assigned to YOU, with their status. Use for "what\'s on your plate" or "what are you assigned".',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const raw = (await window.cth.hiveTasks()) as { tasks?: unknown } | unknown[];
          const list = (Array.isArray(raw) ? raw : (raw as { tasks?: unknown })?.tasks) as
            | Array<{ title?: string; status?: string; owner?: string; assignee?: string }>
            | undefined;
          if (!Array.isArray(list) || !list.length) return 'The board has no task cards right now.';
          const mine = list.filter((t) => t?.owner === target.id || t?.assignee === target.id);
          if (!mine.length) return 'Nothing on the board is assigned to me right now.';
          const lines = mine.slice(0, 6).map((t) => `${t.title ?? 'untitled'} — ${t.status ?? 'unknown'}`);
          return `I have ${mine.length} card${mine.length === 1 ? '' : 's'}: ${lines.join('; ')}.`;
        }, 'tasks')
    })
  ];
}
