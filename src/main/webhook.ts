/**
 * WebhookServer —— 一个通用的、受密钥门控的入站 HTTP API，把外部 POST 变成
 * hive 工作，并让每个调用方凭令牌轮询该工作的状态。
 *
 * 多端点，单服务器，单隧道。端点靠请求路径中的 id 区分，因此新增 webhook
 * 不占额外端口、不占额外隧道：
 *   - POST /<webhookId>  + `x-md-webhook-secret: <该端点的密钥>`
 *       + 匹配该端点用户可编辑 schema 的 JSON body
 *       → 当端点的 TriggerMode 放行消息时返回 200 `{ ok, token, taskId }`
 *         （路由给 god、创建看板卡片），或
 *       → 当模式为操作员保留消息时返回 202
 *         `{ ok, pending: true, token, status: 'awaiting-approval' }`。
 *         无论哪种情况调用方都能拿到自己的 token。
 *   - GET  /<webhookId>  + `x-md-webhook-token: <token>`（或 `?token=`）
 *       → 只返回该 token 对应的任务状态：`{ ok, status, title, result? }`。
 *   - POST /（裸路径）是 id 为 `legacy` 的端点的别名，因此持有升级前 URL 的
 *     调用方在升级后仍能继续工作。
 *
 * 安全——这是一个 PUBLIC 表面（经隧道转发），不同于回环的 /reply 端点，
 * 因此闸门严格。单端点版本的每个性质都保留，外加多租户新增的：
 *   - 常量时间密钥比较（`timingSafeEqual`，长度守卫），只针对该端点的密钥
 *     ——吊销一个端点不会影响另一个，
 *   - 未知端点 id 的应答与错误密钥完全一致：比较仍然执行（针对不可猜测的
 *     每进程诱饵），回复是同样的 401 body，因此该表面无法被遍历以发现哪些
 *     id 存在，
 *   - GET 无论 id 是否已知都会做 token 查询，理由相同：相同的工作、相同的
 *     404——不泄露可枚举信号，
 *   - 密钥只保存在本类中，绝不记录、回显或转发进路由消息 / 卡片 / 响应
 *     （处理器拿到的是 `{id,name}`，而不是端点记录），
 *   - 能力 token 不可猜测（由调用方侧处理器铸造，192 位），且 GET 只揭示它
 *     映射到的单个任务——无列表，
 *   - 请求体上限 + 固定窗口限流（GLOBAL *且* 按端点，因此一个吵闹的调用方
 *     无法饿死其他调用方）在解析/加密之前就限制滥用。
 *
 * 运行于 Electron 主进程。刻意不引入任何 `electron` 导入，以便可以作为普通
 * Node 模块进行单元/冒烟测试。实际的卡片创建 + god 路由 + token→状态查找
 * 以回调形式注入（它们需要 hive 访问，那存在于主入口）；本类只负责传输、
 * 密钥门、schema 校验、限流和隧道。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { validateAgainstSchema, type InboundKind } from '../shared/triggers';
// 注意：`tunnelmole` 是仅 ESM 的包。Electron 主进程以 CommonJS 打包，因此
// 静态 `import` 会被外部化为 `require('tunnelmole')`，在加载时抛出
// ERR_REQUIRE_ESM。它改为在 `openTunnel()` 内部动态导入——Rollup 在 CJS
// 输出中保留动态 import()，这样可以加载 ESM。别把它重新提升为顶层导入。

/** 一个可服务的端点——本类需要的 `WebhookTrigger` 结构子集。整个
 *  `WebhookTrigger` 可赋值给它，因此调用方无需映射步骤即可直接传入配置行。 */
export interface WebhookEndpoint {
  id: string;
  name: string;
  /** 调用方在 `x-md-webhook-secret` 中回显的共享密钥。绝不离开本类。 */
  secret: string;
  /** 用户可编辑的 JSON Schema（序列化后），入站 body 会据此校验。 */
  schema: string;
}

/** 分派处理器被告知的、消息到达端点时的信息。DELIBERATELY 排除 `secret`：
 *  处理器会写卡片、hive 消息和历史行，其中任何一项都绝不能携带实时凭证。 */
export interface WebhookEndpointRef {
  id: string;
  name: string;
}

/** 已接受 POST 的校验后 body——只是要做的工作加上发送者自己的框定。密钥
 *  已经过验证，并有意识地不属于此形状，因此它永远不会被转发出去。 */
export interface WebhookInbound {
  message: string;
  title?: string;
  /** 调用方愿意声明时声明之；否则由处理器分类。 */
  kind?: InboundKind;
  /** 谁在发送，用于触发历史。缺省回退到端点名。 */
  from?: string;
}

/** 处理器对已接受消息所做的处理。`pending` 是整个拆分的关键：如实地告诉
 *  调用方工作是否真的开始了。 */
export interface WebhookDispatch {
  /** 要交回的能力令牌——唯一的回显，且只返回一次。 */
  token: string;
  /** 看板卡片 id；消息等待操作员时缺失（还没有卡片）。 */
  taskId?: string;
  /** true = 为操作员审批保留（→ 202），false = 已路由给 god（→ 200）。 */
  pending: boolean;
}

/** GET 为一个令牌揭示的内容——只镜像看板的公开列，外加消息成为工作之前
 *  报告的合成状态。 */
export interface WebhookTaskStatus {
  status: string;
  title: string;
  result?: string;
}

export interface WebhookServerOptions {
  /** HTTP 服务器绑定的本地 TCP 端口（隧道也转发到它）。 */
  port: number;
  /** 要服务的端点。之后可用 `setEndpoints` 替换。 */
  endpoints: WebhookEndpoint[];
  /**
   * 把已验证的 POST 变成 hive 工作（或变成等待操作员的消息）。返回 null 表示
   * 服务端失败（→ 500）。它返回的令牌是回显给调用方的唯一内容；密钥绝不
   * 到达这里。
   */
  onMessage: (msg: WebhookInbound, endpoint: WebhookEndpointRef) => WebhookDispatch | null;
  /**
   * 把一个能力令牌解析为其任务的公开状态，令牌映射不到任何东西时返回 null
   * （→ 404）。MUST 限定于那一个令牌——绝不能揭示或枚举其他任何任务。
   */
  lookupStatus: (token: string) => WebhookTaskStatus | null;
}

/** 在缓冲之前拒绝大于此的请求体——调用方发送的是很小的 JSON；该上限阻止
 *  未认证对等方在认证前强迫无限内存占用。 */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
/** 在放弃公共隧道前等待的最长时间（服务器保持运行）。 */
const TUNNEL_START_TIMEOUT_MS = 10_000;
/** 基础滥用防护：固定窗口内全局最多这么多请求。 */
const RATE_LIMIT = 120;
/** ……且每个端点这么多，因此一个吵闹的调用方先烧光自己的预算，而不是大家
 *  的。严格低于全局上限，否则它永远不会生效。 */
const PER_ENDPOINT_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** 裸 `POST /` 继续服务升级前迁移停靠在该 id 下的端点，因此已经指向旧 URL
 *  的调用方不受影响。 */
export const LEGACY_ENDPOINT_ID = 'legacy';

/** 由每个未知 id 共享的限流桶。一个桶，而不是每 id 一个：如果我们不为
 *  未服务的 id 建每 id 桶，探测者既能让我们的内存无限增长，更糟的是——
 *  还能观察到未知 id 从不触发每端点上限，而真实 id 会。共享一个桶让两者
 *  无法区分。 */
const UNKNOWN_BUCKET = ':unknown';

export class WebhookServer {
  private server: Server | null = null;
  private tunnelUrl: string | null = null;
  private readonly port: number;
  private endpoints = new Map<string, WebhookEndpoint>();
  private readonly onMessage: (msg: WebhookInbound, endpoint: WebhookEndpointRef) => WebhookDispatch | null;
  private readonly lookupStatus: (token: string) => WebhookTaskStatus | null;
  /** 请求的 id 不存在时与之比较，纯粹为了让失败路径与错误密钥失败做同样的
   *  工作。每进程随机且绝不导出，因此连意外都无法匹配上。 */
  private readonly decoySecret = randomBytes(32).toString('hex');
  // 以桶为键的固定窗口限流器（'' = 全局，否则为端点 id）。
  // 远程 IP 是隧道的，因此经过 tunnelmole 后按 IP 限流没有意义。
  private windows = new Map<string, { start: number; count: number }>();

  constructor(opts: WebhookServerOptions) {
    this.port = opts.port;
    this.onMessage = opts.onMessage;
    this.lookupStatus = opts.lookupStatus;
    this.setEndpoints(opts.endpoints);
  }

  /**
   * 不重启服务器或隧道就替换所服务的端点列表——操作员从 UI 添加、编辑和吊销
   * webhook，而重启会铸造一个全新的（临时）隧道 URL，静默破坏其他所有端点的
   * 每个调用方。映射整体重建，因此被移除的 id 会在下一个请求就不再解析。
   */
  setEndpoints(list: WebhookEndpoint[]): void {
    const next = new Map<string, WebhookEndpoint>();
    for (const e of list) {
      if (!e || typeof e.id !== 'string' || !e.id || typeof e.secret !== 'string' || !e.secret) continue;
      next.set(e.id, e);
    }
    this.endpoints = next;
    // 丢弃不再服务的 id 的限流状态；保留全局和未知桶，这样一次替换不能
    // 被用来重置一场正在进行的洪泛。
    for (const key of [...this.windows.keys()]) {
      if (key === '' || key === UNKNOWN_BUCKET) continue;
      if (!next.has(key)) this.windows.delete(key);
    }
  }

  /** 当前服务的 id，供显示每端点 URL 的设置界面使用。 */
  endpointIds(): string[] {
    return [...this.endpoints.keys()];
  }

  /** 公共隧道 URL，无隧道时为 null。 */
  publicUrl(): string | null {
    return this.tunnelUrl;
  }

  /** 本地 HTTP 服务器是否已绑定？`start()` 在隧道失败时也会报告 ok:false，
   *  而在那种情况下安全边界仍然存活——调用方必须保留该实例（否则监听器
   *  泄漏，且无法停止）。 */
  listening(): boolean {
    return this.server != null;
  }

  /**
   * 绑定本地 HTTP 服务器，然后向它打开公共隧道。HTTP 处理器（安全边界）在
   * `listen` resolve 的瞬间即已生效；隧道随后打开且不会致命——若无法建立，
   * 服务器继续运行，我们在没有 URL 的情况下报告隧道错误。
   */
  async start(): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (this.server) return { ok: false, error: 'already running' };
    if (this.endpoints.size === 0) return { ok: false, error: 'no enabled webhook endpoints' };
    try {
      await this.listen();
    } catch (e) {
      this.stop();
      return { ok: false, error: `failed to bind port ${this.port}: ${errMsg(e)}` };
    }
    try {
      const url = await this.openTunnel();
      if (!url) throw new Error('tunnelmole returned empty URL');
      this.tunnelUrl = url;
      // tunnelmole 在后台运行；这里没有可接线的关闭句柄。
      return { ok: true, url };
    } catch (e) {
      // 把隧道失败暴露出来，而不是静默返回不带 url 的 ok:true。
      return { ok: false, error: `tunnel unavailable: ${errMsg(e)}` };
    }
  }

  /** 关闭 HTTP 服务器。幂等且尽力而为。
   *  注意：tunnelmole 没有文档化的关闭句柄；拆除是尽力而为。 */
  stop(): void {
    this.tunnelUrl = null;
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
  }

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      const onError = (e: Error): void => reject(e);
      server.once('error', onError);
      server.listen(this.port, () => {
        server.off('error', onError);
        this.server = server;
        resolve();
      });
    });
  }

  private async openTunnel(): Promise<string> {
    // TODO: 可选持久域名——当配置携带 domain 时在这里传入。
    // 动态导入让仅 ESM 的 `tunnelmole` 远离 CJS require 图。
    const { tunnelmole } = await import('tunnelmole');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), TUNNEL_START_TIMEOUT_MS);
      tunnelmole({ port: this.port })
        .then((url) => { clearTimeout(timer); resolve(url); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** 固定窗口限流器——在任何解析/加密运行前就限制总工作量。 */
  private allowRequest(bucket: string, limit: number): boolean {
    const now = Date.now();
    const w = this.windows.get(bucket);
    if (!w || now - w.start > RATE_WINDOW_MS) {
      this.windows.set(bucket, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // 先限流——在任何工作之前做最便宜的拒绝。
    if (!this.allowRequest('', RATE_LIMIT)) { json(res, 429, { ok: false, error: 'rate limited' }); return; }
    const id = readEndpointId(req);
    const endpoint = id !== null ? this.endpoints.get(id) ?? null : null;
    // 每端点预算，所有未知 id 共享一个桶（见 UNKNOWN_BUCKET）。
    if (!this.allowRequest(endpoint ? endpoint.id : UNKNOWN_BUCKET, PER_ENDPOINT_RATE_LIMIT)) {
      json(res, 429, { ok: false, error: 'rate limited' }); return;
    }
    const method = req.method ?? '';
    if (method === 'GET') { this.handleStatus(req, res, endpoint); return; }
    if (method === 'POST') { this.handleCreate(req, res, endpoint); return; }
    res.writeHead(405); res.end();
  }

  /**
   * GET —— 返回令牌对应任务的状态（只按令牌；绝无列表）。
   *
   * 即使 id 未知也会执行查找，此时答案与未知令牌情形给出的 404 相同。
   * 跳过查找会让"无此 webhook"比"无此令牌"明显更廉价——这正是 id 枚举
   * 探测想要找的信号。
   */
  private handleStatus(req: IncomingMessage, res: ServerResponse, endpoint: WebhookEndpoint | null): void {
    const token = readToken(req);
    if (!token) { json(res, 401, { ok: false, error: 'token required' }); return; }
    let status: WebhookTaskStatus | null = null;
    try { status = this.lookupStatus(token); }
    catch { json(res, 500, { ok: false, error: 'lookup failed' }); return; }
    // 未知令牌返回 404 ——与畸形令牌和未知端点 id 完全相同，因此探测者无法
    // 区分三者中的任何一个（不可枚举）。
    if (!status || !endpoint) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, status: status.status, title: status.title, result: status.result ?? null });
  }

  /** POST —— 先验证该端点的密钥，再缓冲 + 校验 + 分派。 */
  private handleCreate(req: IncomingMessage, res: ServerResponse, endpoint: WebhookEndpoint | null): void {
    // 在读 body 之前先认证，让未认证对等方甚至连缓冲（在大小上限内）都
    // 做不到。任何失败都返回 401——不泄露任何细节；未知 id 也会走到这里，
    // 得到完全一致的应答。
    if (!this.verifySecret(req, endpoint) || !endpoint) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { aborted = true; json(res, 413, { ok: false, error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { json(res, 400, { ok: false, error: 'bad json' }); return; }

      // 端点自己的 schema 决定什么 body 是有效的。回显校验器的消息是安全的：
      // 它描述的是 CALLER 的载荷，绝不可能包含我们的密钥（schema 是操作员
      // 自己的文档）。
      const check = validateAgainstSchema(parsed, parseSchema(endpoint.schema));
      if (!check.ok) { json(res, 400, { ok: false, error: check.error }); return; }

      const body = (parsed ?? {}) as Record<string, unknown>;
      // 无论用户的 schema 怎么说，`message` 都是必需的——它是路由器缺了
      // 就无法工作的那个字段，因此把 schema 编辑到去掉它也会在这里失败，
      // 而不是产出一张空卡片。
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) { json(res, 400, { ok: false, error: 'message required' }); return; }
      const inbound: WebhookInbound = { message };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (title) inbound.title = title;
      if (body.kind === 'directive' || body.kind === 'communication') inbound.kind = body.kind;
      const from = typeof body.from === 'string' ? body.from.trim() : '';
      if (from) inbound.from = from;

      let out: WebhookDispatch | null = null;
      try { out = this.onMessage(inbound, { id: endpoint.id, name: endpoint.name }); }
      catch { json(res, 500, { ok: false, error: 'could not create task' }); return; }
      if (!out) { json(res, 500, { ok: false, error: 'could not create task' }); return; }
      // 202 而非 200：消息已被接受但工作尚未开始。调用方仍然拿到自己的令牌
      // 以便轮询保留状态，GET 也如实报告保留，而不是假装任务已排队。
      if (out.pending) {
        json(res, 202, {
          ok: true,
          pending: true,
          status: 'awaiting-approval',
          token: out.token,
          detail: 'accepted — waiting for the operator to approve it before the hive sees it'
        });
        return;
      }
      json(res, 200, { ok: true, token: out.token, taskId: out.taskId });
    });
    req.on('error', () => { if (!aborted) { try { res.writeHead(400); res.end(); } catch { /* socket 已消失 */ } } });
  }

  /**
   * 常量时间检查 `x-md-webhook-secret` 是否等于该端点的密钥。长度不匹配本身
   * 就是失败，并在比较前短路（timingSafeEqual 遇到长度不等会抛错）。
   *
   * null 端点（未知 id）仍会运行比较——针对任何调用方都无法持有的诱饵——
   * 然后无条件失败：因此"无此 webhook"与"密钥错误"代价相同，应答也同为 401。
   */
  private verifySecret(req: IncomingMessage, endpoint: WebhookEndpoint | null): boolean {
    const provided = req.headers['x-md-webhook-secret'];
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(endpoint ? endpoint.secret : this.decoySecret);
    if (a.length !== b.length) return false;
    const equal = timingSafeEqual(a, b);
    return endpoint ? equal : false;
  }
}

/**
 * 从请求路径取端点 id：`/foo` → `foo`，裸 `/` → `legacy`。更深路径
 * （`/a/b`）解析为 null = "无此端点"，应答与错误密钥 / 未知令牌完全一致。
 */
function readEndpointId(req: IncomingMessage): string | null {
  let pathname: string;
  try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; }
  catch { return null; }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return LEGACY_ENDPOINT_ID;
  if (segments.length > 1) return null;
  try { return decodeURIComponent(segments[0]); } catch { return segments[0]; }
}

/** 解析端点存储的 schema。无法解析的返回 `undefined`，`validateAgainstSchema`
 *  将其视为"接受"——打错的 schema 绝不能把持有有效密钥的调用方锁在端点外。 */
function parseSchema(schema: string): unknown {
  if (typeof schema !== 'string' || !schema.trim()) return undefined;
  try { return JSON.parse(schema); } catch { return undefined; }
}

/** 从 `x-md-webhook-token` 请求头取能力令牌，缺省回退到 `?token=` 查询参数。
 *  优先使用请求头（不进入 URL/访问日志）。 */
function readToken(req: IncomingMessage): string {
  const h = req.headers['x-md-webhook-token'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const q = url.searchParams.get('token');
    if (q && q.trim()) return q.trim();
  } catch { /* 畸形 url → 无令牌 */ }
  return '';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch { /* socket 已消失 */ }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
