import { RunSnapshot } from '../data/types';

export function CostLatencyPanel({ run }: { run: RunSnapshot }) {
  const { usd, input, output, cache_read, cache_creation } = run.costTotals;
  const totalTokens = input + output + cache_read + cache_creation;

  return (
    <div style={{ border: '1px solid var(--border-color, #ccc)', padding: '1rem', borderRadius: '4px' }}>
      <h2>Cost & Latency</h2>
      <div style={{ display: 'flex', gap: '2rem' }}>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>${usd.toFixed(4)}</div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Total Cost</div>
        </div>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{totalTokens.toLocaleString()}</div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Total Tokens</div>
        </div>
      </div>
      <p style={{ marginTop: '1rem', fontSize: '0.9rem', fontStyle: 'italic', color: '#888' }}>
        Note: True model TTFT latency is not logged. Dashboard latency metrics (if calculated) are a coordination-latency proxy.
      </p>
    </div>
  );
}
