/**
 * Free Flow recorder — a single shared push-to-talk capture engine for the whole
 * renderer. Both entry points use it, so only ONE recording can run at a time:
 *   (A) the "Free Flow" button in MessageQueueComposer (click to start/stop), and
 *   (B) hold-Option-to-talk (see freeflow/holdOption.ts) — start on arm, stop on
 *       Option release.
 *
 * Flow: getUserMedia(audio) → MediaRecorder (webm/opus) → on stop, the blob's
 * bytes go to main over IPC (`freeflowTranscribe`), which calls Groq Whisper and
 * returns the transcript. The transcript is APPENDED to the target agent's
 * composer draft (store.drafts) — never auto-sent — faithful to freeflow: the
 * user reviews, then presses Send/Enter.
 *
 * Hold-to-talk makes the start/stop race real: a user can release Option before
 * getUserMedia resolves. `wantActive` tracks the user's intent so a stop that
 * lands mid-open discards the about-to-start recording instead of stranding it.
 *
 * Exposed as a module singleton + a `useFreeflow()` hook (useSyncExternalStore).
 */
import { useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';

export type FreeflowStatus = 'idle' | 'recording' | 'transcribing';

export interface FreeflowState {
  status: FreeflowStatus;
  /** The agent whose draft a finished transcript will land in. */
  targetAgentId: string | null;
  /** Last error (mic denied, Groq failure…). Cleared when a new capture starts. */
  error: string | null;
}

let state: FreeflowState = { status: 'idle', targetAgentId: null, error: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<FreeflowState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): FreeflowState {
  return state;
}

// ─── Recording internals ─────────────────────────────────────────────────────
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
/** True between start() and the next stop(): the user wants a recording. A stop
 *  that arrives while getUserMedia is still opening flips this so the open path
 *  discards instead of recording. */
let wantActive = false;
/** True while getUserMedia is in flight, to ignore re-entrant start() calls. */
let opening = false;

/** Prefer webm/opus (Groq-supported, Chromium default); fall back to whatever the
 *  platform offers. Returns '' to let MediaRecorder pick its default. */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const supported = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
  if (supported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
  }
  return '';
}

/** Release the mic stream so the OS recording indicator clears. */
function teardownStream(): void {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
  stream = null;
}

/** Append `text` to the target agent's composer draft (with a separating space). */
function deliverTranscript(agentId: string, text: string): void {
  const st = useStore.getState();
  const cur = st.drafts[agentId] ?? '';
  const sep = cur && !/\s$/.test(cur) ? ' ' : '';
  st.setDraft(agentId, cur + sep + text);
}

/** Begin capturing for `agentId`. Safe to call only from the idle state; surfaces
 *  a friendly error if the mic can't be opened. */
async function start(agentId: string): Promise<void> {
  if (state.status !== 'idle' || opening) return;
  if (!agentId) { setState({ error: 'no agent selected' }); return; }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    setState({ error: 'microphone not available' });
    return;
  }
  wantActive = true;
  opening = true;
  setState({ error: null });
  let opened: MediaStream;
  try {
    opened = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    opening = false;
    wantActive = false;
    const name = e instanceof DOMException ? e.name : '';
    setState({
      status: 'idle',
      error: name === 'NotAllowedError' ? 'microphone permission denied' : 'could not open microphone'
    });
    return;
  }
  opening = false;
  // Released before the mic finished opening (a quick tap) — discard cleanly.
  if (!wantActive) {
    try { opened.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    return;
  }
  stream = opened;
  chunks = [];
  const mimeType = pickMimeType();
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    teardownStream();
    wantActive = false;
    setState({ status: 'idle', error: 'recording not supported' });
    return;
  }
  recorder.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
  recorder.onstop = () => { void finish(agentId); };
  recorder.start();
  setState({ status: 'recording', targetAgentId: agentId, error: null });
}

/** Stop the active recording (triggers transcription via `onstop`). If a start is
 *  still opening the mic, this cancels it (the open path discards). */
function stop(): void {
  wantActive = false;
  if (opening) return; // the in-flight start() will see !wantActive and discard
  if (state.status !== 'recording' || !recorder) return;
  try { recorder.stop(); } catch { /* already stopped */ }
}

/** Called when MediaRecorder finishes: assemble the clip, transcribe, deliver. */
async function finish(agentId: string): Promise<void> {
  const type = recorder?.mimeType || 'audio/webm';
  teardownStream();
  recorder = null;
  const blob = new Blob(chunks, { type });
  chunks = [];
  if (blob.size === 0) {
    setState({ status: 'idle', error: 'nothing recorded' });
    return;
  }
  setState({ status: 'transcribing', error: null });
  try {
    const buf = await blob.arrayBuffer();
    const ext = type.includes('ogg') ? 'ogg' : 'webm';
    const res = await window.cth.freeflowTranscribe({
      audio: buf,
      mimeType: type.split(';')[0],
      filename: `dictation.${ext}`
    });
    if (res.ok && res.text) {
      deliverTranscript(agentId, res.text);
      setState({ status: 'idle', error: null });
    } else {
      setState({ status: 'idle', error: res.error || 'transcription failed' });
    }
  } catch (e) {
    setState({ status: 'idle', error: e instanceof Error ? e.message : 'transcription failed' });
  }
}

/** Toggle capture for `agentId` (used by the composer button): start if idle,
 *  stop if recording. During transcription it's a no-op (the upload is in flight). */
function toggle(agentId: string): void {
  if (state.status === 'recording') stop();
  else if (state.status === 'idle') void start(agentId);
}

/** True while a clip is recording or uploading — the hold gesture uses this to
 *  avoid starting a second capture. */
function isBusy(): boolean {
  return state.status !== 'idle' || opening;
}

export const freeflowRecorder = { start, stop, toggle, isBusy, subscribe, getSnapshot };

/** React hook: subscribe to the shared recorder state. */
export function useFreeflow(): FreeflowState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
