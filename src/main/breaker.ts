/**
 * CircuitBreaker — the cost/runaway guardrail (#7C.4), INTERIM glue.
 *
 * ⚠ OWNERSHIP: this is the Lane C "glue" — it wires the telemetry SOURCE
 * (telemetry.ts `getAgentUsage`, mine) to the BreakerState consumer (the avatar
 * adapter + fleet meter, also mine). The breaker POLICY — the full trip-condition
 * set (repeated-identical-tool-call loops, error storms, no-progress) and the
 * steer→constrain→stop escalation ladder — is Lane A's #6 and will REPLACE this.
 * Kept deliberately small and swap-trivial: it needs only `getAgentUsage` + an
 * `emit`, exactly the locked seams. The two conditions implemented here (budget
 * and token-velocity) are the ones computable purely from usage samples.
 *
 * Runs as an in-process poll (the syncMissions pattern, NOT launchd) in the
 * Electron main process. No `electron` import so it stays unit-testable.
 */
import type { AgentUsageSample, BreakerState } from './telemetry';

export type BreakerLevel = BreakerState['level'];

export interface BreakerConfig {
  /** Per-agent USD cap. Undefined = no budget tripping. */
  agentBudgetUsd?: number;
  /** Tokens/min ceiling. Undefined = no velocity tripping. */
  tokenVelocityPerMin?: number;
}

export interface CircuitBreakerOptions {
  /** Pull cumulative usage for an agent (the locked provider seam). */
  getAgentUsage: (agentId: string) => AgentUsageSample | null;
  /** The agent ids to evaluate each tick (live PTY agents). */
  liveAgents: () => string[];
  /** Current budget/velocity knobs (read fresh each tick so config edits apply). */
  config: () => BreakerConfig;
  /** Emit a state change — wired to the control:breakerState fan-out. */
  emit: (state: BreakerState) => void;
  /** Poll interval; default 5s (matches the metric export cadence). */
  intervalMs?: number;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
}

interface Track {
  level: BreakerLevel;
  lastTotal: number;
  lastTs: number;
}

function totalTokens(s: AgentUsageSample): number {
  return s.input + s.output + s.cacheRead + s.cacheCreation;
}

export class CircuitBreaker {
  private timer: NodeJS.Timeout | null = null;
  private readonly tracks = new Map<string, Track>();
  private readonly o: Required<Pick<CircuitBreakerOptions, 'intervalMs' | 'now'>> & CircuitBreakerOptions;

  constructor(opts: CircuitBreakerOptions) {
    this.o = { intervalMs: 5000, now: () => Date.now(), ...opts };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never crash the poll */ } }, this.o.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One evaluation pass. Public so a test can drive it deterministically. */
  tick(): void {
    const cfg = this.o.config();
    const now = this.o.now();
    for (const agentId of this.o.liveAgents()) {
      const usage = this.o.getAgentUsage(agentId);
      if (!usage) continue;
      const total = totalTokens(usage);
      const prev = this.tracks.get(agentId);
      const velocity = prev && now > prev.lastTs
        ? (total - prev.lastTotal) / ((now - prev.lastTs) / 60000)
        : 0;

      const { level, reason } = this.evaluate(usage.usd, velocity, cfg);

      if (!prev) {
        this.tracks.set(agentId, { level, lastTotal: total, lastTs: now });
        if (level !== 'healthy') this.o.emit({ agentId, level, reason, ts: now });
        continue;
      }
      prev.lastTotal = total;
      prev.lastTs = now;
      if (level !== prev.level) {
        prev.level = level;
        this.o.emit({ agentId, level, reason, ts: now });
      }
    }
  }

  /** Map (spend, velocity, config) → a breaker level. Budget dominates velocity. */
  private evaluate(usd: number, velocity: number, cfg: BreakerConfig): { level: BreakerLevel; reason: string } {
    const budget = cfg.agentBudgetUsd;
    if (budget && budget > 0) {
      if (usd >= budget) return { level: 'stopped', reason: `budget exceeded ($${usd.toFixed(2)} ≥ $${budget})` };
      if (usd >= budget * 0.9) return { level: 'constrained', reason: `near budget ($${usd.toFixed(2)} of $${budget})` };
      if (usd >= budget * 0.75) return { level: 'steering', reason: `approaching budget ($${usd.toFixed(2)} of $${budget})` };
    }
    const ceiling = cfg.tokenVelocityPerMin;
    if (ceiling && ceiling > 0 && velocity > 0) {
      if (velocity >= ceiling * 2) return { level: 'constrained', reason: `token velocity ${Math.round(velocity).toLocaleString()}/min (>2× ceiling)` };
      if (velocity >= ceiling) return { level: 'steering', reason: `token velocity ${Math.round(velocity).toLocaleString()}/min (> ceiling)` };
    }
    return { level: 'healthy', reason: 'ok' };
  }
}
