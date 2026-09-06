/**
 * 熔断器 —— 失控/成本护栏策略（Lane A #6.6b）。
 *
 * Claude Code 暴露了 `--max-turns`，但没有美元上限，因此我们自行强制实施。
 * 本模块只负责 POLICY —— 触发条件 + steer → constrain → stop 升级阶梯。
 * 它没有副作用：读取信号并返回决策；由调用方（index.ts 中的心跳 beat）
 * 执行强制手段（发送纠正消息、通知、kill+archive），并在独立的
 * `control:breakerState` 通道上发出 BreakerState（Seam 2，与
 * Oscar/#7 协作，其 avatar 适配器让熔断等级优先于 hook 状态）。
 *
 * 输入聚合三个来源：
 *   (a) Oscar 经 UsageProvider [Seam 1] 的用量采样 —— 用于成本与 token 速率;
 *   (b) hook 事件（重复的相同工具调用、api_error 风暴）—— 由
 *       HookServer 通过 recordToolUse/recordError 喂入;
 *   (c) 文件 mtime 无进展 —— 由 beat 以 `progressing` 形式逐 agent 传入。
 *
 * 速率是相邻累计采样的 DIFF（Δoutput/Δt），绝不会把单个采样当作增量。
 *
 * 结构上安全：先 steer、每个 beat 只升一级（绝不直接跳到 kill）、
 * 每个健康 beat 降一级（恢复），且 `hardStop` 默认 OFF ——
 * 没有它，阶梯最高只到 `constrained`，永远不会 kill。
 */
import type { CircuitBreakerConfig } from './config';
import type { AgentUsageSample } from './usage';

export type BreakerLevel = 'healthy' | 'steering' | 'constrained' | 'stopped';

/** 在 control:breakerState（Seam 2）上发出。每个 beat 每个 agent 一条，让 Oscar 的
 *  仪表盘/头像保持实时；`level` 优先于由 hook 推导的状态。 */
export interface BreakerState {
  agentId: string;
  level: BreakerLevel;
  reason: string;
  ts: number;
}

/** 本 tick 中 beat 应对单个 agent 采取的动作。仅当等级 ESCALATES（升级）时
 *  `action` 才会触发（这样持久化的 steer 消息不会每个 beat 都重发）。 */
export type BreakerAction = 'none' | 'steer' | 'constrain' | 'stop';

export interface BreakerDecision {
  state: BreakerState;
  action: BreakerAction;
  /** 自上一 beat 以来等级是否发生变化（升级或恢复均为 true）。 */
  changed: boolean;
}

/** 单个 beat 中每个 agent 的输入。 */
export interface BreakerInput {
  agentId: string;
  /** 累计用量快照，未知时为 null（此时跳过成本/速率触发）。 */
  sample: AgentUsageSample | null;
  /** 该 agent 近期是否取得了协调进展（文件 mtime 信号）？ */
  progressing: boolean;
}

const LEVELS: BreakerLevel[] = ['healthy', 'steering', 'constrained', 'stopped'];
const rank = (l: BreakerLevel): number => LEVELS.indexOf(l);
const actionFor = (l: BreakerLevel): BreakerAction =>
  l === 'steering' ? 'steer' : l === 'constrained' ? 'constrain' : l === 'stopped' ? 'stop' : 'none';

/** 累计采样中的 token 总数（含所有类型），未知时为 0。 */
const tokensOf = (s: AgentUsageSample | null): number =>
  s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;

const DEFAULTS = {
  enabled: true,
  hardStop: false,
  repeatedToolLimit: 8,
  errorStormLimit: 5,
  tokenVelocityPerMin: 60_000 // 输出 token/分钟 —— 粗粒度兜底，刻意定得较高
};

/** PreCompact 豁免的安全上限：若 PostCompact 永不出现（崩溃，
 *  或某个不发出该事件的 Claude 构建），Δoutput 触发会自动重新武装。 */
const COMPACT_GRACE_MS = 5 * 60_000;
/** PostCompact 之后的尾随宽限期：压缩突增会落入下一 beat 的累计 diff 中，
 *  因此豁免必须比压缩本身活得更久。 */
const POST_COMPACT_GRACE_MS = 90_000;
/** 一个 DISTINCT 工具调用必须多近才能算作 no-progress 分支的进展。
 *  与 beat 的文件 mtime 进展窗口（300s）保持一致。 */
const PROGRESS_TOOL_WINDOW_MS = 300_000;
/** no-progress 分支触发前需要的连续触发 beat 数 —— 单 beat 的瞬时毛刺
 *  （inbox 确认、状态行突增）绝不会单独触发 steer。 */
const NO_PROGRESS_BEATS = 2;

interface AgentBreakerState {
  level: BreakerLevel;
  reason: string;
  lastSample: AgentUsageSample | null;
  /** 连续相同工具调用（相同 name+input）对应的键。 */
  repeatKey: string | null;
  repeatCount: number;
  /** 连续发生的 api_error / retry 事件数（期间没有任何进展）。 */
  errorCount: number;
  /** 在此时间点之前，基于 Δoutput 的触发被豁免（压缩进行中时设置于
   *  PreCompact；PostCompact 会把它缩短为一段尾随宽限）。 */
  compactingUntil: number;
  /** 最近一次 DISTINCT（name+input）工具调用的时间。多样化的工具流就是
   *  工作 —— 输出落在 hive 文件之外的（git、Jira 等）后台工作流/交互式会话
   *  不能被读成"no progress"。真正的单调用循环永远不会刷新它；即使是
   *  会刷新它的交替循环，也仍然有速率触发兜底。 */
  lastDistinctToolAt: number;
  /** no-progress 条件持续成立的连续 beat 数（防抖计数器）。 */
  noProgressBeats: number;
}

export class CircuitBreaker {
  private agents = new Map<string, AgentBreakerState>();

  constructor(private getConfig: () => CircuitBreakerConfig & { costCapUsd?: number; costCapTokens?: number; agentTokenCaps?: Record<string, number> }) {}

  private cfg() {
    const c = this.getConfig() ?? {};
    return {
      enabled: c.enabled ?? DEFAULTS.enabled,
      hardStop: c.hardStop ?? DEFAULTS.hardStop,
      repeatedToolLimit: c.repeatedToolLimit ?? DEFAULTS.repeatedToolLimit,
      errorStormLimit: c.errorStormLimit ?? DEFAULTS.errorStormLimit,
      tokenVelocityPerMin: c.tokenVelocityPerMin ?? DEFAULTS.tokenVelocityPerMin,
      costCapUsd: c.costCapUsd,
      costCapTokens: c.costCapTokens,
      agentTokenCaps: c.agentTokenCaps
    };
  }

  private get(agentId: string): AgentBreakerState {
    let s = this.agents.get(agentId);
    if (!s) {
      s = {
        level: 'healthy', reason: '', lastSample: null, repeatKey: null, repeatCount: 0,
        errorCount: 0, compactingUntil: 0, lastDistinctToolAt: 0, noProgressBeats: 0
      };
      this.agents.set(agentId, s);
    }
    return s;
  }

  /** 清空某 agent 的全部状态（在 archive/kill 时调用，避免泄漏/残留）。 */
  forget(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** 某 agent 当前的熔断等级（用于实时 fleet 快照）。 */
  levelFor(agentId: string): BreakerLevel {
    return this.agents.get(agentId)?.level ?? 'healthy';
  }

  // ── 事件驱动输入（由 HookServer 喂入） ──────────────────────────────────

  /** 一次工具调用已执行。NEW（name+input）键计为正向进展（重置
   *  repeat 与 error 计数器，并更新 no-progress 分支读取的 distinct 工具时钟）；
   *  连续出现 SAME 键则是循环信号。 */
  recordToolUse(agentId: string, toolName: string | undefined, toolInput: unknown, now = Date.now()): void {
    const s = this.get(agentId);
    const key = this.toolKey(toolName, toolInput);
    if (key === s.repeatKey) {
      s.repeatCount += 1;
    } else {
      s.repeatKey = key;
      s.repeatCount = 1;
      s.errorCount = 0; // 一次 distinct 工具调用即进展；清除错误风暴
      s.lastDistinctToolAt = now;
    }
  }

  /** 发生了 api_error / retry（无正向进展）。 */
  recordError(agentId: string): void {
    this.get(agentId).errorCount += 1;
  }

  /** 压缩已开始（PreCompact hook）。豁免基于 Δoutput 的触发 ——
   *  压缩会消耗输出 token 却不触碰任何协调文件，这正是上游 issue #109
   *  的误报形态（harness 自身的 auto-compact 任务在空闲 agent 上
   *  触发自己的熔断器）。 */
  recordCompactStart(agentId: string, now = Date.now()): void {
    this.get(agentId).compactingUntil = now + COMPACT_GRACE_MS;
  }

  /** 压缩已结束（PostCompact 或任意 SessionStart）。把豁免缩短为
   *  一段尾随宽限 —— 突增仍会落入下一 beat 的累计 diff。
   *  当没有压缩在进行时这是空操作，因此普通的会话开始绝不会授予豁免。 */
  recordCompactEnd(agentId: string, now = Date.now()): void {
    const s = this.get(agentId);
    if (s.compactingUntil > now) s.compactingUntil = now + POST_COMPACT_GRACE_MS;
  }

  private toolKey(toolName: string | undefined, toolInput: unknown): string {
    // 截断式 replacer：Write/Edit 的 tool_input 携带整个文件内容
    // （可到数 MB），而这里会在每次 PostToolUse 的 hook 应答路径中同步执行
    // —— 只为了保留 200 字符就把全部内容序列化，每次大写入都会产生
    // 数 MB 的瞬时分配。给每个字符串字段设上限在限制工作量的同时
    // 保持键的语义（相同调用的重复仍产生相同键；distinct 调用在前 200
    // 字符内不同的概率远高于完整序列化的价值）。
    let inp = '';
    try {
      inp = JSON.stringify(toolInput, (_k, v) =>
        typeof v === 'string' && v.length > 250 ? v.slice(0, 250) : v) ?? '';
    } catch { inp = String(toolInput); }
    return `${toolName ?? '?'}:${inp.slice(0, 200)}`;
  }

  // ── 周期性评估（由心跳 beat 调用） ──────────────────────────────────────

  /** 为本 beat 评估每个 agent，并返回每个 agent 的决策。调用方
   *  发出每个状态（保持仪表盘实时）并在有 `action` 时强制执行。 */
  tick(inputs: BreakerInput[], nowMs: number): BreakerDecision[] {
    const cfg = this.cfg();
    const decisions: BreakerDecision[] = [];
    if (!cfg.enabled) {
      // 熔断器关闭：所有人都报告 healthy，不采取任何动作。
      for (const { agentId } of inputs) {
        const s = this.get(agentId);
        const changed = s.level !== 'healthy';
        s.level = 'healthy'; s.reason = '';
        decisions.push({ state: { agentId, level: 'healthy', reason: '', ts: nowMs }, action: 'none', changed });
      }
      return decisions;
    }

    // 成本上限是全场（floor）级别的：汇总累计 usd，归咎于单个最大开支者，
    // 这样单个失控者不会触发整个 floor 熔断。
    let topSpender: string | null = null;
    if (typeof cfg.costCapUsd === 'number' && cfg.costCapUsd > 0) {
      let total = 0; let max = -1;
      for (const i of inputs) {
        const usd = i.sample?.usd ?? 0;
        total += usd;
        if (usd > max) { max = usd; topSpender = i.agentId; }
      }
      if (total <= cfg.costCapUsd) topSpender = null; // 未超上限 —— 无人被归咎
    }

    // Token 上限（面向用户的预算）：对总 token 数采用同样的全场逻辑。
    let topTokenSpender: string | null = null;
    if (typeof cfg.costCapTokens === 'number' && cfg.costCapTokens > 0) {
      let total = 0; let max = -1;
      for (const i of inputs) {
        const tok = tokensOf(i.sample);
        total += tok;
        if (tok > max) { max = tok; topTokenSpender = i.agentId; }
      }
      if (total <= cfg.costCapTokens) topTokenSpender = null; // 未超上限
    }

    for (const input of inputs) {
      const s = this.get(input.agentId);
      const trip = this.evaluate(
        input, s, cfg, nowMs,
        input.agentId === topSpender, cfg.costCapUsd,
        input.agentId === topTokenSpender, cfg.costCapTokens
      );
      // 记住累计基线，供下一 beat 的速率 diff 使用
      if (input.sample) s.lastSample = input.sample;

      const ceiling: BreakerLevel = cfg.hardStop ? 'stopped' : 'constrained';
      let target = s.level;
      if (trip.tripping) {
        target = LEVELS[Math.min(rank(s.level) + 1, rank(ceiling))];
      } else {
        target = LEVELS[Math.max(rank(s.level) - 1, 0)]; // 恢复一级
      }
      const changed = target !== s.level;
      const escalated = rank(target) > rank(s.level);
      s.level = target;
      s.reason = trip.tripping ? trip.reason : (changed ? 'recovering — signals cleared' : s.reason);

      decisions.push({
        state: { agentId: input.agentId, level: target, reason: s.reason, ts: nowMs },
        action: escalated ? actionFor(target) : 'none',
        changed
      });
    }
    return decisions;
  }

  /** 给定信号与记忆的基线，对单个 agent 做纯触发评估。 */
  private evaluate(
    input: BreakerInput,
    s: AgentBreakerState,
    cfg: ReturnType<CircuitBreaker['cfg']>,
    nowMs: number,
    isTopSpender: boolean,
    costCapUsd: number | undefined,
    isTopTokenSpender: boolean,
    costCapTokens: number | undefined
  ): { tripping: boolean; reason: string } {
    // (b) 重复的相同工具调用
    if (s.repeatCount >= cfg.repeatedToolLimit) {
      return { tripping: true, reason: `循环：${s.repeatCount}× 相同的工具调用（${s.repeatKey?.split(':')[0] ?? '?'}）` };
    }
    // (b) api_error 风暴
    if (s.errorCount >= cfg.errorStormLimit) {
      return { tripping: true, reason: `错误风暴：${s.errorCount} 次连续的 API 错误/重试` };
    }
    // (a) 单 agent token 上限 —— 该 agent 自身总量超过其配置上限
    const perAgentCap = cfg.agentTokenCaps?.[input.agentId];
    if (typeof perAgentCap === 'number' && perAgentCap > 0 && tokensOf(input.sample) > perAgentCap) {
      return { tripping: true, reason: `token 超限：${tokensOf(input.sample).toLocaleString()}，超过该 agent 上限 ${perAgentCap.toLocaleString()}` };
    }
    // (a) 成本上限 —— floor 总量超过上限，且该 agent 是最大开支者
    if (isTopSpender && typeof costCapUsd === 'number') {
      return { tripping: true, reason: `成本超限：楼层总额超过 $${costCapUsd}（最高支出者 $${(input.sample?.usd ?? 0).toFixed(2)}）` };
    }
    // (a) token 上限 —— floor 总 token 数超过上限，且该 agent 是最大开支者
    if (isTopTokenSpender && typeof costCapTokens === 'number') {
      return { tripping: true, reason: `token cap: floor total over ${costCapTokens.toLocaleString()} tokens (top spender ${tokensOf(input.sample).toLocaleString()})` };
    }
    // (a) token 速率尖峰 —— 连续 beat 之间累计输出的差分。
    // 压缩进行期间（+ 尾随宽限）完全跳过：/compact 消耗输出 token 却没有任何
    // 协调写入，这正是 issue #109 的误报形态 —— auto-compact 任务在空闲
    // agent 上触发熔断器。
    if (input.sample && s.lastSample && nowMs >= s.compactingUntil) {
      const dOut = input.sample.output - s.lastSample.output;
      const dMin = (input.sample.ts - s.lastSample.ts) / 60_000;
      if (dOut > 0 && dMin > 0) {
        const velocity = dOut / dMin;
        if (velocity > cfg.tokenVelocityPerMin) {
          return { tripping: true, reason: `token velocity ${Math.round(velocity)}/min > ${cfg.tokenVelocityPerMin}/min` };
        }
        // (c) 无进展：在未协调的情况下消耗输出 token。最近的
        // DISTINCT 工具调用也算进展 —— 后台工作流和交互式会话做的实际工作
        // 从不触碰 hive 文件（单调用循环永远不会刷新该时钟，且上面的
        // 循环/速率分支仍会兜底）。经过防抖：只有在连续
        // NO_PROGRESS_BEATS 个 beat 后才触发，因此单 beat 的毛刺绝不会 steer。
        const toolActive = nowMs - s.lastDistinctToolAt < PROGRESS_TOOL_WINDOW_MS;
        if (!input.progressing && !toolActive) {
          s.noProgressBeats += 1;
          if (s.noProgressBeats >= NO_PROGRESS_BEATS) {
            return { tripping: true, reason: 'no-progress: generating tokens without coordinating (stale log/files)' };
          }
        } else {
          s.noProgressBeats = 0;
        }
      }
    }
    return { tripping: false, reason: '' };
  }
}
