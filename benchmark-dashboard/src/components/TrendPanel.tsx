import { RunSnapshot } from '../data/types';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';

export function TrendPanel({ runs }: { runs: RunSnapshot[] }) {
  const data = runs.map((r, i) => ({
    run: `Run ${i + 1}`,
    usd: r.costTotals.usd,
    tokens: r.costTotals.input + r.costTotals.output + r.costTotals.cache_read + r.costTotals.cache_creation
  }));

  if (data.length === 0) return <div>No trend data</div>;

  return (
    <div style={{ border: '1px solid var(--border-color, #ccc)', padding: '1rem', borderRadius: '4px', height: '300px' }}>
      <h2>Trend Over Runs (Cost)</h2>
      <ResponsiveContainer width="100%" height="80%">
        <LineChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="run" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="usd" stroke="#82ca9d" name="Cost (USD)" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
