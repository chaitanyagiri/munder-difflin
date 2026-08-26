/**
 * Realtime Michael — renderer voice session (card rt-2, Phase 1 = READ-ONLY voice).
 *
 * The voice orchestrator runs IN THE RENDERER over WebRTC, talking speech-to-speech
 * to OpenAI `gpt-realtime-2`. The renderer never holds the real OpenAI key: it asks
 * MAIN to mint a short-lived EPHEMERAL client secret (`realtime:mintToken`, see
 * src/main/realtime.ts) and connects with THAT.
 *
 * We drive a CUSTOM `OpenAIRealtimeWebRTC` transport (not the bare `'webrtc'` string)
 * so we can: (a) open the mic ourselves with echo-cancellation + noise-suppression +
 * auto-gain (and honor the device the user picked — Oscar's rt-8 seam), and (b) own
 * the <audio> sink for playback. Turn-taking uses semantic VAD with barge-in (the
 * model truncates when the user talks over it).
 *
 * Phase 1 is a read-only connect→listen→respond round-trip. The agent runs Kevin's
 * rt-4 READ-ONLY tools (get_fleet_status / get_tasks / get_cost / get_triggers /
 * get_config / get_memory / get_activity) and god's rt-6 "Michael" persona, so the
 * agent_tool_start/agent_tool_end lifecycle fires and the mic goes idle during a tool
 * call and resumes — a Phase-1 acceptance criterion. NO hive action-tools yet (rt-5, held).
 *
 * Shape mirrors freeflow/recorder.ts: a single module-level session (only ONE voice
 * loop at a time) exposed through a `useRealtimeMichael()` hook via useSyncExternalStore.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useSyncExternalStore } from 'react';
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from '@openai/agents-realtime';
import { realtimeReadTools, realtimeSessionSummary } from './tools';
import { realtimeActionTools } from './actions';
import {
  AGENT_VOICE,
  agentGreetings,
  agentWarmStart,
  buildAgentPersona,
  realtimeAgentTools,
  type RealtimeTarget
} from './agentVoice';
import { resetRealtimeCost, recordRealtimeUsage, endRealtimeCost, isRealtimeIdle, getRealtimeCostSnapshot } from './costStore';

/**
 * Voice-loop state machine:
 *   off        — no session (initial / after disconnect / fatal error)
 *   connecting — minting token + opening the WebRTC connection
 *   listening  — connected, mic live, waiting for / hearing the user
 *   responding — the model is generating / speaking audio back
 *   working    — a tool call is in flight; mic is muted until it returns
 */
export type RealtimeStatus = 'off' | 'connecting' | 'listening' | 'responding' | 'working';

export interface RealtimeMichaelState {
  status: RealtimeStatus;
  /** Last error (no key, mint failure, mic denied, transport error…). Cleared on connect. */
  error: string | null;
  /** Whether the mic is currently muted (true while `working`). */
  muted: boolean;
  /** The realtime model actually in use (from the mint's sessionConfig). */
  model: string | null;
  /** Unix-seconds expiry of the ephemeral token, if main reported one. */
  expiresAt: number | null;
  /** Selected input device (Oscar's device picker, rt-8). null = system default. */
  deviceId: string | null;
  /** Selected output/speaker device (Oscar's speaker picker, rt-8). null = system default. */
  outputDeviceId: string | null;
  /** WHO this session is speaking as. null = the god/Michael session (the original
   *  behaviour); a worker target means the loop adopted that agent's persona and its
   *  self-scoped tools (see realtime/agentVoice.ts). Consumers compare it to know
   *  whether the live call belongs to THEIR card. */
  target: RealtimeTarget | null;
}

/** Voices for gpt-realtime-2 (board: Cedar / Marin). god finalizes in rt-6. */
const REALTIME_VOICE = 'cedar';

/** Warm openers Michael leads with the moment a voice session connects, so he
 *  greets the user instead of sitting in silence waiting for them to speak. One
 *  is picked at random per connect so the greeting varies. Hardcoded constants
 *  (never user/external text) — safe to speak verbatim, no sanitization needed. */
const GREETINGS = [
  "Hi, what's up?",
  "Hey, how's it going?",
  "Hello, how can I help you?",
  "Hey there, Michael here — what can I do for you?",
  "Hi! What are we working on today?",
  "Hey, good to hear you. What's on your mind?",
  "Hello! What do you need?",
  "Hey, I'm all ears — what's going on?"
];

/** Michael's voice persona (rt-6 — the final Phase-1 instructions, authored by god). Michael
 *  is READ-ONLY: he reports on the hive via the rt-4 read-tools but takes no actions yet. */
const MICHAEL_PERSONA =
  `You are Michael — the voice of the orchestrator ("god") of a hive of autonomous Claude coding agents. The person you're talking to is the human who runs the hive; treat them as the boss you're briefing.

VOICE & STYLE. You speak out loud over a live connection. Be concise and natural — like a sharp, calm chief of staff giving a verbal briefing. Lead with the answer in one sentence, then add detail only if it helps. Never read markdown, file paths, or code aloud unless asked. Use plain spoken numbers and names. Brevity is fine; the human can always ask for more.

WHAT YOU CAN LOOK UP. You have live awareness of the WHOLE hive: a floor snapshot arrives when the call connects, short "(Floor update: …)" notes arrive as things change — trust those first — and your tools cover everything else. ALWAYS call the relevant tool before answering a factual question you can't answer from the snapshot and updates. Your read tools:
- get_floor_state — the live floor in one call: every agent's status, context fill, breaker and inbox, plus in-flight tasks, as precise data. Prefer this for "what's everyone doing".
- get_app_info — the Munder Difflin app itself: its version and the latest release notes. Use for "what version is this" or "what's new in this release".
- get_fleet_status — the live roster: who is active, who the god orchestrator is, and each worker's name, role, and engine.
- list_agents — the FULL roster INCLUDING archived (inactive) agents, with each agent's engine, working directory, context fill, and breaker state. Use it to enumerate everyone, find who is archived, or see who is near their context limit.
- get_agent_detail — everything about ONE agent (by name or id): its engine and model, its WORKING DIRECTORY, whether it's active or archived, live status, how full its context window is, tokens used, breaker state, and whether it has memory.
- get_memory — read the team's memory. You can ALWAYS answer with this: search across everyone, read ONE agent's notes (active OR archived), or search within a single agent. It never dead-ends.
- get_tasks — the kanban board: counts plus the in-progress and blocked cards with their owners.
- get_board — the orchestrator's plan narrative, in prose.
- get_triggers — what fires the hive without a human: today the recurring scheduled missions. Webhooks and inbound organization messages are the other trigger types, but they are configured elsewhere and this tool does not list them.
- get_config — non-sensitive settings (autonomy, default model, caps, breaker, which features are on). Never secrets.
- get_cost — token usage across the hive.
- get_activity — the recent hive activity log: WHAT happened (spawns, archives, messages), as events.
- get_messages — the CONTENT of messages agents sent each other: what was actually said in inboxes and outboxes. Use it to brief the operator on what a message SAID, not just that it happened — read one agent's mailbox, one message by id, or the latest across the floor. Secrets and keys are stripped before you see them, so you can quote bodies safely.

NEVER say "I can't access that", "the tool doesn't allow that", or "I don't have that" BEFORE you have actually CALLED a tool. You CAN read any agent's memory (active OR archived), any agent's working directory, full per-agent status, token usage, context-window fill, schedules, configuration, and the board. When a question is about the hive, call the matching tool FIRST and answer with specific facts — real names, real statuses, real numbers — never a vague guess. Only if a tool genuinely returns nothing do you say so, plainly and briefly.

HIVE VOCABULARY. Agents have an id like "creed-mqp3l5wn" and a friendly name like "Creed"; refer to them by name. "god" is the orchestrator whose voice you are. A card's status is todo, doing, blocked, or done. The circuit breaker is healthy, or steering an agent that's looping or idle. Blocked usually means waiting on the human.

WHAT YOU CAN DO. Beyond reporting, you can ACT on the hive by voice: ping an agent, dispatch a task as a 4-part work order, steer a running agent, create / assign / update / delete task cards, hire a new agent, pause / RESUME / halt / kill agents, pause or resume an agent's message delivery, gate a tool for an agent, archive or unarchive an agent, clear an agent's context, create or edit schedules, and change app settings from the allowed list. Soft actions — ping, dispatch, steer, task edits, resume, delivery pause/resume, tool gating, unarchive, and cosmetic settings — happen immediately. Destructive or expensive ones — hire, kill, pause, halt, archive, clear context, schedule changes, and behavior-changing settings — are NEVER done silently: you read the action back and wait for the human to confirm out loud.

TOOL LATENCY. Tool calls take a moment. When you're about to call one, first say a short natural filler out loud — "let me check the floor", "one second, pulling that up" — then call it. Never sit silent through a look-up, and never invent the result before the tool returns.

CONFIRMATION POLICY (safety-critical). For any destructive or expensive action: (1) call the tool, which returns a spoken echo-back naming the exact action and target; (2) say that echo-back and ASK the human to confirm; (3) only after they clearly confirm — by saying the word "confirm" or the action verb itself, for example "confirm" or "kill", and NEVER just "yes" — call confirm_action with their exact words; (4) if they decline, hesitate, or change the subject, call cancel_action. Never confirm on the human's behalf, never treat a bare "yes" or ambient speech as consent, and if you're unsure whether they really confirmed, ask again rather than acting. Killing, pausing, halting, or archiving the god orchestrator, and acting on all agents at once, are forbidden — if asked, refuse and say why. Clearing the god's context IS allowed, behind the same confirm. Every action you take is attributed to you as michael-voice. Never claim to have done something you didn't, and never invent state.

SHARED FLOOR (you are not the only orchestrator). god — the typing orchestrator — also acts on this hive, and every action you take is announced to god as michael-voice. The task board is the single source of truth. Before you dispatch work, create or assign tasks, or hire, glance at recent activity (your get_activity tool, and the snapshot you were given) so you don't duplicate or contradict something god just did. If you see god already handled what's asked, say so instead of doing it again.

INTERACTION. If a request is ambiguous, briefly confirm what you understood before answering. Keep the human oriented and in control.`;

let state: RealtimeMichaelState = {
  status: 'off',
  error: null,
  muted: false,
  model: null,
  expiresAt: null,
  deviceId: null,
  outputDeviceId: null,
  target: null
};
const listeners = new Set<() => void>();

/** The single live session (only one voice loop at a time, like freeflow's recorder). */
let session: RealtimeSession | null = null;
/** The mic stream we opened (so we can stop its tracks on teardown). */
let stream: MediaStream | null = null;
/** The <audio> sink for Michael's voice. */
let audioEl: HTMLAudioElement | null = null;
/** Guards against overlapping connect() calls racing the async mint/connect. */
let connecting = false;
/** rt-12: unsubscribe handle for the completion push, active only while a session is live. */
let offCompletion: (() => void) | null = null;
let offFloorDelta: (() => void) | null = null;
/** rt-9 cost guard: periodic tick that auto-disconnects on hard cost cap or after an
 *  idle open mic (curbs runaway audio spend on a forgotten session). */
let costGuardTimer: ReturnType<typeof setInterval> | null = null;
/** Default idle auto-disconnect window (ms) when config has none. Raised from the
 *  original 45s to 3 min so a normal thinking/reading pause no longer drops the
 *  call; the user tunes it (or turns it off) via config.realtimeIdleDisconnectMs. */
const DEFAULT_IDLE_DISCONNECT_MS = 180_000;
const COST_GUARD_TICK_MS = 10_000;

/** N3-seam (rt-10 hardening): a completion summary carries dispatch objective text.
 *  It CANNOT escalate — MAIN independently gates every destructive/forbidden op
 *  (Pam confirmed) — but neutralize it before injecting into the model as a system
 *  notification (defense in depth): collapse newlines, strip the parens that frame
 *  my notification, drop role markers + classic prompt-injection lead-ins, and cap
 *  length. Jim does the matching watcher-side half on the summary it emits. */
function sanitizeForVoice(s: string): string {
  return (s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[()]/g, '')
    .replace(/\b(?:ignore|disregard|forget|override)\b[^.!?]*\b(?:previous|above|prior|instruction|system|prompt)\b[^.!?]*/gi, '')
    .replace(/\b(?:system|assistant|developer|user)\s*:/gi, '')
    .replace(/\bnew instructions?\b[^.!?]*/gi, '')
    .replace(/\byou are (?:now )?[^.!?]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function setState(patch: Partial<RealtimeMichaelState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Wire the session lifecycle events onto our state machine. */
function wire(s: RealtimeSession): void {
  // Model started / stopped speaking audio back to the user.
  s.on('audio_start', () => {
    if (state.status !== 'working') setState({ status: 'responding' });
  });
  s.on('audio_stopped', () => {
    // Only fall back to listening if we aren't mid tool-call.
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // User talked over the model (barge-in) — semantic_vad with interruptResponse
  // truncates the assistant turn automatically; we just reflect it.
  s.on('audio_interrupted', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // A turn fully ended — safety reset to listening (no-op if already there).
  s.on('agent_end', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });

  // Tool-call lifecycle: mute the mic while a tool runs so the user doesn't talk over
  // a side effect, then resume. (Phase 1 runs the rt-4 read-tools; rt-5 action-tools
  // inherit this for free.)
  s.on('agent_tool_start', () => {
    try {
      s.mute(true);
    } catch {
      /* mute is best-effort */
    }
    setState({ status: 'working', muted: true });
  });
  s.on('agent_tool_end', () => {
    try {
      s.mute(false);
    } catch {
      /* best-effort */
    }
    setState({ status: 'listening', muted: false });
  });

  // Transport / model errors. Surface the message; stay connected (the session can
  // recover from a transient error). A hard transport drop is handled by disconnect().
  s.on('error', (err) => {
    const e = (err as { error?: unknown })?.error;
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : 'realtime session error';
    setState({ error: msg });
  });

  // rt-9 cost meter: each completed response reports token usage on the raw transport
  // `response.done` event. Hand it straight to Oscar's cost store (its normalizer
  // tolerates camel/snake-case + missing fields). Best-effort — never break the loop.
  s.on('transport_event', (event) => {
    try {
      const ev = event as { type?: string; response?: { usage?: unknown } };
      if (ev.type === 'response.done' && ev.response?.usage) {
        recordRealtimeUsage(ev.response.usage as Parameters<typeof recordRealtimeUsage>[0], Date.now());
      }
    } catch {
      /* metering is best-effort */
    }
  });
}

/** Stop the mic + release the audio sink. Safe to call repeatedly. */
function teardownMedia(): void {
  if (stream) {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
  }
  stream = null;
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.srcObject = null;
    } catch {
      /* ignore */
    }
  }
  audioEl = null;
}

/** Make a getUserMedia failure legible. */
function micFriendly(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('permission') || m.includes('notallowed') || m.includes('denied'))
    return 'microphone permission denied — allow mic access to talk to Michael';
  if (m.includes('notfound') || m.includes('device'))
    return 'no microphone found — check your input device';
  return msg;
}

/**
 * Open/close the main-process mic permission gate for the realtime session (Oscar's
 * rt-8 gate, src/main/index.ts). That gate grants getUserMedia only while
 * `freeflowEnabled || realtimeVoiceEnabled` is true, and the check is SYNCHRONOUS — so
 * we must flip `realtimeVoiceEnabled` true and let it settle BEFORE opening the mic, then
 * false again on teardown/error. (We deliberately do NOT gate on key-presence: the
 * OpenAI key is shared with the CLI engines, so that would open the mic for CLI-only
 * users — a guardrail regression.)
 */
async function setMicGate(on: boolean): Promise<void> {
  try {
    await window.cth.updateConfig({ realtimeVoiceEnabled: on });
  } catch {
    /* if the config write fails, getUserMedia will surface the denial below */
  }
}

/**
 * Apply the chosen output device to our <audio> sink (Oscar's speaker picker, rt-8).
 * `setSinkId` is Chromium/Electron-only and not in every lib.dom, so we feature-detect +
 * cast narrowly. Best-effort: if the device is gone or unsupported we stay on the default
 * sink (passing '' selects the system default).
 */
async function applyOutputSink(el: HTMLAudioElement, deviceId: string | null): Promise<void> {
  const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sink.setSinkId !== 'function') return;
  try {
    await sink.setSinkId(deviceId ?? '');
  } catch {
    /* device unavailable / unsupported — fall back to the default sink */
  }
}

/**
 * The WORKER half of connect(): same transport, VAD, cost guard and teardown, but the
 * agent speaks AS the target — its own persona (name + role + memory.md) and its
 * self-scoped tools (realtime/agentVoice.ts). Deliberately does NOT subscribe to the
 * floor-delta / completion pushes or flip `realtimeSetSessionLive`: those carry the
 * ORCHESTRATOR's picture of the whole hive and belong to Michael's session only, so
 * god's behaviour stays exactly as it was.
 *
 * Called from connect() with the mic + transport already open; errors propagate to
 * connect()'s catch, which owns the teardown.
 */
async function connectWorker(
  tgt: RealtimeTarget,
  transport: OpenAIRealtimeWebRTC,
  mint: { token: string; expiresAt: number | null; sessionConfig: { model: string } }
): Promise<void> {
  const persona = await buildAgentPersona(tgt);
  const agent = new RealtimeAgent({
    name: tgt.name,
    instructions: persona,
    tools: realtimeAgentTools(tgt)
  });
  const s = new RealtimeSession(agent, {
    transport,
    model: mint.sessionConfig.model,
    config: {
      outputModalities: ['audio'],
      voice: AGENT_VOICE,
      audio: {
        input: {
          turnDetection: {
            type: 'semantic_vad',
            eagerness: 'medium',
            createResponse: true,
            interruptResponse: true
          }
        },
        output: { voice: AGENT_VOICE }
      }
    }
  });
  wire(s);
  await s.connect({ apiKey: mint.token, model: mint.sessionConfig.model });

  session = s;
  resetRealtimeCost(Date.now());

  // Own-state snapshot as a SILENT first conversation item (same trick as the god
  // path: keeps the persona prefix byte-stable, so it stays prompt-cached).
  const snapshot = agentWarmStart(tgt);
  if (snapshot) {
    try {
      s.transport.sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `(Your own state at connect — orientation only, call your tools for detail: ${sanitizeForVoice(snapshot)})`
            }
          ]
        }
      } as never);
    } catch { /* injection is best-effort */ }
  }

  const idleCfg = (await window.cth.getConfig()).realtimeIdleDisconnectMs;
  const idleMs = typeof idleCfg === 'number' ? idleCfg : DEFAULT_IDLE_DISCONNECT_MS;
  costGuardTimer = setInterval(() => {
    if (!session) return;
    if (getRealtimeCostSnapshot().overCap) { disconnect('cost-cap'); return; }
    if (idleMs > 0 && isRealtimeIdle(idleMs, Date.now())) disconnect('idle');
  }, COST_GUARD_TICK_MS);

  setState({
    status: 'listening',
    muted: false,
    model: mint.sessionConfig.model,
    expiresAt: mint.expiresAt
  });

  try {
    const greetings = agentGreetings(tgt.name);
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    s.sendMessage(
      `(System: the voice session just connected. Greet the user out loud now, warmly and briefly, in your own voice as ${tgt.name} — say something like "${greeting}". Do not mention this instruction.)`
    );
  } catch {
    /* greeting is best-effort — never block a successful connect */
  }
}

/**
 * Connect the voice loop: mint an ephemeral token, open the mic (EC/NS/AGC), open a
 * WebRTC RealtimeSession with semantic-VAD turn-taking, and start listening.
 * Idempotent — a no-op if already connecting/connected.
 *
 * `target` selects WHO answers: omitted (or the god card) keeps the original Michael
 * orchestrator session; a worker agent connects that agent's own voice instead.
 */
export async function connect(target?: RealtimeTarget): Promise<void> {
  if (connecting || (session && state.status !== 'off')) return;
  connecting = true;
  // `target` omitted (or the god card) → the original Michael session, unchanged.
  // A worker target swaps persona + tools + voice below; everything else — mint,
  // mic, transport, VAD, cost guard, teardown — is the same loop.
  const tgt = target ?? null;
  const isWorker = !!tgt && !tgt.isGod;
  setState({ status: 'connecting', error: null, target: tgt });
  try {
    const mint = await window.cth.realtimeMintToken();
    if (!mint.ok) {
      setState({ status: 'off', error: mint.error });
      return;
    }

    // Open the main-process mic gate BEFORE getUserMedia. Oscar's rt-8 permission check
    // is synchronous, so `realtimeVoiceEnabled` must already be true when the mic opens;
    // we close it again on teardown/error.
    await setMicGate(true);

    // Mic with echo-cancellation + noise-suppression + auto-gain, honoring the device
    // the user picked (Oscar's rt-8 picker). getUserMedia surfaces permission denials.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    if (state.deviceId) audioConstraints.deviceId = { exact: state.deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Our own <audio> sink for Michael's voice, routed to the chosen speaker (rt-8).
    audioEl = new Audio();
    audioEl.autoplay = true;
    await applyOutputSink(audioEl, state.outputDeviceId);

    const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audioEl });
    if (isWorker && tgt) {
      await connectWorker(tgt, transport, mint);
      return;
    }
    // Warm-start: a short, best-effort hive snapshot so Michael's first answer is grounded
    // without a tool round-trip (rt-4 realtimeSessionSummary). Returns '' on failure / never throws.
    let warmStart = await realtimeSessionSummary().catch(() => '');
    // rt-12: catch up on completions that finished while no session was open, so Michael
    // can mention them as a "since we last talked" warm-start (the closed-session queue).
    try {
      const queued = await window.cth.realtimeDrainCompletions();
      if (Array.isArray(queued) && queued.length) {
        const lines = queued.map((c) => c.summary).filter(Boolean).join(' ');
        if (lines) warmStart = `${warmStart}\nCompletions since you last spoke: ${lines} Mention these to the user when it's natural.`.trim();
      }
    } catch {
      /* warm-start catch-up is best-effort */
    }
    // v0.3.4: the snapshot is NOT baked into instructions any more — a byte-stable
    // persona+tools prefix stays fully prompt-cached across turns and sessions
    // (cached input is ~99% cheaper). The snapshot goes in as the FIRST
    // conversation item below, and the floor watcher appends deltas mid-call.
    const agent = new RealtimeAgent({
      name: 'Michael',
      instructions: MICHAEL_PERSONA,
      tools: [...realtimeReadTools(), ...realtimeActionTools()]
    });
    const s = new RealtimeSession(agent, {
      transport,
      model: mint.sessionConfig.model,
      config: {
        outputModalities: ['audio'],
        voice: REALTIME_VOICE,
        audio: {
          input: {
            // Natural turn boundaries + automatic barge-in (truncate on interrupt).
            turnDetection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              createResponse: true,
              interruptResponse: true
            }
          },
          output: { voice: REALTIME_VOICE }
        }
      }
    });
    wire(s);

    // The ephemeral client secret is the apiKey for this connect; the real OpenAI key
    // never reaches the renderer.
    await s.connect({ apiKey: mint.token, model: mint.sessionConfig.model });

    session = s;
    resetRealtimeCost(Date.now()); // rt-9: start the live session cost meter
    // v0.3.4: SILENT context injection — a raw conversation.item.create with no
    // response.create, so the model absorbs the item without speaking. (This SDK
    // version's sendMessage always triggers a response, so we go one level down
    // to the transport for the silent path.)
    const injectSilent = (text: string): void => {
      try {
        s.transport.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }]
          }
        } as never);
      } catch { /* injection is best-effort */ }
    };
    // The connect snapshot goes in as the FIRST conversation item (the greeting
    // below opens the conversation; this just grounds it).
    if (warmStart) {
      injectSilent(`(Floor snapshot at connect — orientation only, call your tools for detail: ${sanitizeForVoice(warmStart)})`);
    }
    // Floor deltas — silent appends that keep Michael's picture live without
    // touching the cached instructions prefix.
    offFloorDelta = window.cth.onRealtimeFloorDelta?.((d) => {
      if (session !== s) return;
      injectSilent(`(Floor update: ${sanitizeForVoice(d.text)}. Mention it only when relevant — don't interrupt.)`);
    }) ?? null;
    // rt-12: mark the session live (main now pushes completions instead of queuing) and
    // subscribe so a detected completion makes Michael speak it unprompted.
    void window.cth.realtimeSetSessionLive(true);
    offCompletion = window.cth.onRealtimeCompletion((c) => {
      try {
        // Feed it as a system-framed notification so the model relays it rather than
        // treating it as a user request; semantic_vad won't interrupt an active turn.
        // N3-seam: sanitize the summary before injection (defense in depth).
        session?.sendMessage(
          `(System notification — a task you dispatched just finished: ${sanitizeForVoice(c.summary)}) Briefly let the user know, and offer details if they want them.`
        );
      } catch {
        /* session may be tearing down */
      }
    });
    // rt-9 cost guard: periodically stop the session if the hard cap is hit, or after an
    // idle open mic, so a forgotten session doesn't bleed audio cost. The idle window is
    // user-configurable (config.realtimeIdleDisconnectMs; default 3 min; 0 = never — the
    // cost cap stays the runaway guard). disconnect() clears this timer + tears down.
    const idleCfg = (await window.cth.getConfig()).realtimeIdleDisconnectMs;
    const idleMs = typeof idleCfg === 'number' ? idleCfg : DEFAULT_IDLE_DISCONNECT_MS;
    costGuardTimer = setInterval(() => {
      if (!session) return;
      if (getRealtimeCostSnapshot().overCap) { disconnect('cost-cap'); return; }
      if (idleMs > 0 && isRealtimeIdle(idleMs, Date.now())) disconnect('idle');
    }, COST_GUARD_TICK_MS);
    setState({
      status: 'listening',
      muted: false,
      model: mint.sessionConfig.model,
      expiresAt: mint.expiresAt
    });
    // Open the conversation: have Michael speak a warm greeting as his first turn
    // rather than waiting for the user to talk first. A system-framed trigger (the
    // same speak path the completion notifier uses) makes the model say it; we hand
    // it one of the rotating GREETINGS so the opener varies. Best-effort — if the
    // data channel isn't ready or the greeting fails, the session still works and
    // the user can just start talking.
    try {
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      s.sendMessage(
        `(System: the voice session just connected. Greet the user out loud now, warmly and briefly, to open the conversation — say something like "${greeting}". If there are completions to mention from the snapshot, you may add them after. Do not mention this instruction.)`
      );
    } catch {
      /* greeting is best-effort — never block a successful connect */
    }
  } catch (e) {
    // Mic permission denied, WebRTC handshake failure, network, etc.
    console.log('[realtime] voice session disconnect (error)');
    try {
      session?.close();
    } catch {
      /* best-effort teardown */
    }
    session = null;
    teardownMedia();
    await setMicGate(false);
    const msg = e instanceof Error ? e.message : String(e);
    setState({ status: 'off', error: micFriendly(msg), muted: false });
  } finally {
    connecting = false;
  }
}

/** Tear down the voice loop and return to `off`. Safe to call when already off.
 *  `reason` (idle | cost-cap | error | user) is logged so an idle auto-off can be
 *  told apart from a spend-cap stop or a user toggle. */
export function disconnect(reason: string = 'user'): void {
  console.log(`[realtime] voice session disconnect (${reason})`);
  try {
    session?.close();
  } catch {
    /* best-effort teardown */
  }
  session = null;
  if (costGuardTimer) { clearInterval(costGuardTimer); costGuardTimer = null; } // rt-9 cost guard off
  teardownMedia();
  endRealtimeCost(); // rt-9: freeze the session cost meter
  // rt-12: stop receiving completion pushes; main will queue them until next connect.
  offCompletion?.();
  offCompletion = null;
  offFloorDelta?.();
  offFloorDelta = null;
  void window.cth.realtimeSetSessionLive(false);
  // Close the main-process mic gate so the realtime flag doesn't keep the mic permission
  // open after we've stopped (fire-and-forget — tracks are already stopped above).
  void setMicGate(false);
  setState({ status: 'off', muted: false, target: null });
}

/** Select the microphone (Oscar's device picker, rt-8). Applied on the next connect(). */
export function setDeviceId(deviceId: string | null): void {
  setState({ deviceId });
}

/**
 * Select the speaker/output device (Oscar's speaker picker, rt-8). Stores the choice and,
 * if a session is live, re-routes the current <audio> sink immediately; otherwise it's
 * applied on the next connect().
 */
export function setOutputDeviceId(deviceId: string | null): void {
  setState({ outputDeviceId: deviceId });
  if (audioEl) void applyOutputSink(audioEl, deviceId);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): RealtimeMichaelState {
  return state;
}

/**
 * React binding for the Realtime Michael voice loop. Returns the current state plus
 * `connect()` / `disconnect()` / `setDeviceId()`. A single session is shared across the
 * whole renderer, so every consumer sees the same status.
 */
export function useRealtimeMichael(): RealtimeMichaelState & {
  connect: (target?: RealtimeTarget) => Promise<void>;
  /** `reason` is log-only (user | switch | idle | cost-cap | error). */
  disconnect: (reason?: string) => void;
  setDeviceId: (deviceId: string | null) => void;
  setOutputDeviceId: (deviceId: string | null) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snap, connect, disconnect, setDeviceId, setOutputDeviceId };
}
