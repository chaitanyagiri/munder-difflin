/**
 * Realtime Michael — renderer voice session (card rt-2, Phase 1 = READ-ONLY voice).
 *
 * The voice orchestrator runs IN THE RENDERER over WebRTC, talking speech-to-speech
 * to OpenAI `gpt-realtime-2`. The renderer never holds the real OpenAI key: it asks
 * MAIN to mint a short-lived EPHEMERAL client secret (`realtime:mintToken`, see
 * src/main/realtime.ts) and connects with THAT. The `@openai/agents-realtime`
 * `RealtimeSession` with the `webrtc` transport auto-configures the microphone input
 * and the audio output element in the browser, so we don't hand-roll getUserMedia /
 * <audio> here (contrast freeflow/recorder.ts, which is push-to-talk Whisper).
 *
 * Phase 1 is a read-only connect→listen→respond round-trip ONLY: NO hive action-tools
 * are registered (those are card rt-5, held). The agent persona is a MINIMAL
 * placeholder — god owns the final Michael persona in rt-6 and swaps it in.
 *
 * Shape mirrors freeflow/recorder.ts: a single module-level session (only ONE voice
 * loop at a time) exposed through a `useRealtimeMichael()` hook via useSyncExternalStore.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useSyncExternalStore } from 'react';
import { RealtimeAgent, RealtimeSession } from '@openai/agents-realtime';

/**
 * Voice-loop state machine:
 *   off        — no session (initial / after disconnect / fatal error)
 *   connecting — minting token + opening the WebRTC connection
 *   listening  — connected, mic live, waiting for / hearing the user
 *   responding — the model is generating / speaking audio back
 *   working    — a tool call is in flight; mic is muted until it returns (rt-5)
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
}

/** Placeholder persona — god owns the real Michael persona in rt-6 and swaps it in. */
const PLACEHOLDER_INSTRUCTIONS = 'You are Michael, the hive orchestrator.';

let state: RealtimeMichaelState = {
  status: 'off',
  error: null,
  muted: false,
  model: null,
  expiresAt: null
};
const listeners = new Set<() => void>();

/** The single live session (only one voice loop at a time, like freeflow's recorder). */
let session: RealtimeSession | null = null;
/** Guards against overlapping connect() calls racing the async mint/connect. */
let connecting = false;

function setState(patch: Partial<RealtimeMichaelState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Wire the session lifecycle events onto our state machine. */
function wire(s: RealtimeSession): void {
  // Model started / stopped speaking audio back to the user.
  s.on('audio_start', () => setState({ status: 'responding' }));
  s.on('audio_stopped', () => {
    // Only fall back to listening if we aren't mid tool-call.
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // User (or a "stop talking" action) cut the model off — back to listening.
  s.on('audio_interrupted', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // A turn fully ended — safety reset to listening (no-op if already there).
  s.on('agent_end', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });

  // Tool-call lifecycle. Phase 1 registers NO tools so these won't fire yet, but
  // wiring them now means rt-5's action-tools get the mic-idle behaviour for free:
  // mute the mic while a tool runs so the user doesn't talk over a side effect.
  s.on('agent_tool_start', () => {
    s.mute(true);
    setState({ status: 'working', muted: true });
  });
  s.on('agent_tool_end', () => {
    s.mute(false);
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

/**
 * Connect the voice loop: mint an ephemeral token, open a WebRTC RealtimeSession,
 * and start listening. Idempotent — a no-op if already connecting/connected.
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

    const agent = new RealtimeAgent({
      name: 'Michael',
      instructions: PLACEHOLDER_INSTRUCTIONS
    });
    const s = new RealtimeSession(agent, {
      transport: 'webrtc',
      model: mint.sessionConfig.model
    });
    wire(s);

    // The ephemeral client secret is the apiKey for this connect; the real OpenAI
    // key never reaches the renderer.
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
    const msg = e instanceof Error ? e.message : String(e);
    setState({ status: 'off', error: msg, muted: false });
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
  setState({ status: 'off', muted: false });
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
 * `connect()` / `disconnect()`. A single session is shared across the whole renderer,
 * so every consumer sees the same status.
 */
export function useRealtimeMichael(): RealtimeMichaelState & {
  connect: () => Promise<void>;
  disconnect: () => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snap, connect, disconnect };
}
