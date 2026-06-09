'use strict';

// CompactGate — core logic for the COMPACT PROTOCOL (see hive/protocols/COMPACT-PROTOCOL.md).
//
// Plain CommonJS so tests can require() this without transpilation and so it
// can be imported from compact.ts with no bundler special-casing.
//
// Responsibilities:
//   - Single-flight: at most one compaction per agent in flight
//   - Cooldown: after a compaction completes, suppresses all compact requests
//     (from any service) for the cooldown window — no compact-on-top-of-compact
//   - 50% threshold: trigger at 50% context utilisation (was 80% in old watchdog)
//   - Fire counter: after every N fires, emit 'refresh' instead of 'compact' so
//     the agent receives the REFRESH PROTOCOL message instead of a silent /compact
//   - Counter reset: when context drops well below threshold the counter resets,
//     indicating a genuine workload drop / context reclaim

const DEFAULT_THRESHOLD = 0.50;
const DEFAULT_COOLDOWN_MS = 90_000;   // 90 s — long enough to cover most /compact ops
const DEFAULT_REFRESH_AFTER_FIRES = 3;

class CompactGate {
  constructor({
    enabled = false,
    threshold = DEFAULT_THRESHOLD,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    refreshAfterFires = DEFAULT_REFRESH_AFTER_FIRES,
  } = {}) {
    this.enabled = enabled;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.refreshAfterFires = refreshAfterFires;

    /** agentId → true while a compaction request is in flight (not yet completed). */
    this.pending = new Set();
    /** agentId → timestamp (ms) after which the cooldown expires. */
    this.cooldownUntil = new Map();
    /** agentId → consecutive compaction fire count (resets on workload drop). */
    this.fireCount = new Map();
  }

  /**
   * Called by the Status hook handler with each context-window reading.
   *
   * Returns:
   *   'skip'    — below threshold or gate disabled; do nothing
   *   'blocked' — above threshold but single-flight or cooldown active; do nothing
   *   'compact' — threshold crossed; issue /compact for this agent
   *   'refresh' — every Nth fire; emit REFRESH PROTOCOL message instead
   */
  check(agentId, contextPct) {
    if (!this.enabled) return 'skip';

    if (contextPct < this.threshold) {
      // Well below threshold (< threshold/2) → workload dropped; reset the fire
      // counter so the next crossing starts fresh rather than escalating to REFRESH
      // prematurely after a genuine context reclaim.
      if (contextPct < this.threshold / 2) {
        this.fireCount.delete(agentId);
        this.pending.delete(agentId);
      }
      return 'skip';
    }

    // Single-flight guard
    if (this.pending.has(agentId)) return 'blocked';

    // Cooldown guard (dedup across any service that might trigger a compact)
    const cd = this.cooldownUntil.get(agentId);
    if (cd !== undefined && Date.now() < cd) return 'blocked';

    // Increment consecutive fire count
    const fires = (this.fireCount.get(agentId) ?? 0) + 1;
    this.fireCount.set(agentId, fires);
    this.pending.add(agentId);

    return fires % this.refreshAfterFires === 0 ? 'refresh' : 'compact';
  }

  /**
   * Call when a compaction has completed (e.g., the post-compact Stop hook fires).
   * Clears the in-flight flag and starts the cooldown window.
   */
  onCompacted(agentId) {
    this.pending.delete(agentId);
    this.cooldownUntil.set(agentId, Date.now() + this.cooldownMs);
  }

  /**
   * Returns true when this gate would suppress a compact request for agentId.
   * Use this to let the scheduler standup or janitor defer to the gate.
   */
  isBlocked(agentId) {
    if (this.pending.has(agentId)) return true;
    const cd = this.cooldownUntil.get(agentId);
    return cd !== undefined && Date.now() < cd;
  }

  /** Remove all per-agent state (agent removed / disconnected). */
  remove(agentId) {
    this.pending.delete(agentId);
    this.cooldownUntil.delete(agentId);
    this.fireCount.delete(agentId);
  }
}

module.exports = { CompactGate, DEFAULT_THRESHOLD, DEFAULT_COOLDOWN_MS, DEFAULT_REFRESH_AFTER_FIRES };
