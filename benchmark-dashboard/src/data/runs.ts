import { LogEvent, CostRow, TaskList, ResultRow, RunSnapshot } from './types';

export function segmentRuns(logs: LogEvent[], costs: CostRow[], tasks?: TaskList, results?: ResultRow[]): RunSnapshot[] {
  const runs: RunSnapshot[] = [];
  let currentRun: RunSnapshot | null = null;

  for (const event of logs) {
    if (!event) continue;
    if (event.kind === 'app-start') {
      currentRun = {
        run_id: event.ts,
        version: event.version,
        spawns: [],
        sessions: [],
        costTotals: { usd: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        modelRollups: {},
        events: [],
        latencyProxies: [],
        tasks: undefined,
        results: []
      };
      runs.push(currentRun);
    }
    if (currentRun) {
      currentRun.events.push(event);
      if (event.kind === 'spawn') currentRun.spawns.push(event);
      if (event.kind === 'session') currentRun.sessions.push(event);
      // Latency proxy: time between a message and something else? The architect notes: "ts deltas between session/message events"
      // Since we just need an array of latency numbers, let's roughly collect deltas between successive events for the same agent/conversation as a proxy.
      // A simpler proxy: just difference between a session start and a message from it.
    }
  }

  // Fallback if no app-start exists
  if (runs.length === 0 && logs.length > 0) {
    runs.push({
      run_id: logs[0].ts,
      version: 'unknown',
      spawns: logs.filter(e => e.kind === 'spawn') as any,
      sessions: logs.filter(e => e.kind === 'session') as any,
      costTotals: { usd: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      modelRollups: {},
      events: logs,
      latencyProxies: []
    });
  }

  // Aggregate costs
  for (const cost of costs) {
    // Find matching run (the one with the largest app-start ts <= cost.ts)
    let matchingRun = runs.length > 0 ? runs[0] : null;
    for (const r of runs) {
      if (r.run_id <= cost.ts) matchingRun = r;
    }
    if (matchingRun) {
      matchingRun.costTotals.usd += cost.usd;
      matchingRun.costTotals.input += cost.input;
      matchingRun.costTotals.output += cost.output;
      matchingRun.costTotals.cache_read += cost.cache_read;
      matchingRun.costTotals.cache_creation += cost.cache_creation;

      if (!matchingRun.modelRollups[cost.model]) {
        matchingRun.modelRollups[cost.model] = { usd: 0, tokens: 0, count: 0 };
      }
      matchingRun.modelRollups[cost.model].usd += cost.usd;
      matchingRun.modelRollups[cost.model].tokens += (cost.input + cost.output + cost.cache_read + cost.cache_creation);
      matchingRun.modelRollups[cost.model].count += 1;
    }
  }

  // For v1, attach the single tasks snapshot to the latest run only (since tasks.json is just current state)
  if (runs.length > 0) {
    runs[runs.length - 1].tasks = tasks;
  }

  // Attach results to corresponding runs if run_id matches (or just the latest)
  if (results) {
    for (const result of results) {
      const r = runs.find(r => r.run_id.toString() === result.run_id);
      if (r) {
        r.results = r.results || [];
        r.results.push(result);
      }
    }
  }

  return runs;
}
