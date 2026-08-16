/**
 * Sandbox exec service — the other half of the "Sandbox exec (Cloudflare)" integration
 * template in Munder Difflin (src/shared/integrations.ts).
 *
 * A hive worker never calls this Worker directly and never holds its token. It calls
 * the app's loopback broker, which injects the credential and forwards:
 *
 *     worker ──▶ $MD_BROKER_URL/i/sandbox-exec/exec
 *                  │  (capability token — a handle, not a secret)
 *                  ▼
 *              broker (Electron main) ──▶ https://<this worker>/exec
 *                                            Authorization: Bearer <AUTH_TOKEN>
 *
 * ROUTES
 *   POST /exec    {"source": "<code>", "backend": "shell"|"js", "timeoutMs"?: number}
 *                 → 200 {"ok":true,"stdout","stderr","exitCode"}
 *   GET  /health  → 200 {"ok":true,"backend":"..."}
 *
 * Auth is a single bearer token compared in constant time. There is no multi-tenancy
 * and no user data here: this exists so an agent can run code it just WROTE somewhere
 * that isn't the user's laptop.
 *
 * NOT PRODUCTION CODE. It is a reference small enough to read in one sitting; deploy it
 * to your own account, or replace it with any service that speaks the same two routes.
 */

/// <reference types="@cloudflare/workers-types" />

import { getSandbox } from '@cloudflare/sandbox';

export interface Env {
  /** Bearer token the broker sends. `wrangler secret put AUTH_TOKEN`. */
  AUTH_TOKEN: string;
  /** Durable Object namespace for the container-backed sandbox (see wrangler.jsonc). */
  Sandbox: DurableObjectNamespace;
}

export { Sandbox } from '@cloudflare/sandbox';

/** Hard ceiling regardless of what the caller asks for. */
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Refuse oversized payloads before doing any work. */
const MAX_SOURCE_BYTES = 256 * 1024;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Constant-time compare, length-guarded — a length mismatch is answered in the same
 *  shape as a wrong token so the endpoint leaks nothing about the secret. */
function tokenOk(presented: string, expected: string): boolean {
  if (!expected || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(presented, env.AUTH_TOKEN)) return json({ ok: false, error: 'unauthorized' }, 401);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, backend: 'sandbox-sdk' });
    }
    if (request.method !== 'POST' || url.pathname !== '/exec') {
      return json({ ok: false, error: 'not found' }, 404);
    }

    let body: { source?: unknown; backend?: unknown; timeoutMs?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'body must be JSON' }, 400);
    }

    const source = typeof body.source === 'string' ? body.source : '';
    if (!source) return json({ ok: false, error: 'source is required' }, 400);
    if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
      return json({ ok: false, error: 'source too large' }, 413);
    }
    const backend = body.backend === 'js' ? 'js' : 'shell';
    const timeoutMs = Math.min(
      typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );

    try {
      const result = await runInSandbox(env, source, backend, timeoutMs);
      return json({ ok: true, ...result });
    } catch (e) {
      // The message can carry the sandbox's own stderr, which is the useful part for
      // the agent. It never carries the token: that is only ever read above.
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
};

/**
 * Run `source` in a fresh sandbox and return its output.
 *
 * Uses @cloudflare/sandbox (beta): a real container per sandbox id, with streaming
 * exec, background processes and `/workspace` file APIs. `sleepAfter` is what stops an
 * idle container from billing forever — an agent's one-shot exec has no reason to
 * outlive the request by more than a minute.
 *
 * ALTERNATIVE — @cloudflare/computer (github.com/cloudflare/computer, PREVIEW, MIT):
 * a virtual filesystem + exec runtime inside Durable Objects, with the authoritative
 * state in SQLite and pluggable backends (container / isolate-bash / isolate-JS):
 *
 *     const workspace = getWorkspace(env.WORKSPACE, 'agent-exec');
 *     const out = await workspace.runtime.exec(source, { backend: 'isolate-shell' });
 *
 * The isolate backends need no container at all, so they are cheaper and start faster
 * for small "run this snippet" jobs — at the cost of a much smaller userland. Its APIs
 * are explicitly unstable, so pin a version if you switch.
 */
async function runInSandbox(
  env: Env,
  source: string,
  backend: 'shell' | 'js',
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // One sandbox id per request → no state carries between two agents' code. Reuse a
  // stable id instead if you WANT a warm container with a persistent /workspace.
  const id = `exec-${crypto.randomUUID()}`;
  const sandbox = getSandbox(env.Sandbox, id, {
    // Reap the container shortly after the job; an agent exec is one-shot.
    sleepAfter: '1m',
    labels: { source: 'munder-difflin' }
  });

  const command =
    backend === 'js'
      ? `node -e ${JSON.stringify(source)}`
      : source;

  const result = await sandbox.exec(command, { timeout: timeoutMs });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 0
  };
}
