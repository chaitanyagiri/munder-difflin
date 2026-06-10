/**
 * Local debug control endpoint.
 *
 * Loopback-only, token-gated control plane for tests and local MCP clients.
 * It deliberately opens no public tunnel and never exposes terminal buffers,
 * memory files, or secrets.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const DEBUG_CONTROL_ENDPOINT_VERSION = 1;

export interface DebugControlServerOptions {
  port: number;
  token: string;
  handlers: DebugControlHandlers;
}

export interface DebugControlHandlers {
  health: () => unknown;
  snapshot: () => unknown;
  workOrder: (payload: unknown) => unknown;
  startClosingTime: () => unknown;
  control: (agentId: string, action: 'steer' | 'halt' | 'resume', payload: unknown) => unknown;
  killPty: (ptyId: string) => unknown;
  quitNow: (payload: unknown) => unknown;
}

export interface DebugControlStartResult {
  ok: boolean;
  port?: number;
  url?: string;
  error?: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

export class DebugControlServer {
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly opts: DebugControlServerOptions) {}

  async start(): Promise<DebugControlStartResult> {
    if (this.server) return { ok: false, error: 'already running' };
    if (!this.opts.token) return { ok: false, error: 'missing token' };

    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      server.once('error', (e) => {
        try { server.close(); } catch { /* noop */ }
        this.server = null;
        resolve({ ok: false, error: errMsg(e) });
      });
      server.listen(this.opts.port, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        this.server = server;
        this.port = port;
        resolve({ ok: true, port, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    this.port = 0;
  }

  currentPort(): number {
    return this.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress)) {
      json(res, 403, { ok: false, error: 'loopback only' });
      return;
    }
    if (!this.authorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    const method = req.method ?? '';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      json(res, 400, { ok: false, error: 'bad url' });
      return;
    }

    try {
      if (method === 'GET') {
        this.handleGet(url.pathname, res);
        return;
      }
      if (method === 'POST') {
        const payload = await readJson(req);
        this.handlePost(url.pathname, payload, res);
        return;
      }
      res.writeHead(405);
      res.end();
    } catch (e) {
      const msg = errMsg(e);
      json(res, msg === 'bad json' ? 400 : 500, { ok: false, error: msg });
    }
  }

  private handleGet(path: string, res: ServerResponse): void {
    if (path === '/health') {
      json(res, 200, this.opts.handlers.health());
      return;
    }
    if (path === '/snapshot') {
      json(res, 200, this.opts.handlers.snapshot());
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  private handlePost(path: string, payload: unknown, res: ServerResponse): void {
    if (path === '/work-order') {
      json(res, 200, this.opts.handlers.workOrder(payload));
      return;
    }
    if (path === '/closing-time/start') {
      json(res, 200, this.opts.handlers.startClosingTime());
      return;
    }
    if (path === '/app/quit-now') {
      json(res, 200, this.opts.handlers.quitNow(payload));
      return;
    }

    const control = path.match(/^\/control\/([^/]+)\/(steer|halt|resume)$/);
    if (control) {
      json(res, 200, this.opts.handlers.control(
        decodeURIComponent(control[1]),
        control[2] as 'steer' | 'halt' | 'resume',
        payload
      ));
      return;
    }

    const kill = path.match(/^\/pty\/([^/]+)\/kill$/);
    if (kill) {
      json(res, 200, this.opts.handlers.killPty(decodeURIComponent(kill[1])));
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  }

  private authorized(req: IncomingMessage): boolean {
    const provided = tokenFromRequest(req);
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.opts.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

function tokenFromRequest(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const debugHeader = req.headers['x-munder-debug-token'];
  return typeof debugHeader === 'string' ? debugHeader.trim() : '';
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('bad json');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
