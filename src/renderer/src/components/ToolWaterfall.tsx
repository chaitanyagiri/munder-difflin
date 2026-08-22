import { useAgentSpans, useFleetTelemetry, totalTokens, cacheFraction } from '@/hooks/useTelemetry';

/**
 * Per-agent tool-call timeline (#7B.2) — a horizontal waterfall of tool spans
 * from live `tool_result` telemetry. Each bar is one tool call, width ∝ its
 * duration, mint=success / coral=failure. A header band shows cumulative cost
 * with the cache-vs-fresh split made visible (fixes cost bug #1.1.3). This is
 * the headline upgrade over the old bare tool-count proxy.
 */
export function ToolWaterfall({ agentId }: { agentId: string }) {
  const spans = useAgentSpans(agentId);
  const { samples } = useFleetTelemetry();
  const sample = samples[agentId];

  const maxDur = Math.max(1, ...spans.map((s) => s.durationMs));
  const recent = spans.slice(-60); // keep the view legible

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)', overflow: 'hidden' }}>
      {/* Header band: cumulative cost + cache-vs-fresh split */}
      <div style={{
        flexShrink: 0, padding: '8px 10px', background: 'var(--cth-cream-200)',
        boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
        fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)',
        display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline'
      }}>
        {sample ? (
          <>
            <span><strong>${sample.usd.toFixed(2)}</strong></span>
            <span style={{ color: 'var(--cth-ink-700)' }}>
              fresh {fmtTokens(sample.input + sample.cacheCreation)}t
            </span>
            <span style={{ color: 'var(--cth-sky)' }}>
              cache {fmtTokens(sample.cacheRead)}t ({Math.round(cacheFraction(sample) * 100)}%)
            </span>
            {sample.model && <span style={{ color: 'var(--cth-ink-500)' }}>{sample.model}</span>}
            <span style={{ color: 'var(--cth-ink-500)' }}>{fmtTokens(totalTokens(sample))}t total</span>
          </>
        ) : (
          <span style={{ color: 'var(--cth-ink-500)' }}>no live telemetry yet — spawn / respawn this agent to instrument it</span>
        )}
      </div>

      {/* Waterfall */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {recent.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
            No tool calls captured yet. Each tool the agent runs appears here with its real duration.
          </div>
        )}
        {recent.map((s, i) => {
          const pct = Math.max(2, Math.round((s.durationMs / maxDur) * 100));
          const ok = s.success && s.tool !== 'api_error';
          return (
            <div key={`${s.sessionId}:${s.ts}:${s.tool}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ width: 88, fontSize: 11, color: 'var(--cth-ink-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.error ?? s.tool}>
                {s.tool}
              </span>
              <div style={{ flex: 1, height: 12, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
                <div
                  title={s.error ? `${s.tool}: ${s.error}` : `${s.tool} · ${s.durationMs}ms · ${ok ? 'ok' : 'failed'}`}
                  style={{ width: `${pct}%`, height: '100%', background: ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}
                />
              </div>
              <span style={{ width: 54, textAlign: 'right', fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {fmtDur(s.durationMs)}
              </span>
              <span style={{ width: 12, textAlign: 'center', fontSize: 11, color: ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}>
                {ok ? '✓' : '✗'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtDur(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
