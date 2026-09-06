/**
 * 终身成本，从 `cost-ledger.jsonl` 中恢复。
 *
 * 为什么存在
 * ───────────
 * `AgentUsageSample.usd` 是“自进程启动以来累积”的计数器，而不是终身值。
 * `TelemetryCollector` 累积到内存映射（`sessions` / `agentSessions`）里，
 * 所以应用重启后会重建为空、计数器在同一个 `session_id` 下从 ~0 重新开始
 * （代理恢复了，只是我们的累加器忘了）。任何只读最后一个值的消费者，
 * 都会低估经历过重启的代理的开销。
 *
 * 在带几十次这类重置的实盘账本上实测，最后的值掩盖了 59% 的真实开销。
 * 缺口随应用重启频率增长，所以长期运行的楼层比新建的受影响更大。
 *
 * 恢复方案
 * ────────
 * 账本保留每一行，所以重置前的峰值仍留在磁盘上。在同一个 (agent, session)
 * 内计数器只会上升，因此“下降”就是重置的签名，不会是别的。终身值于是为：
 *
 *     sum(每个已关闭区段的峰值) + 打开区段的峰值
 *
 * 任何下降都计入，只留一个浮点噪声的 epsilon。曾考虑过美元阈值并否决：
 * 真实重启常常从远低于一美元直接掉到零，任何大得值得用的阈值都会悄悄漏掉
 * 它们。累积计数器没有正当理由下降，所以那个魔法数买不到任何东西，
 * 反而损失覆盖率。
 *
 * 成本 / 形态
 * ───────────
 * 账本只追加、无界增长，所以在成熟楼层上完整折叠一次耗时太长，
 * 绝不能落在 Electron 主线程上。因此折叠是异步且增量的：每轮只读取
 * 自上一轮以来追加的字节，并保留运行中的区段状态。稳态下每轮成本
 * 只有几百字节，与账本大小无关。
 *
 * 只读：本模块从不写账本。
 */

import { createReadStream, statSync } from 'fs';

/** 每个 (agent, session) 的折叠状态：已关闭区段加当前打开区段。 */
interface Segment {
  /** 已被一次重置关闭的所有区段峰值之和。 */
  committed: number;
  /** 当前打开区段的最高水位。 */
  peak: number;
}

/** 浮点噪声防护。真实重置至少会掉几美分，所以任何低于此值的
 *  都只是运算尘埃，而非一次重启。 */
const EPS = 1e-9;

/** 每轮的上限，避免冷启动被一次超大读取卡住。
 *  折叠只是在下一次调用时继续。 */
const MAX_BYTES_PER_PASS = 8 * 1024 * 1024;

export class CostLedgerTotals {
  /** 账本已折叠的字节数。 */
  private offset = 0;
  /** 末尾不完整的一行，以 BYTES 保存，这样跨读取边界被切开的多字节
   *  字符绝不会被半截解码。 */
  private tail: Buffer = Buffer.alloc(0);
  /** `agentId \t sessionId` → 折叠状态。 */
  private readonly seg = new Map<string, Segment>();
  /** agentId → 终身 usd。每轮之后重新计算。 */
  private totals = new Map<string, number>();
  /** 同一时间只进行一轮；定时器绝不能让自己叠加折叠。 */
  private folding = false;
  /** 一旦某轮完整完成即为 true，这样调用者能区分“零开销”与“尚未读取”，
   *  而不会自信地报出 $0。 */
  private warm = false;

  /** 单个代理的终身 usd，账本尚未折叠时返回 null。用 null 而非 0，
   *  这样调用者绝不会把冷启动的 0 当作事实发布。 */
  usdFor(agentId: string): number | null {
    if (!this.warm) return null;
    return this.totals.get(agentId) ?? 0;
  }

  /** 每个代理的终身 usd。首轮完成前为空。 */
  all(): Map<string, number> {
    return new Map(this.totals);
  }

  /** 是否已至少完成一轮完整折叠？ */
  get ready(): boolean {
    return this.warm;
  }

  /** 账本中所有代理的真实终身开销。 */
  floorTotal(): number {
    let t = 0;
    for (const v of this.totals.values()) t += v;
    return t;
  }

  /**
   * 折叠自上一轮以来追加的内容。立即返回；实际工作在调用者的栈之外完成。
   * 可安全地从定时器调用，且从不抛出（读不到的账本只是保留最后的好总量，
   * 与本处其他尽力而为的写入者契约一致）。
   */
  refresh(ledgerPath: string): Promise<void> {
    if (this.folding) return Promise.resolve();
    this.folding = true;
    return this.fold(ledgerPath)
      .catch(() => { /* 保留最后的好总量 */ })
      .finally(() => { this.folding = false; });
  }

  /** 反复折叠直到追上 EOF。方便那些现在就想要数字、而不是等几个定时器
   *  滴答的调用者。 */
  async refreshFully(ledgerPath: string): Promise<void> {
    for (let i = 0; i < 4096; i++) {
      await this.refresh(ledgerPath);
      if (this.warm) return;
    }
  }

  private async fold(ledgerPath: string): Promise<void> {
    let size: number;
    try { size = statSync(ledgerPath).size; } catch { return; }

    // 底下发生了截断或轮换：偏移现在指向末尾之后，所以保存的每个区段
    // 都不可信。从头开始。
    if (size < this.offset) this.reset();
    if (size === this.offset) { this.warm = true; return; }

    const end = Math.min(size, this.offset + MAX_BYTES_PER_PASS) - 1;
    const from = this.offset;

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(ledgerPath, { start: from, end });
      stream.on('data', (chunk: string | Buffer) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        this.consume(buf);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });

    this.offset = end + 1;
    this.recompute();
    // 只有追上 EOF 才算“warm”；被上限截断的一轮仍落后于文件。
    if (this.offset >= size) this.warm = true;
  }

  /** 折叠一个缓冲区，暂存任何不完整的末尾行。 */
  private consume(chunk: Buffer): void {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const cut = buf.lastIndexOf(0x0a); // '\n'
    if (cut === -1) { this.tail = buf; return; }
    this.tail = buf.subarray(cut + 1);
    for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
      if (line) this.foldLine(line);
    }
  }

  private foldLine(line: string): void {
    let row: { agent_id?: string; session_id?: string; usd?: number };
    try { row = JSON.parse(line); } catch { return; } // 写了一半的尾部行
    if (!row || typeof row.agent_id !== 'string') return;
    const usd = typeof row.usd === 'number' && Number.isFinite(row.usd) ? row.usd : 0;

    const key = `${row.agent_id}\t${row.session_id ?? ''}`;
    let s = this.seg.get(key);
    if (!s) { s = { committed: 0, peak: 0 }; this.seg.set(key, s); }

    if (usd < s.peak - EPS) {
      // 计数器回退：上一个区段在其峰值处结束。
      s.committed += s.peak;
      s.peak = usd;
    } else if (usd > s.peak) {
      s.peak = usd;
    }
  }

  private recompute(): void {
    const next = new Map<string, number>();
    for (const [key, s] of this.seg) {
      const agentId = key.slice(0, key.indexOf('\t'));
      next.set(agentId, (next.get(agentId) ?? 0) + s.committed + s.peak);
    }
    this.totals = next;
  }

  private reset(): void {
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.seg.clear();
    this.totals = new Map();
    this.warm = false;
  }
}

/**
 * 对已在内存中的账本做一次性折叠。供测试以及任何想直接拿到数字、
 * 而不持有增量读取器的调用者使用。
 */
export function lifetimeUsdFromLedger(text: string): Map<string, number> {
  const t = new CostLedgerTotals();
  // 复用完全相同的折叠路径，保证二者永不一致。
  (t as unknown as { consume(b: Buffer): void }).consume(Buffer.from(text.endsWith('\n') ? text : `${text}\n`));
  (t as unknown as { recompute(): void }).recompute();
  return t.all();
}
