/**
 * Loopback secret broker (Phase 2 foundation, main process).
 *
 * A 127.0.0.1-only HTTP proxy. An ephemeral worker calls
 *   <METHOD> http://127.0.0.1:<port>/i/<integrationId>/<path...>
 * authenticating with a PER-WORKER CAPABILITY TOKEN (a handle, NOT any secret) in the
 * `Authorization: Bearer` / `X-MD-Broker-Token` header. The broker validates the token,
 * authorizes the integration, decrypts the integration's real secret, injects it as the
 * upstream auth header, forwards to the integration's baseUrl, and streams the response
 * back. The worker uses the integration WITHOUT EVER SEEING the credential.
 *
 * Generalizes the existing src/main/slack.ts `SlackReplyServer` (a loopback broker that
 * posts Slack replies without the agent seeing the bot token) to an N-integration proxy.
 *
 * DEPENDENCY-FREE of electron by design: `getRecord` + `getSecret` are injected, so this
 * module is unit-testable under plain node. The secret is materialized ONLY here, at
 * forward-time, and is NEVER logged, NEVER returned to the worker, NEVER echoed in an
 * error.
 *
 * NOT an open proxy: a worker can only reach baseUrls the user registered (it selects an
 * integration by id, never a host), and the path is confined under the integration
 * origin (see resolveUpstreamUrl).
 *
 * Contract: hive/docs/integrations-spec.md.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  type IntegrationRecord,
  buildAuthHeaders,
  resolveUpstreamUrl,
  authTypeNeedsSecret
} from '../shared/integrations';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB request-body cap
const UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = 'munder-difflin-broker/1';

/** Hop-by-hop headers never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
/** Request headers the worker is NEVER allowed to pass upstream. */
const STRIP_REQUEST = new Set([
  'authorization', 'x-md-broker-token', 'host', 'cookie', 'content-length', ...HOP_BY_HOP
]);
/** Response headers never forwarded back (fetch already decodes the body, so the
 *  upstream content-encoding/length would be wrong). */
const STRIP_RESPONSE = new Set([
  'content-encoding', 'content-length', 'set-cookie', ...HOP_BY_HOP
]);

interface Capability {
  workerId: string;
  allowedIds: Set<string>;
  grantedAt: number;
}

export interface IntegrationBrokerDeps {
  /** Resolve an integration record by id (injected — the registry). */
  getRecord: (id: string) => IntegrationRecord | undefined;
  /** Decrypt a secret by ref (injected — the secret store). Main-internal. */
  getSecret: (secretRef: string | undefined) => string | undefined;
}

/** True for IPv4 loopback (127.0.0.0/8) and IPv6 ::1 (incl. v4-mapped). Mirrors slack.ts. */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

export class IntegrationBroker {
  private server: Server | null = null;
  private port = 0;
  private readonly deps: IntegrationBrokerDeps;
  /** token -> capability. In-memory only; NEVER persisted. */
  private readonly byToken = new Map<string, Capability>();
  /** workerId -> token, for revoke. */
  private readonly byWorker = new Map<string, string>();

  constructor(deps: IntegrationBrokerDeps) {
    this.deps = deps;
  }

  /** Bind a loopback port (0 ⇒ OS-assigned). Resolves the bound port. */
  start(preferredPort = 0): Promise<{ ok: boolean; port?: number; error?: string }> {
    return new Promise((resolve) => {
      if (this.server) { resolve({ ok: true, port: this.port }); return; }
      const server = createServer((req, res) => this.handle(req, res));
      const onError = (e: Error): void => { server.off('listening', onListening); resolve({ ok: false, error: e.message }); };
      const onListening = (): void => {
        server.off('error', onError);
        this.server = server;
        const addr = server.address();
        this.port = addr && typeof addr === 'object' ? addr.port : preferredPort;
        resolve({ ok: true, port: this.port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 127.0.0.1 ONLY — never bound to a routable interface, never tunneled.
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /** Close the broker. Idempotent and best-effort. Clears all capabilities. */
  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    this.port = 0;
    this.byToken.clear();
    this.byWorker.clear();
  }

  /** Whether the broker is bound and serving. */
  running(): boolean {
    return !!this.server && this.port > 0;
  }

  /** The base URL workers use (only valid while running). */
  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Mint a per-worker capability token granting access to `allowedIds`. Any prior
   *  token for this worker is revoked first. The token is a random handle — never a
   *  secret, never persisted. */
  grant(workerId: string, allowedIds: string[]): string {
    this.revoke(workerId);
    const token = randomBytes(32).toString('base64url');
    this.byToken.set(token, { workerId, allowedIds: new Set(allowedIds), grantedAt: Date.now() });
    this.byWorker.set(workerId, token);
    return token;
  }

  /** Revoke a worker's capability (called on teardown). Idempotent. */
  revoke(workerId: string): void {
    const token = this.byWorker.get(workerId);
    if (token) { this.byToken.delete(token); this.byWorker.delete(workerId); }
  }

  /** Constant-time-ish lookup of a presented token against live capabilities. */
  private resolveCapability(provided: string | undefined): Capability | undefined {
    if (!provided) return undefined;
    const a = Buffer.from(provided);
    for (const [token, cap] of this.byToken) {
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return cap;
    }
    return undefined;
  }

  private static sendError(res: ServerResponse, status: number, code: string, message: string): void {
    if (res.headersSent) { try { res.end(); } catch { /* noop */ } return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message, code }));
  }

  /** Extract the bearer/x-md-broker-token from the request. */
  private static tokenFrom(req: IncomingMessage): string | undefined {
    const x = req.headers['x-md-broker-token'];
    if (typeof x === 'string' && x) return x;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (m) return m[1].trim();
    }
    return undefined;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // 1) Loopback — defense in depth even though the bind already excludes others.
    if (!isLoopback(req.socket.remoteAddress ?? '')) {
      return IntegrationBroker.sendError(res, 403, 'forbidden', 'loopback callers only');
    }
    // 2) Capability token.
    const cap = this.resolveCapability(IntegrationBroker.tokenFrom(req));
    if (!cap) return IntegrationBroker.sendError(res, 401, 'unauthorized', 'missing or invalid capability token');

    // 3) Parse /i/<integrationId>/<path...>.
    const rawUrl = req.url ?? '';
    const m = /^\/i\/([^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?$/.exec(rawUrl);
    if (!m) return IntegrationBroker.sendError(res, 404, 'not_found', 'expected /i/<integrationId>/<path>');
    const integrationId = decodeURIComponent(m[1]);
    const path = m[2] ?? '';
    const query = m[3] ?? '';

    // 4) Authorize against this worker's capability.
    if (!cap.allowedIds.has(integrationId)) {
      return IntegrationBroker.sendError(res, 403, 'forbidden', 'integration not in this worker capability');
    }
    // 5) Resolve the record (still enabled?).
    const rec = this.deps.getRecord(integrationId);
    if (!rec) return IntegrationBroker.sendError(res, 404, 'not_found', 'unknown integration');
    if (!rec.enabled) return IntegrationBroker.sendError(res, 403, 'forbidden', 'integration is disabled');

    // 6) Confine the upstream URL under the integration origin (NOT an open proxy).
    const upstream = resolveUpstreamUrl(rec.baseUrl, path + query);
    if (!upstream) return IntegrationBroker.sendError(res, 400, 'bad_request', 'invalid or out-of-bounds path');

    // 7) Secret (decrypted ONLY here, used ONLY to inject the upstream header).
    let secret: string | undefined;
    if (authTypeNeedsSecret(rec.authType)) {
      secret = this.deps.getSecret(rec.secretRef);
      if (!secret) return IntegrationBroker.sendError(res, 503, 'no_secret', 'no secret configured for this integration');
    }

    void this.forward(req, res, rec, upstream, secret);
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    rec: IntegrationRecord,
    upstream: URL,
    secret: string | undefined
  ): Promise<void> {
    // Buffer the request body with a hard cap (write methods).
    const method = (req.method ?? 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let body: Buffer | undefined;
    if (hasBody) {
      try {
        body = await readBodyCapped(req);
      } catch (e) {
        if ((e as Error).message === 'too_large') {
          return IntegrationBroker.sendError(res, 413, 'payload_too_large', 'request body too large');
        }
        return IntegrationBroker.sendError(res, 400, 'bad_request', 'could not read request body');
      }
    }

    // Sanitize worker headers, then inject the auth header(s). Injected auth ALWAYS
    // wins: the strip list removes any worker-supplied authorization/auth header.
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (STRIP_REQUEST.has(key)) continue;
      if (Array.isArray(v)) outHeaders[key] = v.join(', ');
      else if (typeof v === 'string') outHeaders[key] = v;
    }
    if (!outHeaders['user-agent']) outHeaders['user-agent'] = DEFAULT_USER_AGENT;
    const injected = buildAuthHeaders(rec.authType, rec.authHeader, secret);
    for (const [k, v] of Object.entries(injected)) {
      delete outHeaders[k]; // ensure the worker can't shadow an injected header
      outHeaders[k] = v;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstream, {
        method,
        headers: outHeaders,
        body: body as BodyInit | undefined,
        redirect: 'manual',
        signal: ac.signal
      });
    } catch (e) {
      clearTimeout(timer);
      // The message could in theory contain the URL but never the secret.
      return IntegrationBroker.sendError(res, 502, 'bad_gateway', `upstream request failed: ${(e as Error).message}`);
    }

    // Stream the response back (status + sanitized headers + body).
    const respHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE.has(key.toLowerCase())) respHeaders[key] = value;
    });
    res.writeHead(upstreamRes.status, respHeaders);
    try {
      if (upstreamRes.body) {
        await pipeWebStream(upstreamRes.body, res);
      } else {
        res.end();
      }
    } catch {
      try { res.end(); } catch { /* socket gone */ }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read a request body into a Buffer, aborting past MAX_BODY_BYTES (throws 'too_large'). */
function readBodyCapped(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

/** Pipe a web ReadableStream (fetch response body) to a node ServerResponse. */
function pipeWebStream(web: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const node = Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
    node.on('error', reject);
    res.on('error', reject);
    res.on('finish', resolve);
    node.pipe(res);
  });
}
