import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface HiveAgentMeta {
  id: string;
  name: string;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  isAssistant?: boolean;
}

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

export interface HiveRegistry {
  godId: string | null;
  /** `archived` agents have had their terminal closed — retained + flagged, not
   *  deleted; only live-PTY agents are 'active'. */
  agents: Record<string, HiveAgentMeta & { status: string; lastSeen: number; archived?: boolean }>;
}

/** A card on the task kanban, persisted to hive/tasks.json. */
export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
}

/** A message the router just delivered, with its resolved recipient ids. Drives
 *  the envelope-handoff animation on the office floor. `needsHuman` is set when
 *  the sender aimed at "human" (now routed to the god proxy) — cosmetic tint
 *  only; there is no approval queue. */
export interface HiveRouteEvent {
  id: string;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  targets: string[];
  needsHuman: boolean;
}

export interface SpawnPtyOptions {
  id: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  /** When present, the agent is provisioned in the hive at spawn. */
  hive?: HiveAgentMeta;
  /** When true (and cwd is a git repo), spawn the agent in its own git worktree. */
  isolate?: boolean;
}

export interface PtyExit { exitCode: number; signal?: number | undefined }

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** Mission flavor; 'heartbeat' (Lane A #1) is a context-aware adaptive beat. */
  kind?: 'dispatch' | 'heartbeat';
  /** Heartbeat only: floor-quiet threshold in ms. */
  quietThresholdMs?: number;
}

/** Circuit-breaker thresholds (Lane A #6.6b). Mirrors src/main/config.ts. */
export interface CircuitBreakerConfig {
  enabled?: boolean;
  hardStop?: boolean;
  repeatedToolLimit?: number;
  errorStormLimit?: number;
  tokenVelocityPerMin?: number;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  harnessHome: string | null;
  registeredRepos: string[];
  autoMode: boolean;
  defaultCommand: string;
  defaultModel?: string;
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  missions?: ScheduledMission[];
  opsStandupSeeded?: boolean;
  heartbeatSeeded?: boolean;
  notifications?: boolean;
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackPort?: number;
  costCapUsd?: number;
  maxTurns?: number;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface MemoryStatus {
  available: boolean;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  palacePath: string | null;
  model: 'minilm' | 'embeddinggemma';
  bin: string | null;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number;
  refs: string[];
}
export interface GitStatusEntry { path: string; index: string; worktree: string }
export interface GitStatus { staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: string[] }

/** Real token usage + estimated USD cost summed from an agent's Claude Code
 *  transcripts under ~/.claude/projects (Sonnet pricing). */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

/** A GitHub issue, normalized for the renderer (labels/assignees flattened to names). */
export interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** A CI (GitHub Actions) workflow run, normalized for the renderer. */
export interface CIRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

const api = {
  version: '0.1.0',

  // ─── PTY ─────────────────────────────────────────────────────────────────
  spawnPty: (opts: SpawnPtyOptions): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id: string, data: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:write', id, data),
  resizePty: (id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  killPty: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:kill', id),
  listPtys: (): Promise<Array<{ id: string; cwd: string; command: string; pid: number }>> =>
    ipcRenderer.invoke('pty:list'),
  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const channel = `pty:data:${id}`;
    const listener = (_e: IpcRendererEvent, data: string) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (id: string, cb: (info: PtyExit) => void): (() => void) => {
    const channel = `pty:exit:${id}`;
    const listener = (_e: IpcRendererEvent, info: PtyExit) => cb(info);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // ─── Dialog ──────────────────────────────────────────────────────────────
  chooseFolder: (): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('dialog:chooseFolder'),

  // ─── Terminal.app ────────────────────────────────────────────────────────
  openTerminalAt: (cwd: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:openAtFolder', cwd),

  // ─── Clipboard ─────────────────────────────────────────────────────────────
  copyToClipboard: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:copyToClipboard', text),

  // ─── Config ──────────────────────────────────────────────────────────────
  getConfig: (): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:get'),
  updateConfig: (patch: Partial<HarnessConfig>): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:update', patch),
  ensureHarnessHome: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:ensureHome', path),

  // ─── Filesystem (sandboxed to cwd) ───────────────────────────────────────
  listDir: (root: string, rel: string): Promise<
    { ok: true; entries: DirEntry[]; path: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:listDir', root, rel),
  readFile: (root: string, rel: string): Promise<
    { ok: true; content: string; path: string; size: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:readFile', root, rel),
  writeFile: (root: string, rel: string, content: string): Promise<
    { ok: true; path: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:writeFile', root, rel, content),

  // ─── Git ─────────────────────────────────────────────────────────────────
  gitIsRepo: (cwd: string): Promise<boolean> => ipcRenderer.invoke('git:isRepo', cwd),
  gitBranch: (cwd: string) =>
    ipcRenderer.invoke('git:branch', cwd) as Promise<{ current: string | null; detached: boolean } | { error: string }>,
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke('git:status', cwd) as Promise<GitStatus | { error: string }>,
  gitLog: (cwd: string, n?: number) =>
    ipcRenderer.invoke('git:log', cwd, n ?? 50) as Promise<GitCommit[] | { error: string }>,
  gitBranches: (cwd: string) =>
    ipcRenderer.invoke('git:branches', cwd) as Promise<{ local: string[]; remote: string[]; current: string | null } | { error: string }>,
  gitAheadBehind: (cwd: string) =>
    ipcRenderer.invoke('git:aheadBehind', cwd) as Promise<{ ahead: number; behind: number; upstream: string | null } | { error: string }>,

  // ─── Hive (multi-agent coordination) ─────────────────────────────────────
  hiveRegistry: (): Promise<HiveRegistry> => ipcRenderer.invoke('hive:registry'),
  hiveBoard: (): Promise<string> => ipcRenderer.invoke('hive:board'),
  hiveTasks: (): Promise<unknown> => ipcRenderer.invoke('hive:tasks'),
  hiveLog: (n?: number): Promise<unknown[]> => ipcRenderer.invoke('hive:log', n ?? 200),
  hiveMemory: (id: string): Promise<string> => ipcRenderer.invoke('hive:memory', id),
  hiveInbox: (id: string): Promise<HiveMessage[]> => ipcRenderer.invoke('hive:inbox', id),

  // ─── Semantic memory (MemPalace CLI) ─────────────────────────────────────
  memoryStatus: (): Promise<MemoryStatus> => ipcRenderer.invoke('hive:memoryStatus'),
  searchMemory: (query: string, wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('hive:searchMemory', query, wing),
  memoryWakeUp: (wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('hive:memoryWakeUp', wing),
  mineNow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('hive:mineNow'),
  hiveSend: (msg: Partial<HiveMessage>, from?: string): Promise<{ ok: boolean; error?: string; message?: HiveMessage }> =>
    ipcRenderer.invoke('hive:send', msg, from),

  // ─── Enrichment assistant (headless Sonnet 1M prompt prep for Michael) ─────
  /** Run Michael's silent assistant on a raw message and return an enriched,
   *  context-rich prompt. `cwd` is the agent's working directory (its default
   *  context); the assistant may read every registered repo to gather more. */
  enrichMessage: (req: { message: string; cwd: string }): Promise<{ ok: boolean; prompt?: string; error?: string }> =>
    ipcRenderer.invoke('assistant:enrich', req),
  onHiveHookEvent: (
    cb: (e: { agentId?: string; event: string; tool?: string; notificationType?: string; source?: string; message?: string; blocked?: boolean }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId?: string; event: string; tool?: string; notificationType?: string; source?: string; message?: string; blocked?: boolean }) => cb(payload);
    ipcRenderer.on('hive:hookEvent', listener);
    return () => ipcRenderer.removeListener('hive:hookEvent', listener);
  },
  onHiveMessage: (cb: (e: HiveRouteEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: HiveRouteEvent) => cb(payload);
    ipcRenderer.on('hive:message', listener);
    return () => ipcRenderer.removeListener('hive:message', listener);
  },

  // ─── Quit confirmation ───────────────────────────────────────────────────
  onCloseRequested: (cb: (info: { ptyCount: number }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: { ptyCount: number }) => cb(info);
    ipcRenderer.on('app:closeRequested', listener);
    return () => ipcRenderer.removeListener('app:closeRequested', listener);
  },
  confirmClose: (): Promise<void> => ipcRenderer.invoke('app:confirmClose'),
  cancelClose: (): Promise<void> => ipcRenderer.invoke('app:cancelClose'),

  // ─── Reset ─────────────────────────────────────────────────────────────────
  /** Wipe all hive data + the memory palace, reset config, and relaunch the app
   *  into onboarding. The process exits, so this promise never resolves. */
  resetAll: (): Promise<void> => ipcRenderer.invoke('app:resetAll'),

  // ─── Token telemetry (real usage + est. cost from CC transcripts) ──────────
  /** Sum input/output/cache tokens + estimated USD cost for an agent from its
   *  Claude Code transcripts. Returns null for an invalid cwd. */
  agentUsage: (cwd: string): Promise<AgentUsage | null> =>
    ipcRenderer.invoke('hive:agentUsage', cwd),

  // ─── Task kanban (hive/tasks.json) ───────────────────────────────────────
  /** Overwrite the hive task ledger with the full task list and commit it. */
  hiveWriteTasks: (tasks: HiveTask[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:writeTasks', tasks),

  // ─── Scheduled missions (recurring auto-dispatch) ──────────────────────────
  listMissions: (): Promise<ScheduledMission[]> => ipcRenderer.invoke('missions:list'),
  saveMissions: (missions: ScheduledMission[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('missions:save', missions),
  /** Fires when the scheduler stamps a mission's lastFiredAt (a beat/dispatch),
   *  so the SCHEDULES panel can refresh "last fired" without a reload. */
  onMissionsUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('missions:updated', listener);
    return () => ipcRenderer.removeListener('missions:updated', listener);
  },

  // ─── Full-text search across hive files (board, tasks, memory) ─────────────
  textSearch: (q: string): Promise<{ ok: boolean; results: Array<{ source: string; excerpt: string }> }> =>
    ipcRenderer.invoke('hive:textSearch', q),

  // ─── GitHub issue ingestion (gh CLI) ───────────────────────────────────────
  /** List up to 30 open issues in the repo at `cwd` via the `gh` CLI. Returns
   *  `{ ok: false, error }` if `gh` is missing/unauthenticated or `cwd` isn't a repo. */
  githubIssues: (cwd: string): Promise<{ ok: boolean; issues?: GHIssue[]; error?: string }> =>
    ipcRenderer.invoke('github:issues', cwd),

  // ─── GitHub CI status watcher (gh CLI) ─────────────────────────────────────
  /** List up to 5 recent CI (GitHub Actions) runs in the repo at `cwd` via the
   *  `gh` CLI. Returns `{ ok: false, error }` if `gh` is missing/unauthenticated,
   *  `cwd` isn't a repo, or the repo has no Actions. */
  githubCIRuns: (cwd: string): Promise<{ ok: boolean; runs?: CIRun[]; error?: string }> =>
    ipcRenderer.invoke('github:ciRuns', cwd),

  // ─── Desktop notifications ───────────────────────────────────────────────────
  /** Toggle native desktop notifications for agent lifecycle events. */
  setNotifications: (v: boolean): Promise<HarnessConfig> =>
    ipcRenderer.invoke('app:setNotifications', v),

  // ─── Agent lifecycle (archival) ─────────────────────────────────────────────
  /** Archive/unarchive a hive agent in the registry. Closing a terminal tab
   *  archives it automatically via pty:kill; this is the explicit primitive. */
  hiveSetArchived: (id: string, archived: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:setArchived', id, archived),

  // ─── Slack integration (Slack message → Michael's queue) ─────────────────────
  /** Register a listener for inbound Slack messages; returns an unsubscribe fn.
   *  Same pattern as onHiveHookEvent. */
  onSlackMessage: (cb: (msg: { text: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, msg: { text: string }) => cb(msg);
    ipcRenderer.on('slack:incomingMessage', listener);
    return () => ipcRenderer.removeListener('slack:incomingMessage', listener);
  },
  /** Start the Slack webhook server; returns the public tunnel URL to paste into
   *  the Slack app's Event Subscriptions → Request URL. */
  slackStart: (): Promise<{ ok: boolean; url?: string; error?: string }> =>
    ipcRenderer.invoke('slack:start'),
  /** Stop the Slack webhook server + tunnel. */
  slackStop: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('slack:stop'),
  /** Persist Slack settings (and stop the server if disabled / secret cleared). */
  slackSetConfig: (patch: {
    signingSecret?: string; botToken?: string; channelId?: string; port?: number; enabled?: boolean;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('slack:setConfig', patch)
};

contextBridge.exposeInMainWorld('cth', api);

export type CthApi = typeof api;
