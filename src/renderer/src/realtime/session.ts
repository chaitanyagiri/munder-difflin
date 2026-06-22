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
 * Phase 1 is a read-only connect→listen→respond round-trip. It registers ONE
 * placeholder no-op tool (god/Kevin swap real read-tools in rt-4/rt-6) so the
 * agent_tool_start/agent_tool_end lifecycle fires and we can PROVE the mic goes idle
 * during a tool call and resumes — a Phase-1 acceptance criterion. NO hive
 * action-tools yet (those are rt-5, held).
 *
 * Shape mirrors freeflow/recorder.ts: a single module-level session (only ONE voice
 * loop at a time) exposed through a `useRealtimeMichael()` hook via useSyncExternalStore.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useSyncExternalStore } from 'react';
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC, tool } from '@openai/agents-realtime';

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
}

/** Voices for gpt-realtime-2 (board: Cedar / Marin). god finalizes in rt-6. */
const REALTIME_VOICE = 'cedar';

/** Starter persona god handed Jim to test the loop with — god owns the final Michael
 *  persona in rt-6 and swaps it in. Phase 1 is read-only, so it says it can report
 *  but not act. */
const PLACEHOLDER_INSTRUCTIONS =
  'You are Michael, the voice of the god orchestrator of a hive of Claude coding agents. ' +
  'You have live read-only awareness of the hive (fleet status, tasks, cost, schedules, ' +
  'config, memory, activity) via your tools. Speak concisely and naturally, like a calm ' +
  'chief of staff. When asked about the hive, call the appropriate read-tool and answer in ' +
  'one or two sentences. In Phase 1 you have NO action capability — if asked to do something, ' +
  'say you can report but not yet act. Always confirm what you heard before answering ' +
  'ambiguous questions.';

let state: RealtimeMichaelState = {
  status: 'off',
  error: null,
  muted: false,
  model: null,
  expiresAt: null,
  deviceId: null
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

/**
 * Phase-1 placeholder tool. Registering at least one tool makes the agent_tool_start /
 * agent_tool_end lifecycle fire, which is how the mic goes idle during a tool call and
 * resumes after. Kevin replaces this with the real read-tools in rt-4; the mic-idle
 * behaviour is wired on the events below, so it survives the swap.
 */
function placeholderTools(): ReturnType<typeof tool>[] {
  return [
    tool({
      name: 'get_hive_status',
      description:
        'Report a brief, high-level status of the agent hive (placeholder — real read-tools land in rt-4).',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        'Placeholder status: the read-tools are not wired yet in this build, so I can confirm I can call tools but cannot read the live hive state until the next phase.'
    })
  ];
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
  // a side effect, then resume. (Phase 1 uses the placeholder tool; rt-5 action-tools
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

    // Mic with echo-cancellation + noise-suppression + auto-gain, honoring the device
    // the user picked (Oscar's rt-8 picker). getUserMedia surfaces permission denials.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    if (state.deviceId) audioConstraints.deviceId = { exact: state.deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Our own <audio> sink for Michael's voice.
    audioEl = new Audio();
    audioEl.autoplay = true;

    const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audioEl });
    const agent = new RealtimeAgent({
      name: 'Michael',
      instructions: PLACEHOLDER_INSTRUCTIONS,
      tools: placeholderTools()
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
  setState({ status: 'off', muted: false });
}

/** Select the microphone (Oscar's device picker, rt-8). Applied on the next connect(). */
export function setDeviceId(deviceId: string | null): void {
  setState({ deviceId });
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
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snap, connect, disconnect, setDeviceId };
}
