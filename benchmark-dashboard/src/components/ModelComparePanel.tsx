import { RunSnapshot } from '../data/types';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';

export function ModelComparePanel({ run }: { run: RunSnapshot }) {
  const data = Object.entries(run.modelRollups).map(([model, stats]) => ({
    name: model,
    usd: stats.usd,
    tokens: stats.tokens,
    count: stats.count
  }));

  if (data.length === 0) return <div>No model data</div>;

  return (
    <div style={{ border: '1px solid var(--border-color, #ccc)', padding: '1rem', borderRadius: '4px', height: '300px' }}>
      <h2>Model Comparison (USD)</h2>
      <ResponsiveContainer width="100%" height="80%">
        <BarChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="usd" fill="#8884d8" name="Cost (USD)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
