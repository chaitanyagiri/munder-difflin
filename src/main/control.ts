/**
 * ControlRegistry —— 对运行中 agent 的操作员控制（#7C.1–7C.3）。
 *
 * 保存每个 agent 的控制状态，HookServer 在决定 hook 返回什么时读取它。这就是
 * 工作区“无需向 PTY 输入文字”也能施加控制的方式：决策搭乘 Claude Code
 * 自己的 hook 返回协议。
 *
 *   - pause / gateTool（#7C.1）→ PreToolUse 返回 permissionDecision:'deny'
 *     （无竞态、即时——不经过渲染进程往返，因此不会撞上 shim 超时）。缓慢的
 *     人工 APPROVAL 则刻意走 Claude 的原生提示，符合规范的延迟缓解要求。
 *   - steer（#7C.2）→ 下一个 UserPromptSubmit/PostToolUse 返回
 *     additionalContext，把指导一次性注入 agent 的上下文。
 *   - halt（#7C.3）→ 下一个 hook 边界返回 { continue:false }，让 agent
 *     “干净地”停下（而不是杀掉 PTY）。覆盖 inbox 排空。
 *
 * 运行在 Electron 主进程；不 import electron（可单元测试）。
 */

/** 每个 agent 排队中的 steer 通知上限，超出后丢弃最旧的一条。每条通知
 *  搭乘下一个 hook 的 additionalContext；停滞/已暂停的 agent 永远不会排空
 *  队列，因此没有上限的话，一阵 steer 突发（closing-time 循环、卡住的
 *  调用方）会让内存无限增长。最新的指令优先：队列满时我们从队首丢弃
 *  （FIFO），这样忙碌的 agent 仍能听到最近的通知。 */
const MAX_PENDING_STEERS = 20;

export interface AgentControlSnapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

interface AgentControl {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: Set<string>;
  steerQueue: string[];
}

export class ControlRegistry {
  private readonly map = new Map<string, AgentControl>();

  private ensure(id: string): AgentControl {
    let c = this.map.get(id);
    if (!c) {
      c = {
        paused: false,
        halted: false,
        autoDeliveryPaused: false,
        gatedTools: new Set(),
        steerQueue: []
      };
      this.map.set(id, c);
    }
    return c;
  }

  // ─── 操作员动作（接到 IPC）──────────────────────────────────────────────────

  pause(id: string, on: boolean): void { this.ensure(id).paused = on; }
  pauseAutoDelivery(id: string, on: boolean): void {
    this.ensure(id).autoDeliveryPaused = on;
  }
  replaceAutoDeliveryPauses(ids: Iterable<string>): void {
    const paused = new Set(ids);
    for (const [id, control] of this.map) {
      control.autoDeliveryPaused = paused.has(id);
    }
    for (const id of paused) this.ensure(id).autoDeliveryPaused = true;
  }
  gateTool(id: string, tool: string, on: boolean): void {
    const c = this.ensure(id);
    if (on) c.gatedTools.add(tool); else c.gatedTools.delete(tool);
  }
  steer(id: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    const q = this.ensure(id).steerQueue;
    if (q.length >= MAX_PENDING_STEERS) {
      // 丢弃最旧的，让最新指令仍能到达下一个 hook
      // 边界。记录一条面包屑，让悄悄从队首掉落的通知可被诊断——
      // 队列满了意味着该 agent 已经很久无法联系到。
      console.warn(`[control] ${id}: steer queue full (${MAX_PENDING_STEERS}) — dropping oldest note`);
      q.shift(); // 保留最新通知，丢弃最旧的
    }
    q.push(t.slice(0, 10000)); // hook additionalContext 上限
  }
  /** 请求在下一个 hook 边界处优雅停止。 */
  halt(id: string): void { this.ensure(id).halted = true; }
  /** 丢弃所有已排队但尚未送达的 steer 通知（例如：忙碌 agent 的下一个 hook
   *  边界还没来得及消化指令，closing time 就被取消了）。 */
  clearSteers(id: string): void { const c = this.map.get(id); if (c) c.steerQueue.length = 0; }
  /** 清除 pause + halt（让已暂停/已停止的 agent 重新运行）。保留门控。 */
  resume(id: string): void { const c = this.ensure(id); c.paused = false; c.halted = false; }

  // ─── 读取（供 HookServer 使用）────────────────────────────────────────────

  shouldHalt(id: string): boolean { return this.map.get(id)?.halted ?? false; }
  isAutoDeliveryPaused(id: string): boolean {
    return this.map.get(id)?.autoDeliveryPaused ?? false;
  }

  /** 工具调用是否应被拒绝（agent 已暂停，或该工具被门控）。 */
  toolDecision(id: string, tool: string): { deny: boolean; reason?: string } {
    const c = this.map.get(id);
    if (!c) return { deny: false };
    if (c.paused) return { deny: true, reason: '已被操作员暂停——回到楼层以恢复。' };
    if (tool && c.gatedTools.has(tool)) return { deny: true, reason: `工具 ${tool} 已被操作员门控。` };
    return { deny: false };
  }

  /** 弹出一条待投递的 steer 通知，若无则返回 undefined。 */
  takeSteer(id: string): string | undefined { return this.map.get(id)?.steerQueue.shift(); }

  snapshot(id: string): AgentControlSnapshot {
    const c = this.map.get(id);
    return {
      paused: c?.paused ?? false,
      halted: c?.halted ?? false,
      autoDeliveryPaused: c?.autoDeliveryPaused ?? false,
      gatedTools: c ? Array.from(c.gatedTools) : [],
      pendingSteers: c?.steerQueue.length ?? 0
    };
  }
}
