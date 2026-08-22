import { create } from 'zustand';
import type { AccentColorName } from '@/design/tokens';
import type { OfficeCharacterName } from '@/scene/office/cast';
import type { ThemeId } from '@/scene/office/themeRegistry';
import type { StatusKind } from '@/components/PixelBadge';
import type { AgentProvider } from '@shared/agentProvider';
import type { HireManifest } from '@shared/hire';
import { DEFAULT_ORG_TRIGGER, type OrgTriggerConfig, type WebhookTrigger } from '@shared/triggers';
import { isCompactionCommand } from '@shared/providerAutomation';

export type ToolKind =
  | 'Read' | 'Edit' | 'Write' | 'Bash' | 'WebFetch' | 'WebSearch'
  | 'Grep' | 'Glob' | 'TodoWrite' | 'MCP';

export type StationKind =
  | 'shelf' | 'terminal' | 'web' | 'board' | 'mailbox' | 'mcp' | 'desk';

export interface BlockReason {
  summary: string;                 // short headline shown on banner
  detail: string;                  // longer explanation
  command?: string;                // verbatim command awaiting confirmation, if any
  actions: Array<{
    label: string;
    kind: 'approve' | 'deny' | 'neutral';
    /** what we'd send to the tmux pane on click */
    send?: string;
  }>;
}

export interface Agent {
  id: string;
  name: string;
  /** which Office character represents this agent on the floor */
  character: OfficeCharacterName;
  accent: AccentColorName;
  /** persistent short context — what is this agent for (shown on the floor) */
  description: string;
  project: string;
  /** legacy field — populated only for the seeded mock agents */
  tmuxTarget: string;
  cwd: string;
  goal?: string;
  /** User-authored private note shown and edited from the roster-card hover. */
  note?: string;
  status: StatusKind;
  action: string;
  progress: number;
  currentStation?: StationKind;
  carrying?: ToolKind;
  /** latest assistant message, streamed character-by-character in the sidebar */
  recentAssistantText?: string;
  /** epoch ms — used to drive the typewriter so identical strings still re-stream */
  recentTextTs?: number;
  /** populated when status === 'blocked' */
  blockReason?: BlockReason;
  /** present iff this agent has a real PTY in the main process */
  ptyId?: string;
  /** Incremented by Restart & Continue to remount this agent's xterm without
   * changing its durable PTY/session identity. */
  terminalGeneration?: number;
  /** the command being run in the PTY (e.g. 'claude' or 'agy') */
  command?: string;
  /** which agent CLI preset owns this PTY recipe; drives the model picker +
   *  spawn flags. Defaults to 'claude' when unset (legacy agents / inferred
   *  from command). */
  provider?: AgentProvider;
  /** the model this agent runs on (e.g. 'claude-sonnet-4-6[1m]' or 'gemini-3-pro');
   *  drives the model selector + the --model arg used when (re)spawning the agent */
  model?: string;
  /** the last prompt the user submitted to this agent in Claude Code —
   *  shown on the floor as a card above the seated avatar */
  lastPrompt?: string;
  /** the orchestrator ("god") agent — seated in Michael's room, runs the floor */
  isGod?: boolean;
  /** Michael's prep assistant — send-only; enriches prompts and forwards them to
   *  the god. Excluded from broadcast fan-out and from the restorable-dead sweep. */
  isAssistant?: boolean;
  /** When git isolation is enabled, the dedicated worktree path the agent runs
   *  in (its own `agent/<id>` branch); undefined for shared-cwd agents. */
  worktreePath?: string;
  /** Live context size of the agent's Claude session (tokens), polled from its
   *  transcript. Drives the context gauge on the agent card. */
  contextTokens?: number;
  /** The context-window limit assumed for this agent's model (tokens). */
  contextLimit?: number;
  /** True once this agent's terminal was closed. Archived agents are retained
   *  (in the store's `archivedAgents` list + the hive registry) but flagged and
   *  kept off the floor; only live-PTY agents are 'active'. */
  archived?: boolean;
  /** Hive protocol to TYPE into this agent's TUI as its first turn, set at spawn
   *  for `seedDelivery:'type-into-tui'` providers (Crush) whose bare TUI rejects a
   *  positional seed. useHive types it once after boot-grace then clears it.
   *  Ephemeral spawn state — not persisted. (ondev-b) */
  seedPrompt?: string;
}

export interface FeedEntry {
  agentId: string;
  text: string;
  ts: number;
}

/** A message the user has parked for an agent while its terminal was busy.
 *  Queued messages are drained one at a time when the agent next goes idle (see
 *  useHive's flush loop). */
export interface QueuedMessage {
  id: string;
  text: string;
  /** epoch ms the message was queued — drives ordering and the "queued 2m ago" hint */
  ts: number;
  /** Slack-originated: thread coordinates so the office can reply in-thread. */
  slack?: { channel: string; thread_ts: string };
  /** Optional override for the text actually typed into the agent's PTY. When set,
   *  the drain submits THIS instead of `text`, while UI/card surfaces keep using
   *  `text`. Used by Slack-origin work to carry the autonomy preamble to god's
   *  prompt without polluting the human-readable kanban card title (= raw `text`). */
  instruction?: string;
  /** User clicked "send now" while floor-wide auto-delivery was paused. Bypasses
   *  ONLY the pause gate in the drain loop — idle/draft/picker safety still hold,
   *  so it delivers the moment the terminal is actually free. */
  manual?: boolean;
}

// 'files' retired in v0.3.4 (the per-agent IDE button superseded it) — a
// persisted 'files' selection falls back to 'terminal' on load. 'git' added in
// v0.3.4: at-a-glance branch/status/log without opening the IDE.
export type SidebarTab = 'terminal' | 'messages' | 'traces' | 'git';

/** Lifecycle of the god agent ("Michael") bootstrap on launch.
 *  'booting' until his PTY is confirmed live, then 'ready' (or 'failed' if the
 *  spawn errored). The empty-floor UI shows a loader while 'booting' so users
 *  don't see the "add agent" prompt before Michael has clocked in. */
export type GodStatus = 'booting' | 'ready' | 'failed';

interface State {
  agents: Agent[];
  /** Agents whose terminal was closed — retained + flagged, kept off the active
   *  roster/floor. The hive registry retains them durably; this mirrors them for
   *  the renderer's "Archived" view. */
  archivedAgents: Agent[];
  /** Workers from the previous session whose terminal died with the app (quit /
   *  crash). Kept with their full spawn recipe (id, cwd, model, command) so the
   *  user can one-click respawn them with the SAME agent id — memory, inbox and
   *  registry entry reattach by themselves. God/assistant are excluded (they
   *  auto-respawn). */
  restorableAgents: Agent[];
  selectedId: string | null;
  feeds: Record<string, string[]>;
  addAgentOpen: boolean;
  fullscreenAgentId: string | null;
  fullscreenFilePath: string | null;
  /** How the fullscreen file overlay renders (v0.3.4): raw editor or rendered
   *  markdown preview. Preview is the default when opened from a terminal link. */
  fullscreenFileView: 'edit' | 'preview';
  /** Absolute path queued for the IDE to open on next mount ("open in IDE"
   *  escalation from the file overlay). Consumed-and-cleared by IdePanel. */
  ideInitialFile: string | null;
  /** Whether the full-window IDE panel (file manager + Monaco editor + git diff)
   *  is open. Toggled from the title-bar IDE button; a global feature surface,
   *  independent of the per-agent sidebar Files/Git tabs. */
  ideOpen: boolean;
  /** WHICH agent the IDE was opened FOR — set by whoever opens it.
   *
   *  The IDE used to infer its workspace purely from `selectedId`, which is a
   *  guess that is usually right and occasionally wrong: `setFullscreen` puts an
   *  agent's terminal on screen WITHOUT selecting it, so hitting IDE from a
   *  fullscreen terminal could open a different agent's directory than the one
   *  being looked at. That was invisible while the title said only "IDE" and the
   *  folder name; it becomes a flatly wrong agent NAME once the title names one.
   *  Callers therefore state their intent, and `selectedId` stays as the
   *  fallback for anything that genuinely has no particular agent in mind. */
  ideAgentId: string | null;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  godStatus: GodStatus;
  /** Per-agent outgoing message queue (agent id → messages awaiting delivery).
   *  Lets the user keep "talking" to a busy agent: messages park here and are
   *  drained to the terminal one-by-one once the agent is free. */
  messageQueues: Record<string, QueuedMessage[]>;
  /** Per-agent tool-call count this session — a lightweight activity/usage proxy
   *  shown in the command center (interactive sessions don't expose billed $). */
  toolCounts: Record<string, number>;
  bumpToolCount: (id: string) => void;
  setGodStatus: (status: GodStatus) => void;
  select: (id: string) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  setAgentNote: (id: string, note: string) => void;
  pushFeed: (id: string, line: string) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  /** Archive an agent (its terminal was closed): move it from the active roster
   *  into `archivedAgents` with its PTY cleared. Retained + flagged, NOT deleted. */
  archiveAgent: (id: string) => void;
  /** Permanently forget an archived agent (drops the renderer entry only; the
   *  hive registry keeps its record). */
  removeArchivedAgent: (id: string) => void;
  /** Drop one agent from the restorable list (it was respawned or dismissed). */
  removeRestorableAgent: (id: string) => void;
  reorderAgents: (fromId: string, toId: string) => void; // move agent fromId into toId's slot (AgentStrip drag-reorder) and persist the new order
  /** One-shot request to open a Command-Center tab (e.g. clicking the office
   *  task board → 'tasks'). `seq` makes repeated identical requests distinct. */
  ccTabRequest: { tab: string; seq: number } | null;
  requestCommandCenterTab: (tab: string) => void;
  /** The task whose detail overlay is open (rendered app-wide over the office
   *  floor — the card content grows: contracts, deps, the human Q&A trail). */
  taskDetailId: string | null;
  openTaskDetail: (id: string) => void;
  closeTaskDetail: () => void;
  /** One-shot prefill for the Command Center's dispatch box (a task detail's
   *  "assign" from anywhere in the app). seq-keyed like ccTabRequest. */
  dispatchSeedRequest: { text: string; seq: number } | null;
  requestDispatchSeed: (text: string) => void;
  /** Unsent ASK ME answer drafts, keyed by task id — so switching tabs (which
   *  unmounts the ask-me view) doesn't eat a half-typed answer. */
  answerDrafts: Record<string, string>;
  setAnswerDraft: (taskId: string, text: string) => void;
  /** Unsent composer drafts, per agent — so switching agents (which remounts the
   *  composer) doesn't eat what the user was typing. */
  drafts: Record<string, string>;
  setDraft: (agentId: string, text: string) => void;
  /** Mirror of config.freeflowEnabled so the composer can show/hide the Free Flow
   *  mic button reactively (set by App on config load and by Settings on save). */
  freeflowEnabled: boolean;
  setFreeflowEnabled: (on: boolean) => void;
  /** Mirror of `!!config.groqApiKey` — boolean presence ONLY; the key value never
   *  enters the store. Lets the composer show the voice button disabled (with a
   *  "add a Groq key" tooltip) instead of hiding it. Set by App on config load and
   *  by Settings on save. */
  hasGroqKey: boolean;
  setHasGroqKey: (has: boolean) => void;
  /** Mirror of BYOK OpenAI key presence (boolean only — the key lives in the main
   *  secret broker, never the store). Gates the Realtime Michael voice toggle the
   *  way hasGroqKey gates the Free Flow mic. Set by App on load via
   *  window.cth.realtimeHasOpenAiKey(). */
  hasOpenAiKey: boolean;
  setHasOpenAiKey: (has: boolean) => void;
  /** Mirror of the active office theme (set by App on config load + by Settings
   *  on switch). OfficeFloor depends on this and rebuilds the scene on change. */
  officeTheme: ThemeId;
  setOfficeTheme: (theme: ThemeId) => void;
  /** Mirror of config.webhookTriggers — the inbound HTTP endpoints. Webhooks are
   *  editable from BOTH Settings → Connections and the Triggers tab, so neither
   *  surface keeps its own copy: both render off this list and both call the
   *  setter after persisting, and the other one repaints without a refetch.
   *  Seeded by App from getConfig() (main deep-fills the field on every read).
   *
   *  Holds per-endpoint secrets, because a secret is what the UI has to show for
   *  reveal/copy to mean anything. Renderer memory only — never persisted to
   *  localStorage or the roster file, never logged, masked in every surface. */
  webhookTriggers: WebhookTrigger[];
  setWebhookTriggers: (list: WebhookTrigger[]) => void;
  /** Mirror of config.orgTrigger (peer messaging between teammates' clone nodes).
   *  Same two-way contract as `webhookTriggers`, and the same handling for
   *  `apiKey` — in memory for the two surfaces that display it masked, nowhere
   *  else. Configuration only for now: no transport reads the key yet. */
  orgTrigger: OrgTriggerConfig;
  setOrgTrigger: (cfg: OrgTriggerConfig) => void;
  /** Park a message for an agent. Returns nothing; the flush loop delivers it.
   *  `meta.instruction`, when set, is what gets typed into the PTY instead of
   *  `text` (UI/card surfaces still show `text`). */
  enqueueMessage: (agentId: string, text: string, meta?: { slack?: { channel: string; thread_ts: string }; instruction?: string }) => void;
  /** Drop a single queued message (user removed it, or it was just delivered). */
  removeQueuedMessage: (agentId: string, messageId: string) => void;
  /** "Send now" while floor auto-delivery is paused: marks the message manual
   *  (drain bypasses the pause gate for it) and moves it to the queue front. */
  releaseQueuedMessage: (agentId: string, messageId: string) => void;
  /** Clear an agent's entire pending queue. */
  clearQueue: (agentId: string) => void;
  setAddAgentOpen: (open: boolean) => void;
  /** A validated hire manifest waiting to pre-fill the Add-Agent modal. */
  pendingHire: HireManifest | null;
  setPendingHire: (m: HireManifest | null) => void;
  setFullscreen: (id: string | null) => void;
  setFullscreenFile: (path: string | null, view?: 'edit' | 'preview') => void;
  /** Open/close the IDE. `agentId` names the agent whose workspace it should
   *  show; omit it only when the caller truly has no specific agent (the IDE
   *  then falls back to the selection and says so in its title). */
  setIdeOpen: (open: boolean, agentId?: string | null) => void;
  setIdeInitialFile: (path: string | null) => void;
  setSidebarWidth: (px: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** Drop persisted agents whose PTY is no longer alive in the main process.
   *  Called once at startup so a renderer reload (e.g. after the laptop sleeps)
   *  restores still-running agents and only removes truly-dead ones. */
  reconcileWithLivePtys: (livePtyIds: string[]) => void;
}

const LS_SIDEBAR_WIDTH = 'cth.sidebarWidth';
const LS_SIDEBAR_TAB = 'cth.sidebarTab';
const LS_AGENTS = 'cth.agents';
const LS_ARCHIVED = 'cth.archivedAgents';
const LS_RESTORABLE = 'cth.restorableAgents';
const LS_SELECTED = 'cth.selectedId';
const LS_QUEUES = 'cth.messageQueues';

// Fields that are large or transient — not worth persisting across reloads.
// contextTokens/contextLimit describe a LIVE session; persisting them showed a
// dead session's context gauge after a restart until the poll caught up.
type PersistedAgent = Omit<Agent, 'recentAssistantText' | 'recentTextTs' | 'blockReason' | 'contextTokens' | 'contextLimit' | 'seedPrompt'>;

// ─── The roster mirror ──────────────────────────────────────────────────────
//
// localStorage is partitioned by ORIGIN, and the two ways this app runs do not
// share one: `npm run dev` serves the renderer from http://localhost:5173, a
// packaged build loads it from file://. So the roster — agents, their private
// notes, worktree paths, archived entries, parked queues — was invisible to
// whichever of the two you were not currently in, even though the hive on disk
// (sessions, memory, inboxes, tasks) was shared and intact the whole time.
//
// So we also mirror it to <harnessHome>/roster.json, which both sides reach by
// path. localStorage keeps being written byte-for-byte as before: it is the
// fallback when there is no file yet, and a standing backup afterwards. Main
// keeps every previous version of the file under roster-backups/.
const fileRoster = (() => {
  try { return window.cth?.rosterReadSync?.() ?? null; } catch { return null; }
})();

/** Prefer the shared file, but only when it actually holds a roster. An empty
 *  file must never win over a populated localStorage — that is exactly the
 *  "opened the build once and my floor went blank" failure this is here to
 *  prevent. A genuine delete-all clears both stores, so nothing resurrects. */
const useFileRoster = !!fileRoster
  && fileRoster.agents.length + fileRoster.archived.length + fileRoster.restorable.length > 0;

/** The renderer's running copy of what should be on disk. Kept as a mutable
 *  mirror updated slice-by-slice rather than read back out of the store, because
 *  every persist* call happens INSIDE a zustand `set()` — `getState()` there
 *  still returns the pre-update state, so a snapshot built that way would
 *  reliably be one edit stale. */
const rosterMirror: {
  agents: PersistedAgent[];
  archived: PersistedAgent[];
  restorable: PersistedAgent[];
  queues: Record<string, QueuedMessage[]>;
  selectedId: string | null;
} = { agents: [], archived: [], restorable: [], queues: {}, selectedId: null };

let rosterFlush: ReturnType<typeof setTimeout> | null = null;

function flushRosterNow(): void {
  if (rosterFlush) { clearTimeout(rosterFlush); rosterFlush = null; }
  try {
    void window.cth?.rosterWrite?.({
      version: 1,
      savedAt: new Date().toISOString(),
      agents: rosterMirror.agents,
      archived: rosterMirror.archived,
      restorable: rosterMirror.restorable,
      queues: rosterMirror.queues,
      selectedId: rosterMirror.selectedId
    });
  } catch { /* the file is a mirror — localStorage already took the write */ }
}

/** Coalesce a burst of persist* calls into one disk write. Agent edits arrive in
 *  clusters (spawn writes agents + selection + queues in the same tick). */
function scheduleRosterFlush(): void {
  if (rosterFlush) return;
  rosterFlush = setTimeout(flushRosterNow, 500);
}

// Don't let a quit inside the debounce window drop the last edit. localStorage
// would still have it, but only for THIS origin — and the whole point is that
// the other origin can read it too.
try {
  window.addEventListener('beforeunload', flushRosterNow);
} catch { /* not a browser context (unit tests) */ }

function slimAgents(agents: Agent[]): PersistedAgent[] {
  return agents.map(({ recentAssistantText, recentTextTs, blockReason, contextTokens, contextLimit, seedPrompt, ...rest }) => {
    void recentAssistantText; void recentTextTs; void blockReason; void contextTokens; void contextLimit; void seedPrompt;
    return rest;
  });
}

function persistAgents(agents: Agent[], selectedId: string | null): void {
  const slim = slimAgents(agents);
  try {
    window.localStorage.setItem(LS_AGENTS, JSON.stringify(slim));
    window.localStorage.setItem(LS_SELECTED, selectedId ?? '');
  } catch { /* noop */ }
  rosterMirror.agents = slim;
  rosterMirror.selectedId = selectedId;
  scheduleRosterFlush();
}

/** Run-state an agent recomputes from its live pty on every reload. A patch made
 *  only of these is not worth a localStorage write; anything else is. Listed as
 *  the volatile set rather than the durable set on purpose — a new durable field
 *  then persists by default instead of being silently dropped. */
const VOLATILE_AGENT_FIELDS = new Set<keyof Agent>([
  'status', 'action', 'progress', 'currentStation', 'carrying',
  'recentAssistantText', 'recentTextTs', 'blockReason',
  'contextTokens', 'contextLimit', 'lastPrompt'
]);

function touchesDurableAgentField(patch: Partial<Agent>): boolean {
  return Object.keys(patch).some((k) => !VOLATILE_AGENT_FIELDS.has(k as keyof Agent));
}

/** The persisted list for one slice: the shared file when it has a roster,
 *  otherwise this origin's localStorage. Returns [] on anything malformed. */
function persistedSlice(
  key: string,
  fromFile: unknown[] | undefined
): PersistedAgent[] {
  if (useFileRoster) return Array.isArray(fromFile) ? (fromFile as PersistedAgent[]) : [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PersistedAgent[]) : [];
  } catch {
    return [];
  }
}

function loadPersistedAgents(): Agent[] {
  try {
    const parsed = persistedSlice(LS_AGENTS, fileRoster?.agents);
    if (!parsed.length) return [];
    // Reset volatile run-state; the PTY stream / mock loop will repopulate it.
    return parsed.map((a) => ({
      ...a,
      progress: 0,
      status: 'idle',
      action: 'reconnecting…',
      currentStation: 'desk',
      carrying: undefined,
      recentTextTs: Date.now(),
    }));
  } catch {
    return [];
  }
}

function persistArchived(archived: Agent[]): void {
  const slim = slimAgents(archived);
  try {
    window.localStorage.setItem(LS_ARCHIVED, JSON.stringify(slim));
  } catch { /* noop */ }
  rosterMirror.archived = slim;
  scheduleRosterFlush();
}

function loadPersistedArchived(): Agent[] {
  try {
    const parsed = persistedSlice(LS_ARCHIVED, fileRoster?.archived);
    if (!parsed.length) return [];
    // Archived agents have no live process — force the flag + clear run-state.
    return parsed.map((a) => ({
      ...a,
      archived: true,
      status: 'idle',
      ptyId: undefined,
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

function persistRestorable(restorable: Agent[]): void {
  // Keeps contextTokens/contextLimit, unlike the other two: a restorable entry
  // is a spawn recipe for a session that has not been re-entered yet, so its
  // last known context size is still meaningful.
  const slim: PersistedAgent[] = restorable.map(({ recentAssistantText, recentTextTs, blockReason, seedPrompt, ...rest }) => {
    void recentAssistantText; void recentTextTs; void blockReason; void seedPrompt;
    return rest;
  });
  try {
    window.localStorage.setItem(LS_RESTORABLE, JSON.stringify(slim));
  } catch { /* noop */ }
  rosterMirror.restorable = slim;
  scheduleRosterFlush();
}

function loadPersistedRestorable(): Agent[] {
  try {
    const parsed = persistedSlice(LS_RESTORABLE, fileRoster?.restorable);
    if (!parsed.length) return [];
    // No live process — clear run-state; the spawn recipe fields are what matter.
    return parsed.map((a) => ({
      ...a,
      status: 'idle',
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

function persistQueues(queues: Record<string, QueuedMessage[]>): void {
  try {
    // Only keep non-empty queues so the key stays small.
    const slim: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(queues)) if (q.length) slim[id] = q;
    window.localStorage.setItem(LS_QUEUES, JSON.stringify(slim));
    rosterMirror.queues = slim;
    scheduleRosterFlush();
  } catch { /* noop */ }
}

function loadPersistedQueues(): Record<string, QueuedMessage[]> {
  try {
    const parsed = useFileRoster
      ? (fileRoster?.queues as Record<string, QueuedMessage[]> | undefined)
      : JSON.parse(window.localStorage.getItem(LS_QUEUES) ?? 'null') as Record<string, QueuedMessage[]> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    // Defensively keep only well-formed entries.
    const out: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(parsed)) {
      if (Array.isArray(q)) {
        out[id] = q.filter((m) => m && typeof m.text === 'string' && typeof m.id === 'string');
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadPersistedSelectedId(agents: Agent[]): string | null {
  try {
    const id = useFileRoster ? fileRoster?.selectedId : window.localStorage.getItem(LS_SELECTED);
    return id && agents.some((a) => a.id === id) ? id : (agents[0]?.id ?? null);
  } catch {
    return agents[0]?.id ?? null;
  }
}
const initialSidebarWidth = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_WIDTH);
    const n = v ? parseInt(v, 10) : NaN;
    if (!Number.isNaN(n) && n >= 320 && n <= 1200) return n;
  } catch { /* noop */ }
  return 420;
})();
const initialSidebarTab: SidebarTab = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_TAB);
    if (v === 'terminal' || v === 'messages' || v === 'traces' || v === 'git') return v;
  } catch { /* noop */ }
  return 'terminal';
})();

const initialAgents = loadPersistedAgents();
const initialArchivedAgents = loadPersistedArchived();
const initialRestorableAgents = loadPersistedRestorable();
const initialSelectedId = loadPersistedSelectedId(initialAgents);
const initialQueues = loadPersistedQueues();

// Prime the mirror with whatever we just loaded, so a later persist of ONE slice
// writes a complete file rather than blanking the slices it didn't touch.
rosterMirror.agents = slimAgents(initialAgents);
rosterMirror.archived = slimAgents(initialArchivedAgents);
rosterMirror.restorable = slimAgents(initialRestorableAgents);
rosterMirror.queues = initialQueues;
rosterMirror.selectedId = initialSelectedId;

// First run with the file: seed it from this origin's localStorage. Only when
// there is something to seed — writing an empty file here would hand a blank
// roster to the other side, which is precisely the outcome being designed out.
if (!useFileRoster && rosterMirror.agents.length + rosterMirror.archived.length + rosterMirror.restorable.length > 0) {
  scheduleRosterFlush();
}

let queuedSeq = 0;
/** Process-unique id for a queued message (timestamp + counter avoids collisions
 *  when several are queued within the same millisecond). */
function newQueuedId(): string {
  queuedSeq += 1;
  return `q-${Date.now()}-${queuedSeq}`;
}

export const useStore = create<State>((set) => ({
  agents: initialAgents,
  archivedAgents: initialArchivedAgents,
  restorableAgents: initialRestorableAgents,
  selectedId: initialSelectedId,
  feeds: {},
  addAgentOpen: false,
  ccTabRequest: null,
  requestCommandCenterTab: (tab) =>
    set((s) => ({ ccTabRequest: { tab, seq: (s.ccTabRequest?.seq ?? 0) + 1 } })),
  fullscreenAgentId: null,
  fullscreenFilePath: null,
  fullscreenFileView: 'edit',
  ideInitialFile: null,
  ideOpen: false,
  ideAgentId: null,
  sidebarWidth: initialSidebarWidth,
  sidebarTab: initialSidebarTab,
  godStatus: 'booting',
  messageQueues: initialQueues,
  toolCounts: {},
  bumpToolCount: (id) =>
    set((s) => ({ toolCounts: { ...s.toolCounts, [id]: (s.toolCounts[id] ?? 0) + 1 } })),
  setGodStatus: (status) => set({ godStatus: status }),
  select: (id) => set((s) => { persistAgents(s.agents, id); return { selectedId: id, ccTabRequest: null }; }),
  updateAgent: (id, patch) =>
    set((s) => {
      const agents = s.agents.map(a => a.id === id ? { ...a, ...patch } : a);
      // Persist only when something DURABLE changed. `updateAgent` is also the
      // pty parser's per-chunk write (status/action/progress), so persisting
      // unconditionally would rewrite localStorage on every burst of terminal
      // output. Persisting nothing was worse: a model or command change lived
      // only in memory, so the selector snapped back to the old model on reload
      // and restore relaunched the old command.
      if (touchesDurableAgentField(patch)) persistAgents(agents, s.selectedId);
      return { agents };
    }),
  setAgentNote: (id, note) =>
    set((s) => {
      const agents = s.agents.map((a) => a.id === id ? { ...a, note } : a);
      persistAgents(agents, s.selectedId);
      return { agents };
    }),
  pushFeed: (id, line) =>
    set((s) => {
      const arr = [...(s.feeds[id] ?? []), line];
      return { feeds: { ...s.feeds, [id]: arr.slice(-500) } };
    }),
  addAgent: (agent) =>
    set((s) => {
      // Idempotent by id: a MAIN-initiated spawn broadcast (hive:agentSpawned, e.g.
      // a voice hire) and a renderer-initiated hire (AddAgentModal) can both call
      // addAgent for the same id — never render a duplicate card. The first writer
      // (richer local record) wins; the broadcast is a no-op for it.
      if (s.agents.some((a) => a.id === agent.id)) return s;
      // GOD enters at the HEAD, everyone else at the tail. Michael's position was
      // otherwise decided by a race he usually lost: useHive's bootstrap removes
      // the restored god entry, then spawns him asynchronously (a setTimeout, a
      // listPtys round-trip, and a --resume that seeds a transcript first), while
      // useRestoreTeam respawns last session's workers in parallel. Whoever
      // resolved first landed first, so a session with workers to restore put the
      // BOSS card fourth — and persistAgents() then wrote that order to disk, so
      // it stuck across restarts instead of flickering once.
      //
      // Fixed at insertion rather than by sorting in AgentStrip: the strip has
      // drag-reorder (reorderAgents) whose whole point is a persisted manual
      // order, and a god-first sort at render time would silently override the
      // user's own arrangement every frame. This just makes the head the honest
      // default; a deliberate drag still wins and still persists.
      const agents = agent.isGod ? [agent, ...s.agents] : [...s.agents, agent];
      // Re-spawning an archived agent un-archives it: an id is active xor archived.
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== agent.id);
      // A live (re)spawn also consumes any restorable entry for the same id.
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== agent.id);
      persistAgents(agents, agent.id);
      persistArchived(archivedAgents);
      if (restorableAgents.length !== s.restorableAgents.length) persistRestorable(restorableAgents);
      return {
        agents,
        archivedAgents,
        restorableAgents,
        selectedId: agent.id,
        feeds: { ...s.feeds, [agent.id]: s.feeds[agent.id] ?? [] }
      };
    }),
  removeAgent: (id) =>
    set((s) => {
      const agents = s.agents.filter(a => a.id !== id);
      const { [id]: _gone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      persistAgents(agents, selectedId);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, feeds, selectedId, messageQueues };
    }),
  archiveAgent: (id) =>
    set((s) => {
      const target = s.agents.find((a) => a.id === id);
      if (!target) return s;
      const agents = s.agents.filter((a) => a.id !== id);
      // Retain a flagged copy; the PTY is gone, so clear all live run-state.
      const archivedEntry: Agent = {
        ...target,
        archived: true,
        ptyId: undefined,
        status: 'idle',
        action: 'archived',
        carrying: undefined,
        currentStation: undefined
      };
      const archivedAgents = [...s.archivedAgents.filter((a) => a.id !== id), archivedEntry];
      const { [id]: _feedGone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      persistAgents(agents, selectedId);
      persistArchived(archivedAgents);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, archivedAgents, feeds, selectedId, messageQueues };
    }),
  removeArchivedAgent: (id) =>
    set((s) => {
      if (!s.archivedAgents.some((a) => a.id === id)) return s;
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== id);
      persistArchived(archivedAgents);
      return { archivedAgents };
    }),
  removeRestorableAgent: (id) =>
    set((s) => {
      if (!s.restorableAgents.some((a) => a.id === id)) return s;
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== id);
      persistRestorable(restorableAgents);
      return { restorableAgents };
    }),
  reorderAgents: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return s;
      const from = s.agents.findIndex((a) => a.id === fromId);
      const to = s.agents.findIndex((a) => a.id === toId);
      if (from === -1 || to === -1) return s;
      const agents = [...s.agents];
      const [moved] = agents.splice(from, 1);
      agents.splice(to, 0, moved);
      // Persist the new roster order so it survives a reload (same slim key the
      // rest of the roster uses). selectedId is unchanged by a reorder.
      persistAgents(agents, s.selectedId);
      return { agents };
    }),
  taskDetailId: null,
  openTaskDetail: (id) => set({ taskDetailId: id }),
  closeTaskDetail: () => set({ taskDetailId: null }),
  dispatchSeedRequest: null,
  requestDispatchSeed: (text) =>
    set((s) => ({ dispatchSeedRequest: { text, seq: (s.dispatchSeedRequest?.seq ?? 0) + 1 } })),
  answerDrafts: {},
  setAnswerDraft: (taskId, text) =>
    set((s) => ({ answerDrafts: { ...s.answerDrafts, [taskId]: text } })),
  drafts: {},
  setDraft: (agentId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [agentId]: text } })),
  freeflowEnabled: false,
  setFreeflowEnabled: (on) => set({ freeflowEnabled: on }),
  hasGroqKey: false,
  setHasGroqKey: (has) => set({ hasGroqKey: has }),
  hasOpenAiKey: false,
  setHasOpenAiKey: (has) => set({ hasOpenAiKey: has }),
  officeTheme: 'office',
  setOfficeTheme: (theme) => set({ officeTheme: theme }),
  webhookTriggers: [],
  setWebhookTriggers: (list) => set({ webhookTriggers: list }),
  // A copy, not the shared DEFAULT_ORG_TRIGGER instance — main takes the same
  // care (withTriggerDefaults), and handing the module-level default out is how
  // one careless mutation rewrites the default for everyone.
  orgTrigger: { ...DEFAULT_ORG_TRIGGER },
  setOrgTrigger: (cfg) => set({ orgTrigger: cfg }),
  enqueueMessage: (agentId, text, meta) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
      // ONE PENDING COMPACT PER AGENT. Compaction is idempotent in the worst way:
      // the first `/compact` does the work and every one behind it answers
      // "nothing to compact", so a queue that accumulates them spends a delivery
      // slot and a model round-trip per copy to achieve nothing, and buries the
      // operator's real backlog behind them.
      //
      // The invariant lives HERE rather than at the call sites because there are
      // several — the context trigger, god dispatching a work order, Slack, the
      // composer — and each one that grew its own check could still be bypassed
      // by the next path someone adds. The context trigger's own check stays as
      // cheap defence in depth, but this is the one that cannot be routed around.
      const queued = s.messageQueues[agentId] ?? [];
      if (isCompactionCommand(trimmed) && queued.some((m) => isCompactionCommand(m.text))) {
        return s;
      }
      const msg: QueuedMessage = {
        id: newQueuedId(), text: trimmed, ts: Date.now(),
        ...(meta?.slack ? { slack: meta.slack } : {}),
        ...(meta?.instruction ? { instruction: meta.instruction } : {})
      };
      const messageQueues = { ...s.messageQueues, [agentId]: [...(s.messageQueues[agentId] ?? []), msg] };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  removeQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      if (!current) return s;
      const next = current.filter((m) => m.id !== messageId);
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  releaseQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      const target = current?.find((m) => m.id === messageId);
      if (!current || !target) return s;
      const next = [
        { ...target, manual: true },
        ...current.filter((m) => m.id !== messageId)
      ];
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  clearQueue: (agentId) =>
    set((s) => {
      if (!s.messageQueues[agentId]?.length) return s;
      const messageQueues = { ...s.messageQueues, [agentId]: [] };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  reconcileWithLivePtys: (livePtyIds) =>
    set((s) => {
      const live = new Set(livePtyIds);
      // Keep agents with no PTY (synthetic) or whose PTY is still alive.
      const agents = s.agents.filter((a) => !a.ptyId || live.has(a.ptyId));
      if (agents.length === s.agents.length) return s;
      // Workers whose terminal died with the previous session become restorable
      // (full spawn recipe retained) instead of silently vanishing. God and the
      // prep assistant are excluded — they auto-respawn at boot.
      const dead = s.agents.filter(
        (a) => a.ptyId && !live.has(a.ptyId) && !a.isGod && !a.isAssistant
      );
      const restorableAgents = [
        ...s.restorableAgents.filter((r) => !dead.some((d) => d.id === r.id)),
        ...dead
      ];
      const feeds: Record<string, string[]> = {};
      for (const a of agents) feeds[a.id] = s.feeds[a.id] ?? [];
      const selectedId = agents.some((a) => a.id === s.selectedId)
        ? s.selectedId
        : (agents[0]?.id ?? null);
      persistAgents(agents, selectedId);
      persistRestorable(restorableAgents);
      return { agents, feeds, selectedId, restorableAgents };
    }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  pendingHire: null,
  setPendingHire: (m) => set({ pendingHire: m }),
  setFullscreen: (id) => set({ fullscreenAgentId: id }),
  setFullscreenFile: (path, view) => set({ fullscreenFilePath: path, fullscreenFileView: view ?? 'edit' }),
  // Closing CLEARS the target: the id is scoped to one IDE session, and a stale
  // one left behind would silently win over the selection on the next open from
  // a caller that passes nothing.
  setIdeOpen: (open, agentId) => set({ ideOpen: open, ideAgentId: open ? (agentId ?? null) : null }),
  setIdeInitialFile: (path) => set({ ideInitialFile: path }),
  setSidebarWidth: (px) => {
    const clamped = Math.min(1200, Math.max(320, Math.round(px)));
    try { window.localStorage.setItem(LS_SIDEBAR_WIDTH, String(clamped)); } catch { /* noop */ }
    set({ sidebarWidth: clamped });
  },
  setSidebarTab: (tab) => {
    try { window.localStorage.setItem(LS_SIDEBAR_TAB, tab); } catch { /* noop */ }
    set({ sidebarTab: tab });
  }
}));

export function selectedAgent(s: State): Agent | undefined {
  return s.agents.find(a => a.id === s.selectedId);
}

/** Whether the Command Center's Trigger History tab has anything to be about
 *  yet: an organisation key is set, or at least one webhook exists. Derived from
 *  the two mirrors rather than stored beside them, so it cannot fall out of step
 *  with the thing it describes. Use as `useStore(triggerHistoryVisible)`. */
export function triggerHistoryVisible(s: State): boolean {
  return s.webhookTriggers.length > 0 || s.orgTrigger.apiKey.trim() !== '';
}
