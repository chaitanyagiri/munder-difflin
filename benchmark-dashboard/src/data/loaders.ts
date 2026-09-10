import { LogEvent, CostRow, TaskList, ResultRow } from './types';

export async function fetchHiveData(hiveRoot: string) {
  const rootQuery = encodeURIComponent(hiveRoot);
  const [logRes, costRes, tasksRes, resultsRes] = await Promise.all([
    fetch(`/api/log?hiveRoot=${rootQuery}`).catch(() => null),
    fetch(`/api/cost?hiveRoot=${rootQuery}`).catch(() => null),
    fetch(`/api/tasks?hiveRoot=${rootQuery}`).catch(() => null),
    fetch(`/api/results?hiveRoot=${rootQuery}`).catch(() => null),
  ]);

  const logs = logRes && logRes.ok ? await logRes.json() as LogEvent[] : [];
  const costs = costRes && costRes.ok ? await costRes.json() as CostRow[] : [];
  const tasks = tasksRes && tasksRes.ok ? await tasksRes.json() as TaskList : undefined;
  const results = resultsRes && resultsRes.ok ? await resultsRes.json() as ResultRow[] : [];

  return { logs, costs, tasks, results };
}
