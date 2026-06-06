import { create } from 'zustand';
import type { AccentColorName } from '@/design/tokens';
import type { OfficeCharacterName } from '@/scene/office/cast';
import type { StatusKind } from '@/components/PixelBadge';

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
  /** the command being run in the PTY (e.g. 'claude') */
  command?: string;
  /** the model this agent runs on (e.g. 'claude-sonnet-4-6[1m]'); drives the
   *  model selector + the --model arg used when (re)spawning the agent */
  model?: string;
  /** the last prompt the user submitted to this agent in Claude Code —
   *  shown on the floor as a card above the seated avatar */
  lastPrompt?: string;
  /** the orchestrator ("god") agent — seated in Michael's room, runs the floor */
  isGod?: boolean;
  /** Michael's prep assistant ("Dwight") — enriches prompts and forwards them to
   *  Michael via the hive. Send-only: never receives inbox/broadcast mail. */
  isAssistant?: boolean;
  /** When git isolation is enabled, the dedicated worktree path the agent runs
   *  in (its own `agent/<id>` branch); undefined for shared-cwd agents. */
  worktreePath?: string;
  /** True once this agent's terminal was closed. Archived agents are retained
   *  (in the store's `archivedAgents` list + the hive registry) but flagged and
   *  kept off the floor; only live-PTY agents are 'active'. */
  archived?: boolean;
}

export interface FeedEntry {
  agentId: string;
  text: string;
  ts: number;
}

/** A message the user has parked for an agent while its terminal was busy.
 *  Queued messages are drained one at a time when the agent next goes idle (see
 *  useHive's flush loop). For Michael's queue the enrich toggle decides whether
 *  each one is typed into Michael directly or routed through the assistant. */
export interface QueuedMessage {
  id: string;
  text: string;
  /** epoch ms the message was queued — drives ordering and the "queued 2m ago" hint */
  ts: number;
}

export type SidebarTab = 'terminal' | 'files' | 'messages';

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
  selectedId: string | null;
  feeds: Record<string, string[]>;
  addAgentOpen: boolean;
  fullscreenAgentId: string | null;
  fullscreenFilePath: string | null;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  godStatus: GodStatus;
  /** Per-agent outgoing message queue (agent id → messages awaiting delivery).
   *  Lets the user keep "talking" to a busy agent: messages park here and are
   *  drained to the terminal one-by-one once the agent is free. */
  messageQueues: Record<string, QueuedMessage[]>;
  /** Global toggle: when on, messages queued for Michael are routed through the
   *  assistant ("Dwight") to be enriched with context before reaching Michael;
   *  when off, they're typed straight into Michael. */
  enrichEnabled: boolean;
  setEnrichEnabled: (on: boolean) => void;
  /** Per-agent tool-call count this session — a lightweight activity/usage proxy
   *  shown in the command center (interactive sessions don't expose billed $). */
  toolCounts: Record<string, number>;
  bumpToolCount: (id: string) => void;
  setGodStatus: (status: GodStatus) => void;
  select: (id: string) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  pushFeed: (id: string, line: string) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  /** Archive an agent (its terminal was closed): move it from the active roster
   *  into `archivedAgents` with its PTY cleared. Retained + flagged, NOT deleted. */
  archiveAgent: (id: string) => void;
  /** Permanently forget an archived agent (drops the renderer entry only; the
   *  hive registry keeps its record). */
  removeArchivedAgent: (id: string) => void;
  /** Unsent composer drafts, per agent — so switching agents (which remounts
   *  the composer) doesn't eat what the user was typing. */
  drafts: Record<string, string>;
  setDraft: (agentId: string, text: string) => void;
  /** Park a message for an agent. Returns nothing; the flush loop delivers it. */
  enqueueMessage: (agentId: string, text: string) => void;
  /** Drop a single queued message (user removed it, or it was just delivered). */
  removeQueuedMessage: (agentId: string, messageId: string) => void;
  /** Clear an agent's entire pending queue. */
  clearQueue: (agentId: string) => void;
  setAddAgentOpen: (open: boolean) => void;
  setFullscreen: (id: string | null) => void;
  setFullscreenFile: (path: string | null) => void;
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
const LS_SELECTED = 'cth.selectedId';
const LS_QUEUES = 'cth.messageQueues';
const LS_ENRICH = 'cth.enrichEnabled';

// Fields that are large or transient — not worth persisting across reloads.
type PersistedAgent = Omit<Agent, 'recentAssistantText' | 'recentTextTs' | 'blockReason'>;

function persistAgents(agents: Agent[], selectedId: string | null): void {
  try {
    const slim: PersistedAgent[] = agents.map(({ recentAssistantText, recentTextTs, blockReason, ...rest }) => {
      void recentAssistantText; void recentTextTs; void blockReason;
      return rest;
    });
    window.localStorage.setItem(LS_AGENTS, JSON.stringify(slim));
    window.localStorage.setItem(LS_SELECTED, selectedId ?? '');
  } catch { /* noop */ }
}

function loadPersistedAgents(): Agent[] {
  try {
    const raw = window.localStorage.getItem(LS_AGENTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAgent[];
    if (!Array.isArray(parsed)) return [];
    // Reset volatile run-state; the PTY stream / mock loop will repopulate it.
    return parsed.map((a) => ({
      ...a,
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
  try {
    const slim: PersistedAgent[] = archived.map(({ recentAssistantText, recentTextTs, blockReason, ...rest }) => {
      void recentAssistantText; void recentTextTs; void blockReason;
      return rest;
    });
    window.localStorage.setItem(LS_ARCHIVED, JSON.stringify(slim));
  } catch { /* noop */ }
}

function loadPersistedArchived(): Agent[] {
  try {
    const raw = window.localStorage.getItem(LS_ARCHIVED);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAgent[];
    if (!Array.isArray(parsed)) return [];
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

function persistQueues(queues: Record<string, QueuedMessage[]>): void {
  try {
    // Only keep non-empty queues so the key stays small.
    const slim: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(queues)) if (q.length) slim[id] = q;
    window.localStorage.setItem(LS_QUEUES, JSON.stringify(slim));
  } catch { /* noop */ }
}

function loadPersistedQueues(): Record<string, QueuedMessage[]> {
  try {
    const raw = window.localStorage.getItem(LS_QUEUES);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, QueuedMessage[]>;
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
    const id = window.localStorage.getItem(LS_SELECTED);
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
    if (v === 'files' || v === 'terminal' || v === 'messages') return v;
  } catch { /* noop */ }
  return 'terminal';
})();

const initialAgents = loadPersistedAgents();
const initialArchivedAgents = loadPersistedArchived();
const initialSelectedId = loadPersistedSelectedId(initialAgents);
const initialQueues = loadPersistedQueues();
const initialEnrichEnabled: boolean = (() => {
  try { return window.localStorage.getItem(LS_ENRICH) === '1'; } catch { return false; }
})();

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
  selectedId: initialSelectedId,
  feeds: {},
  addAgentOpen: false,
  fullscreenAgentId: null,
  fullscreenFilePath: null,
  sidebarWidth: initialSidebarWidth,
  sidebarTab: initialSidebarTab,
  godStatus: 'booting',
  messageQueues: initialQueues,
  enrichEnabled: initialEnrichEnabled,
  setEnrichEnabled: (on) => {
    try { window.localStorage.setItem(LS_ENRICH, on ? '1' : '0'); } catch { /* noop */ }
    set({ enrichEnabled: on });
  },
  toolCounts: {},
  bumpToolCount: (id) =>
    set((s) => ({ toolCounts: { ...s.toolCounts, [id]: (s.toolCounts[id] ?? 0) + 1 } })),
  setGodStatus: (status) => set({ godStatus: status }),
  select: (id) => set((s) => { persistAgents(s.agents, id); return { selectedId: id }; }),
  updateAgent: (id, patch) =>
    set((s) => ({ agents: s.agents.map(a => a.id === id ? { ...a, ...patch } : a) })),
  pushFeed: (id, line) =>
    set((s) => ({ feeds: { ...s.feeds, [id]: [...(s.feeds[id] ?? []), line] } })),
  addAgent: (agent) =>
    set((s) => {
      const agents = [...s.agents, agent];
      // Re-spawning an archived agent un-archives it: an id is active xor archived.
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== agent.id);
      persistAgents(agents, agent.id);
      persistArchived(archivedAgents);
      return {
        agents,
        archivedAgents,
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
  drafts: {},
  setDraft: (agentId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [agentId]: text } })),
  enqueueMessage: (agentId, text) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
      const msg: QueuedMessage = { id: newQueuedId(), text: trimmed, ts: Date.now() };
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
      const feeds: Record<string, string[]> = {};
      for (const a of agents) feeds[a.id] = s.feeds[a.id] ?? [];
      const selectedId = agents.some((a) => a.id === s.selectedId)
        ? s.selectedId
        : (agents[0]?.id ?? null);
      persistAgents(agents, selectedId);
      return { agents, feeds, selectedId };
    }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  setFullscreen: (id) => set({ fullscreenAgentId: id }),
  setFullscreenFile: (path) => set({ fullscreenFilePath: path }),
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
