/**
 * 回环地址秘密代理（Phase 2 基础，主进程）。
 *
 * 一个仅限 127.0.0.1 的 HTTP 代理。临时 worker 调用
 *   <METHOD> http://127.0.0.1:<port>/i/<integrationId>/<path...>
 * 在 `Authorization: Bearer` / `X-MD-Broker-Token` 头中携带“每个 worker 的
 * 能力令牌”（一个句柄，不是任何秘密）认证。代理校验令牌、授权该集成、
 * 解密集成真实的秘密，把它作为上游认证头注入，转发到集成的 baseUrl，
 * 并把响应流式返回。worker 使用该集成但“从未看到凭证”。
 *
 * 把现有 src/main/slack.ts 的 `SlackReplyServer`（一个在不暴露 bot token 的
 * 情况下发 Slack 回复的回环代理）泛化为 N 集成代理。
 *
 * 设计上对 electron 零依赖：`getRecord` + `getSecret` 由注入提供，因此本模块
 * 可以在纯 node 下做单元测试。秘密只在转发时刻于此处实体化，绝不记录日志、
 * 绝不返回给 worker、绝不在错误里回显。
 *
 * 不是开放代理：worker 只能访问用户注册的 baseUrl（它按 id 选择集成，
 * 从不选择主机），路径也被限制在集成源站之下（见 resolveUpstreamUrl）。
 *
 * 契约：hive/docs/integrations-spec.md。
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

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB 请求体上限
const UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = 'munder-difflin-broker/1';

/** 逐跳（hop-by-hop）头，两个方向都绝不转发。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
/** 绝不允许 worker 传给上游的请求头。 */
const STRIP_REQUEST = new Set([
  'authorization', 'x-md-broker-token', 'host', 'cookie', 'content-length', ...HOP_BY_HOP
]);
/** 绝不转发回给下游的响应头（fetch 已经解码了响应体，因此上游的
 *  content-encoding/length 会是错的）。 */
const STRIP_RESPONSE = new Set([
  'content-encoding', 'content-length', 'set-cookie', ...HOP_BY_HOP
]);

interface Capability {
  workerId: string;
  allowedIds: Set<string>;
  grantedAt: number;
}

export interface IntegrationBrokerDeps {
  /** 按 id 解析集成记录（注入——注册表）。 */
  getRecord: (id: string) => IntegrationRecord | undefined;
  /** 按 ref 解密秘密（注入——秘密存储）。仅供主进程内部。 */
  getSecret: (secretRef: string | undefined) => string | undefined;
}

/** 对 IPv4 回环（127.0.0.0/8）和 IPv6 ::1（含 v4 映射）返回 true。与 slack.ts 一致。 */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

export class IntegrationBroker {
  private server: Server | null = null;
  private port = 0;
  private readonly deps: IntegrationBrokerDeps;
  /** token → 能力。仅存内存；绝不持久化。 */
  private readonly byToken = new Map<string, Capability>();
  /** workerId → token，用于撤销。 */
  private readonly byWorker = new Map<string, string>();

  constructor(deps: IntegrationBrokerDeps) {
    this.deps = deps;
  }

  /** 绑定一个回环端口（0 ⇒ 由操作系统分配）。resolve 出已绑定的端口。 */
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
      // 仅限 127.0.0.1——绝不绑定到可路由接口，绝不隧道化。
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /** 关闭代理。幂等且尽力而为。清除全部能力。 */
  stop(): void {
    try { this.server?.close(); } catch { /* 空操作 */ }
    this.server = null;
    this.port = 0;
    this.byToken.clear();
    this.byWorker.clear();
  }

  /** 代理是否已绑定并对外服务。 */
  running(): boolean {
    return !!this.server && this.port > 0;
  }

  /** worker 使用的基础 URL（仅在运行期间有效）。 */
  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 铸造一个授予 `allowedIds` 访问权的、每 worker 的能力令牌。该 worker
   *  先前的任何令牌都会先行撤销。令牌是一个随机句柄——绝不是秘密、
   *  绝不持久化。 */
  grant(workerId: string, allowedIds: string[]): string {
    this.revoke(workerId);
    const token = randomBytes(32).toString('base64url');
    this.byToken.set(token, { workerId, allowedIds: new Set(allowedIds), grantedAt: Date.now() });
    this.byWorker.set(workerId, token);
    return token;
  }

  /** 撤销 worker 的能力（拆除时调用）。幂等。 */
  revoke(workerId: string): void {
    const token = this.byWorker.get(workerId);
    if (token) { this.byToken.delete(token); this.byWorker.delete(workerId); }
  }

  /** 对出示的令牌对照现存能力做“近似恒定时间”的查找。 */
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
    if (res.headersSent) { try { res.end(); } catch { /* 空操作 */ } return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message, code }));
  }

  /** 从请求中提取 bearer/x-md-broker-token。 */
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
    // 1) 回环——虽然是纵深防御，绑定本身已排除其他来源。
    if (!isLoopback(req.socket.remoteAddress ?? '')) {
      return IntegrationBroker.sendError(res, 403, 'forbidden', 'loopback callers only');
    }
    // 2) 能力令牌。
    const cap = this.resolveCapability(IntegrationBroker.tokenFrom(req));
    if (!cap) return IntegrationBroker.sendError(res, 401, 'unauthorized', 'missing or invalid capability token');

    // 3) 解析 /i/<integrationId>/<path...>。
    const rawUrl = req.url ?? '';
    const m = /^\/i\/([^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?$/.exec(rawUrl);
    if (!m) return IntegrationBroker.sendError(res, 404, 'not_found', 'expected /i/<integrationId>/<path>');
    const integrationId = decodeURIComponent(m[1]);
    const path = m[2] ?? '';
    const query = m[3] ?? '';

    // 4) 对照该 worker 的能力做授权。
    if (!cap.allowedIds.has(integrationId)) {
      return IntegrationBroker.sendError(res, 403, 'forbidden', 'integration not in this worker capability');
    }
    // 5) 解析记录（仍然启用？）。
    const rec = this.deps.getRecord(integrationId);
    if (!rec) return IntegrationBroker.sendError(res, 404, 'not_found', 'unknown integration');
    if (!rec.enabled) return IntegrationBroker.sendError(res, 403, 'forbidden', 'integration is disabled');

    // 6) 把上游 URL 限制在集成源站之下（不是开放代理）。
    const upstream = resolveUpstreamUrl(rec.baseUrl, path + query);
    if (!upstream) return IntegrationBroker.sendError(res, 400, 'bad_request', 'invalid or out-of-bounds path');

    // 7) 秘密（只在此处解密，只用于注入上游头）。
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
    // 带硬上限缓冲请求体（写方法）。
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

    // 清洗 worker 头，然后注入认证头。注入的认证“总是”
    // 生效：清洗清单会移除任何 worker 提供的 authorization/auth 头。
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
      delete outHeaders[k]; // 确保 worker 无法遮蔽已注入的头
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
      // 理论上消息可以包含 URL，但绝不能包含秘密。
      return IntegrationBroker.sendError(res, 502, 'bad_gateway', `upstream request failed: ${(e as Error).message}`);
    }

    // 把响应流式返回（状态 + 已清洗的头 + 响应体）。
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
      try { res.end(); } catch { /* 套接字已消失 */ }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 把请求体读入 Buffer，超过 MAX_BODY_BYTES 即中止（抛 'too_large'）。 */
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

/** 把 web ReadableStream（fetch 响应体）管道到 node ServerResponse。 */
function pipeWebStream(web: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const node = Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
    node.on('error', reject);
    res.on('error', reject);
    res.on('finish', resolve);
    node.pipe(res);
  });
}
