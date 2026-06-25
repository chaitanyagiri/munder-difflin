/**
 * Realtime Michael — completion watcher (card rt-12, Phase 2, "respond when done").
 *
 * When voice-Michael DISPATCHES work (fire-and-notify, the default pattern), he does
 * NOT block on it. This module is the main-process engine that watches each dispatched
 * task for completion and EMITS a completion event so the rest of the realtime stack can
 * make Michael speak it unprompted ("Oscar finished — want details?").
 *
 * OWNERSHIP / SEAM (rt-12 split, god-ruled 2026-06-25): this module is OWNED by Jim and
 * is deliberately DISJOINT from Kevin's realtime CORE files. It NEVER imports session.ts
 * / the live RealtimeSession / electron — it only takes injected readers + a clock and
 * EMITS via callbacks. Kevin's side subscribes `onCompletion(...)` and pushes the event
 * down the new main→renderer channel (preload binding + session.ts injection), calls
 * `track(...)` from the dispatch action, flips `setSessionLive(...)` on connect/disconnect,
 * and `drainQueuedCompletions()` at warm-start. Keeping this file electron-free + reader-
 * injected makes it unit-testable and collision-free on the shared checkout.
 *
 * Completion signal (see {@link detectCompletion}) is EITHER:
 *   (a) the dispatched task's card flips to `done` in tasks.json, OR
 *   (b) an inbox done-msg arrives from the assignee (a reply to the dispatch, after it).
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */

/** A unit of work voice-Michael dispatched and is now awaiting completion of. */
export interface PendingDispatch {
  /** Stable id for this dispatch (the watcher key). e.g. the dispatch message id. */
  correlationId: string;
  /** What kind of work was dispatched — shapes the spoken summary. */
  kind: 'dispatch' | 'task' | 'spawn';
  /** The agent the work went to (e.g. "oscar-mqpbr18v"). */
  targetAgentId: string;
  /** The task-card id, if a card exists for this dispatch (enables card→done detection). */
  taskId?: string;
  /** Short objective text, for the spoken summary. */
  objective?: string;
  /** Epoch-ms the dispatch happened — only signals AFTER this count (avoids stale replies). */
  dispatchedAt: number;
  /** The dispatch message id, if known — lets us match an inbox reply via `in_reply_to`. */
  dispatchMessageId?: string;
}

/** Minimal task-card shape we read from tasks.json (extra fields ignored). */
export interface TaskCard {
  id: string;
  status?: string;
  assignee?: string | null;
  owner?: string | null;
  title?: string;
}

/** Minimal inbox-message shape we scan for done-signals (extra fields ignored). */
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

/** The data the detector reads — injected so this module touches no filesystem itself. */
export interface CompletionContext {
  tasks: TaskCard[];
  inbox: InboxMessage[];
}

/** Outcome of the pure detection predicate. */
export interface CompletionResult {
  done: boolean;
  /** How completion was observed — for logging + de-dupe. */
  via?: 'card-done' | 'inbox-reply';
  /** Epoch-ms the completion was observed (best-effort). */
  at?: number;
  /** Short, speakable summary of what finished. */
  summary?: string;
  /** The matched inbox message id (when via 'inbox-reply') — lets the watcher de-dupe. */
  messageId?: string;
}

/**
 * The completion object the watcher emits via `onCompletion` AND returns from
 * `drainQueuedCompletions()` — the SAME shape (rt-12 contract lock with Kevin). Kevin
 * forwards it verbatim over the main→renderer push channel and into warm-start, so every
 * field here reaches Michael. `summary` is the human-speakable line; `completedAt` is
 * epoch-ms. The trailing fields are extra context (safe to ignore on the wire).
 */
export interface RealtimeCompletion {
  correlationId: string;
  kind: PendingDispatch['kind'];
  targetAgentId: string;
  taskId?: string;
  /** Human-speakable line, e.g. "Oscar finished the cost guard." */
  summary: string;
  /** Epoch-ms the completion was observed. */
  completedAt: number;
  /** Short objective text — extra context for a toast / log. */
  objective?: string;
  /** How completion was detected — extra, for logging / de-dupe. */
  via?: 'card-done' | 'inbox-reply';
  /** Matched inbox message id when via 'inbox-reply' — extra, for de-dupe. */
  messageId?: string;
}

/** Dependencies injected by the wiring (index.ts), so the watcher stays electron-free. */
export interface CompletionWatcherDeps {
  /** Current task cards (from tasks.json). Called each poll. */
  readTasks: () => TaskCard[];
  /** Current dispatcher-inbox messages (where assignee replies land). Called each poll. */
  readInbox: () => InboxMessage[];
  /** Clock — injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Poll cadence in ms. Default 4000. */
  pollIntervalMs?: number;
  /** Optional OS-notification hook (e.g. electron Notification) for the session-closed path. */
  onNotify?: (event: RealtimeCompletion) => void;
}

const DEFAULT_POLL_MS = 4000;

function isDoneStatus(status: string | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'done';
}

/** Parse an ISO timestamp to epoch-ms; returns null if absent/unparseable. */
function parseTs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** A circuit-breaker / scheduler / system sender never counts as a real completion reply. */
function isSystemSender(from: string | undefined): boolean {
  const f = (from ?? '').toLowerCase();
  return f === 'breaker' || f === 'scheduler' || f === 'system' || f === '';
}

function speakableName(agentId: string): string {
  // "oscar-mqpbr18v" → "Oscar". Falls back to the raw id if it has no name segment.
  const head = agentId.split('-')[0] ?? agentId;
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : agentId;
}

function summarize(pending: PendingDispatch, via: CompletionResult['via']): string {
  const who = speakableName(pending.targetAgentId);
  const what = pending.objective ? ` on "${pending.objective.slice(0, 80)}"` : '';
  const tail = via === 'card-done' ? ' (card marked done)' : '';
  return `${who} finished${what}.${tail}`.replace(' .', '.');
}

/**
 * PURE completion predicate — given a pending dispatch and a snapshot of tasks + inbox,
 * decide whether the work has completed. No I/O, no realtime imports, fully testable.
 *
 * Completion = card→done (when a taskId is known) OR an inbox reply from the assignee
 * that post-dates the dispatch (preferring an explicit `in_reply_to` match).
 */
export function detectCompletion(pending: PendingDispatch, ctx: CompletionContext): CompletionResult {
  // (a) The dispatched card flipped to done.
  if (pending.taskId) {
    const card = ctx.tasks.find((t) => t.id === pending.taskId);
    if (card && isDoneStatus(card.status)) {
      return { done: true, via: 'card-done', at: pending.dispatchedAt, summary: summarize(pending, 'card-done') };
    }
  }

  // (b) The assignee sent a done-msg back. Prefer an explicit in_reply_to; otherwise accept
  //     a non-system message from the assignee that post-dates the dispatch.
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
      // An explicit reply match is authoritative — take it immediately.
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
 * The completion watcher. Construct once (in index.ts), `start()` it, `track()` each voice
 * dispatch, and `onCompletion()` to receive events. It polls the injected readers, runs the
 * pure detector, and routes results: emit when a session is live, else queue (+ notify) for
 * warm-start. It owns NO realtime/session/electron state — Kevin's core wires the emit to
 * the main→renderer push channel.
 */
export class RealtimeCompletionWatcher {
  private readonly deps: CompletionWatcherDeps;
  private readonly now: () => number;
  private readonly pollMs: number;

  private readonly pending = new Map<string, PendingDispatch>();
  private readonly listeners = new Set<CompletionListener>();
  private readonly waiters = new Set<Waiter>();
  /** Completions detected while no session was live — drained at warm-start. */
  private queued: RealtimeCompletion[] = [];
  private sessionLive = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CompletionWatcherDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  /** Begin watching a dispatched unit of work. Idempotent per correlationId. */
  track(record: PendingDispatch): void {
    this.pending.set(record.correlationId, record);
  }

  /** Stop watching a dispatch (e.g. it was cancelled). */
  untrack(correlationId: string): void {
    this.pending.delete(correlationId);
  }

  /** Subscribe to completion events. Returns an unsubscribe fn. */
  onCompletion(cb: CompletionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Await a specific task's completion (the `wait_for(taskId)` tool path). Resolves with the
   * completion event, or with a timeout sentinel after `timeoutMs`. If the task is already
   * tracked we use full detection; an untracked taskId still resolves on a card→done signal.
   */
  waitFor(taskId: string, timeoutMs: number): Promise<RealtimeCompletion | { timedOut: true; taskId: string }> {
    // Already complete? Resolve synchronously off the current snapshot.
    const immediate = this.checkOne(this.pendingForTask(taskId) ?? this.syntheticPending(taskId));
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      const waiter: Waiter = { taskId, resolve: (e) => resolve(e) };
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve({ timedOut: true, taskId });
      }, Math.max(0, timeoutMs));
      // Ensure the timeout never keeps the process alive on its own.
      if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();
    });
  }

  /** Tell the watcher whether a realtime session is currently live (emit vs queue). */
  setSessionLive(live: boolean): void {
    this.sessionLive = live;
  }

  /** Return + clear completions that queued while no session was live (warm-start use). */
  drainQueuedCompletions(): RealtimeCompletion[] {
    const out = this.queued;
    this.queued = [];
    return out;
  }

  /** Number of dispatches still being watched (diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Start the poll loop. Safe to call repeatedly. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop the poll loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run detection across all pending dispatches once. Exposed for tests / manual ticks. */
  poll(): void {
    if (this.pending.size === 0 && this.waiters.size === 0) return;
    for (const record of [...this.pending.values()]) {
      const event = this.checkOne(record);
      if (event) {
        this.pending.delete(record.correlationId);
        this.route(event);
      }
    }
  }

  // --- internals ---

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

  /** Resolve any waiters for this task, then emit (live) or queue (closed). */
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
          /* a listener throwing must not stall the watcher */
        }
      }
    } else {
      this.queued.push(event);
      try {
        this.deps.onNotify?.(event);
      } catch {
        /* notification is best-effort */
      }
    }
  }

  private pendingForTask(taskId: string): PendingDispatch | undefined {
    for (const r of this.pending.values()) if (r.taskId === taskId) return r;
    return undefined;
  }

  /** Minimal pending record for an untracked wait_for(taskId) — card→done only. */
  private syntheticPending(taskId: string): PendingDispatch {
    return { correlationId: `wait:${taskId}`, kind: 'task', targetAgentId: '', taskId, dispatchedAt: 0 };
  }
}

/** Read a source defensively — a throwing/late reader yields an empty snapshot, never crashes the poll. */
function safeRead<T>(reader: () => T[]): T[] {
  try {
    const v = reader();
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// --- shared singleton (rt-12 contract lock with Kevin) ------------------------------------
// ONE watcher instance across the whole main process: one pending map, one queue. index.ts
// initializes it with the real hive-backed readers; realtimeActions.ts (and any other core
// caller) get that SAME instance via getCompletionWatcher(). This avoids a per-call watcher
// where track() and onCompletion() would land on different objects.

let _instance: RealtimeCompletionWatcher | null = null;

/**
 * Create (once) and return the shared completion-watcher singleton. Call this from index.ts
 * with readers backed by hive.ts. Calling again returns the existing instance (later `deps`
 * are ignored) so every importer shares one watcher.
 */
export function initCompletionWatcher(deps: CompletionWatcherDeps): RealtimeCompletionWatcher {
  if (!_instance) _instance = new RealtimeCompletionWatcher(deps);
  return _instance;
}

/**
 * Get the shared completion-watcher singleton. Throws if not yet initialized — index.ts must
 * call {@link initCompletionWatcher} first. Use from realtimeActions.ts for track()/waitFor().
 */
export function getCompletionWatcher(): RealtimeCompletionWatcher {
  if (!_instance) {
    throw new Error(
      'completion watcher not initialized — call initCompletionWatcher(deps) from index.ts first'
    );
  }
  return _instance;
}

/** Test seam: drop the singleton so a fresh instance can be initialized. */
export function __resetCompletionWatcherForTest(): void {
  _instance?.stop();
  _instance = null;
}
