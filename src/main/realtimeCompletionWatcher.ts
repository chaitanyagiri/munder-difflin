/**
 * Realtime Michael —— 完成观察器（卡片 rt-12，第二阶段，“完成时回应”）。
 *
 * 当语音版 Michael 派发工作（fire-and-notify，默认模式）时，他不会阻塞等它。
 * 本模块就是主进程的引擎：观察每个已派发任务的完成情况，并发出完成事件，
 * 让 realtime 栈的其余部分能让 Michael 主动说出来（“Oscar 完成了——要细节吗？”）。
 *
 * 归属 / 接缝（rt-12 拆分，2026-06-25 由 god 裁定）：本模块归 Jim 所有，
 * 刻意与 Kevin 的 realtime CORE 文件不相交。它绝不 import session.ts /
 * 实时 RealtimeSession / electron——只接受注入的读取器 + 一个时钟，
 * 并通过回调发出事件。Kevin 一侧订阅 `onCompletion(...)`，
 * 把事件推下新的 main→renderer 通道（preload 绑定 + session.ts 注入），
 * 在派发动作里调用 `track(...)`，在连接/断开时翻转 `setSessionLive(...)`，
 * 并在热启动时 `drainQueuedCompletions()`。让这个文件不依赖 electron、
 * 读取器注入，使它可做单元测试，也不会在共享 checkout 上冲突。
 *
 * 完成信号（见 {@link detectCompletion}）是二者之一：
 *   (a) 已派发任务的卡片在 tasks.json 中翻到 `done`，或者
 *   (b) 收件人发来一条 inbox done 消息（对派发消息的回复，且在其之后）。
 *
 * 分支 feat/realtime-michael。见 board.md “🎙 REALTIME MICHAEL”。
 */

/** 语音版 Michael 派发出去、此刻正等待其完成的一个工作单元。 */
export interface PendingDispatch {
  /** 这次派发的稳定 id（观察器的键）。例如派发消息 id。 */
  correlationId: string;
  /** 派发了什么类型的工作——决定口头摘要的形态。 */
  kind: 'dispatch' | 'task' | 'spawn';
  /** 工作派给的那个 agent（例如 "oscar-mqpbr18v"）。 */
  targetAgentId: string;
  /** 任务卡片 id——如果这次派发对应一张卡片（启用卡片→done 检测）。 */
  taskId?: string;
  /** 简短的目标文字，供口头摘要使用。 */
  objective?: string;
  /** 派发发生的 epoch 毫秒——只有此时间之后的信号才算数（避免过期回复）。 */
  dispatchedAt: number;
  /** 派发消息的 id（若已知）——让我们能通过 `in_reply_to` 匹配 inbox 回复。 */
  dispatchMessageId?: string;
}

/** 我们从 tasks.json 读取的最小任务卡片形状（忽略多余字段）。 */
export interface TaskCard {
  id: string;
  status?: string;
  assignee?: string | null;
  owner?: string | null;
  title?: string;
}

/** 我们扫描 done 信号的最小 inbox 消息形状（忽略多余字段）。 */
export interface InboxMessage {
  id: string;
  from?: string;
  to?: string;
  act?: string;
  in_reply_to?: string | null;
  subject?: string;
  body?: string;
  created_at?: string;
}

/** 检测器读取的数据——注入进来，让本模块不碰任何文件系统。 */
export interface CompletionContext {
  tasks: TaskCard[];
  inbox: InboxMessage[];
}

/** 纯检测谓词的结果。 */
export interface CompletionResult {
  done: boolean;
  /** 完成是如何被观察到的——供日志与去重用。 */
  via?: 'card-done' | 'inbox-reply';
  /** 观察到完成的 epoch 毫秒（尽力而为）。 */
  at?: number;
  /** 简短、可念出的“什么完成了”摘要。 */
  summary?: string;
  /** 匹配到的 inbox 消息 id（当通过 'inbox-reply' 时）——让观察器去重。 */
  messageId?: string;
}

/**
 * 观察器经 `onCompletion` 发出、也从 `drainQueuedCompletions()` 返回的
 * 完成对象——同一个形状（与 Kevin 的 rt-12 契约锁）。Kevin 原样转发它，
 * 经 main→renderer 推送通道并进入热启动，所以这里的每个字段都能到达
 * Michael。`summary` 是给人念的行；`completedAt` 是 epoch 毫秒。
 * 尾随字段是额外上下文（线上可安全忽略）。
 */
export interface RealtimeCompletion {
  correlationId: string;
  kind: PendingDispatch['kind'];
  targetAgentId: string;
  taskId?: string;
  /** 给人念的行，例如 "Oscar finished the cost guard." */
  summary: string;
  /** 观察到完成的 epoch 毫秒。 */
  completedAt: number;
  /** 简短目标文字——供 toast / 日志使用的额外上下文。 */
  objective?: string;
  /** 完成是如何被检测到的——额外信息，供日志 / 去重。 */
  via?: 'card-done' | 'inbox-reply';
  /** 经 'inbox-reply' 时匹配到的 inbox 消息 id——额外信息，供去重。 */
  messageId?: string;
}

/** 由接线方（index.ts）注入的依赖，让观察器保持无 electron。 */
export interface CompletionWatcherDeps {
  /** 当前任务卡片（来自 tasks.json）。每次轮询调用。 */
  readTasks: () => TaskCard[];
  /** 当前调度方 inbox 的消息（收件人回复落在那里）。每次轮询调用。 */
  readInbox: () => InboxMessage[];
  /** 时钟——供测试注入。默认为 Date.now。 */
  now?: () => number;
  /** 轮询节奏（毫秒）。默认 4000。 */
  pollIntervalMs?: number;
  /** 可选的系统通知钩子（例如 electron Notification），用于会话关闭路径。 */
  onNotify?: (event: RealtimeCompletion) => void;
}

const DEFAULT_POLL_MS = 4000;

/** N2（rt-10 加固）——约束内存，让长生命周期会话无法泄漏。 */
const MAX_PENDING = 200;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUED = 50;

/** N3（rt-10 加固）——需要在口头摘要中中和的提示注入前导语。 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.!?\n]*\b(?:previous|above|prior|instruction|system|prompt)\b[^.!?\n]*/gi,
  /\b(?:system|assistant|developer|user)\s*:/gi,
  /\byou are (?:now )?[^.!?\n]*/gi,
  /\bnew instructions?\b[^.!?\n]*/gi
];

/**
 * N3 纵深防御：口头摘要内嵌 `objective`，它来自可能被精心构造的任务。
 * 剥掉控制字符、中和提示注入前导语、折叠空白、限制长度，
 * 让恶意目标无法左右 Michael 说的话或做的事。
 * （Kevin 在 session.ts 注入接缝处也会中和——这是观察器这半边的“腰带”。）
 */
function neutralizeForVoice(text: string): string {
  let out = text.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  for (const p of INJECTION_PATTERNS) out = out.replace(p, '[omitted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function isDoneStatus(status: string | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'done';
}

/** 把 ISO 时间戳解析为 epoch 毫秒；缺失或无法解析时返回 null。 */
function parseTs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 熔断器 / 调度器 / 系统发送者永远不算真正的完成回复。 */
function isSystemSender(from: string | undefined): boolean {
  const f = (from ?? '').toLowerCase();
  return f === 'breaker' || f === 'scheduler' || f === 'system' || f === '';
}

function speakableName(agentId: string): string {
  // "oscar-mqpbr18v" → "Oscar"。若没有名称段则回退到原始 id。
  const head = agentId.split('-')[0] ?? agentId;
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : agentId;
}

function summarize(pending: PendingDispatch, via: CompletionResult['via']): string {
  const who = speakableName(pending.targetAgentId);
  // N3：目标文字是任务提供的——先中和再让它到达语音模型。
  const obj = pending.objective ? neutralizeForVoice(pending.objective) : '';
  const what = obj ? `，关于「${obj}」` : '';
  const tail = via === 'card-done' ? '（卡片已标记完成）' : '';
  return `${who} 已完成${what}。${tail}`.replace(' 。', '。');
}

/**
 * 纯完成谓词——给定一个待处理的派发 + tasks/inbox 快照，
 * 判定工作是否已完成。没有 I/O、没有 realtime 导入，完全可测。
 *
 * 完成 = 卡片→done（当 taskId 已知时）或收件人发来的、
 * 晚于派发时间的 inbox 回复（优先显式的 `in_reply_to` 匹配）。
 */
export function detectCompletion(pending: PendingDispatch, ctx: CompletionContext): CompletionResult {
  // (a) 已派发的卡片翻到了 done。
  if (pending.taskId) {
    const card = ctx.tasks.find((t) => t.id === pending.taskId);
    if (card && isDoneStatus(card.status)) {
      return { done: true, via: 'card-done', at: pending.dispatchedAt, summary: summarize(pending, 'card-done') };
    }
  }

  // (b) 收件人发回了 done 消息。优先显式的 in_reply_to；否则接受
  //     一条来自收件人、晚于派发时间的非系统消息。
  let best: { msg: InboxMessage; at: number } | null = null;
  for (const m of ctx.inbox) {
    if (m.from !== pending.targetAgentId) continue;
    if (isSystemSender(m.from)) continue;
    const replyMatch = !!pending.dispatchMessageId && m.in_reply_to === pending.dispatchMessageId;
    const at = parseTs(m.created_at);
    const postDates = at === null ? false : at >= pending.dispatchedAt;
    if (replyMatch || postDates) {
      const effAt = at ?? pending.dispatchedAt;
      if (!best || effAt >= best.at) best = { msg: m, at: effAt };
      // 显式的回复匹配具有权威性——立即采用。
      if (replyMatch) break;
    }
  }
  if (best) {
    return {
      done: true,
      via: 'inbox-reply',
      at: best.at,
      messageId: best.msg.id,
      summary: summarize(pending, 'inbox-reply')
    };
  }

  return { done: false };
}

type CompletionListener = (event: RealtimeCompletion) => void;
interface Waiter {
  taskId: string;
  resolve: (e: RealtimeCompletion) => void;
}

/**
 * 完成观察器。构造一次（在 index.ts 里），`start()` 它，给每次语音派发
 * `track()`，并用 `onCompletion()` 接收事件。它轮询注入的读取器、运行
 * 纯检测器、路由结果：会话存活时发出，否则排队（+ 通知）供热启动。
 * 它不拥有任何 realtime/session/electron 状态——Kevin 的核心把 emit
 * 接到 main→renderer 推送通道上。
 */
export class RealtimeCompletionWatcher {
  private readonly deps: CompletionWatcherDeps;
  private readonly now: () => number;
  private readonly pollMs: number;

  private readonly pending = new Map<string, PendingDispatch>();
  private readonly listeners = new Set<CompletionListener>();
  private readonly waiters = new Set<Waiter>();
  /** 会话未存活时检测到的完成——在热启动时排空。 */
  private queued: RealtimeCompletion[] = [];
  private sessionLive = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CompletionWatcherDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  /** 开始观察一个已派发的工作单元。按 correlationId 幂等。 */
  track(record: PendingDispatch): void {
    this.pending.set(record.correlationId, record);
    this.prunePending();
  }

  /** 停止观察一次派发（例如它被取消了）。 */
  untrack(correlationId: string): void {
    this.pending.delete(correlationId);
  }

  /** 订阅完成事件。返回退订函数。 */
  onCompletion(cb: CompletionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * 等待某个特定任务的完成（`wait_for(taskId)` 工具路径）。以完成事件
   * 兑现，或在 `timeoutMs` 后以超时哨兵兑现。若任务已在跟踪中则用完整
   * 检测；未跟踪的 taskId 仍会在卡片→done 信号上兑现。
   */
  waitFor(taskId: string, timeoutMs: number): Promise<RealtimeCompletion | { timedOut: true; taskId: string }> {
    // 已完成?基于当前快照同步兑现。
    const immediate = this.checkOne(this.pendingForTask(taskId) ?? this.syntheticPending(taskId));
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      const waiter: Waiter = { taskId, resolve: (e) => resolve(e) };
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve({ timedOut: true, taskId });
      }, Math.max(0, timeoutMs));
      // 确保超时器不会独自让进程保持存活。
      if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();
    });
  }

  /** 告诉观察器 realtime 会话当前是否存活（发出 vs 排队）。 */
  setSessionLive(live: boolean): void {
    this.sessionLive = live;
  }

  /** 返回并清空会话未存活时排队的完成（热启动使用）。 */
  drainQueuedCompletions(): RealtimeCompletion[] {
    const out = this.queued;
    this.queued = [];
    return out;
  }

  /** 仍在被观察的派发数量（诊断）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 启动轮询循环。可安全地重复调用。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** 停止轮询循环。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 对所有待处理派发运行一次检测。供测试 / 手动滴答暴露。 */
  poll(): void {
    if (this.pending.size === 0 && this.waiters.size === 0) return;
    this.prunePending();
    for (const record of [...this.pending.values()]) {
      const event = this.checkOne(record);
      if (event) {
        this.pending.delete(record.correlationId);
        this.route(event);
      }
    }
  }

  /**
   * N2：约束 pending 表，让长会话无法泄漏。丢弃被放弃的派发
   * （早于 TTL 的——我们永远不会看到它们的完成），然后若仍超上限，
   * 按派发时间逐出最旧的。
   */
  private prunePending(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [id, rec] of this.pending) {
      if (rec.dispatchedAt > 0 && rec.dispatchedAt < cutoff) this.pending.delete(id);
    }
    if (this.pending.size > MAX_PENDING) {
      const oldestFirst = [...this.pending.entries()].sort(
        (a, b) => a[1].dispatchedAt - b[1].dispatchedAt
      );
      const overflow = this.pending.size - MAX_PENDING;
      for (let i = 0; i < overflow; i++) this.pending.delete(oldestFirst[i][0]);
    }
  }

  // --- 内部 ---

  private snapshot(): CompletionContext {
    return { tasks: safeRead(this.deps.readTasks), inbox: safeRead(this.deps.readInbox) };
  }

  private checkOne(record: PendingDispatch): RealtimeCompletion | null {
    const res = detectCompletion(record, this.snapshot());
    if (!res.done) return null;
    return {
      correlationId: record.correlationId,
      kind: record.kind,
      targetAgentId: record.targetAgentId,
      taskId: record.taskId,
      objective: record.objective,
      via: res.via ?? 'inbox-reply',
      completedAt: res.at ?? this.now(),
      summary: res.summary ?? summarize(record, res.via),
      messageId: res.messageId
    };
  }

  /** 兑现此任务的任何等待者，然后发出（存活）或排队（关闭）。 */
  private route(event: RealtimeCompletion): void {
    for (const w of [...this.waiters]) {
      if (event.taskId && w.taskId === event.taskId) {
        this.waiters.delete(w);
        w.resolve(event);
      }
    }
    if (this.sessionLive) {
      for (const l of this.listeners) {
        try {
          l(event);
        } catch {
          /* 监听器抛出异常绝不能拖住观察器 */
        }
      }
    } else {
      this.queued.push(event);
      // N2：限制关闭会话的积压——只保留最近的 MAX_QUEUED 个。
      if (this.queued.length > MAX_QUEUED) this.queued = this.queued.slice(-MAX_QUEUED);
      try {
        this.deps.onNotify?.(event);
      } catch {
        /* 通知是尽力而为 */
      }
    }
  }

  private pendingForTask(taskId: string): PendingDispatch | undefined {
    for (const r of this.pending.values()) if (r.taskId === taskId) return r;
    return undefined;
  }

  /** 未跟踪 wait_for(taskId) 的最小 pending 记录——仅卡片→done。 */
  private syntheticPending(taskId: string): PendingDispatch {
    return { correlationId: `wait:${taskId}`, kind: 'task', targetAgentId: '', taskId, dispatchedAt: 0 };
  }
}

/** 防御性读取源——抛异常/迟钝的读取器得到空快照，绝不搞崩轮询。 */
function safeRead<T>(reader: () => T[]): T[] {
  try {
    const v = reader();
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// --- 共享单例（与 Kevin 的 rt-12 契约锁）------------------------------------
// 整个主进程只有一个观察器实例：一个 pending 表、一个队列。index.ts
// 用真实的 hive 支撑读取器初始化它；realtimeActions.ts（以及任何其他核心
// 调用方）通过 getCompletionWatcher() 拿到同一个实例。这避免了每个调用
// 各建一个观察器、track() 和 onCompletion() 落在不同对象上的情况。

let _instance: RealtimeCompletionWatcher | null = null;

/**
 * 创建（一次）并返回共享的完成观察器单例。从 index.ts 用 hive.ts 支撑的
 * 读取器调用它。再次调用会返回已有实例（后续 `deps` 被忽略），
 * 让每个导入方共享同一个观察器。
 */
export function initCompletionWatcher(deps: CompletionWatcherDeps): RealtimeCompletionWatcher {
  if (!_instance) _instance = new RealtimeCompletionWatcher(deps);
  return _instance;
}

/**
 * 获取共享的完成观察器单例。未初始化则抛出——index.ts 必须先调用
 * {@link initCompletionWatcher}。供 realtimeActions.ts 的 track()/waitFor() 使用。
 */
export function getCompletionWatcher(): RealtimeCompletionWatcher {
  if (!_instance) {
    throw new Error(
      'completion watcher not initialized — call initCompletionWatcher(deps) from index.ts first'
    );
  }
  return _instance;
}

/** 测试接缝：丢弃单例，让新实例可以被初始化。 */
export function __resetCompletionWatcherForTest(): void {
  _instance?.stop();
  _instance = null;
}
