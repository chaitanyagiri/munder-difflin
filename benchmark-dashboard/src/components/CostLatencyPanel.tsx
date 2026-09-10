import { RunSnapshot } from '../data/types';

export function CostLatencyPanel({ run }: { run: RunSnapshot }) {
  const { usd, input, output, cache_read, cache_creation } = run.costTotals;
  const totalTokens = input + output + cache_read + cache_creation;

  let avgLatency = 0;
  let medianLatency = 0;
  
  if (run.latencyProxies && run.latencyProxies.length > 0) {
    const sorted = [...run.latencyProxies].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    avgLatency = sum / sorted.length;
    const mid = Math.floor(sorted.length / 2);
    medianLatency = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

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
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
            {avgLatency > 0 ? (avgLatency / 1000).toFixed(1) + 's' : 'N/A'}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Avg Latency Proxy</div>
        </div>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
            {medianLatency > 0 ? (medianLatency / 1000).toFixed(1) + 's' : 'N/A'}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Median Latency Proxy</div>
        </div>
      </div>
      <p style={{ marginTop: '1rem', fontSize: '0.9rem', fontStyle: 'italic', color: '#888' }}>
        Note: True model TTFT latency is not logged. Dashboard latency metrics (msg to session delta) are a coordination-latency proxy.
      </p>
    </div>
  );
}
