import { useEffect, useState } from 'react';
import { fetchHiveData } from './data/loaders';
import { segmentRuns } from './data/runs';
import { RunSnapshot } from './data/types';
import { ScoresPanel } from './components/ScoresPanel';
import { CostLatencyPanel } from './components/CostLatencyPanel';
import { ModelComparePanel } from './components/ModelComparePanel';
import { TrendPanel } from './components/TrendPanel';

export default function App() {
  const [hiveRoot, setHiveRoot] = useState(
    localStorage.getItem('HIVE_ROOT') || process.env.HIVE_ROOT || '/Users/saikiransangarthi/HarnessAgents/hive'
  );
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunIdx, setSelectedRunIdx] = useState<number>(0);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchHiveData(hiveRoot);
      const segmented = segmentRuns(data.logs, data.costs, data.tasks, data.results);
      setRuns(segmented);
      setSelectedRunIdx(segmented.length > 0 ? segmented.length - 1 : 0);
      localStorage.setItem('HIVE_ROOT', hiveRoot);
    } catch (e: any) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [hiveRoot]);

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Munder Difflin Benchmark</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <label htmlFor="hiveRoot">HIVE_ROOT:</label>
          <input
            id="hiveRoot"
            type="text"
            value={hiveRoot}
            onChange={e => setHiveRoot(e.target.value)}
            style={{ width: '300px', padding: '0.25rem' }}
          />
          <button onClick={loadData}>Refresh</button>
        </div>
      </div>

      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
      {loading && runs.length === 0 && <div>Loading data...</div>}
      {!loading && runs.length === 0 && !error && <div>No data found at {hiveRoot}</div>}

      {runs.length > 0 && (
        <>
          <div style={{ marginBottom: '1rem' }}>
            <label>Select Run: </label>
            <select value={selectedRunIdx} onChange={e => setSelectedRunIdx(Number(e.target.value))}>
              {runs.map((r, i) => (
                <option key={r.run_id} value={i}>Run {i + 1} ({new Date(r.run_id).toLocaleString()})</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
            <ScoresPanel run={runs[selectedRunIdx]} />
            <CostLatencyPanel run={runs[selectedRunIdx]} />
            <ModelComparePanel run={runs[selectedRunIdx]} />
            <TrendPanel runs={runs} />
          </div>
        </>
      )}
    </div>
  );
}
