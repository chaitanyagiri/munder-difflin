/**
 * SlackWebhookServer —— 接收 Slack 消息并交给 harness。
 *
 * 一个裸的 `node:http` 服务器（无 @slack/bolt），只实现 Slack Events API
 * 中恰好够用的部分，让用户能把频道消息灌进 Michael 的消息队列：
 *   - 用 Slack 的签名密钥 HMAC 对原始请求体验证每一个请求，
 *     外加 5 分钟的重放时间戳守卫（任何失败返回 403），
 *   - 应答一次性的 `url_verification` 挑战握手，
 *   - 在普通 `message` 事件上，剥掉开头的机器人 @提及，
 *     并经 `onMessage` 发出文本。
 *
 * 它还开一条 `tunnelmole` 隧道，让本地端口能被 Slack 的服务器触达；
 * 隧道 URL 就是用户粘进 Slack 应用 Event Subscriptions → Request URL
 * 的东西。隧道是尽力而为：本地 handler 是安全边界，
 * 即使隧道建不起来它也保持在线。
 *
 * 运行在 Electron 主进程。刻意不导入任何 `electron`，
 * 以便作为普通 Node 模块做单元/冒烟测试。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHmac, timingSafeEqual } from 'node:crypto';
// 注意：`tunnelmole` 是仅 ESM 的包。Electron 主进程被打包成 CommonJS，
// 静态 `import` 会被外部化成 `require('tunnelmole')` 并在加载时抛出
// ERR_REQUIRE_ESM。它在 `openTunnel()` 内部做动态导入——Rollup 会保留
// CJS 输出中的动态 import()，而动态 import 可以加载 ESM。
// 别把它提升回顶层 import。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  shouldTrigger: _shouldTrigger,
  ActivatedThreads: _ActivatedThreads,
  SeenEvents: _SeenEvents,
  dedupKey: _dedupKey,
} = require('./slack-trigger.cjs') as {
    shouldTrigger: (
      ev: SlackPayload['event'],
      botUserId: string | null,
      channelId: string | undefined,
      activatedThreads: _IActivatedThreads
    ) => { trigger: boolean; text: string; files: _SlackEventFile[] };
    ActivatedThreads: new (maxSize?: number) => _IActivatedThreads;
    SeenEvents: new (maxSize?: number) => _ISeenEvents;
    dedupKey: (ev: SlackPayload['event']) => string;
  };

interface _IActivatedThreads {
  add(threadTs: string): void;
  has(threadTs: string): boolean;
  readonly size: number;
}

interface _ISeenEvents {
  seen(key: string): boolean;
  readonly size: number;
}

/** file_share 事件的 `files[]` 数组中收到的原始 Slack 文件元数据。
 *  由 slack-trigger.cjs 填充；下载后由 index.ts 消费并剥掉。 */
export interface SlackEventFile {
  id?: string;
  url_private: string;
  name?: string;
  mimetype?: string;
  size?: number;
}
// 本模块内部使用的别名。
type _SlackEventFile = SlackEventFile;

export interface SlackWebhookServerOptions {
  /** HTTP 服务器绑定的本地 TCP 端口（隧道也转发到它）。 */
  port: number;
  /** Slack 应用的签名密钥（Basic Information → Signing Secret）。必填。 */
  signingSecret: string;
  /** 可选的频道 id 过滤——设置后，来自其他频道的事件被丢弃。 */
  channelId?: string;
  /** 每个被接受、已去 @提及的消息调用一次——带着在原线程中回复所需的
 *  Slack 线程坐标。可以是异步的（例如在经 IPC 转发前下载文件附件）。 */
  onMessage: (m: SlackInboundMessage) => void | Promise<void>;
}

/** 一条已验证、已去 @提及的入站 Slack 消息，外加在线程内回复所需的坐标。
 *  `thread_ts` 是原消息的线程（若它本身不是回复，就是它自己的 ts），
 *  这样办公室回复会嵌套在请求之下。
 *
 *  `files` 携带本地文件路径（index.ts 下载之后）；纯文本消息没有它。
 *  `_rawFiles` 是内部传输字段：index.ts 读取它以下载附件，
 *  然后在经 IPC 转发前剥掉它——渲染进程永远看不到。 */
export interface SlackInboundMessage {
  text: string;
  channel: string;
  ts: string;
  thread_ts: string;
  /** 已下载附件的本地路径（纯文本消息为 undefined）。 */
  files?: { path: string; name: string; mimetype: string }[];
  /** 内部：原始 Slack 文件元数据；由 index.ts onMessage 消费并剥掉。 */
  _rawFiles?: SlackEventFile[];
}

/** 拒绝大于此值的请求体——Slack 事件载荷很小；该上限阻止未认证的
 *  对等方在我们检查签名之前就强迫我们用掉无界内存。 */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
/** Slack 建议的重放窗口：拒绝偏差超过 5 分钟的时间戳。 */
const REPLAY_WINDOW_SECONDS = 60 * 5;
/** 放弃前等待公共隧道的时长上限（服务器保持在线）。 */
const TUNNEL_START_TIMEOUT_MS = 10_000;

export class SlackWebhookServer {
  private server: Server | null = null;
  private tunnelUrl: string | null = null;
  private readonly port: number;
  private readonly signingSecret: string;
  private readonly channelId?: string;
  private readonly onMessage: (m: SlackInboundMessage) => void | Promise<void>;
  /** Bot 自己的 Slack 用户 id——从第一个 event_callback 的
   *  `authorizations[].user_id` 学到。用于检测 <@BOTID> 文本提及。 */
  private botUserId: string | null = null;
  /** bot 被 @提及过的线程根；这些线程里之后的回复也触发 onMessage。
   *  有界 FIFO，防止无界增长。 */
  private readonly activatedThreads: _IActivatedThreads = new _ActivatedThreads();
  /** 最近转发过的消息身份（channel:ts）的幂等缓存。
   *  当应用同时订阅 `app_mention` 和 `message.*` 时（一次 @提及 Slack 会
   *  各发一份），阻止同一条消息触发两次 onMessage——以及因此的两次 ack
   *  回复——并吸收 Slack 对未确认事件的重试。 */
  private readonly seenEvents: _ISeenEvents = new _SeenEvents();

  constructor(opts: SlackWebhookServerOptions) {
    this.port = opts.port;
    this.signingSecret = opts.signingSecret;
    this.channelId = opts.channelId?.trim() || undefined;
    this.onMessage = opts.onMessage;
  }

  /**
   * 绑定本地 HTTP 服务器，然后为它打开公共隧道。`listen` 一兑现，
   * HTTP handler（安全边界）就立即在线；隧道随后打开且非致命——
   * 若建不起来（离线、loca.lt 宕机、超时），服务器继续运行，
   * 我们不带 URL 地报告隧道错误。
   */
  async start(): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (this.server) return { ok: false, error: 'already running' };
    if (!this.signingSecret) return { ok: false, error: 'missing signing secret' };
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
      // 把隧道失败呈现出来，而不是静默返回没有 url 的 ok:true。
      return { ok: false, error: `tunnel unavailable: ${errMsg(e)}` };
    }
  }

  /** 关闭 HTTP 服务器。幂等且尽力而为。
   *  注意：tunnelmole 没有文档化的关闭句柄；拆除是尽力而为。 */
  stop(): void {
    this.tunnelUrl = null;
    try { this.server?.close(); } catch { /* 空操作 */ }
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
    // TODO：可选持久域名——配置携带时在这里传 `domain`。
    // 动态导入让仅 ESM 的 `tunnelmole` 不进入 CJS require 图。
    const { tunnelmole } = await import('tunnelmole');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), TUNNEL_START_TIMEOUT_MS);
      tunnelmole({ port: this.port })
        .then((url) => { clearTimeout(timer); resolve(url); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** 在大小上限内缓冲原始请求体（HMAC 需要原样字节），然后验证 +
   *  分发。只接受 POST。 */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413); res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      this.handleBody(req, res, Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (aborted) return;
      try { res.writeHead(400); res.end(); } catch { /* socket 已经没了 */ }
    });
  }

  private handleBody(req: IncomingMessage, res: ServerResponse, rawBody: string): void {
    // 1) 在解析之前对原始请求体验证。任何失败 → 403。
    if (!this.verify(req, rawBody)) { res.writeHead(403); res.end(); return; }

    let payload: SlackPayload;
    try { payload = JSON.parse(rawBody) as SlackPayload; }
    catch { res.writeHead(400); res.end(); return; }

    // 2) URL 验证握手——把 challenge 原样回显。
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    // 3) 真实事件：只有 @提及或已激活线程里的回复——不是每条普通频道消息。
    //    从 authorizations 缓存 bot 用户 id，这样无需额外 API scope
    //    就能检测文本提及（<@BOTID>）。
    if (payload.type === 'event_callback' && payload.event) {
      // 第一次见到时学习 bot 自己的用户 id（每个 event_callback 都带）。
      const authUserId = payload.authorizations?.[0]?.user_id;
      if (authUserId && !this.botUserId) this.botUserId = authUserId;

      const ev = payload.event;
      const { trigger, text: rawText, files: rawFiles } = _shouldTrigger(
        ev, this.botUserId, this.channelId, this.activatedThreads
      );
      if (trigger) {
        const text = stripLeadingMention(rawText);
        const channel = typeof ev.channel === 'string' ? ev.channel : '';
        const ts = typeof ev.ts === 'string' ? ev.ts : '';
        const thread_ts = (typeof ev.thread_ts === 'string' && ev.thread_ts) || ts;
        // 当文本非空或附了文件时触发（file_share 可能没有标题）。
        if ((text || rawFiles.length > 0) && channel && ts) {
          // 去重：每条逻辑消息只有一个 onMessage（因此只有一个 ack）。当
          // 应用同时订阅 `app_mention` 和 `message.*` 时，一次 @提及会以两个
          // 共享 channel:ts 的 event_callback 到达；这也吸收 Slack 对未确认事件
          // 的重试。门控放在提及/线程过滤之后，因此不触发的消息不受影响。
          const dupKey = _dedupKey(ev);
          const isDuplicate = dupKey ? this.seenEvents.seen(dupKey) : false;
          if (!isDuplicate) {
            const msg: SlackInboundMessage = { text, channel, ts, thread_ts };
            if (rawFiles.length > 0) msg._rawFiles = rawFiles;
            try { void this.onMessage(msg); } catch { /* 投递是尽力而为 */ }
          }
        }
      }
    }

    // 总是返回 200，让 Slack 认为事件已投递、不再重试。
    res.writeHead(200); res.end();
  }

  /**
   * 验证请求真的来自 Slack：以签名密钥对 `v0:<ts>:<rawBody>` 做
   * HMAC-SHA256，结果必须等于 `X-Slack-Signature` 头（常量时间比较），
   * 并且时间戳必须在重放窗口内。
   */
  private verify(req: IncomingMessage, rawBody: string): boolean {
    const sig = req.headers['x-slack-signature'];
    const ts = req.headers['x-slack-request-timestamp'];
    if (typeof sig !== 'string' || typeof ts !== 'string') return false;

    // 重放守卫：拒绝过期或非数字的时间戳（偏差 > 5 分钟）。
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(Date.now() / 1000 - tsNum) > REPLAY_WINDOW_SECONDS) return false;

    const expected = 'v0=' + createHmac('sha256', this.signingSecret)
      .update(`v0:${ts}:${rawBody}`)
      .digest('hex');
    const provided = Buffer.from(sig);
    const computed = Buffer.from(expected);
    // timingSafeEqual 在长度不匹配时抛异常——先守卫；长度不同本身就是
    // 不匹配，所以在常量时间比较之前就退出。
    if (provided.length !== computed.length) return false;
    return timingSafeEqual(provided, computed);
  }
}

/** 我们处理的 Slack Events API 载荷的最小形状。 */
interface SlackPayload {
  type?: string;
  challenge?: string;
  /** 出现在 event_callback 上——含 bot 自己的 user_id，因此无需任何额外
   *  API scope 就能检测 <@BOTID> 文本提及。 */
  authorizations?: { user_id?: string }[];
  event?: {
    /** 普通频道消息是 'message'；@提及是 'app_mention'。 */
    type?: string;
    /** 文件上传是 'file_share'；'message_changed' / 'channel_join' 等被丢弃。 */
    subtype?: string;
    bot_id?: string;
    channel?: string;
    text?: string;
    /** 消息时间戳——Slack 的每条消息 id，用作回复线程根。 */
    ts?: string;
    /** 当消息本身是回复时设置；要回帖进的线程。 */
    thread_ts?: string;
    /** 出现在 file_share 事件上——上传文件的元数据。 */
    files?: {
      id?: string;
      url_private?: string;
      name?: string;
      mimetype?: string;
      size?: number;
    }[];
  };
}

/** 剥掉单个开头的 `<@BOTID>` 应用提及，让 "@bot do X" 入队 "do X"。 */
function stripLeadingMention(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 经 `chat.postMessage` 把回复发进 Slack 线程——裸 `node:https` POST
 * （无 `@slack/*` 依赖），与仓库零 SDK 的做法一致。bot token 由调用方
 * 传入：它住在主进程的配置里，绝不离开主进程，也绝不记录。
 * 兑现 Slack 的 `{ ok, error? }`。
 */
export function postSlackReply(opts: {
  botToken: string;
  channel: string;
  thread_ts: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!opts.botToken) { resolve({ ok: false, error: 'missing bot token' }); return; }
    // CLAUSE-1 守卫（fix-slack-integration）：拒绝任何缺少显式频道 + 线程
    // 目标的发送。空白/纯空格的 thread_ts 会发到频道根部——一个调用方从未
    // 指名过的隐含目的地——所以每次应用/语音发起的发送都必须带着它被
    // 显式给予的线程。来自 Slack 的完成回复轮询器和 loopback /reply 端点
    // 总是传具体值，因此这条路永远不会为它们触发（行为无变化）。
    if (!opts.channel?.trim() || !opts.thread_ts?.trim()) {
      resolve({ ok: false, error: 'missing explicit channel or thread_ts' }); return;
    }
    const body = JSON.stringify({ channel: opts.channel, thread_ts: opts.thread_ts, text: opts.text });
    const req = httpsRequest({
      method: 'POST',
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${opts.botToken}`
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: boolean; error?: string };
          resolve({ ok: json.ok === true, error: json.error });
        } catch { resolve({ ok: false, error: 'bad response from Slack' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: errMsg(e) }));
    req.write(body);
    req.end();
  });
}

/** 回复端点的每次会话共享密钥 + 懒加载 bot-token 访问器。 */
export interface SlackReplyServerOptions {
  /** 辅助脚本必须在 `x-md-reply-token` 头中回显的密钥。 */
  token: string;
  /** 最新的 bot token，懒读取以便回复时能拾取配置变更。 */
  getBotToken: () => string | undefined;
  /** agent 的直接回复经此 loopback 成功发出后，带着 thread_ts 触发。
   *  让主进程记录该线程已被答复，使完成摘要轮询器可以跳过它
   *  （轮询器是兜底，不是重复器）。 */
  onReplied?: (thread_ts: string) => void;
}

/**
 * 仅 loopback 的 HTTP 端点，让捆绑的辅助脚本可以发布 Slack 回复，
 * 却从头到尾看不到 bot token。它只绑定 `127.0.0.1`，绝不放在公共隧道
 * 后面（只有 webhook 端口被转发）。每个请求必须携带按会话的
 * `x-md-reply-token` 头；即使绑定已经排除了非 loopback 对等方，
 * 它们仍会被拒绝（纵深防御）。主进程把 `{ port, token }` 写进
 * `<userData>/slack-reply.json`，让辅助脚本能找到这个 socket。
 */
export class SlackReplyServer {
  private server: Server | null = null;
  private readonly token: string;
  private readonly getBotToken: () => string | undefined;
  private readonly onReplied?: (thread_ts: string) => void;

  constructor(opts: SlackReplyServerOptions) {
    this.token = opts.token;
    this.getBotToken = opts.getBotToken;
    this.onReplied = opts.onReplied;
  }

  /** 绑定一个 loopback 端口（0 ⇒ 由操作系统分配）。兑现实际绑定的端口。 */
  start(preferredPort = 0): Promise<{ ok: boolean; port?: number; error?: string }> {
    return new Promise((resolve) => {
      if (this.server) { resolve({ ok: false, error: 'already running' }); return; }
      const server = createServer((req, res) => this.handle(req, res));
      const onError = (e: Error): void => { server.off('listening', onListening); resolve({ ok: false, error: errMsg(e) }); };
      const onListening = (): void => {
        server.off('error', onError);
        this.server = server;
        const addr = server.address();
        resolve({ ok: true, port: addr && typeof addr === 'object' ? addr.port : preferredPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 仅 '127.0.0.1'——公共隧道转发 webhook 端口，绝不转发这个。
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /** 关闭端点。幂等且尽力而为。 */
  stop(): void {
    try { this.server?.close(); } catch { /* 空操作 */ }
    this.server = null;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // 纵深防御：即使只绑定 loopback，也拒绝任何非 loopback 对等方。
    if (!isLoopback(req.socket.remoteAddress ?? '')) { res.writeHead(403); res.end(); return; }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/reply') {
      res.writeHead(404); res.end(); return;
    }
    if (!this.checkToken(req.headers['x-md-reply-token'])) { res.writeHead(401); res.end(); return; }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { aborted = true; res.writeHead(413); res.end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let parsed: { channel?: string; thread_ts?: string; text?: string };
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); return; }
      const botToken = this.getBotToken();
      if (!botToken) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'no bot token' })); return; }
      if (!parsed.channel || !parsed.thread_ts || !parsed.text) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'channel, thread, text required' })); return;
      }
      const thread_ts = parsed.thread_ts;
      postSlackReply({ botToken, channel: parsed.channel, thread_ts, text: parsed.text })
        .then((r) => {
          // 一次成功的直接回复意味着 agent 已经答复了这个线程——
          // 告诉主进程，让完成摘要轮询器把它当作兜底并跳过。
          if (r.ok) { try { this.onReplied?.(thread_ts); } catch { /* 绝不破坏回复 */ } }
          res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' }); res.end(JSON.stringify(r));
        })
        .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: errMsg(e) })); });
    });
    req.on('error', () => { if (!aborted) { try { res.writeHead(400); res.end(); } catch { /* socket 没了 */ } } });
  }

  /** 请求的回复 token 与会话 token 的常量时间匹配。 */
  private checkToken(provided: string | string[] | undefined): boolean {
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/** IPv4 loopback（127.0.0.0/8）和 IPv6 ::1（含 v4 映射形式）时为 true。 */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}
