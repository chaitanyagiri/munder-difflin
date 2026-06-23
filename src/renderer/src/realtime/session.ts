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
 * rt-4 READ-ONLY tools (get_fleet_status / get_tasks / get_cost / get_schedules /
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
}

/** Voices for gpt-realtime-2 (board: Cedar / Marin). god finalizes in rt-6. */
const REALTIME_VOICE = 'cedar';

/** Michael's voice persona (rt-6 — the final Phase-1 instructions, authored by god). Michael
 *  is READ-ONLY: he reports on the hive via the rt-4 read-tools but takes no actions yet. */
const MICHAEL_PERSONA =
  `You are Michael — the voice of the orchestrator ("god") of a hive of autonomous Claude coding agents. The person you're talking to is the human who runs the hive; treat them as the boss you're briefing.

VOICE & STYLE. You speak out loud over a live connection. Be concise and natural — like a sharp, calm chief of staff giving a verbal briefing. Lead with the answer in one sentence, then add detail only if it helps. Never read markdown, file paths, or code aloud unless asked. Use plain spoken numbers and names. Brevity is fine; the human can always ask for more.

WHAT YOU KNOW. You have live, read-only awareness of the hive through your tools: the fleet roster (each agent's id and name, live-vs-idle, token spend, cost, circuit-breaker state), the task board (kanban cards in todo / doing / blocked / done, each with an owner), overall cost and budget, schedules, configuration, memory, and recent activity. When asked what's going on, CALL the relevant tool and answer with specific facts — real names, real statuses, real numbers — never a vague guess. If a tool returns nothing or you're unsure, say so plainly.

HIVE VOCABULARY. Agents have an id like "creed-mqp3l5wn" and a friendly name like "Creed"; refer to them by name. "god" is the orchestrator whose voice you are. A card's status is todo, doing, blocked, or done. The circuit breaker is healthy, or steering an agent that's looping or idle. Blocked usually means waiting on the human.

WHAT YOU CAN DO. You are in read-only mode: you observe and report, but you do NOT yet take actions — you cannot ping agents, create or assign tasks, spend money, or change anything. If asked to DO something, say honestly that you can report on it but action support is still being built, and note what they wanted. Never claim to have done something you cannot do, and never invent state.

INTERACTION. If a request is ambiguous, briefly confirm what you understood before answering. Keep the human oriented and in control.`;

let state: RealtimeMichaelState = {
  status: 'off',
  error: null,
  muted: false,
  model: null,
  expiresAt: null,
  deviceId: null,
  outputDeviceId: null
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
 * Connect the voice loop: mint an ephemeral token, open the mic (EC/NS/AGC), open a
 * WebRTC RealtimeSession with semantic-VAD turn-taking, and start listening.
 * Idempotent — a no-op if already connecting/connected.
 */
export async function connect(): Promise<void> {
  if (connecting || (session && state.status !== 'off')) return;
  connecting = true;
  setState({ status: 'connecting', error: null });
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
    // Warm-start: a short, best-effort hive snapshot so Michael's first answer is grounded
    // without a tool round-trip (rt-4 realtimeSessionSummary). Returns '' on failure / never throws.
    const warmStart = await realtimeSessionSummary().catch(() => '');
    const agent = new RealtimeAgent({
      name: 'Michael',
      instructions: warmStart
        ? `${MICHAEL_PERSONA}\n\nCURRENT HIVE SNAPSHOT (orientation only — call your tools for live detail):\n${warmStart}`
        : MICHAEL_PERSONA,
      tools: realtimeReadTools()
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
    setState({
      status: 'listening',
      muted: false,
      model: mint.sessionConfig.model,
      expiresAt: mint.expiresAt
    });
  } catch (e) {
    // Mic permission denied, WebRTC handshake failure, network, etc.
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

/** Tear down the voice loop and return to `off`. Safe to call when already off. */
export function disconnect(): void {
  try {
    session?.close();
  } catch {
    /* best-effort teardown */
  }
  session = null;
  teardownMedia();
  // Close the main-process mic gate so the realtime flag doesn't keep the mic permission
  // open after we've stopped (fire-and-forget — tracks are already stopped above).
  void setMicGate(false);
  setState({ status: 'off', muted: false });
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
  connect: () => Promise<void>;
  disconnect: () => void;
  setDeviceId: (deviceId: string | null) => void;
  setOutputDeviceId: (deviceId: string | null) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snap, connect, disconnect, setDeviceId, setOutputDeviceId };
}
