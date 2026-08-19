/**
 * Web UI bridge (#hosting): serve the SAME renderer UI over plain HTTP so a
 * browser on another device can run the office — the "old laptop as a server"
 * setup, without RDP.
 *
 * How it works, end to end:
 *
 *  1. `installIpcCapture(ipcMain)` runs before any handler registers and wraps
 *     `ipcMain.handle` / `ipcMain.on`, recording every channel → handler pair.
 *     The bridge routes browser calls through the EXACT same handlers the
 *     Electron renderer uses — no parallel API surface to drift.
 *  2. `WebUiServer` serves the built renderer (`out/renderer`) as static files.
 *     Its `index.html` is served with three extra classic scripts injected
 *     ahead of the app bundle: `boot.js` (a browser stand-in for the `electron`
 *     preload imports: `ipcRenderer` over fetch/SSE, `contextBridge` → window),
 *     the REAL built preload bundle (`out/preload/index.js`, byte-for-byte —
 *     so `window.cth` in the browser is always the shipped preload, never a
 *     copy), and `cleanup.js` (removes the CJS shim globals).
 *  3. `ipcRenderer.invoke`   → POST /__webui/invoke   → captured handler.
 *     `ipcRenderer.sendSync` → sync XHR /__webui/sendSync (rare: clipboard,
 *     roster boot read — both already have try/catch fallbacks in preload).
 *     `ipcRenderer.on`       ← GET  /__webui/events (SSE): every
 *     `webContents.send` in main is mirrored to connected browsers by
 *     `wrapWebContentsSend`, installed via `app.on('web-contents-created')`.
 *
 * OFF by default. Enabled via config (`webUi.enabled`) or env (`MD_WEBUI=1`).
 * When bound beyond loopback a bearer token is REQUIRED (auto-generated and
 * persisted if unset) — every request must carry it (first visit via
 * `?token=…`, exchanged for an HttpOnly cookie).
 *
 * NO Electron value imports here (types only): the module stays loadable under
 * plain Node so test/webui.test.cjs can exercise routing/auth/serialization.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

type AnyFn = (...args: unknown[]) => unknown;

/** Minimal structural slice of Electron's ipcMain — what the capture patches. */
export interface IpcMainLike {
  handle: (channel: string, listener: AnyFn) => void;
  removeHandler?: (channel: string) => void;
  on: (channel: string, listener: AnyFn) => unknown;
}

/** channel → invoke handler (`ipcMain.handle`). */
const invokeHandlers = new Map<string, AnyFn>();
/** channel → event listeners (`ipcMain.on`, used by the two sendSync channels). */
const eventListeners = new Map<string, AnyFn[]>();

let captureInstalled = false;

/**
 * Patch `ipcMain.handle`/`ipcMain.on` to RECORD registrations while delegating
 * to the originals. Must run before any handler registers (index.ts calls it
 * immediately after its imports), so the maps see every channel in the app.
 */
export function installIpcCapture(ipc: IpcMainLike): void {
  if (captureInstalled) return;
  captureInstalled = true;
  const origHandle = ipc.handle.bind(ipc);
  ipc.handle = (channel: string, listener: AnyFn) => {
    invokeHandlers.set(channel, listener);
    return origHandle(channel, listener);
  };
  if (ipc.removeHandler) {
    const origRemove = ipc.removeHandler.bind(ipc);
    ipc.removeHandler = (channel: string) => {
      invokeHandlers.delete(channel);
      return origRemove(channel);
    };
  }
  const origOn = ipc.on.bind(ipc);
  ipc.on = (channel: string, listener: AnyFn) => {
    const arr = eventListeners.get(channel) ?? [];
    arr.push(listener);
    eventListeners.set(channel, arr);
    return origOn(channel, listener);
  };
}

/** Test-only: reset the capture maps and the installed latch. */
export function resetIpcCaptureForTests(): void {
  invokeHandlers.clear();
  eventListeners.clear();
  captureInstalled = false;
}

/**
 * Channels that MUST NOT reach their real handler from a browser: they open
 * native pickers on the SERVER's display, which a remote user can't see — the
 * invoke would hang forever on an invisible dialog. Each returns the
 * handler-shaped `{ok:false,error}` instead, which every caller already treats
 * as a cancel. (Paths are server-side anyway; the UI's manual path inputs work.)
 */
const WEB_BLOCKED_CHANNELS: Record<string, unknown> = {
  'dialog:chooseFolder': { ok: false, error: 'Native folder picker is not available over the web UI — type the path instead.' },
  'dialog:attachFiles': { ok: false, error: 'Native file picker is not available over the web UI.' },
  'kg:addFiles': { ok: false, error: 'Native file picker is not available over the web UI.' },
  'hire:openFile': { ok: false, error: 'Native file picker is not available over the web UI.' }
};

// ─── Wire serialization ───────────────────────────────────────────────────────
// IPC payloads cross Electron via structured clone, which carries typed arrays
// (fs:readBinary returns a Uint8Array). JSON can't, so binary values travel as
// { $mdWebUiBytes: <base64> } markers, revived on the other side. Everything
// else is plain JSON-able data already.

const BYTES_TAG = '$mdWebUiBytes';

export function encodeWire(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) {
    return { [BYTES_TAG]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (value instanceof ArrayBuffer) {
    return { [BYTES_TAG]: Buffer.from(value).toString('base64') };
  }
  if (seen.has(value)) throw new Error('cyclic IPC payload');
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => encodeWire(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = encodeWire(v, seen);
  }
  return out;
}

export function decodeWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeWire);
  const obj = value as Record<string, unknown>;
  if (typeof obj[BYTES_TAG] === 'string' && Object.keys(obj).length === 1) {
    return new Uint8Array(Buffer.from(obj[BYTES_TAG] as string, 'base64'));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = decodeWire(v);
  return out;
}

// ─── Event mirroring ─────────────────────────────────────────────────────────

/** Structural slice of Electron.WebContents the mirror needs. */
interface WebContentsLike {
  send: (channel: string, ...args: unknown[]) => void;
}

/** The running server (at most one), so mirrored sends know where to go. */
let activeServer: WebUiServer | null = null;

/**
 * Wrap a webContents' `send` so every renderer-bound event is ALSO broadcast
 * to connected browsers. Installed for every webContents from
 * `app.on('web-contents-created')` in index.ts — one seam catches all ~30
 * `liveWebContents()?.send(...)` call sites plus the PTY output stream,
 * whatever module they live in. Near-free when no browser is connected.
 */
export function wrapWebContentsSend(wc: WebContentsLike): void {
  const orig = wc.send.bind(wc);
  wc.send = (channel: string, ...args: unknown[]) => {
    try { activeServer?.broadcastEvent(channel, args); } catch { /* never break the native path */ }
    return orig(channel, ...args);
  };
}

// ─── Runtime config resolution ───────────────────────────────────────────────

/** Persisted shape (config.ts `webUi`) + env overrides → what to actually run. */
export interface WebUiRuntimeConfig {
  enabled: boolean;
  host: string;
  port: number;
  token: string | null;
  /** True when `host` only accepts local connections (token then optional). */
  loopback: boolean;
}

export const WEB_UI_DEFAULT_PORT = 4820;

export function resolveWebUiRuntimeConfig(
  cfg: { enabled?: boolean; port?: number; host?: string; token?: string } | undefined,
  env: Record<string, string | undefined>
): WebUiRuntimeConfig {
  const envFlag = (env.MD_WEBUI ?? '').trim().toLowerCase();
  let enabled = cfg?.enabled === true;
  if (['1', 'true', 'on', 'yes'].includes(envFlag)) enabled = true;
  else if (['0', 'false', 'off', 'no'].includes(envFlag)) enabled = false;
  const envPort = Number.parseInt(env.MD_WEBUI_PORT ?? '', 10);
  const port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536
    ? envPort
    : (cfg?.port && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536 ? cfg.port : WEB_UI_DEFAULT_PORT);
  const host = (env.MD_WEBUI_HOST ?? cfg?.host ?? '0.0.0.0').trim() || '0.0.0.0';
  const token = (env.MD_WEBUI_TOKEN ?? cfg?.token ?? '').trim() || null;
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  return { enabled, host, port, token, loopback };
}

// ─── The server ──────────────────────────────────────────────────────────────

export interface WebUiServerOptions {
  host: string;
  port: number;
  /** Shared secret; null = no auth (loopback only — start() enforces this). */
  token: string | null;
  /** Absolute path to the built renderer (out/renderer). */
  rendererDir: string;
  /** Absolute path to the built preload bundle (out/preload/index.js). */
  preloadFile: string;
  /** Absolute path to the browser shim assets dir (out/main/webui-client). */
  clientDir: string;
  /** Live main-window webContents, used as `event.sender` for bridged invokes
   *  (pty:spawn records it as the output owner, so PTY streams keep flowing —
   *  and get mirrored — even when the spawn came from a browser). */
  getSender: () => unknown;
  version: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

/** Largest accepted request body (fs:writeFile carries whole files). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** A browser that falls this far behind the SSE stream is dropped, not buffered
 *  without bound (PTY output can be a firehose). It reconnects and re-syncs. */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
const AUTH_COOKIE = 'md_webui';

export class WebUiServer {
  private server: Server | null = null;
  private readonly sseClients = new Set<ServerResponse>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: WebUiServerOptions) {}

  start(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const { host, port, token, loopback } = {
      ...this.opts,
      loopback: ['127.0.0.1', '::1', 'localhost'].includes(this.opts.host)
    };
    if (!token && !loopback) {
      return Promise.resolve({
        ok: false as const,
        error: `refusing to bind ${host} without a token — set webUi.token (or MD_WEBUI_TOKEN)`
      });
    }
    return new Promise((resolvePromise) => {
      const server = createServer((req, res) => {
        try {
          this.route(req, res);
        } catch (e) {
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`web UI error: ${e instanceof Error ? e.message : String(e)}`);
          } catch { /* response already gone */ }
        }
      });
      server.on('error', (e) => {
        this.server = null;
        resolvePromise({ ok: false, error: e instanceof Error ? e.message : String(e) });
      });
      server.listen(port, host, () => {
        this.server = server;
        // Nudge every connected browser periodically so proxies keep the SSE
        // stream open, and reap clients that stopped draining.
        this.keepaliveTimer = setInterval(() => {
          for (const res of this.sseClients) this.writeSse(res, ':ka\n\n');
        }, 25_000);
        this.keepaliveTimer.unref?.();
        const shownHost = host === '0.0.0.0' || host === '::' ? '<this-machine>' : host;
        const suffix = token ? `/?token=${token}` : '/';
        resolvePromise({ ok: true, url: `http://${shownHost}:${port}${suffix}` });
      });
    });
  }

  stop(): void {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    for (const res of this.sseClients) { try { res.destroy(); } catch { /* already gone */ } }
    this.sseClients.clear();
    this.server?.close();
    this.server = null;
    if (activeServer === this) activeServer = null;
  }

  /** Register as the target of `wrapWebContentsSend` mirroring. */
  activate(): void { activeServer = this; }

  get clientCount(): number { return this.sseClients.size; }

  /** Mirror one renderer-bound event to every connected browser. */
  broadcastEvent(channel: string, args: unknown[]): void {
    if (this.sseClients.size === 0) return;
    let frame: string;
    try {
      frame = `data: ${JSON.stringify({ channel, args: encodeWire(args) })}\n\n`;
    } catch {
      return; // non-serializable payload: native renderer still gets it
    }
    for (const res of this.sseClients) this.writeSse(res, frame);
  }

  private writeSse(res: ServerResponse, frame: string): void {
    if (res.writableEnded || res.destroyed) { this.sseClients.delete(res); return; }
    if (res.writableLength > MAX_SSE_BUFFER_BYTES) {
      this.sseClients.delete(res);
      try { res.destroy(); } catch { /* already gone */ }
      return;
    }
    try { res.write(frame); } catch { this.sseClients.delete(res); }
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  private tokenMatches(candidate: string | null | undefined): boolean {
    const expected = this.opts.token;
    if (!expected) return true; // loopback, no token configured
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.opts.token) return true;
    if (this.tokenMatches(url.searchParams.get('token'))) return true;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && this.tokenMatches(auth.slice(7))) return true;
    const cookies = req.headers.cookie ?? '';
    for (const part of cookies.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === AUTH_COOKIE && this.tokenMatches(rest.join('='))) return true;
    }
    return false;
  }

  // ─── Routing ───────────────────────────────────────────────────────────────

  /** Public so tests can drive it with mock req/res, no socket needed. */
  route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://webui.invalid');
    const path = url.pathname;

    if (path === '/__webui/health') {
      this.json(res, 200, { ok: true, app: 'munder-difflin', version: this.opts.version });
      return;
    }

    if (!this.authorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Munder Difflin</title>' +
        '<body style="font-family:system-ui;padding:2rem"><h1>401</h1>' +
        '<p>This Munder Difflin web UI requires a token. Open <code>/?token=&lt;your token&gt;</code> ' +
        '(printed in the server log at startup, and stored as <code>webUi.token</code> in config.json).</p>');
      return;
    }

    // First visit with ?token: exchange it for an HttpOnly cookie and strip the
    // token from the address bar (it would otherwise sit in browser history).
    if (path === '/' && url.searchParams.has('token') && this.opts.token) {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${AUTH_COOKIE}=${this.opts.token}; HttpOnly; SameSite=Lax; Path=/`
      });
      res.end();
      return;
    }

    if (path === '/__webui/events') { this.handleSse(req, res); return; }
    if (path === '/__webui/invoke' && req.method === 'POST') { void this.handleInvoke(req, res); return; }
    if (path === '/__webui/sendSync' && req.method === 'POST') { void this.handleSendSync(req, res); return; }
    if (path === '/__webui/boot.js') { this.serveFile(res, join(this.opts.clientDir, 'boot.js'), '.js'); return; }
    if (path === '/__webui/cleanup.js') { this.serveFile(res, join(this.opts.clientDir, 'cleanup.js'), '.js'); return; }
    if (path === '/__webui/preload.js') { this.serveFile(res, this.opts.preloadFile, '.js'); return; }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    this.serveStatic(res, path);
  }

  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    this.sseClients.add(res);
    req.on('close', () => this.sseClients.delete(res));
  }

  private async handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (!body) return;
    const { channel, args } = body as { channel?: unknown; args?: unknown };
    if (typeof channel !== 'string') { this.json(res, 400, { ok: false, error: 'missing channel' }); return; }
    if (channel in WEB_BLOCKED_CHANNELS) {
      this.json(res, 200, { ok: true, value: WEB_BLOCKED_CHANNELS[channel] });
      return;
    }
    const handler = invokeHandlers.get(channel);
    if (!handler) { this.json(res, 404, { ok: false, error: `no handler for '${channel}'` }); return; }
    const decodedArgs = (Array.isArray(args) ? args : []).map(decodeWire);
    const fakeEvent = { sender: this.opts.getSender(), senderFrame: null, frameId: 0, processId: 0 };
    try {
      const value = await handler(fakeEvent, ...decodedArgs);
      this.json(res, 200, { ok: true, value: encodeWire(value) });
    } catch (e) {
      this.json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async handleSendSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req, res);
    if (!body) return;
    const { channel, args } = body as { channel?: unknown; args?: unknown };
    if (typeof channel !== 'string') { this.json(res, 400, { ok: false, error: 'missing channel' }); return; }
    const listeners = eventListeners.get(channel);
    if (!listeners || listeners.length === 0) {
      this.json(res, 404, { ok: false, error: `no listener for '${channel}'` });
      return;
    }
    const decodedArgs = (Array.isArray(args) ? args : []).map(decodeWire);
    const fakeEvent: { sender: unknown; returnValue: unknown } = {
      sender: this.opts.getSender(),
      returnValue: undefined
    };
    try {
      listeners[0](fakeEvent, ...decodedArgs);
      this.json(res, 200, { ok: true, value: encodeWire(fakeEvent.returnValue) });
    } catch (e) {
      this.json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
    return new Promise((resolvePromise) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const fail = (status: number, error: string): void => {
        if (done) return;
        done = true;
        this.json(res, status, { ok: false, error });
        resolvePromise(null);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(); fail(413, 'body too large'); return; }
        chunks.push(chunk);
      });
      req.on('error', () => fail(400, 'request aborted'));
      req.on('end', () => {
        if (done) return;
        done = true;
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          this.json(res, 400, { ok: false, error: 'invalid JSON' });
          resolvePromise(null);
        }
      });
    });
  }

  // ─── Static files ──────────────────────────────────────────────────────────

  private serveStatic(res: ServerResponse, path: string): void {
    if (path === '/' || path === '/index.html') { this.serveIndex(res); return; }
    let rel: string;
    try { rel = decodeURIComponent(path); } catch { this.json(res, 400, { ok: false, error: 'bad path' }); return; }
    if (rel.includes('\0')) { this.json(res, 400, { ok: false, error: 'bad path' }); return; }
    const root = resolve(this.opts.rendererDir);
    const abs = normalize(join(root, rel));
    // normalize() collapses any ../ the URL smuggled in; anything that escaped
    // the renderer root is refused. (`root + sep` so /rendererX can't pass.)
    if (abs !== root && !abs.startsWith(root + sep)) {
      this.json(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    this.serveFile(res, abs, extname(abs).toLowerCase());
  }

  private serveIndex(res: ServerResponse): void {
    const indexPath = join(this.opts.rendererDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Renderer bundle not found. The web UI serves the BUILT app — run `npm run build` first (dev mode serves the renderer from Vite, which the bridge does not proxy).');
      return;
    }
    let html = readFileSync(indexPath, 'utf8');
    // Classic scripts injected at the top of <head> run, in order, before the
    // deferred module bundle — so window.cth exists before React boots.
    html = html.replace(
      '<head>',
      '<head>\n    <script src="/__webui/boot.js"></script>' +
      '<script src="/__webui/preload.js"></script>' +
      '<script src="/__webui/cleanup.js"></script>'
    );
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(html);
  }

  private serveFile(res: ServerResponse, abs: string, ext: string): void {
    let stats;
    try { stats = statSync(abs); } catch { this.json(res, 404, { ok: false, error: 'not found' }); return; }
    if (!stats.isFile()) { this.json(res, 404, { ok: false, error: 'not found' }); return; }
    let data: Buffer;
    try { data = readFileSync(abs); } catch { this.json(res, 404, { ok: false, error: 'not found' }); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      // Hashed renderer assets are immutable; everything else revalidates.
      'Cache-Control': /-[A-Za-z0-9_-]{8,}\./.test(abs) ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    res.end(data);
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }
}
