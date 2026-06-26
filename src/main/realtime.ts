/**
 * Realtime Michael — main-process ephemeral-token mint (card rt-1, Phase 1).
 *
 * The voice orchestrator (OpenAI `gpt-realtime-2`, speech-to-speech over WebRTC)
 * connects from the RENDERER. The renderer must NEVER hold the real OpenAI key, so
 * MAIN owns it: the BYOK key is stored encrypted at rest in `integration-secrets.json`
 * under `apikey:openai` (the same write-only broker the CLI engines use — set via the
 * `providerKey:*` IPC, materialized main-only, never echoed back). On demand MAIN
 * decrypts it ONCE to mint a SHORT-LIVED EPHEMERAL client secret; only that token +
 * a minimal session config cross IPC to the renderer's `RealtimeSession`. The real
 * key is never returned over IPC, never logged.
 *
 * Phase 1 is read-only — this module ONLY mints (no action tools; that's rt-5).
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { ipcMain } from 'electron';
import { getSecret, hasSecret } from './integrations';

/** Mirrors `providerKeyRef('openai')` in src/main/index.ts (BACKEND_KEY_ENV maps
 *  openai→OPENAI_API_KEY). Inlined as a local const so this module needs no new
 *  export added to index.ts — keeping the index.ts edit to a single registration
 *  line (rt-1 COORD: Oscar also edits index.ts). */
const OPENAI_KEY_REF = 'apikey:openai';

/** GA speech-to-speech model for the voice orchestrator (board: GA 2026-05-07). */
export const REALTIME_MODEL = 'gpt-realtime-2';

/** GA ephemeral-secret mint endpoint. If an account/tier still answers the legacy
 *  beta shape, we fall back to /v1/realtime/sessions on a 404 and normalize both
 *  response shapes below. (Live verification is pending the user's real key.) */
const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const LEGACY_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';

const MINT_TIMEOUT_MS = 15_000;

export type MintResult =
  | { ok: true; token: string; expiresAt: number | null; sessionConfig: { model: string } }
  | { ok: false; error: string; code?: string };

/** Whether a BYOK OpenAI key is stored (presence only — no decryption). Gates the
 *  Realtime Michael voice toggle in the renderer, the way `hasGroqKey` gates the
 *  Free Flow mic button. */
export function hasOpenAiKey(): boolean {
  return hasSecret(OPENAI_KEY_REF);
}

/** Mint a short-lived ephemeral client secret for a realtime WebRTC session. The
 *  real OpenAI key is decrypted MAIN-ONLY here and is NEVER part of the result. */
export async function mintRealtimeToken(model: string = REALTIME_MODEL): Promise<MintResult> {
  const key = getSecret(OPENAI_KEY_REF);
  if (!key) {
    return { ok: false, error: 'no OpenAI API key set — add one in Settings → AI Engines', code: 'no_key' };
  }

  const post = async (url: string, body: unknown) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MINT_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      const text = await r.text();
      let json: Record<string, unknown> | undefined;
      try { json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined; } catch { /* non-JSON body */ }
      return { status: r.status, ok: r.ok, json, text };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // GA shape first: { session: { type, model } } → { value, expires_at, ... }.
    let res = await post(CLIENT_SECRETS_URL, { session: { type: 'realtime', model } });
    // Older accounts: fall back to the legacy sessions endpoint shape.
    if (res.status === 404) res = await post(LEGACY_SESSIONS_URL, { model });

    if (!res.ok) {
      const errObj = res.json?.error as { message?: unknown } | undefined;
      const msg =
        (typeof errObj?.message === 'string' && errObj.message) ||
        (res.text ? res.text.slice(0, 200) : `HTTP ${res.status}`);
      return { ok: false, error: `token mint failed (${res.status}): ${msg}`, code: 'mint_failed' };
    }

    // Normalize across GA ({ value }) and legacy ({ client_secret: { value } }) shapes.
    const clientSecret = res.json?.client_secret as { value?: unknown; expires_at?: unknown } | undefined;
    const token =
      (typeof res.json?.value === 'string' && (res.json.value as string)) ||
      (typeof clientSecret?.value === 'string' && clientSecret.value) ||
      '';
    if (!token) return { ok: false, error: 'mint returned no ephemeral token', code: 'no_token' };

    const expRaw = res.json?.expires_at ?? clientSecret?.expires_at;
    const expiresAt = typeof expRaw === 'number' ? expRaw : null;

    return { ok: true, token, expiresAt, sessionConfig: { model } };
  } catch (e) {
    const err =
      e instanceof Error ? (e.name === 'AbortError' ? 'token mint timed out' : e.message) : String(e);
    return { ok: false, error: err, code: 'network' };
  }
}

/** Register the renderer-facing realtime IPC. A SINGLE call from index.ts (rather
 *  than per-handler `ipcMain.handle` lines there) keeps the index.ts footprint to
 *  one line — rt-1 COORD note (Oscar also edits index.ts). Neither handler ever
 *  returns the real OpenAI key. */
export function registerRealtimeIpc(): void {
  // Boolean presence only — gates the voice toggle.
  ipcMain.handle('realtime:hasKey', () => hasOpenAiKey());
  // Mint an ephemeral token; returns { token, sessionConfig } only.
  ipcMain.handle('realtime:mintToken', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { model?: unknown };
    const model = typeof p.model === 'string' && p.model.trim() ? p.model.trim() : REALTIME_MODEL;
    return mintRealtimeToken(model);
  });
}
