/**
 * WorkerWakeWatchdog —— 主进程针对工作线程代理的收件箱唤醒看门狗（#151）。
 *
 * 渲染进程的空闲收件箱唤醒提示（useHive.ts 的 effect #3）是唯一能让
 * 在提示符处安静下来的工作线程重新醒来的路径：它在渲染进程里用
 * setInterval 轮询，因此被节流/遮挡的窗口（Chromium 会挂起后台的
 * setInterval 定时器）可能错过邮件落地的时刻，然后工作线程就会永远
 * 坐在一个未被消费的收件箱前——编排者（"god"）从不会有这个问题，
 * 因为主进程会按自己的心跳节奏重新驱动它。
 *
 * 这个看门狗是工作线程侧的对应物：按节奏找出真正空闲、有未消费的收件箱
 * 邮件、未暂停/未等待人类决策、且最近未被提示过的工作线程——然后把
 * 渲染进程本会打出的那个同样带防护的提示，直接敲进 PTY。
 *
 * 安全性与渲染进程带防护的队列排空（useHive.ts dispatch）保持一致：
 *  - 只有 GENUINELY 空闲的工作线程才会被提示（IDLE_MS 内没有 PTY 输出——
 *    与渲染进程空闲回退所用的同一静默标准），绝不打扰回合中途的线程，
 *  - 绝不在启动序列内提示（生成后的 BOOT_GRACE_MS，对应渲染进程的
 *    bootGraceUntil），
 *  - 投递暂停 / 代理暂停 / 已停机 → 不提示（ControlRegistry），
 *  - 最近的权限/HITL 通知会重新武装一次封锁（HITL_REARM_MS），确保
 *    人类正在决策的提示不会被敲进去，
 *  - 每个工作线程有冷却时间（NUDGE_COOLDOWN_MS），避免看门狗与渲染进程
 *    的提示叠加在一起。
 *
 * 刻意复用渲染进程自己的提示文本，以及渲染进程 submitToPty 所用的同一
 * 打字模式（先文本，Enter 作为单独的按键）。
 *
 * 不 import electron —— 可单元测试（与 ControlRegistry 一致）。
 */

/** 渲染进程收件箱唤醒循环本会敲出的那一条确切提示。 */
export const WORKER_WAKE_NUDGE =
  'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.';

/** 这么久没有 PTY 输出 = 真正空闲（渲染进程的 QUIESCE_IDLE_MS）。 */
export const WORKER_WAKE_IDLE_MS = 12_000;
/** 绝不在启动序列内提示（渲染进程的 BOOT_GRACE_MS）。 */
export const WORKER_WAKE_BOOT_GRACE_MS = 35_000;
/** 同一工作线程两次看门狗提示之间的最小间隔。 */
export const WORKER_WAKE_COOLDOWN_MS = 60_000;
/** 权限/HITL 通知触发后，会在这么长时间内封锁提示。 */
export const WORKER_WAKE_HITL_REARM_MS = 5 * 60_000;

/** 表示「代理需要人类」的钩子事件消息——权限 / 批准 / 确认提示
 *  （对应渲染进程 useHive.ts 中的 needsHuman 检测）。任何符合
 *  空闲等待形态的消息都不是 HITL 挂起。 */
export type HookClass = 'needsHuman' | 'idle' | null;

export function classifyHook(event: string | undefined, message: string | undefined): HookClass {
  if (event === 'Notification') {
    const msg = (message ?? '').toLowerCase();
    const idleWaiting = !msg
      || msg.includes('waiting for your input')
      || msg.includes('is idle')
      || msg.includes('waiting for input');
    const needsHuman = msg.includes('permission')
      || msg.includes('approve')
      || msg.includes('confirm')
      || msg.includes('needs your');
    if (needsHuman && !idleWaiting) return 'needsHuman';
    return 'idle';
  }
  return null;
}

/** 某个工作线程的实时事实，由调用方每个周期收集。 */
export interface WorkerWakeFacts {
  /** 工作线程代理 id（god 永远不会成为候选）。 */
  agentId: string;
  /** 该代理是否为编排者——god 永远不会被提示。 */
  isGod?: boolean;
  /** 实时 PTY id；代理没有终端时为 undefined。 */
  ptyId?: string;
  /** PTY 最后一次输出的时间戳（0 = 从未输出）。 */
  lastOutputAt: number;
  /** 未消费的收件箱消息数（0 → 没有需要唤醒的理由）。 */
  inboxCount: number;
  /** ControlRegistry 快照标志。 */
  autoDeliveryPaused: boolean;
  paused: boolean;
  halted: boolean;
}

export class WorkerWakeWatchdog {
  /** ptyId → 生成时间戳（启动宽限）。 */
  private spawnedAt = new Map<string, number>();
  /** agentId → 上次提示时间戳（冷却）。 */
  private lastNudgeAt = new Map<string, number>();
  /** agentId → 最近一次 needsHuman 钩子通知的时间戳。 */
  private lastHumanNeedsAt = new Map<string, number>();

  /** 记录一次 PTY 生成，以便它的启动序列不被打扰。 */
  noteSpawn(ptyId: string, at = Date.now()): void {
    this.spawnedAt.set(ptyId, at);
  }

  /** 投喂钩子事件（来自 HookServer），使 HITL 提示得以封锁提示。 */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now()): void {
    if (!agentId) return;
    if (classifyHook(event, message) === 'needsHuman') this.lastHumanNeedsAt.set(agentId, at);
  }

  /** 遗忘按代理的状态（例如该代理的 PTY 已关闭）。 */
  forget(agentId: string, ptyId?: string): void {
    this.lastNudgeAt.delete(agentId);
    this.lastHumanNeedsAt.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** 现在应当被提示的工作线程 id，按稳定的注册表顺序。纯决策——由调用方敲入提示。 */
  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    const out: string[] = [];
    for (const f of facts) {
      if (f.isGod || f.inboxCount <= 0 || !f.ptyId) continue;
      if (f.autoDeliveryPaused || f.paused || f.halted) continue;
      if (f.lastOutputAt <= 0) continue; // 从未产生输出 → 仍在启动中
      if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS) continue; // 回合中途
      const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
      if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) continue;
      const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
      if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) continue;
      const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;
      if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) continue;
      this.lastNudgeAt.set(f.agentId, now);
      out.push(f.agentId);
    }
    return out;
  }

  /** 该工作线程上次被提示的时间（0 = 从未）——用于诊断。 */
  lastNudge(agentId: string): number {
    return this.lastNudgeAt.get(agentId) ?? 0;
  }
}