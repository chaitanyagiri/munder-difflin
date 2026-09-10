export interface LogAppStart { kind: 'app-start'; ts: number; version: string; packaged: boolean; appPath: string; electron: string; platform: string; }
export interface LogSpawn { kind: 'spawn'; ts: number; agentId: string; name?: string; isGod?: boolean; }
export interface LogSession { kind: 'session'; ts: number; agentId: string; sessionId: string; }
export interface LogMessage { kind: 'message'; ts: number; from: string; to: string; act: string; subject?: string; id: string; delivered?: string[]; }
export interface LogDrop { kind: 'drop'; ts: number; reason: string; from: string; to: string; id: string; }
export type LogEvent = LogAppStart | LogSpawn | LogSession | LogMessage | LogDrop;

export interface CostRow {
  agent_id: string;
  session_id: string;
  ts: number;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  model: string;
  usd: number;
}

export interface Task {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  assignee: string;
  createdAt: string;
  humanQA?: {q: string; askedAt: string; a?: string}[];
  notes?: string;
}

export interface TaskList {
  tasks: Task[];
}

export interface ResultRow {
  run_id: string;
  task_id: string;
  passed: boolean;
  score?: number;
}

export interface RunSnapshot {
  run_id: number;
  version: string;
  spawns: LogSpawn[];
  sessions: LogSession[];
  costTotals: {
    usd: number;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
  modelRollups: Record<string, { usd: number; tokens: number; count: number }>;
  tasks?: TaskList;
  results?: ResultRow[];
  events: LogEvent[];
  latencyProxies: number[];
}
