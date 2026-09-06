/**
 * Closing Time —— 优雅、零数据丢失的关闭协议。
 *
 * 在 agent 思考中途杀掉 PTY，会丢失它们工作内存里的一切：未提交的 WIP、
 * 未记录的决定、写到一半的 memory.md 文件。“打烊时间（closing time）”像真实
 * 办公室那样收尾：人类宣布打烊，每位员工收拾好并确认，经理锁门。
 *
 *   1. 人类在退出对话框里点击“closing time”。
 *   2. 我们给 god agent 发送一份关闭简报：向团队广播 closing time；每个
 *      worker 提交/暂存 WIP，把状态 + 后续步骤追加到自己的 memory.md，
 *      然后以主题 CLOSING-TIME-ACK 回复。
 *   3. god 等待每个 ACK（harness 通过观察同一份 inbox 流量显示实时进度）、
 *      保存自己的记忆，并发送主题为 CLOSING-TIME-COMPLETE 的消息。
 *   4. 路由器观察者发现那条消息 → 应用拆除并退出。
 *
 * 一切都搭乘现有的 hive 轨道：inbox 投递、空闲时 inbox-wake 轻推，以及
 * Stop-hook 排空，已经保证消息会被处理。本模块只注入启动邮件并观察
 * 被路由的流量——它从不向终端输入文字。
 *
 * 运行在 Electron 主进程。
 */
import type { WebContents } from 'electron';
import type { HiveManager, HiveMessage } from './hive';
import type { ControlRegistry } from './control';

export type ClosingTimePhase =
  | 'started' | 'progress' | 'complete' | 'timeout' | 'cancelled';

export interface ClosingTimeEvent {
  phase: ClosingTimePhase;
  /** 目前已经 ACK 的 worker 数 / 正在等待的 worker 总数。 */
  acked: number;
  total: number;
}

/** 主题标记。刻意放宽匹配（大小写、-/ _/空格）——agent 是手写的，
 *  因此 “Closing Time Ack” 也要算数，和简报要求的规范写法
 *  CLOSING-TIME-ACK 一样生效。 */
const ACK_RE = /CLOSING[-_\s]*TIME[-_\s]*ACK/i;
const COMPLETE_RE = /CLOSING[-_\s]*TIME[-_\s]*COMPLETE/i;

/** 在提示“耗时过长——强制退出？”之前等待多久。
 *  压缩或一次很长的工具调用很容易让 ACK 拖上几分钟。 */
const TIMEOUT_MS = 6 * 60_000;
/** COMPLETE 之后、拆除之前的宽限期，让 god 最后的提交/日志写入
 *  落到磁盘上，工作区也能可见地收尾。 */
const TEARDOWN_GRACE_MS = 2_500;

export class ClosingTimeController {
  private active = false;
  private godId = 'god';
  private workers = new Set<string>();
  private acked = new Set<string>();
  private timeoutTimer: NodeJS.Timeout | null = null;
  private teardownTimer: NodeJS.Timeout | null = null;

  constructor(
    private hive: HiveManager,
    /** 当前拥有 LIVE PTY 的 agent id。仅靠 hive 注册表是不够的：随应用一起
     *  死亡的 agent（硬退出、崩溃）会保留注册记录，却从未被标记为
     *  `archived`，因此基于注册表的名册会一直等待永远无法 ACK 的幽灵。 */
    private getLiveAgentIds: () => string[],
    private getWebContents: () => WebContents | null,
    /** 一旦 god 结束时调用——执行真正的拆除 + app.quit()。 */
    private onConcluded: () => void,
    /** 运行中的 steering（#7C.2）：让 closing time 能在深度忙碌（DEEP BUSY）的
     *  agent 到达下一个 hook 边界时触达它，而不是等待 Stop-hook 的 inbox
     *  排空——这就是优雅中断。可选参数，测试可以省略它。 */
    private control?: ControlRegistry
  ) {}

  isActive(): boolean {
    return this.active;
  }

  /** 启动协议。当工作区无法运行时（没有在线的 god agent）返回错误字符串，
   *  这样 UI 可以回退到硬退出。 */
  start(): { ok: boolean; error?: string } {
    if (this.active) {
      // 运行中被再次按下（例如从超时视图）：继续等待。
      this.armTimeout();
      this.emitState('progress');
      return { ok: true };
    }
    const reg = this.hive.registry();
    this.godId = reg.godId ?? 'god';
    const live = new Set(this.getLiveAgentIds());
    if (!reg.agents[this.godId] || !live.has(this.godId)) {
      return { ok: false, error: '没有编排器在运行——关闭流程需要 god agent 来收集报告。' };
    }

    // 只有拥有在线终端的 agent 才会被等待——注册表在这里只是
    // 元数据（名字 + god/assistant 标志），绝不是名册来源。
    this.workers = new Set(
      [...live].filter((id) => {
        const a = reg.agents[id];
        return id !== this.godId && !!a && !a.isGod;
      })
    );
    this.acked = new Set();
    this.active = true;

    const names = [...this.workers]
      .map((id) => `${reg.agents[id]?.name ?? id} (${id})`)
      .join(', ') || '(none — the floor is just you)';

    this.hive.send({
      to: 'god',
      act: 'request',
      subject: 'CLOSING TIME —— 现在执行关闭协议',
      body: [
        '人类按下了「closing time」：只要你确认楼层安全，整个框架就会关闭。现在立刻执行本协议，先于任何其他事项：',
        '',
        `1. 向团队 BROADCAST closing time（消息里带 "to":"broadcast"）。当前成员：${names}。`,
        '   告诉每个成员立刻：安全地暂存或提交手头未完成的工作，把当前状态 + 具体下一步追到其 memory.md，然后回复你一条 subject 恰好为 "CLOSING-TIME-ACK" 的消息。',
        '2. 等待并持续清空收件箱，直到上面每一个成员都发来了它的 CLOSING-TIME-ACK。必要时催促一次掉队的。',
        '3. 保存你自己的状态：更新 board.md，并把本轮小结追到你的 memory.md。',
        `4. 收尾：发送一条带 "to":"human" 且 subject 恰好为 "CLOSING-TIME-COMPLETE" 的消息——框架会盯住它并关闭应用。在所有成员确认之前不要发送：框架会独立核验 ACK，并拒绝过早的结论。`,
        '',
        this.workers.size === 0
          ? '现在楼上一个成员都没有——立即执行第 3、4 步。'
          : '预备助理会单独保存自己的记忆——不要等它，也不要给它发消息。',
        '这是一次关闭：不要开始新工作，也不要接受新任务。'
      ].join('\n')
    }, 'human');

    // 针对深度忙碌的优雅中断（#7C.2）：上面的 inbox 简报
    // 只在 agent 下一次 STOP 时才落地——一个任务做到一半的 worker 会
    // 拖住整个关闭流程。改由一条 steer 通知搭乘下一个 hook 边界
    // （PostToolUse/UserPromptSubmit），因此每个在线 agent 都会
    // 在一次工具调用内得知 closing time。空闲 agent 由
    // inbox-wake 轻推覆盖；忙碌的由 steer 覆盖——双轨并行，无需向 PTY 打字。
    this.control?.steer(this.godId,
      '人类按下了 CLOSING TIME：在下一个合适的位置暂停当前工作，现在立即清空收件箱——里面有份关闭简报等着你。先协调楼层的关闭，再做别的。');
    for (const id of this.workers) {
      this.control?.steer(id,
        'CLOSING TIME —— 办公室正在关闭。完成当前这一步，但不要开始新工作。安全地暂存或提交未完成的工作，把当前状态 + 具体下一步追到你的 memory.md，然后回复 god 一条 subject 恰好为 "CLOSING-TIME-ACK" 的消息。');
    }

    this.armTimeout();
    this.emitState('started');
    return { ok: true };
  }

  /** 人类改变了主意——把工作区重新立起来。 */
  cancel(): void {
    if (!this.active) return;
    this.cleanup();
    // 丢弃尚无任何 hook 边界消费的 closing-time steer，这样在人类取消之后，
    // 忙碌的 agent 不会才被告知要关闭。
    // 已经看到通知的 agent 会通过 god 纠正（见下）。
    this.control?.clearSteers(this.godId);
    for (const id of this.workers) this.control?.clearSteers(id);
    this.emitState('cancelled');
    try {
      this.hive.send({
        to: 'god',
        act: 'inform',
        subject: 'CLOSING TIME 已取消',
        body: '人类取消了关闭——忽略关闭协议，恢复正常运作。已经完成的记忆保存是额外收获，不是问题。'
      }, 'human');
    } catch { /* 尽力而为 */ }
  }

  /** 路由器观察者——hive 对每条被路由的消息都会调用它。 */
  onRouted(msg: HiveMessage, targets: string[]): void {
    if (!this.active) return;
    // 一个 worker 在报到。只有已知 worker、且 ACK 确实到达 god 时才计数
    //（而不是例如误入的广播回显）。
    if (ACK_RE.test(msg.subject) && this.workers.has(msg.from) && targets.includes(this.godId)) {
      if (!this.acked.has(msg.from)) {
        this.acked.add(msg.from);
        this.emitState('progress');
      }
      return;
    }
    // god 在收尾。只有 god 自己发出的 COMPLETE 才被认可——worker
    // 不能（有意或无意地）关闭整个工作区。
    if (COMPLETE_RE.test(msg.subject) && msg.from === this.godId) {
      // 信任但要验证：god 被要求等待每个 ACK，但
      // closing time 的全部意义在于不让任何 worker 丢失未保存的状态——
      // 因此过早的 COMPLETE 绝不能关闭工作区。协议中途
      // 终端死掉的 worker（标签页关闭、崩溃）可以豁免：他们的
      // ACK 永远不会到达，而且无论怎样会话都已消失。
      const reg = this.hive.registry();
      const liveNow = new Set(this.getLiveAgentIds());
      const pending = [...this.workers].filter(
        (id) => !this.acked.has(id) && liveNow.has(id) && !reg.agents[id]?.archived
      );
      if (pending.length > 0) {
        const names = pending.map((id) => `${reg.agents[id]?.name ?? id} (${id})`).join(', ');
        this.hive.send({
          to: 'god',
          act: 'refuse',
          subject: 'CLOSING TIME —— 结论被拒绝，仍有成员未确认',
          body: [
            `框架仍然缺少来自以下成员的 CLOSING-TIME-ACK：${names}。`,
            '应用会保持打开，直到每个成员都确认其记忆已保存。',
            '催促掉队的成员（向每个人重发关闭指令），等他们的 ACK，然后再次发送 CLOSING-TIME-COMPLETE。'
          ].join('\n')
        }, 'human');
        this.emitState('progress');
        return;
      }
      this.cleanup();
      this.active = true; // 宽限期内保持 "active"，这样 UI 就能保持
      this.emitState('complete');
      this.teardownTimer = setTimeout(() => {
        this.active = false;
        this.onConcluded();
      }, TEARDOWN_GRACE_MS);
    }
  }

  private armTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (this.active) this.emitState('timeout');
    }, TIMEOUT_MS);
  }

  private cleanup(): void {
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.teardownTimer) { clearTimeout(this.teardownTimer); this.teardownTimer = null; }
    this.active = false;
  }

  private emitState(phase: ClosingTimePhase): void {
    const ev: ClosingTimeEvent = { phase, acked: this.acked.size, total: this.workers.size };
    try { this.getWebContents()?.send('app:closingTime', ev); } catch { /* 窗口已拆除 */ }
  }
}
