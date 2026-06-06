/**
 * Circuit breaker — runaway/cost guardrail policy (Lane A #6.6b).
 *
 * Claude Code exposes `--max-turns` but NO dollar ceiling, so we enforce one
 * ourselves. This module owns the POLICY only — trip conditions + the
 * steer → constrain → stop escalation ladder. It has no side effects: it reads
 * signals and returns decisions; the caller (the heartbeat beat in index.ts)
 * performs the enforcement (send a corrective message, notify, kill+archive) and
 * emits BreakerState on the separate `control:breakerState` channel (Seam 2 with
 * Oscar/#7, whose avatar adapter gives breaker level precedence over hook status).
 *
 * Inputs aggregate three sources:
 *   (a) Oscar's usage samples via UsageProvider [Seam 1] — for cost + token velocity;
 *   (b) hook events (repeated identical tool calls, api_error storms) — fed in by
 *       HookServer through recordToolUse/recordError;
 *   (c) file-mtime no-progress — passed per-agent by the beat as `progressing`.
 *
 * Velocity is the DIFF of consecutive cumulative samples (Δoutput/Δt), never a
 * single sample treated as an increment.
 *
 * Safe by construction: steer-first, one level per beat (never jump to a kill),
 * de-escalates a level per healthy beat (recovery), and `hardStop` is OFF by
 * default — without it the ladder caps at `constrained` and never kills.
 */
import type { CircuitBreakerConfig } from './config';
import type { AgentUsageSample } from './usage';

export type BreakerLevel = 'healthy' | 'steering' | 'constrained' | 'stopped';

/** Emitted on control:breakerState (Seam 2). One per agent per beat so Oscar's
 *  dashboard/avatars stay live; `level` takes precedence over hook-derived status. */
export interface BreakerState {
  agentId: string;
  level: BreakerLevel;
  reason: string;
  ts: number;
}

/** What the beat should do this tick for one agent. `action` fires only when the
 *  level ESCALATES (so a durable steer message isn't re-sent every beat). */
export type BreakerAction = 'none' | 'steer' | 'constrain' | 'stop';

export interface BreakerDecision {
  state: BreakerState;
  action: BreakerAction;
  /** True when level changed since the previous beat (escalation OR recovery). */
  changed: boolean;
}

/** Per-agent input for one beat. */
export interface BreakerInput {
  agentId: string;
  /** Cumulative usage snapshot, or null when unknown (skips cost/velocity trips). */
  sample: AgentUsageSample | null;
  /** Did the agent make coordination progress recently (file-mtime signal)? */
  progressing: boolean;
}

const LEVELS: BreakerLevel[] = ['healthy', 'steering', 'constrained', 'stopped'];
const rank = (l: BreakerLevel): number => LEVELS.indexOf(l);
const actionFor = (l: BreakerLevel): BreakerAction =>
  l === 'steering' ? 'steer' : l === 'constrained' ? 'constrain' : l === 'stopped' ? 'stop' : 'none';

/** Total tokens in a cumulative sample (all kinds), 0 when unknown. */
const tokensOf = (s: AgentUsageSample | null): number =>
  s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;

const DEFAULTS = {
  enabled: true,
  hardStop: false,
  repeatedToolLimit: 8,
  errorStormLimit: 5,
  tokenVelocityPerMin: 60_000 // output tokens/min — coarse backstop, deliberately high
};

interface AgentBreakerState {
  level: BreakerLevel;
  reason: string;
  lastSample: AgentUsageSample | null;
  /** Consecutive identical tool calls (same name+input). */
  repeatKey: string | null;
  repeatCount: number;
  /** Consecutive api_error / retry events with no intervening progress. */
  errorCount: number;
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
      s = { level: 'healthy', reason: '', lastSample: null, repeatKey: null, repeatCount: 0, errorCount: 0 };
      this.agents.set(agentId, s);
    }
    return s;
  }

  /** Drop all state for an agent (call on archive/kill so it can't leak/zombie). */
  forget(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Current breaker level for an agent (for the live fleet snapshot). */
  levelFor(agentId: string): BreakerLevel {
    return this.agents.get(agentId)?.level ?? 'healthy';
  }

  // ── event-driven inputs (fed by HookServer) ──────────────────────────────

  /** A tool call ran. A NEW (name+input) key counts as forward progress (resets
   *  the repeat + error counters); the SAME key in a row is the loop signal. */
  recordToolUse(agentId: string, toolName: string | undefined, toolInput: unknown): void {
    const s = this.get(agentId);
    const key = this.toolKey(toolName, toolInput);
    if (key === s.repeatKey) {
      s.repeatCount += 1;
    } else {
      s.repeatKey = key;
      s.repeatCount = 1;
      s.errorCount = 0; // a distinct tool call = progress; clear the error storm
    }
  }

  /** An api_error / retry occurred (no forward progress). */
  recordError(agentId: string): void {
    this.get(agentId).errorCount += 1;
  }

  private toolKey(toolName: string | undefined, toolInput: unknown): string {
    let inp = '';
    try { inp = JSON.stringify(toolInput) ?? ''; } catch { inp = String(toolInput); }
    return `${toolName ?? '?'}:${inp.slice(0, 200)}`;
  }

  // ── periodic evaluation (called by the heartbeat beat) ────────────────────

  /** Evaluate every agent for this beat and return a decision per agent. The
   *  caller emits each state (keeps the dashboard live) and enforces `action`
   *  when present. */
  tick(inputs: BreakerInput[], nowMs: number): BreakerDecision[] {
    const cfg = this.cfg();
    const decisions: BreakerDecision[] = [];
    if (!cfg.enabled) {
      // Breaker off: report healthy for everyone, take no action.
      for (const { agentId } of inputs) {
        const s = this.get(agentId);
        const changed = s.level !== 'healthy';
        s.level = 'healthy'; s.reason = '';
        decisions.push({ state: { agentId, level: 'healthy', reason: '', ts: nowMs }, action: 'none', changed });
      }
      return decisions;
    }

    // Cost cap is floor-wide: sum cumulative usd, blame the single biggest spender
    // so one runaway doesn't trip the whole floor.
    let topSpender: string | null = null;
    if (typeof cfg.costCapUsd === 'number' && cfg.costCapUsd > 0) {
      let total = 0; let max = -1;
      for (const i of inputs) {
        const usd = i.sample?.usd ?? 0;
        total += usd;
        if (usd > max) { max = usd; topSpender = i.agentId; }
      }
      if (total <= cfg.costCapUsd) topSpender = null; // under cap — nobody blamed
    }

    // Token cap (the user-facing budget): same floor-wide logic on total tokens.
    let topTokenSpender: string | null = null;
    if (typeof cfg.costCapTokens === 'number' && cfg.costCapTokens > 0) {
      let total = 0; let max = -1;
      for (const i of inputs) {
        const tok = tokensOf(i.sample);
        total += tok;
        if (tok > max) { max = tok; topTokenSpender = i.agentId; }
      }
      if (total <= cfg.costCapTokens) topTokenSpender = null; // under cap
    }

    for (const input of inputs) {
      const s = this.get(input.agentId);
      const trip = this.evaluate(
        input, s, cfg,
        input.agentId === topSpender, cfg.costCapUsd,
        input.agentId === topTokenSpender, cfg.costCapTokens
      );
      // remember the cumulative baseline for next beat's velocity diff
      if (input.sample) s.lastSample = input.sample;

      const ceiling: BreakerLevel = cfg.hardStop ? 'stopped' : 'constrained';
      let target = s.level;
      if (trip.tripping) {
        target = LEVELS[Math.min(rank(s.level) + 1, rank(ceiling))];
      } else {
        target = LEVELS[Math.max(rank(s.level) - 1, 0)]; // recover one level
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

  /** Pure trip evaluation for one agent given its signals + remembered baseline. */
  private evaluate(
    input: BreakerInput,
    s: AgentBreakerState,
    cfg: ReturnType<CircuitBreaker['cfg']>,
    isTopSpender: boolean,
    costCapUsd: number | undefined,
    isTopTokenSpender: boolean,
    costCapTokens: number | undefined
  ): { tripping: boolean; reason: string } {
    // (b) repeated identical tool calls
    if (s.repeatCount >= cfg.repeatedToolLimit) {
      return { tripping: true, reason: `looping: ${s.repeatCount}× identical tool call (${s.repeatKey?.split(':')[0] ?? '?'})` };
    }
    // (b) api_error storm
    if (s.errorCount >= cfg.errorStormLimit) {
      return { tripping: true, reason: `error storm: ${s.errorCount} consecutive api errors/retries` };
    }
    // (a) per-agent token limit — this agent's own total over its configured cap
    const perAgentCap = cfg.agentTokenCaps?.[input.agentId];
    if (typeof perAgentCap === 'number' && perAgentCap > 0 && tokensOf(input.sample) > perAgentCap) {
      return { tripping: true, reason: `token limit: ${tokensOf(input.sample).toLocaleString()} over the agent cap of ${perAgentCap.toLocaleString()}` };
    }
    // (a) cost cap — floor total over cap, this agent is the biggest spender
    if (isTopSpender && typeof costCapUsd === 'number') {
      return { tripping: true, reason: `cost cap: floor total over $${costCapUsd} (top spender $${(input.sample?.usd ?? 0).toFixed(2)})` };
    }
    // (a) token cap — floor total tokens over cap, this agent is the biggest spender
    if (isTopTokenSpender && typeof costCapTokens === 'number') {
      return { tripping: true, reason: `token cap: floor total over ${costCapTokens.toLocaleString()} tokens (top spender ${tokensOf(input.sample).toLocaleString()})` };
    }
    // (a) token-velocity spike — diff cumulative output across consecutive beats
    if (input.sample && s.lastSample) {
      const dOut = input.sample.output - s.lastSample.output;
      const dMin = (input.sample.ts - s.lastSample.ts) / 60_000;
      if (dOut > 0 && dMin > 0) {
        const velocity = dOut / dMin;
        if (velocity > cfg.tokenVelocityPerMin) {
          return { tripping: true, reason: `token velocity ${Math.round(velocity)}/min > ${cfg.tokenVelocityPerMin}/min` };
        }
        // (c) no-progress: burning output tokens while not coordinating
        if (!input.progressing) {
          return { tripping: true, reason: 'no-progress: generating tokens without coordinating (stale log/files)' };
        }
      }
    }
    return { tripping: false, reason: '' };
  }
}
