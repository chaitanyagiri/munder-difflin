/**
 * Realtime Michael —— 面板增量（delta）观察器（v0.3.4）。
 *
 * 语音会话的上下文策略是“连接时快照 + 只追加的增量”（绝不 session.update
 * 指令——那会打爆 prompt 缓存）。这个观察器就是增量那一半：语音会话存活
 * 期间，它轮询面板在主进程侧的信号，推送短的合并后更新句，由渲染进程把
 * 它们作为静默项目注入对话。
 *
 * 信号（全部归主进程所有——不信任渲染进程）：
 *   - roster：agent 出现 / 归档（hive 注册表）
 *   - tasks：看板台账上的状态转换
 *   - activity：pty 在安静与流式之间翻转（≈ 空闲 ↔ 工作中）
 * 增量被去抖（两次推送之间 ≥ MIN_PUSH_GAP_MS）并合并成一行带括号的
 * 文字，长度设上限。没有会话存活时什么都不发、什么都不排队——
 * 下一次连接会取全新快照。
 */

interface RegistryLike {
  agents: Record<string, { name?: string; archived?: boolean }>;
  godId?: string | null;
}

export interface FloorWatcherDeps {
  enabled(): boolean;
  registry(): RegistryLike;
  tasks(): unknown;
  ptys(): Array<{ id: string; lastOutputAt: number }>;
  push(text: string): void;
}

const POLL_MS = 5_000;
const MIN_PUSH_GAP_MS = 12_000;
const ACTIVE_WINDOW_MS = 8_000;
const MAX_PUSH_CHARS = 600;

export class RealtimeFloorWatcher {
  private deps: FloorWatcherDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private live = false;
  private lastPushAt = 0;
  private buffer: string[] = [];
  private prevAgents = new Map<string, { archived: boolean; name: string }>();
  private prevTasks = new Map<string, { status: string; title: string }>();
  private prevActive = new Map<string, boolean>();
  private primed = false;

  constructor(deps: FloorWatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* 绝不让定时器抛出异常 */ } }, POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSessionLive(live: boolean): void {
    this.live = live;
    // 新会话从新快照开始——旧的缓冲增量会与快照已有的内容重复。
    this.buffer = [];
    this.primed = false; // 重新启动，让连接后的第一个滴答从“现在”开始做差
  }

  private tick(): void {
    if (!this.deps.enabled()) return;

    const reg = this.deps.registry();
    const agents = new Map<string, { archived: boolean; name: string }>();
    for (const [id, m] of Object.entries(reg.agents ?? {})) {
      agents.set(id, { archived: !!m.archived, name: m.name || id });
    }

    const tasksRaw = this.deps.tasks() as { tasks?: Array<{ id?: string; status?: string; title?: string }> } | null;
    const tasks = new Map<string, { status: string; title: string }>();
    for (const t of Array.isArray(tasksRaw?.tasks) ? tasksRaw!.tasks! : []) {
      if (typeof t?.id === 'string') tasks.set(t.id, { status: t.status ?? 'todo', title: t.title ?? t.id });
    }

    const now = Date.now();
    const active = new Map<string, boolean>();
    for (const p of this.deps.ptys()) {
      active.set(p.id.replace(/^pty-/, ''), now - p.lastOutputAt < ACTIVE_WINDOW_MS);
    }

    if (this.primed && this.live) {
      // roster 变化
      for (const [id, cur] of agents) {
        const prev = this.prevAgents.get(id);
        if (!prev) this.buffer.push(`${cur.name} joined the floor`);
        else if (!prev.archived && cur.archived) this.buffer.push(`${cur.name} was archived`);
        else if (prev.archived && !cur.archived) this.buffer.push(`${cur.name} is back from the archive`);
      }
      // 任务状态转换
      for (const [id, cur] of tasks) {
        const prev = this.prevTasks.get(id);
        if (!prev) this.buffer.push(`new task "${cur.title.slice(0, 60)}"`);
        else if (prev.status !== cur.status) this.buffer.push(`task "${cur.title.slice(0, 60)}" moved to ${cur.status}`);
      }
      // activity 翻转（quiet ↔ streaming），经注册表取名
      for (const [id, isActive] of active) {
        const prev = this.prevActive.get(id);
        const name = agents.get(id)?.name;
        if (prev === undefined || !name || agents.get(id)?.archived) continue;
        if (prev && !isActive) this.buffer.push(`${name} went quiet (likely done or idle)`);
        else if (!prev && isActive) this.buffer.push(`${name} started producing output`);
      }
    }

    this.prevAgents = agents;
    this.prevTasks = tasks;
    this.prevActive = active;
    this.primed = true;

    if (!this.live || this.buffer.length === 0) { if (!this.live) this.buffer = []; return; }
    if (now - this.lastPushAt < MIN_PUSH_GAP_MS) return;

    const text = this.buffer.join('; ').slice(0, MAX_PUSH_CHARS);
    this.buffer = [];
    this.lastPushAt = now;
    this.deps.push(text);
  }
}
