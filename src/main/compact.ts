/**
 * TypeScript wrapper around compact-gate.cjs so the main process and hooks.ts
 * can import with full types. The plain-JS core lives in compact-gate.cjs so
 * tests can require() it directly without a TypeScript compile step.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CompactGate: _CG, DEFAULT_THRESHOLD, DEFAULT_COOLDOWN_MS, DEFAULT_REFRESH_AFTER_FIRES } =
  require('./compact-gate.cjs') as {
    CompactGate: new (opts?: CompactGateConfig) => _GateInstance;
    DEFAULT_THRESHOLD: number;
    DEFAULT_COOLDOWN_MS: number;
    DEFAULT_REFRESH_AFTER_FIRES: number;
  };

export { DEFAULT_THRESHOLD, DEFAULT_COOLDOWN_MS, DEFAULT_REFRESH_AFTER_FIRES };

export type CompactAction = 'compact' | 'refresh' | 'blocked' | 'skip';

export interface CompactGateConfig {
  /** Feature flag — default false. Zero behavior change when off. */
  enabled?: boolean;
  /** Context-window utilisation threshold (0–1). Default 0.50 (50%). */
  threshold?: number;
  /** Milliseconds to suppress all compact requests after one completes. Default 90 000. */
  cooldownMs?: number;
  /** Issue REFRESH PROTOCOL after every N fires. Default 3. */
  refreshAfterFires?: number;
}

interface _GateInstance {
  enabled: boolean;
  threshold: number;
  pending: Set<string>;
  fireCount: Map<string, number>;
  check(agentId: string, contextPct: number): string;
  onCompacted(agentId: string): void;
  isBlocked(agentId: string): boolean;
  remove(agentId: string): void;
}

export class CompactGate {
  readonly enabled: boolean;
  readonly threshold: number;
  private _g: _GateInstance;

  constructor(config: CompactGateConfig = {}) {
    this._g = new _CG(config);
    this.enabled = this._g.enabled;
    this.threshold = this._g.threshold;
  }

  check(agentId: string, contextPct: number): CompactAction {
    return this._g.check(agentId, contextPct) as CompactAction;
  }

  onCompacted(agentId: string): void { this._g.onCompacted(agentId); }
  isBlocked(agentId: string): boolean { return this._g.isBlocked(agentId); }
  remove(agentId: string): void { this._g.remove(agentId); }
}
