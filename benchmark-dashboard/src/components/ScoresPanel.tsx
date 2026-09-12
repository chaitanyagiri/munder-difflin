import { RunSnapshot } from '../data/types';

export function ScoresPanel({ run }: { run: RunSnapshot }) {
  const tasks = run.tasks?.tasks || [];
  const results = run.results || [];
  
  const hasResults = results.length > 0;
  
  let passed = 0;
  let total = 0;
  let metricLabel = '';

  if (hasResults) {
    total = results.length;
    passed = results.filter(r => r.passed).length;
    metricLabel = 'Pass Rate';
  } else {
    total = tasks.length;
    passed = tasks.filter(t => t.status === 'done').length;
    metricLabel = 'Task-Completion Rate';
  }

  const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';

  return (
    <div style={{ border: '1px solid var(--border-color, #ccc)', padding: '1rem', borderRadius: '4px' }}>
      <h2>Scores</h2>
      <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>
        {rate}% <span style={{ fontSize: '1rem', fontWeight: 'normal' }}>({metricLabel})</span>
      </div>
      <p>{passed} / {total} completed</p>
      
      <table style={{ width: '100%', marginTop: '1rem', textAlign: 'left', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(t => (
            <tr key={t.id} style={{ borderTop: '1px solid var(--border-color, #eee)' }}>
              <td>{t.id}</td>
              <td>{t.title}</td>
              <td>{t.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
