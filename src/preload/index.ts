import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { AgentProvider } from '../shared/agentProvider';
import type { HireManifest } from '../shared/hire';
export type { HireManifest } from '../shared/hire';
import type { IntegrationRecord, IntegrationTemplate } from '../shared/integrations';
export type { IntegrationRecord, IntegrationTemplate } from '../shared/integrations';

/** Renderer-visible integration record: the secretRef handle is redacted to a
 *  presence boolean. Matches main `integrations.listRecordsRedacted()` — the
 *  write-only secret contract (spec §2): a secret value is NEVER returned over IPC. */
export type IntegrationRecordView = Omit<IntegrationRecord, 'secretRef'> & { hasSecret: boolean };

// Injected at build time from package.json (see electron.vite.config.ts).
declare const __APP_VERSION__: string;

export interface HiveAgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on (claude/codex/antigravity/custom); defaults claude. */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — send-only; enriches prompts and forwards them. */
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

/** One question→answer exchange with the human, recorded ON the task card. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
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
  /** First-class human feedback: god appends {q}, the harness UI fills {a};
   *  the full history stays on the card. */
  humanQA?: HumanQA[];
  /** Outcome summary used for the Slack done-notification. */
  result?: string;
  /** Origin thread for a Slack-sourced task (drives the done-summary reply). */
  slack?: { channel: string; thread_ts: string };
  /** SHA-256 of the capability token for a generic-webhook-sourced task (drives
   *  the GET status lookup; the raw token is never persisted). */
  webhook?: { tokenHash: string };
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

/** A direct hive message addressed to a provider that cannot drain hive inbox.
 *  The renderer turns this into a queued terminal work order for that agent. */
export interface HiveTerminalHandoffEvent {
  id: string;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  body: string;
  requiresReply: boolean;
  createdAt: string;
}

export interface SpawnPtyOptions {
  id: string;
  cwd: string;
  command: string;
  /** Which CLI to spawn; usually inferred from `command` in the main process. */
  provider?: AgentProvider;
  args?: string[];
  cols?: number;
  rows?: number;
  /** When present, the agent is provisioned in the hive at spawn. */
  hive?: HiveAgentMeta;
  /** When true (and cwd is a git repo), spawn the agent in its own git worktree. */
  isolate?: boolean;
  /** When true, continue the agent's prior CLI session if one was recorded
   *  (provider-aware: Claude `--resume`, Antigravity `--conversation`). For
   *  Claude the main process looks up the session id from the hive registry and
   *  seeds its transcript into the cwd's project dir (#1 — restore on restart). */
  resume?: boolean;
  /** Explicit Claude session id to resume (#2 — Add Agent "resume session"). The
   *  main process seeds that session's `.jsonl` into the target cwd's project dir
   *  (copying it from wherever it lives) and launches `claude --resume <id>`. */
  resumeSessionId?: string;
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
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** Heartbeat only: floor-quiet threshold in ms. */
  quietThresholdMs?: number;
}

/** Circuit-breaker thresholds (Lane A #6.6b). Mirrors src/main/config.ts. */
export interface KnowledgeGraphConfig {
  enabled?: boolean;
  rootPath?: string;
}

export interface CircuitBreakerConfig {
  enabled?: boolean;
  hardStop?: boolean;
  repeatedToolLimit?: number;
  errorStormLimit?: number;
  tokenVelocityPerMin?: number;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  /** Onboarding audience ('technical' | 'non-technical'); drives onboarding copy.
   *  Mirrors src/main/config.ts. */
  audience?: 'technical' | 'non-technical';
  harnessHome: string | null;
  /** Recently-opened hive home folders (most-recent first). Mirrors src/main/config.ts. */
  recentHives?: string[];
  registeredRepos: string[];
  autoMode: boolean;
  defaultCommand: string;
  defaultModel?: string;
  /** Which provider+model powers the GOD orchestrator ("Michael"). Default
   *  'claude' / 'claude-opus-4-8'. Mirrors src/main/config.ts. */
  godProvider?: AgentProvider;
  godModel?: string;
  /** Per-server consent for the default MCP bundle, keyed by catalog id. Mirrors
   *  src/main/config.ts. */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  missions?: ScheduledMission[];
  opsStandupSeeded?: boolean;
  heartbeatSeeded?: boolean;
  notifications?: boolean;
  /** Opt-in strong keep-alive (prevent-display-sleep). Mirrors main + renderer
   *  HarnessConfig so updateConfig({ strongKeepalive }) is typed across the bridge. */
  strongKeepalive?: boolean;
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackPort?: number;
  webhookEnabled?: boolean;
  webhookSecret?: string;
  webhookPort?: number;
  /** Free Flow voice dictation — master flag (default off), user Groq key, model.
   *  Entry point B (hold-Option-to-talk) is handled in the renderer, no hotkey. */
  freeflowEnabled?: boolean;
  groqApiKey?: string;
  freeflowModel?: string;
  /** Realtime Michael voice loop — true ONLY while a session holds the mic
   *  (renderer session sets it at start()/stop()); the main mic permission gate
   *  reads it. Default off. */
  realtimeVoiceEnabled?: boolean;
  /** Realtime voice idle auto-disconnect (ms); default 180000 (3 min), 0 = never.
   *  Tuned in Settings → Realtime Michael; the cost cap stays the runaway guard. */
  realtimeIdleDisconnectMs?: number;
  costCapUsd?: number;
  costCapTokens?: number;
  agentTokenCaps?: Record<string, number>;
  maxTurns?: number;
  circuitBreaker?: CircuitBreakerConfig;
  /** Enterprise Knowledge Graph (multimodal context for agents). Default OFF. */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** Terminal theme, mirrored into each agent's per-session Claude settings. */
  terminalTheme?: 'light' | 'dark';
  /** TV-show office themes feature flag (Settings picker + switch flow). Default OFF. */
  tvShowOffices?: boolean;
  /** Active office map/cast theme (honored only when tvShowOffices is on). */
  officeTheme?: 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
  /** Per-CLI-provider local/self-hosted base URL (Ollama/LM Studio/vLLM, …) for the
   *  OpenCode/Crush/pi/qwen engines; applied at spawn. API KEYS are NOT stored here —
   *  they live write-only in the secret broker. */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** Per-CLI-provider default model slug, used to pre-fill the model picker. */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
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

/** Enterprise Knowledge Graph — corpus status, one document, and a search hit. */
export interface KnowledgeStatus {
  enabled: boolean;
  root: string;
  docCount: number;
  chunkCount: number;
  byModality: Record<string, number>;
}
export interface KnowledgeDoc {
  id: string;
  title: string;
  source: string;
  modality: string;
  mime: string | null;
  origExt: string;
  bytes: number;
  tags: string[];
  caption: string | null;
  chunkCount: number;
  addedAt: string;
  extractor: string;
  truncated: boolean;
}
export interface KnowledgeHit {
  docId: string;
  title: string;
  source: string;
  modality: string;
  chunkIdx: number;
  score: number;
  snippet: string;
}
export interface KnowledgeIngestResult {
  ok: boolean;
  results: Array<{ ok: boolean; srcPath: string; docId?: string; chunkCount?: number; error?: string }>;
  error?: string;
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
 *  transcripts under ~/.claude/projects. Reconciler/fallback path — now priced
 *  PER MODEL (not Sonnet-for-everyone). The live path uses AgentUsageSample. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  /** Most-recently-seen model id (normalized), if any priced record was found. */
  model?: string;
}

/** Live cumulative cost/token snapshot from the OTel collector (the locked
 *  cross-lane seam). PII-free by construction. Mirrors telemetry.ts. */
export interface AgentUsageSample {
  agentId: string;
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
  usd: number;
}

/** One tool invocation for the per-agent span waterfall (#7B.2). Ephemeral. */
export interface ToolSpan {
  agentId: string;
  sessionId: string;
  ts: number;
  tool: string;
  success: boolean;
  durationMs: number;
  decision?: 'accept' | 'reject';
  error?: string;
}

/** Power-resume signal (mirrors the emitter in src/main). Fired after the Mac
 *  wakes from sleep / unlocks: `dead` lists PTY ids that were live before sleep
 *  but emitted nothing after resume (wedged terminals); `total` is how many were
 *  checked. The renderer auto-respawns exactly the `dead` ids. */
export interface PowerResumeEvent {
  reason: string;
  awayMs: number | null;
  dead: string[];
  total: number;
}

/** Closing-time progress event (mirrors src/main/closingTime.ts). */
export interface ClosingTimeEvent {
  phase: 'started' | 'progress' | 'complete' | 'timeout' | 'cancelled';
  /** Workers that have ACKed so far / total workers being waited on. */
  acked: number;
  total: number;
}

/** Per-agent operator-control state (#7C.1–7C.3). */
export interface AgentControlSnapshot {
  paused: boolean;
  halted: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

/** Circuit-breaker state (Lane A #6 → this lane's avatars/meter). */
export interface BreakerState {
  agentId: string;
  level: 'healthy' | 'steering' | 'constrained' | 'stopped';
  reason: string;
  ts: number;
}

/** Live telemetry push payload (channel `telemetry:event`). */
export type TelemetryEvent =
  | { kind: 'usage'; sample: AgentUsageSample }
  | { kind: 'tool_result'; span: ToolSpan }
  | { kind: 'api_error'; agentId: string; sessionId: string; ts: number; error: string };

/** Cold-start backfill from the collector. */
export interface TelemetrySnapshot {
  usage: AgentUsageSample[];
  spans: Record<string, ToolSpan[]>;
}

/** One captured user prompt from the SQLite command_history table. */
export interface CommandHistoryEntry {
  id: number;
  agentId: string;
  cwd: string | null;
  text: string;
  ts: number;
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

/** One live god-triggered ephemeral worker, as shown in the Workers tab. */
export interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY already gone
  tokensUsed: number;
  tokenCap: number | null;      // effective cap; null = unlimited (the default)
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working';
}
/** A worker worktree preserved at teardown, awaiting integration + GC. */
export interface PreservedWorktreeSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

const api = {
  version: __APP_VERSION__,

  // ─── PTY ─────────────────────────────────────────────────────────────────
  spawnPty: (opts: SpawnPtyOptions): Promise<{ ok: boolean; error?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string }> =>
    ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id: string, data: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:write', id, data),
  resizePty: (id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  killPty: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:kill', id),
  listPtys: (): Promise<Array<{ id: string; cwd: string; command: string; pid: number; lastOutputAt: number }>> =>
    ipcRenderer.invoke('pty:list'),
  /** Resolve a Claude session id to the cwd it originally ran in (Add Agent
   *  resume auto-fill), or null if the id is invalid/unknown. */
  resolveSessionCwd: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke('session:resolveCwd', sessionId),
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
  /** Fires when an agent is auto restart-and-continued into this SAME pty after a
   *  first-time engine-CLI install. The terminal should re-arm in place (clear the
   *  "process exited" line + re-enable input) so the relaunched CLI paints clean. */
  onPtyRelaunch: (id: string, cb: () => void): (() => void) => {
    const channel = `pty:relaunch:${id}`;
    const listener = () => cb();
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
  /** Read the system clipboard as plain text ('' when empty/unreadable). */
  readClipboard: (): Promise<string> =>
    ipcRenderer.invoke('app:readClipboard'),

  // ─── Config ──────────────────────────────────────────────────────────────
  getConfig: (): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:get'),
  updateConfig: (patch: Partial<HarnessConfig>): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:update', patch),
  ensureHarnessHome: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:ensureHome', path),
  /** Change the harness home folder. 'move' copies the existing hive + palace
   *  into the new folder (old kept as a safety net); 'fresh' just re-points and
   *  bootstraps an empty home. On success the app relaunches (never resolves);
   *  on failure (e.g. copy error) returns { ok: false, error }. */
  changeHome: (newHome: string, mode: 'move' | 'fresh'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:changeHome', { newHome, mode }),

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

  // ─── Ephemeral workers (P4 — Slack-triggered isolated workers) ───────────
  /** Live ephemeral workers + worktrees preserved awaiting integration/GC. */
  listWorkers: (): Promise<{ live: WorkerSnapshot[]; preserved: PreservedWorktreeSnapshot[]; maxWorkers: number }> =>
    ipcRenderer.invoke('workers:list'),
  /** Manually stop a live ephemeral worker (safety-gated teardown; work preserved). */
  stopWorker: (workerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('workers:stop', workerId),

  // ─── Semantic memory (MemPalace CLI) ─────────────────────────────────────
  memoryStatus: (): Promise<MemoryStatus> => ipcRenderer.invoke('hive:memoryStatus'),
  searchMemory: (query: string, wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('hive:searchMemory', query, wing),
  memoryWakeUp: (wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('hive:memoryWakeUp', wing),
  mineNow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('hive:mineNow'),
  /** Condense agent memory.md files (the janitor's missing half). With an id,
   *  condense that agent on demand; without, run a full threshold scan. Returns
   *  the per-agent outcomes ({ id, condensed, reason, oldBytes?, newBytes? }). */
  reflectNow: (id?: string): Promise<Array<{ id: string; condensed: boolean; reason: string; oldBytes?: number; newBytes?: number }>> =>
    ipcRenderer.invoke('memory:reflectNow', id),

  // ─── Enterprise Knowledge Graph (multimodal context for agents) ───────────
  kgStatus: (): Promise<KnowledgeStatus> => ipcRenderer.invoke('kg:status'),
  kgList: (): Promise<KnowledgeDoc[]> => ipcRenderer.invoke('kg:list'),
  kgSearch: (query: string, limit?: number): Promise<KnowledgeHit[]> =>
    ipcRenderer.invoke('kg:search', query, limit),
  kgGet: (id: string): Promise<{ meta: KnowledgeDoc; text: string } | null> =>
    ipcRenderer.invoke('kg:get', id),
  kgRemove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('kg:remove', id),
  /** Open an OS file picker and ingest the chosen artifacts in one round-trip. */
  kgAddFiles: (): Promise<KnowledgeIngestResult> => ipcRenderer.invoke('kg:addFiles'),
  /** Ingest explicit file paths (e.g. drag-and-drop). */
  kgIngestFiles: (paths: string[], tags?: string[]): Promise<KnowledgeIngestResult> =>
    ipcRenderer.invoke('kg:ingestFiles', { paths, tags }),

  // ─── Composer attachments (images + files, sent to agents by PATH) ─────────
  /** Open an OS picker for images/files; returns chosen absolute paths + names. */
  attachFiles: (): Promise<
    { ok: true; files: { path: string; name: string }[] } | { ok: false; error: string }
  > => ipcRenderer.invoke('dialog:attachFiles'),
  /** Resolve a dropped File's absolute path (Electron 32 removed File.path). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** Write the current clipboard image to a temp PNG and return its path (paste-to-attach). */
  saveClipboardImage: (): Promise<
    { ok: true; file: { path: string; name: string } } | { ok: false; error: string }
  > => ipcRenderer.invoke('clipboard:saveImage'),

  // ─── Command history (SQLite — every prompt submitted to an agent) ─────────
  /** Record one submitted prompt. Fire-and-forget from the prompt-detection hook. */
  historyAdd: (entry: { agentId: string; cwd?: string; text: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('history:add', entry),
  /** Most-recent-first history, optionally scoped to one agent. */
  historyList: (agentId?: string, limit?: number): Promise<CommandHistoryEntry[]> =>
    ipcRenderer.invoke('history:list', agentId, limit),
  /** Substring search over prompt text, most-recent-first. */
  historySearch: (query: string, limit?: number): Promise<CommandHistoryEntry[]> =>
    ipcRenderer.invoke('history:search', query, limit),
  hiveSend: (msg: Partial<HiveMessage>, from?: string): Promise<{ ok: boolean; error?: string; message?: HiveMessage }> =>
    ipcRenderer.invoke('hive:send', msg, from),

  onHiveHookEvent: (
    cb: (e: { agentId?: string; event: string; tool?: string; notificationType?: string; source?: string; message?: string; blocked?: boolean }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId?: string; event: string; tool?: string; notificationType?: string; source?: string; message?: string; blocked?: boolean }) => cb(payload);
    ipcRenderer.on('hive:hookEvent', listener);
    return () => ipcRenderer.removeListener('hive:hookEvent', listener);
  },
  /** Push-based context accounting from the status line: live tokens + the
   *  session's EXACT context-window size. Same pattern as onHiveHookEvent. */
  onHiveContextUpdate: (
    cb: (e: { agentId: string; tokens: number; limit: number }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId: string; tokens: number; limit: number }) => cb(payload);
    ipcRenderer.on('hive:contextUpdate', listener);
    return () => ipcRenderer.removeListener('hive:contextUpdate', listener);
  },
  onHiveMessage: (cb: (e: HiveRouteEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: HiveRouteEvent) => cb(payload);
    ipcRenderer.on('hive:message', listener);
    return () => ipcRenderer.removeListener('hive:message', listener);
  },
  /** Register a listener for hive tasks routed to non-Claude agents (e.g.
   *  Codex). Main emits this instead of bouncing; the renderer enqueues the
   *  raw text so the drain effect types it into the agent's REPL when idle. */
  onHiveEnqueue: (cb: (e: { targetId: string; text: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { targetId: string; text: string }) => cb(payload);
    ipcRenderer.on('hive:enqueueToAgent', listener);
    return () => ipcRenderer.removeListener('hive:enqueueToAgent', listener);
  },
  /** A MAIN-initiated agent spawn (e.g. a voice hire via rt-5) — the renderer adds
   *  the floor card from this descriptor since it didn't initiate the hire itself. */
  onHiveAgentSpawned: (
    cb: (rec: {
      id: string; name: string; provider?: string; cwd: string;
      command?: string; role?: string; worktreePath?: string;
    }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on('hive:agentSpawned', listener);
    return () => ipcRenderer.removeListener('hive:agentSpawned', listener);
  },
  /** A MAIN-initiated agent kill/archive (e.g. a voice kill via rt-5) — the renderer
   *  archives the floor card since it didn't initiate the kill itself. */
  onHiveAgentArchived: (cb: (e: { id: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string }) => cb(payload);
    ipcRenderer.on('hive:agentArchived', listener);
    return () => ipcRenderer.removeListener('hive:agentArchived', listener);
  },
  /** Register a listener for terminal work-order handoffs (#53) — hive mail to a
   *  hookless provider that can't drain an inbox; the renderer types it into the
   *  agent's REPL as a work order. */
  onHiveTerminalHandoff: (cb: (e: HiveTerminalHandoffEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: HiveTerminalHandoffEvent) => cb(payload);
    ipcRenderer.on('hive:terminalHandoff', listener);
    return () => ipcRenderer.removeListener('hive:terminalHandoff', listener);
  },

  // ─── Shareable hires (deep link / file import) ────────────────────────────
  /** Fired when a validated hire manifest arrives via the munderdifflin://
   *  deep link. The renderer opens the Add-Agent modal pre-filled — import
   *  never spawns anything by itself. */
  onHireImport: (cb: (manifest: HireManifest) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, manifest: HireManifest) => cb(manifest);
    ipcRenderer.on('hire:import', listener);
    return () => ipcRenderer.removeListener('hire:import', listener);
  },
  /** Fired when a deep-linked manifest failed validation/fetch. */
  onHireError: (cb: (info: { error: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: { error: string }) => cb(info);
    ipcRenderer.on('hire:error', listener);
    return () => ipcRenderer.removeListener('hire:error', listener);
  },
  /** Signal readiness and pull any queued deep-linked manifests (cold-start
   *  links, links that arrived during load). Resolves the queued list. */
  drainPendingHires: (): Promise<HireManifest[]> =>
    ipcRenderer.invoke('hire:drainPending'),
  /** Open a file picker and validate the chosen hire-manifest JSON. */
  importHireFile: (): Promise<{ ok: boolean; manifest?: HireManifest; error?: string }> =>
    ipcRenderer.invoke('hire:openFile'),

  // ─── Quit confirmation ───────────────────────────────────────────────────
  onCloseRequested: (cb: (info: { ptyCount: number }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: { ptyCount: number }) => cb(info);
    ipcRenderer.on('app:closeRequested', listener);
    return () => ipcRenderer.removeListener('app:closeRequested', listener);
  },
  confirmClose: (): Promise<void> => ipcRenderer.invoke('app:confirmClose'),
  cancelClose: (): Promise<void> => ipcRenderer.invoke('app:cancelClose'),

  // ─── Power / wake (auto-revive wedged PTYs after sleep/lock) ────────────────
  /** Subscribe to the main-process power-resume signal; returns an unsubscribe
   *  fn. The main process catches up after a sleep/unlock and reports the PTY
   *  ids that wedged across it in `dead` — the renderer respawns ONLY those
   *  (empty `dead[]` = no-op). Same main→renderer push pattern as onClosingTime. */
  onPowerResume: (cb: (e: PowerResumeEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: PowerResumeEvent) => cb(payload);
    ipcRenderer.on('power:resume', listener);
    return () => ipcRenderer.removeListener('power:resume', listener);
  },

  // ─── Multi-window floors ───────────────────────────────────────────────────
  /** Open a new floor (independent office window). No-op when the multiWindow
   *  flag is off. Resolves { ok } indicating whether a window opened. */
  newFloor: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:newFloor'),

  // ─── Closing time (graceful shutdown via the hive) ─────────────────────────
  /** Start the closing-time protocol: the god broadcasts shutdown, every worker
   *  saves its memory and ACKs, the god concludes — then the app quits itself.
   *  Resolves with ok:false (+ error) when no god agent is running. */
  startClosingTime: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:startClosingTime'),
  /** Abort an in-progress closing time and tell the floor to resume work. */
  cancelClosingTime: (): Promise<void> => ipcRenderer.invoke('app:cancelClosingTime'),
  /** Progress events for the quit dialog: started → progress (ACK counts) →
   *  complete (the app tears down moments later) | timeout | cancelled. */
  onClosingTime: (cb: (ev: ClosingTimeEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: ClosingTimeEvent) => cb(ev);
    ipcRenderer.on('app:closingTime', listener);
    return () => ipcRenderer.removeListener('app:closingTime', listener);
  },

  // ─── Reset ─────────────────────────────────────────────────────────────────
  /** Wipe all hive data + the memory palace, reset config, and relaunch the app
   *  into onboarding. The process exits, so this promise never resolves. */
  resetAll: (): Promise<void> => ipcRenderer.invoke('app:resetAll'),

  // ─── Token telemetry (real usage + est. cost from CC transcripts) ──────────
  /** Sum input/output/cache tokens + estimated USD cost for an agent from its
   *  Claude Code transcripts (reconciler/fallback). Returns null for an invalid cwd. */
  agentUsage: (cwd: string): Promise<AgentUsage | null> =>
    ipcRenderer.invoke('hive:agentUsage', cwd),
  /** Current context size (tokens) of an agent's live session, read from the
   *  last assistant message of its transcript. Null until the agent's hooks
   *  have fired at least once (the transcript path is learned from them). */
  agentContext: (agentId: string): Promise<number | null> =>
    ipcRenderer.invoke('hive:agentContext', agentId),

  // ─── Live telemetry (OTel collector — the usage-provider seam + spans) ──────
  /** Live cumulative usage for an agent (OTel-preferred, transcript fallback). */
  telemetryUsage: (agentId: string): Promise<AgentUsageSample | null> =>
    ipcRenderer.invoke('telemetry:usage', agentId),
  /** Recent tool spans for an agent's waterfall (#7B.2). */
  telemetrySpans: (agentId: string): Promise<ToolSpan[]> =>
    ipcRenderer.invoke('telemetry:spans', agentId),
  /** Cold-start backfill of all agents' usage + recent spans. */
  telemetrySnapshot: (): Promise<TelemetrySnapshot> =>
    ipcRenderer.invoke('telemetry:snapshot'),
  /** Subscribe to live telemetry pushes; returns an unsubscribe fn. */
  onTelemetryEvent: (cb: (e: TelemetryEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: TelemetryEvent) => cb(payload);
    ipcRenderer.on('telemetry:event', listener);
    return () => ipcRenderer.removeListener('telemetry:event', listener);
  },

  // ─── Circuit breaker (Lane A #6 state → avatars/meter) ──────────────────────
  /** Subscribe to breaker-state changes; returns an unsubscribe fn. */
  onBreakerState: (cb: (s: BreakerState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: BreakerState) => cb(payload);
    ipcRenderer.on('control:breakerState', listener);
    return () => ipcRenderer.removeListener('control:breakerState', listener);
  },
  /** Push a breaker state to the renderer (Lane A's policy / interim glue calls this). */
  setBreakerState: (state: BreakerState): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('control:setBreakerState', state),

  // ─── Operator control over agents (#7C.1–7C.3) ──────────────────────────────
  /** Pause/unpause an agent — paused → its tool calls are denied at PreToolUse. */
  controlPause: (agentId: string, on: boolean): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:pause', agentId, on),
  /** Clear pause + halt so the agent can run again. */
  controlResume: (agentId: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:resume', agentId),
  /** Gate/ungate a specific tool for an agent (denied at PreToolUse). */
  controlGateTool: (agentId: string, tool: string, on: boolean): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:gateTool', agentId, tool, on),
  /** Queue a steer note — injected as context on the agent's next hook (#7C.2). */
  controlSteer: (agentId: string, text: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:steer', agentId, text),
  /** Request a graceful stop at the next hook boundary (#7C.3). */
  controlHalt: (agentId: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:halt', agentId),
  /** Read an agent's current control snapshot. */
  controlSnapshot: (agentId: string): Promise<AgentControlSnapshot | null> =>
    ipcRenderer.invoke('control:snapshot', agentId),
  /** Subscribe to gate/deny events (a tool was blocked); returns unsubscribe fn. */
  onApprovalRequest: (cb: (e: { agentId: string; tool?: string; reason?: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId: string; tool?: string; reason?: string }) => cb(payload);
    ipcRenderer.on('control:approvalRequest', listener);
    return () => ipcRenderer.removeListener('control:approvalRequest', listener);
  },

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
  /** Fires when an autoCompact mission ticks — the renderer queues a /compact
   *  per agent (deduped) and delivers it when each agent is idle. */
  onAutoCompact: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('mission:autoCompact', listener);
    return () => ipcRenderer.removeListener('mission:autoCompact', listener);
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

  // ─── Reliability / OS integration (onboarding permissions step) ──────────────
  /** Open a System Settings deep-link (or https URL) in the OS handler. Main
   *  restricts the scheme; the renderer just points at the pane. */
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:openExternal', url),
  /** Toggle macOS "Open at Login". Resolves to the resulting state (no prompt). */
  setLoginItem: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setLoginItem', enabled),

  // ─── Agent lifecycle (archival) ─────────────────────────────────────────────
  /** Archive/unarchive a hive agent in the registry. Closing a terminal tab
   *  archives it automatically via pty:kill; this is the explicit primitive. */
  hiveSetArchived: (id: string, archived: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('hive:setArchived', id, archived),

  // ─── Slack integration (Slack message → Michael's queue) ─────────────────────
  /** Register a listener for inbound Slack messages; returns an unsubscribe fn.
   *  The message carries the thread coordinates needed to reply in-thread. */
  onSlackMessage: (cb: (msg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble?: string; files?: { path: string; name: string; mimetype: string }[] }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, msg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble?: string; files?: { path: string; name: string; mimetype: string }[] }) => cb(msg);
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
  /** Current connection state + last Request URL (so Settings can hydrate the
   *  "Connected" badge and re-show the persisted tunnel URL on reopen). */
  slackStatus: (): Promise<{ running: boolean; url?: string }> =>
    ipcRenderer.invoke('slack:status'),
  /** Post a reply into a Slack thread (the bot token stays in main). Used for the
   *  renderer's immediate "queued" ack. */
  slackReply: (m: { channel: string; thread_ts: string; text: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('slack:reply', m),
  /** Absolute path to the bundled reply helper, for the office worker's
   *  end-of-run "post your summary back to Slack" instruction. */
  slackReplyScriptPath: (): Promise<string> =>
    ipcRenderer.invoke('slack:replyScriptPath'),
  /** Persist Slack settings (and stop the server if disabled / secret cleared). */
  slackSetConfig: (patch: {
    signingSecret?: string; botToken?: string; channelId?: string; port?: number; enabled?: boolean;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('slack:setConfig', patch),

  // ─── Generic webhook + status API (POST → work, GET → status) ────────────────
  /** Start the generic webhook server; returns the public endpoint URL callers
   *  POST to (secret-gated) and GET a token's status from. */
  webhookStart: (): Promise<{ ok: boolean; url?: string; error?: string }> =>
    ipcRenderer.invoke('webhook:start'),
  /** Stop the generic webhook server + tunnel. */
  webhookStop: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('webhook:stop'),
  /** Current state + last endpoint URL (so Settings can hydrate the badge/URL). */
  webhookStatus: (): Promise<{ running: boolean; url?: string }> =>
    ipcRenderer.invoke('webhook:status'),
  /** Mint + persist a fresh secret and return it for the user to copy. */
  webhookGenerateSecret: (): Promise<{ ok: boolean; secret?: string }> =>
    ipcRenderer.invoke('webhook:generateSecret'),
  /** Persist webhook settings (and stop the server if disabled / secret cleared). */
  webhookSetConfig: (patch: {
    secret?: string; port?: number; enabled?: boolean;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('webhook:setConfig', patch),

  // ─── Free Flow (voice dictation → message queue) ─────────────────────────────
  /** Persist Free Flow settings (flag / Groq key / model). The Groq key is stored
   *  in main config; entry point B (hold-Option) is renderer-side, no hotkey here. */
  freeflowSetConfig: (patch: {
    enabled?: boolean; apiKey?: string; model?: string;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('freeflow:setConfig', patch),
  /** Transcribe one captured audio clip via Groq (the key stays in main; only the
   *  audio bytes go in and the transcript comes back). Gated on the flag + a key. */
  freeflowTranscribe: (arg: {
    audio: ArrayBuffer | Uint8Array; mimeType?: string; filename?: string; language?: string;
  }): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('freeflow:transcribe', arg),

  // ─── Integrations registry (Phase 2 — labeled REST endpoints via the secret broker) ──
  // Bridges the §6 IPC surface for the Settings UI. WRITE-ONLY secret contract end to
  // end: `integrationsList` returns records with secretRef redacted to `hasSecret`;
  // `integrationsSetSecret` takes a secret ONE WAY (never echoed); NO method ever
  // returns a secret value to the renderer. Method names match registryClient's
  // feature-detection (camelCase ↔ colon-channel), so its real path activates as-is.
  integrationsList: (): Promise<IntegrationRecordView[]> =>
    ipcRenderer.invoke('integrations:list'),
  integrationsTemplates: (): Promise<IntegrationTemplate[]> =>
    ipcRenderer.invoke('integrations:templates'),
  integrationsUpsert: (record: IntegrationRecord): Promise<{ ok: true; record: IntegrationRecord } | { ok: false; error: string }> =>
    ipcRenderer.invoke('integrations:upsert', record),
  integrationsSetSecret: (req: { id: string; secret: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('integrations:setSecret', req),
  integrationsRemove: (req: { id: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('integrations:remove', req),
  integrationsTest: (req: { id: string; path?: string }): Promise<{ ok: boolean; status?: number; error?: string }> =>
    ipcRenderer.invoke('integrations:test', req),
  // Per-CLI-provider BYOK keys — WRITE-ONLY. `providerKeySet` stores a backend key one
  // way (never echoed); `providerKeyHas` returns only a boolean; no method ever returns
  // the plaintext. Keys are materialized MAIN-ONLY at spawn.
  providerKeySet: (req: { backend: string; key: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('providerKey:set', req),
  providerKeyHas: (backend: string): Promise<boolean> =>
    ipcRenderer.invoke('providerKey:has', backend),
  providerKeyClear: (backend: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('providerKey:clear', backend),
  // Realtime Michael (voice orchestrator) — MAIN mints a short-lived EPHEMERAL token
  // from the BYOK OpenAI key; the real key NEVER crosses IPC. `realtimeHasOpenAiKey`
  // is a presence boolean only (gates the voice toggle, like providerKeyHas).
  realtimeHasOpenAiKey: (): Promise<boolean> =>
    ipcRenderer.invoke('realtime:hasKey'),
  realtimeMintToken: (
    req?: { model?: string }
  ): Promise<
    | { ok: true; token: string; expiresAt: number | null; sessionConfig: { model: string } }
    | { ok: false; error: string; code?: string }
  > => ipcRenderer.invoke('realtime:mintToken', req ?? {}),
  // rt-5 voice ACTIONS — the renderer holds NO policy; main (realtimeActions.ts) owns
  // the tiering, two-step verbal confirm, hard allowlist, and michael-voice
  // attribution. These just forward {verb,...args} and speak back `spoken`.
  realtimeAction: (
    payload: { verb: string } & Record<string, unknown>
  ): Promise<{ ok: boolean; spoken: string; needsConfirm?: boolean }> =>
    ipcRenderer.invoke('realtime:action', payload),
  realtimeActionConfirm: (
    req: { phrase: string }
  ): Promise<{ ok: boolean; spoken: string; needsConfirm?: boolean }> =>
    ipcRenderer.invoke('realtime:action:confirm', req),
  realtimeActionCancel: (): Promise<{ ok: boolean; spoken: string; needsConfirm?: boolean }> =>
    ipcRenderer.invoke('realtime:action:cancel'),
  // rt-12 completion seam — a voice-dispatched task finished. `summary` is the
  // human-speakable line Michael relays; the rest is context for a toast/log.
  onRealtimeCompletion: (
    cb: (evt: { correlationId: string; kind: string; targetAgentId: string; taskId?: string; summary: string; completedAt: number; objective?: string }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on('realtime:completion', listener);
    return () => ipcRenderer.removeListener('realtime:completion', listener);
  },
  /** Tell main whether a live voice session is open (drives queue-vs-push for completions). */
  realtimeSetSessionLive: (live: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('realtime:setSessionLive', live),
  /** Drain completions that arrived while no session was open (warm-start catch-up). */
  realtimeDrainCompletions: (): Promise<
    { correlationId: string; kind: string; targetAgentId: string; taskId?: string; summary: string; completedAt: number; objective?: string }[]
  > => ipcRenderer.invoke('realtime:drainCompletions'),
  /** Block until a tracked task completes (or times out) — backs the wait_for tool. */
  realtimeWaitFor: (
    taskId: string,
    timeoutMs?: number
  ): Promise<{ summary: string; targetAgentId: string; taskId?: string } | { timedOut: true; taskId: string }> =>
    ipcRenderer.invoke('realtime:waitFor', taskId, timeoutMs)
};

contextBridge.exposeInMainWorld('cth', api);

export type CthApi = typeof api;
