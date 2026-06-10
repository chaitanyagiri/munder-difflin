/**
 * Free Flow — Groq Whisper speech-to-text, run from the Electron MAIN process.
 *
 * The renderer captures mic audio (getUserMedia → MediaRecorder) and hands the
 * raw bytes here over IPC; this module does the multipart upload to Groq's
 * OpenAI-compatible transcription endpoint and returns the transcript. Doing the
 * HTTP call in main (like `slack.ts` / `webhook.ts`) keeps the user's Groq key out
 * of the renderer and dodges CORS.
 *
 * Electron 32 bundles Node 20, so the global `fetch` + `FormData` + `Blob`
 * (undici) are available here — no extra dependency and no hand-rolled multipart.
 *
 * The API key is passed in by the caller (it lives in main's config), is used
 * ONLY for the Authorization header, and is NEVER logged.
 *
 * Deliberately free of any `electron` import so it can be unit-/smoke-tested as a
 * plain Node module.
 */

/** Groq's OpenAI-compatible transcription endpoint. */
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
/** Default model — fast, multilingual; ~216× real-time. The other option is the
 *  higher-accuracy `whisper-large-v3`. */
export const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
/** Groq free-tier upload cap is 25 MB; reject larger payloads before we spend a
 *  network round-trip (our clips are seconds long / tens of KB in practice). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Don't let a hung request wedge the feature — bound the call. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface TranscribeOptions {
  /** User's Groq API key. Used only for the Authorization header; never logged. */
  apiKey: string;
  /** Raw audio bytes captured in the renderer (e.g. webm/opus). */
  audio: ArrayBuffer | Uint8Array | Buffer;
  /** MIME type of `audio` (e.g. 'audio/webm'). Defaults to 'audio/webm'. */
  mimeType?: string;
  /** Upload filename (Groq infers format from the extension). Defaults to a webm name. */
  filename?: string;
  /** Groq model id. Defaults to DEFAULT_GROQ_MODEL. */
  model?: string;
  /** Optional ISO-639-1 language hint to improve accuracy/latency. */
  language?: string;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Transcribe a single audio clip via Groq Whisper. Resolves `{ ok, text }` on
 * success or `{ ok: false, error }` otherwise. Never throws; never logs the key.
 */
export async function transcribeWithGroq(opts: TranscribeOptions): Promise<TranscribeResult> {
  if (!opts.apiKey) return { ok: false, error: 'missing Groq API key' };

  const bytes = toUint8Array(opts.audio);
  if (bytes.byteLength === 0) return { ok: false, error: 'empty audio' };
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return { ok: false, error: 'audio too large (Groq free-tier cap is 25 MB)' };
  }

  const mimeType = opts.mimeType || 'audio/webm';
  const filename = opts.filename || 'dictation.webm';
  const model = opts.model || DEFAULT_GROQ_MODEL;

  const form = new FormData();
  form.append('model', model);
  // `response_format=text` returns the bare transcript, but JSON is more robust to
  // parse defensively; we ask for json and read `.text`.
  form.append('response_format', 'json');
  if (opts.language) form.append('language', opts.language);
  form.append('file', new Blob([toArrayBuffer(bytes)], { type: mimeType }), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: controller.signal
    });
    const raw = await res.text();
    if (!res.ok) {
      // Surface Groq's error message (NOT the key) — e.g. 401 invalid_api_key,
      // 413 too large, 429 rate limited. Keep it short.
      return { ok: false, error: `Groq ${res.status}: ${extractError(raw) || res.statusText}` };
    }
    let text = '';
    try {
      const json = JSON.parse(raw) as { text?: unknown };
      text = typeof json.text === 'string' ? json.text.trim() : '';
    } catch {
      // response_format fallback: a bare-text body.
      text = raw.trim();
    }
    if (!text) return { ok: false, error: 'no speech detected' };
    return { ok: true, text };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, error: aborted ? 'transcription timed out' : errMsg(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a human-readable message out of Groq's JSON error envelope, if present. */
function extractError(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string };
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
  } catch { /* not json */ }
  return '';
}

function toUint8Array(audio: ArrayBuffer | Uint8Array | Buffer): Uint8Array {
  if (audio instanceof Uint8Array) return audio; // Buffer is a Uint8Array subclass
  return new Uint8Array(audio);
}

/** Blob wants an ArrayBuffer-backed view; copy out a clean ArrayBuffer slice. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
