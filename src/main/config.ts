import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  autoModeFlagForProvider,
  defaultCommandForProvider,
  inferAgentProvider,
  providerPreset,
  type AgentProvider
} from '../shared/agentProvider';
import { defaultMcpDefaults } from '../shared/mcpCatalog';
import { MAX_AGENT_TOKEN_CAP } from '../shared/tokenCaps';
import { expandTilde, normalizeHiveHome } from './fs';
import type { IntegrationRecord } from '../shared/integrations';
import {
  DEFAULT_CONTEXT_TRIGGER,
  DEFAULT_ORG_TRIGGER,
  DEFAULT_TRIGGER_MODE,
  DEFAULT_WEBHOOK_SCHEMA,
  type ContextTriggerConfig,
  type OrgTriggerConfig,
  type WebhookTrigger
} from '../shared/triggers';

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  /** Day-of-week + time-of-day schedule. When present and valid this REPLACES
   *  `intervalMs` — an interval cannot say "weekday mornings", because it drifts
   *  against the clock and a 24h one started at 15:00 fires at 15:00 forever.
   *  `intervalMs` is deliberately left on the record so switching back restores
   *  the cadence the user had. See shared/weeklySchedule.ts. */
  weekly?: { days: number[]; minute: number };
  to: string;
  body: string;
  enabled: boolean;
  /** When true, the scheduler asks the renderer to compact live terminals when
   *  this mission fires — but only agents whose context has filled past the bar
   *  in `contextTrigger.compact` (60% by default, 40% on ~1M-token windows), so
   *  small/idle sessions are left alone instead of compacting on every tick.
   *
   *  This gate used to be described here but was never actually implemented: every
   *  live agent was compacted on every tick. It is real now, and the bars live in
   *  `ContextTriggerConfig` where the operator can edit them, so do not restate
   *  the numbers anywhere else — they will drift. */
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** Mission flavor. Absent ⇒ 'dispatch' (the classic interval-dispatch mission,
   *  e.g. the ops standup). 'heartbeat' (Lane A #1) is a context-aware beat: it
   *  observes live floor state, re-engages a quiet god, and ticks the circuit
   *  breaker — armed with an adaptive cadence, not a fixed setInterval. */
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** Heartbeat only: a floor is "quiet" when no tracked signal (log.jsonl mtime,
   *  inbox/outbox mtimes, any PTY output) has moved in this many ms. Default
   *  ~5 min. NOT derived from registry.status (which never transitions in main). */
  quietThresholdMs?: number;
}

/** The built-in hourly ops standup: god reviews who's doing what + whether tasks
 *  are on track and agents are running, and every terminal's context is compacted.
 *  Shipped enabled by default; users can toggle it off in the Command Center. */
export const OPS_STANDUP_MISSION: ScheduledMission = {
  id: 'ops-standup',
  label: 'Hourly ops standup',
  intervalMs: 3_600_000,
  to: 'god',
  body:
    'Hourly ops standup. Review every agent: who is doing what, and confirm each ' +
    'is still running (not stalled or idle-stale). Check the task board — are ' +
    'in-flight tasks on track, and is anything blocked or unowned? Flag stale ' +
    'agents and at-risk tasks, and keep the board accurate. (As part of this ' +
    "standup each working agent is asked to summarise its current task and the " +
    'next step, then compact and resume from the same point — so terminal ' +
    'contexts stay bounded without losing work. The compaction is queued and ' +
    'runs when an agent is idle, so it never interrupts work mid-step.)',
  enabled: true
  // NO autoCompact. Compaction belongs to contextTrigger.compact and nothing else.
  // This flag used to live here as well, which meant a default install asked for
  // compaction on TWO cadences — hourly from this standup and 2-hourly from the
  // trigger — the exact "two controls that disagree" the maint-1 retirement below
  // was written to end. The standup's own prose still describes compaction, and
  // that stays true: the trigger does it, just not on this mission's clock.
};

/** The built-in heartbeat (Lane A #1). A context-aware beat that, each tick,
 *  observes live floor state and — only when the floor has gone quiet — drops a
 *  digest into god's inbox and (if god's PTY is genuinely idle) nudges it to
 *  re-engage anyone stalled. The same beat ticks the circuit breaker.
 *
 *  Shipped DISABLED by default (opt-in): unlike the standup, which only sends a
 *  hive message, the heartbeat types into god's PTY, so the user turns it on
 *  explicitly in the Command Center once they want active re-engagement.
 *  `intervalMs` is the normal-cadence base; the scheduler derives a tighter beat
 *  when an agent looks stuck and a slower one right after a re-engage. */
export const HEARTBEAT_MISSION: ScheduledMission = {
  id: 'heartbeat',
  label: 'Floor heartbeat',
  intervalMs: 120_000,
  to: 'god',
  body:
    'Floor heartbeat: the team has gone quiet. Review the digest in your inbox, ' +
    're-engage anyone stalled or blocked, and keep the board accurate — or rest ' +
    'if the work is genuinely done.',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 300_000
};

/** The dedicated auto-compact MAINTENANCE schedule (maint-1). DECOUPLED from the
 *  ops standup so editing/replacing a standup can never silently disable
 *  compaction again (the bug this fixes). It fires ONLY the auto-compact signal —
 *  `kind:'compact'` makes syncMissions skip the hive.send dispatch (empty to/body).
 *  Shipped DISABLED (v0.3.4 founder decision): scheduled compaction is opt-in.
 *  Turn it on in Settings → General or the Schedules tab; the Schedules warning
 *  panel explains the risk of leaving it off for long-running agents. It is the
 *  SINGLE source of truth for compaction, and it's persistent: deleting it makes
 *  it reappear DISABLED.
 *  Existing installs keep whatever enabled state the user already has
 *  (compactMaintenanceSeeded guards re-seeding). */
export const COMPACT_MAINTENANCE_MISSION: ScheduledMission = {
  id: 'compact-maintenance',
  label: 'Auto-compact (maintenance)',
  // 2h, matching DEFAULT_CONTEXT_TRIGGER.compact.everyMs. The two cadences must
  // agree: this mission is the schedule half of the same behaviour the context
  // trigger now owns, and a 1h seed here would keep interrupting agents on the
  // old rhythm no matter what the trigger says.
  intervalMs: 7_200_000,
  to: '',
  body: '',
  enabled: false,
  autoCompact: true,
  kind: 'compact'
};

/** The 1h cadence `compact-maintenance` was seeded with before Triggers doubled
 *  it. `migrateTriggersV1` bumps only missions still sitting on this EXACT value,
 *  so an interval the user tuned by hand is left exactly where they put it. */
const LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS = 3_600_000;

/** Circuit-breaker thresholds (Lane A #6.6b). The breaker runs inside the
 *  heartbeat beat, so it only ticks when the heartbeat is enabled. Trip
 *  conditions are behavioral by default; `costCapUsd` is the only $-based one and
 *  is unset by default (a hardcoded dollar default would be arbitrary). Defaults
 *  are deliberately conservative and steer-first — `hardStop` is OFF unless the
 *  user opts in, so the breaker never auto-kills a healthy long-runner. */
export interface CircuitBreakerConfig {
  /** Master switch for breaker evaluation within the beat. Default true. */
  enabled?: boolean;
  /** Allow the top of the ladder (kill PTY + archive). Default false = the
   *  breaker may steer/constrain but never hard-stops until the user opts in. */
  hardStop?: boolean;
  /** Consecutive identical tool calls (same name+input) before tripping. */
  repeatedToolLimit?: number;
  /** Consecutive api_error / retry events before tripping. */
  errorStormLimit?: number;
  /** Output-token velocity (tokens/min, diffed across beats) before tripping. */
  tokenVelocityPerMin?: number;
}

/** Enterprise Knowledge Graph (multimodal context store + agent access tool).
 *  The user ingests their own documents/images/PDFs; agents query them on demand
 *  via the `kg` CLI. Opt-in like the heartbeat/Slack features — `enabled` gates
 *  everything (no env injected, no prompt line, no store touched when off). See
 *  docs/design/knowledge-graph.md. */
export interface KnowledgeGraphConfig {
  /** Master switch. Default false = zero behaviour change (the feature is dark). */
  enabled?: boolean;
  /** Override the store location. Unset = <userData>/knowledge. */
  rootPath?: string;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Self-identified audience picked on the first onboarding screen. Drives the
   *  copy register everywhere onboarding explains itself: 'technical' shows CLI /
   *  flag lingo, 'non-technical' explains each concept in plain language. Unset =
   *  not yet chosen (treated as technical for any incidental copy). */
  audience?: 'technical' | 'non-technical';
  /** Folder where the harness keeps its own state (agent metadata, logs). */
  harnessHome: string | null;
  /** Recently-opened hive home folders (most-recent first), surfaced by the
   *  launch-time hive picker. Maintained by writeConfig whenever harnessHome is
   *  set (onboarding finish, changeHome). Capped to a handful. */
  recentHives?: string[];
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, new agents are spawned with --permission-mode bypassPermissions. */
  autoMode: boolean;
  /** May the orchestrator ("Michael") spin up agents on its own?
   *
   *  Default FALSE. Spawning an agent is a SPEND decision, so it should not
   *  happen unprompted. The ability itself shipped in v0.4.4 with no gate at all,
   *  so this closes an existing default-on behaviour rather than gating a new
   *  feature: an operator who wants it must now say so.
   *
   *  Off does not FAIL a queued spawn request, it declines to consume one. The
   *  request sits in HIVE_ROOT/spawn-requests until the toggle is turned on. */
  orchestratorMaySpawn: boolean;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Which provider powers the GOD orchestrator ("Michael"). The persona is
   *  constant; only its engine is selectable. Default 'claude'. Eligible providers
   *  are those that can receive inbox (claude/codex/antigravity/qwen). */
  godProvider?: AgentProvider;
  /** The model GOD runs on. Unset falls back to the provider preset's
   *  `recommendedOrchestratorModel`, then MODEL_GOD. Default 'claude-opus-4-8'. */
  godModel?: string;
  /** Per-server consent state for the default MCP bundle, keyed by catalog id.
   *  Seeded from MCP_CATALOG (safe-readonly ON, write/secret OFF); the user flips
   *  these in Settings. A server is wired into an agent only when enabled here. */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  /** Enable semantic memory (MemPalace CLI). No-op if mempalace isn't installed. */
  semanticMemory: boolean;
  /** Embedding model for the palace: lightweight 'minilm' or multilingual 'embeddinggemma'. */
  embeddingModel: 'minilm' | 'embeddinggemma';
  /** Recurring auto-dispatch missions handled by the scheduler. */
  missions?: ScheduledMission[];
  /** One-time guard: has the built-in hourly ops standup been seeded into an
   *  existing install's missions? Prevents re-adding it after a user deletes it. */
  opsStandupSeeded?: boolean;
  /** One-time guard for the built-in heartbeat mission (mirrors opsStandupSeeded
   *  so a user who deletes the heartbeat doesn't get it re-added every boot). */
  heartbeatSeeded?: boolean;
  /** maint-1 guard for the dedicated auto-compact maintenance mission. UNLIKE the
   *  two above, this does NOT suppress re-add forever: once seeded (flag set), a
   *  later delete makes the mission reappear DISABLED on next boot (compaction is
   *  required, so it's never silently lost — only user-disabled). */
  compactMaintenanceSeeded?: boolean;
  /** DEPRECATED (v0.3.4): config-file only, no UI anywhere. Hard dollar ceiling
   *  across all active agents. Still enforced if present so legacy configs keep
   *  their guard, but the token cap (costCapTokens) is the real budget —
   *  scheduled for removal next release. */
  costCapUsd?: number;
  /** Hard TOKEN ceiling (total tokens across all active agents) before the
   *  breaker trips. The user-facing budget — set in Settings. Opt-in like the
   *  $-cap; total = input + output + cacheRead + cacheCreation, summed across the
   *  floor (the biggest token spender is blamed). */
  costCapTokens?: number;
  /** Per-agent total-token ceiling, keyed by agent id. When an agent's own total
   *  tokens exceed its cap the breaker trips that agent alone (independent of the
   *  floor budget). Set from each agent's card in the Command Center. */
  agentTokenCaps?: Record<string, number>;
  /** Agent ids whose automatic inbox/queue delivery is paused. Pending messages
   *  stay durable until the operator explicitly resumes delivery. */
  autoDeliveryPausedAgents?: string[];
  /** Passed to every spawned agent as `--max-turns <n>` when set; unset = no cap
   *  (Claude Code's default). A coarse runaway guard independent of the breaker. */
  maxTurns?: number;
  /** Max concurrent god-triggered ephemeral Slack workers; extra spawn-requests
   *  wait in the queue (natural backpressure, a resource backstop). Default 4. */
  maxConcurrentWorkers?: number;
  /** Minutes an ephemeral worker may produce NO output before the reaper kills it
   *  — idle-based, never wall-clock, so an actively-working worker is never reaped.
   *  Default 20. */
  workerIdleTimeoutMinutes?: number;
  /** Registered integrations (Phase 2) — labeled REST endpoints workers reach through
   *  the loopback secret broker. METADATA ONLY: each record carries a `secretRef`
   *  handle, never the secret value (secrets live encrypted in a separate file via
   *  Electron safeStorage — see src/main/integrations.ts). Default []. */
  integrations?: IntegrationRecord[];
  /** Default per-worker TOTAL-token cap (input+output+cache) applied to every
   *  god-triggered ephemeral worker; a worker's own spawn-request `tokenCap`
   *  overrides it. When the effective cap is exceeded the worker is reaped (its
   *  committed work preserved) and god is informed. This is PLUMBING for a later
   *  budget feature: per the human directive there is NO per-worker cap today, so
   *  the default is 0 = UNLIMITED — the mechanism is wired but never throttles
   *  unless someone explicitly sets a positive cap (per request or here). */
  defaultWorkerTokenCap?: number;
  /** Circuit-breaker thresholds (Lane A #6.6b). Unset = conservative defaults. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Enterprise Knowledge Graph (multimodal context for agents). Default OFF. */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
  /** Opt-in "strong keep-alive": while ≥1 agent PTY is live, escalate the power
   *  blocker from 'prevent-app-suspension' to 'prevent-display-sleep', which on
   *  macOS also blocks TRUE system sleep (lid-close/idle) so scheduled missions
   *  and terminals keep firing ON TIME while away — at a battery cost (best on
   *  AC). Default OFF: the honest default is "survive sleep + catch up once on
   *  resume" (see the powerMonitor 'resume' handler), not "stay awake". */
  strongKeepalive?: boolean;
  /** Auto-update from GitHub releases (v0.3.4). Default ON. Packaged builds
   *  check on boot + every ~6h, download in the background, and show a
   *  "restart to update" toast — installation is always user-initiated. OFF
   *  disables checking entirely. (Mirrored in preload + renderer config.) */
  autoUpdate?: boolean;
  /** Multi-window "floors": expose a New Floor action that opens additional
   *  windows, each an independent office with isolated renderer state (its own
   *  session partition) and per-window PTY routing. ON by default (v0.3.4: code
   *  and comment disagreed; the shipped behavior — enabled — wins) —
   *  the window/PTY-ownership plumbing is always active and single-window-safe,
   *  but the New Floor entry points (app menu item + IPC) only appear when on.
   *  The on-disk hive (god orchestration under harnessHome) stays process-global;
   *  floors share it. */
  multiWindow?: boolean;
  /** Terminal theme — mirrored into each agent's per-session Claude settings
   *  ("theme" key) at spawn so the TUI's truecolor palette matches. Scoped to
   *  harness agents only; the user's global Claude theme is never touched. */
  terminalTheme?: 'light' | 'dark';
  /** Anonymous product analytics (PostHog) — the exact events/properties are
   *  documented in TELEMETRY.md. Default ON (opt-out, like autoUpdate); builds
   *  without an injected key and environments with DO_NOT_TRACK set never send
   *  regardless of this flag. (Mirrored in preload + renderer config.) */
  telemetryEnabled?: boolean;
  /** Master flag for the TV-show office themes feature (Settings theme picker +
   *  destructive switch flow). Default false = the picker is hidden and the
   *  office renders as today (zero behavior change). */
  tvShowOffices?: boolean;
  /** Which office map/cast theme the pixel office renders. Only honored when
   *  `tvShowOffices` is on; otherwise the office theme is used. Unbuilt show
   *  themes fall back to 'office' in the loader. */
  officeTheme?: 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
  /** Per-CLI-provider local/self-hosted base URL (Ollama/LM Studio/vLLM, …) for the
   *  OpenCode/Crush/pi/qwen engines; applied at spawn (config-injection or proxy
   *  upstream). API KEYS are NOT stored here — they live write-only in the secret
   *  broker (integrations.ts), read MAIN-ONLY at spawn. */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** Per-CLI-provider default model slug, used to pre-fill the model picker. */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
  /** Master toggle for the Slack → Michael's-queue integration. */
  slackEnabled?: boolean;
  /** Slack app signing secret (Basic Information → Signing Secret). Never logged. */
  slackSigningSecret?: string;
  /** Bot token (xoxb-…) — only needed if the bot ever replies; optional for now. */
  slackBotToken?: string;
  /** Restrict ingestion to one channel id; empty/undefined = any channel. */
  slackChannelId?: string;
  /** Local HTTP port the webhook server binds to (default 3847). */
  slackPort?: number;
  /** Opt-in: allow APP/VOICE-INITIATED proactive posting into Slack (e.g. the
   *  renderer's "queued" acknowledgement). DEFAULT OFF per the human directive
   *  "stop posting into Slack by default". This does NOT gate the Slack-ORIGIN
   *  done-reply round-trip (a user @-mention → task → result posted back to that
   *  thread) or an agent's own direct in-thread reply — those always stay on. */
  slackProactivePosting?: boolean;

  // ─── Free Flow (voice dictation → message queue) ───────────────────────────
  /** Master toggle for Free Flow push-to-talk dictation. Default OFF: with it off
   *  the composer shows no mic button, no getUserMedia runs, and no Groq call is
   *  ever made (zero behavior change). */
  freeflowEnabled?: boolean;
  /** User-pasted Groq API key (the user supplies their own free key). Used ONLY in
   *  the main process for the Groq STT call; NEVER logged, and never crosses IPC
   *  for the request. Treated like `slackBotToken`. */
  groqApiKey?: string;
  /** Groq Whisper model id. Default 'whisper-large-v3-turbo' (fast, multilingual). */
  freeflowModel?: string;

  // ─── Realtime Michael (premium speech-to-speech voice orchestrator) ─────────
  /** True ONLY while a Realtime Michael voice session is live: the renderer
   *  session flips this on at start() (before getUserMedia) and off at stop().
   *  The main-process mic permission gate reads it so the Electron media
   *  permission is open EXACTLY while the voice loop holds the mic — never just
   *  because an OpenAI key exists (that key is shared with the CLI engines).
   *  Default off; absence ⇒ mic denied, mirroring `freeflowEnabled`. */
  realtimeVoiceEnabled?: boolean;
  /** How long (ms) a realtime voice session may sit with no voice activity before
   *  it auto-disconnects (the rt-9 idle guard). Default 180000 (3 min). 0 = never
   *  auto-disconnect on idle — the spend cap remains the runaway guard. The user
   *  tunes this in Settings → Realtime Michael. */
  realtimeIdleDisconnectMs?: number;

  // ─── Generic inbound webhook + status API (LEGACY, single-endpoint) ─────────
  // Superseded by `webhookTriggers`, which allows many endpoints over one server
  // and one tunnel. These three are kept because they are the MIGRATION SOURCE
  // (`migrateTriggersV1` folds them into a `WebhookTrigger`) and because the main
  // process still reads them until the server is rewired onto the new list.
  // Nothing new should be written here.
  /** @deprecated Use `webhookTriggers[].enabled`. */
  webhookEnabled?: boolean;
  /** App-generated shared secret callers echo in `x-md-webhook-secret`. Never
   *  logged, and never forwarded into the routed message/card/response.
   *  @deprecated Use `webhookTriggers[].secret` (one secret per endpoint, so
   *  revoking one caller never disturbs the others). */
  webhookSecret?: string;
  /** Local HTTP port the generic webhook server binds to (default 3849).
   *  @deprecated The port is a property of the shared server, not of any one
   *  trigger; `webhookTriggers` are multiplexed over it by id. */
  webhookPort?: number;

  // ─── Triggers (src/shared/triggers.ts owns every type here) ────────────────
  /** Auto-compaction / auto-clearing of agent terminal context. Both halves ship
   *  in DEFAULT_CONTEXT_TRIGGER; `readConfig` deep-fills them, because the
   *  top-level merge below is one level deep and a half-written sub-object would
   *  otherwise reach consumers with `undefined` thresholds. */
  contextTrigger?: ContextTriggerConfig;
  /** Inbound HTTP endpoints, one entry per caller. Replaces the legacy single
   *  webhook above; several coexist on one port, told apart by `id` in the path. */
  webhookTriggers?: WebhookTrigger[];
  /** Peer messaging between teammates' clone nodes. Persistence + UI only today —
   *  no transport service reads `apiKey` yet. */
  orgTrigger?: OrgTriggerConfig;
  /** One-time guard for `migrateTriggersV1` (legacy webhook → webhookTriggers,
   *  1h → 2h compact cadence). Set once the migration has run to completion. */
  triggersMigratedV1?: boolean;

  // ─── Memory reflection (the janitor's condense half) ───────────────────────
  /** Master toggle for the in-process MemoryReflector. Default on. */
  reflectEnabled?: boolean;
  /** How often to scan agent memory.md files for condensing (default 30 min). */
  reflectIntervalMs?: number;
  /** Condense when bytes exceed this percent of the 128 KB budget (matches the
   *  janitor's TRIGGER_PCT). DECIDED: 50. */
  reflectByteTriggerPct?: number;
  /** ...OR when `## ` section count exceeds this (AND bytes > floor). DECIDED: 50. */
  reflectSectionTrigger?: number;
  /** Newest K verbatim `## ` sections kept untouched on each condense. */
  reflectRecentKeep?: number;
  /** Never condense a file smaller than this; also the section-trigger byte floor.
   *  DECIDED: 16 KB. */
  reflectMinBytes?: number;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  recentHives: [],
  registeredRepos: [],
  autoMode: true,
  orchestratorMaySpawn: false,
  defaultCommand: 'claude',
  godProvider: 'claude',
  godModel: 'claude-opus-4-8',
  // Global default model for every agent that hasn't picked one explicitly — wins
  // over the role-based tiers (modelForRole) in the spawn handler, so all agents
  // (incl. god) default to Fable 5. A per-agent model choice still overrides it.
  defaultModel: 'claude-fable-5',
  // Seeded from the MCP catalog so the consent defaults never drift from it
  // (safe-readonly ON, write/secret OFF).
  mcpDefaults: defaultMcpDefaults(),
  maxConcurrentWorkers: 4,
  workerIdleTimeoutMinutes: 20,
  integrations: [],
  defaultWorkerTokenCap: 0, // 0 = unlimited (human directive: NO per-worker cap)
  semanticMemory: true,
  embeddingModel: 'minilm',
  missions: [OPS_STANDUP_MISSION],
  notifications: false,
  strongKeepalive: false,
  autoUpdate: true,
  telemetryEnabled: true,
  multiWindow: true,
  tvShowOffices: false,
  officeTheme: 'office',
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  slackProactivePosting: false,
  freeflowEnabled: true,
  groqApiKey: undefined,
  freeflowModel: 'whisper-large-v3-turbo',
  realtimeVoiceEnabled: false,
  realtimeIdleDisconnectMs: 180_000,
  webhookEnabled: false,
  webhookSecret: undefined,
  webhookPort: undefined,
  // Triggers. These three are the ONLY object/array defaults that get handed
  // straight back out of `readConfig` for a config that never persisted them, so
  // `withTriggerDefaults` re-copies them on every read — see the note there.
  contextTrigger: DEFAULT_CONTEXT_TRIGGER,
  webhookTriggers: [],
  orgTrigger: DEFAULT_ORG_TRIGGER,
  triggersMigratedV1: false,
  // Memory reflection — preventive; nobody is over threshold today, so it sits
  // dark until an agent's memory crosses one of these (the verify gate is the
  // safety for the LLM step). Thresholds DECIDED by god 2026-06-06.
  reflectEnabled: true,
  reflectIntervalMs: 1_800_000,
  reflectByteTriggerPct: 50,
  reflectSectionTrigger: 50,
  reflectRecentKeep: 12,
  reflectMinBytes: 16_384,
  // Enterprise Knowledge Graph — opt-in; dark until the user enables it.
  // v0.3.4 fix: default OFF, matching the field's own documentation ("Default
  // OFF / dark until enabled") — the true default contradicted it. Existing
  // installs keep their persisted value.
  knowledgeGraph: { enabled: false }
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/**
 * Deep-fill the trigger sub-objects, and hand back copies of them.
 *
 * TWO problems, one fix. First, the merge in `readConfig` is one level deep, so a
 * `contextTrigger` persisted by an older build (or by a `writeConfig` that
 * patched only `compact`) arrives missing sub-keys that DEFAULTS would have
 * supplied — the consumer then reads `undefined` where it expects a number and
 * the rule never fires. Second, that same shallow merge hands the literal
 * DEFAULT_CONTEXT_TRIGGER / DEFAULT_ORG_TRIGGER instances to every config that
 * didn't persist them, so one caller mutating what it read would rewrite the
 * defaults for the whole process — and for every config read afterwards.
 *
 * Every branch below therefore constructs a fresh object, including the
 * "nothing persisted" branch.
 */
function withTriggerDefaults(cfg: HarnessConfig): HarnessConfig {
  return {
    ...cfg,
    contextTrigger: {
      compact: { ...DEFAULT_CONTEXT_TRIGGER.compact, ...cfg.contextTrigger?.compact },
      clear: { ...DEFAULT_CONTEXT_TRIGGER.clear, ...cfg.contextTrigger?.clear }
    },
    orgTrigger: { ...DEFAULT_ORG_TRIGGER, ...cfg.orgTrigger },
    webhookTriggers: Array.isArray(cfg.webhookTriggers)
      ? cfg.webhookTriggers.map((t) => ({ ...t }))
      : []
  };
}

/** Set once `migrateTriggersV1` has run in THIS process. `writeConfig` reads
 *  before it writes, so without an in-memory latch the migration's own persist
 *  would re-enter `readConfig` and run the migration a second time before
 *  `triggersMigratedV1: true` ever reached disk. */
let triggersMigrationRan = false;

/**
 * Fold the pre-Triggers config shape forward, exactly once per install.
 *
 * Runs from `readConfig`, so it is complete before any consumer can observe the
 * config — there is no boot ordering to get wrong and no window in which half
 * the app sees the old shape. Two things move:
 *
 *   1. The single legacy webhook (`webhookEnabled`/`webhookSecret`) becomes one
 *      `WebhookTrigger` with the stable id `legacy`, so the caller that already
 *      holds that secret keeps working across the upgrade. Skipped when
 *      `webhookTriggers` is already populated — the user has moved on, and
 *      re-adding a synthesised entry would resurrect a revoked endpoint.
 *   2. The seeded `compact-maintenance` mission moves from the old 1h cadence to
 *      2h, but ONLY if it still reads exactly 1h. A user-chosen interval is a
 *      decision, not a stale default, and is left alone.
 *
 * Wrapped end-to-end in a try/catch: a config that is corrupt in some unrelated
 * way must still boot the app, and a migration is never worth a failed launch.
 */
function migrateTriggersV1(cfg: HarnessConfig): HarnessConfig {
  if (cfg.triggersMigratedV1 || triggersMigrationRan) return cfg;
  triggersMigrationRan = true;
  try {
    const next: HarnessConfig = { ...cfg, triggersMigratedV1: true };

    const legacySecret = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret.trim() : '';
    if (legacySecret && (cfg.webhookTriggers?.length ?? 0) === 0) {
      next.webhookTriggers = [
        {
          id: 'legacy',
          name: 'Default webhook',
          secret: legacySecret,
          enabled: cfg.webhookEnabled ?? false,
          mode: DEFAULT_TRIGGER_MODE,
          schema: DEFAULT_WEBHOOK_SCHEMA,
          createdAt: Date.now()
        }
      ];
    }

    const missions = Array.isArray(cfg.missions) ? cfg.missions : [];
    const stale = (m: ScheduledMission): boolean =>
      m?.id === COMPACT_MAINTENANCE_MISSION.id
      && m.intervalMs === LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS;
    if (missions.some(stale)) {
      next.missions = missions.map((m) =>
        stale(m) ? { ...m, intervalMs: COMPACT_MAINTENANCE_MISSION.intervalMs } : m
      );
    }

    persistConfig(next);
    return next;
  } catch {
    // Leave the config exactly as read. The latch above stays set, so a failing
    // migration retries on the next launch rather than on every single read.
    return cfg;
  }
}

/** Per-PROCESS hive override, set once at startup from `--hive=<path>`. When
 *  present it wins over the harnessHome persisted in config.json for THIS
 *  process only — that is what lets several instances run different hives off
 *  one shared config.json. Never persisted: writeConfig bases its merge on
 *  readConfigRaw(), so an overridden instance cannot rewrite the global home. */
let hiveOverride: string | null = null;

/** Install the per-process hive override. Must run before anything reads config. */
export function setHiveOverride(home: string | null): void {
  hiveOverride = home && home.trim() ? expandTilde(home.trim()) : null;
}

/** This process's hive override, or null when it follows config.json. */
export function getHiveOverride(): string | null {
  return hiveOverride;
}

/** Config EXACTLY as persisted, with NO override applied. Use for writes — so a
 *  `--hive` instance can never rewrite the global home — and for anything that
 *  must reason about the configured default rather than this instance's hive. */
export function readConfigRaw(): HarnessConfig {
  const p = configPath();
  // No file yet = a first run with nothing to migrate; the defaults ARE the
  // post-migration shape. Deliberately does not persist — a bare read must not
  // conjure a config.json before onboarding has written one.
  if (!existsSync(p)) return withTriggerDefaults({ ...DEFAULTS });
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeStoredHomes(migrateTriggersV1(withTriggerDefaults({ ...DEFAULTS, ...parsed })));
  } catch {
    return withTriggerDefaults({ ...DEFAULTS });
  }
}

/** Config as THIS process sees it: persisted values, with harnessHome replaced by
 *  the `--hive` override when one was given. Every service resolves the hive
 *  lazily through here (`() => readConfig().harnessHome`), so a single override
 *  reaches all of them without touching a single call site. */
export function readConfig(): HarnessConfig {
  const cfg = readConfigRaw();
  if (hiveOverride) cfg.harnessHome = hiveOverride;
  return cfg;
}

/** (#140, the upgrade path) A config.json persisted BEFORE `writeConfig`
 *  learned to expand `~` still holds literal `~/…` strings in `harnessHome` /
 *  `recentHives`, and nothing rewrites the file until the next write — so the
 *  hive picker renders the raw `~` string and feeds it straight back into
 *  `config:changeHome`, which lands on `resolve()` → `<cwd>/~/…`, a real
 *  directory named "~". `normalizeHiveHome` only cleans values on the way IN;
 *  this cleans them on the way OUT, so no consumer can see a `~` path
 *  regardless of the file's vintage. Expanded duplicates collapse (a stale
 *  "~/X" next to its absolute twin becomes one entry). */
function normalizeStoredHomes(cfg: HarnessConfig): HarnessConfig {
  if (typeof cfg.harnessHome === 'string' && cfg.harnessHome.trim()) {
    cfg.harnessHome = expandTilde(cfg.harnessHome);
  }
  if (Array.isArray(cfg.recentHives)) {
    const seen = new Set<string>();
    cfg.recentHives = cfg.recentHives
      .filter((h): h is string => typeof h === 'string' && !!h.trim())
      .map((h) => expandTilde(h))
      .filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
  }
  return cfg;
}

/** Announces every saved setting, so a screen showing one can update.
 *
 *  Settings, Slack, voice and notifications each save by their own route, and
 *  all of them end up writing the file below — so one subscription here covers
 *  every setting rather than the ones anybody remembered to wire up. */
type ConfigWriteListener = (next: HarnessConfig) => void;
const configWriteListeners = new Set<ConfigWriteListener>();

export function onConfigWritten(listener: ConfigWriteListener): () => void {
  configWriteListeners.add(listener);
  return () => { configWriteListeners.delete(listener); };
}

function persistConfig(next: HarnessConfig): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  // Saving one setting stores only that setting, so fill the rest back in first:
  // subscribers must see the same complete config a read gives them, never a
  // half-filled one. Skip the migration — it saves in its own right, and has
  // already run against what this change was built on.
  const view = normalizeStoredHomes(withTriggerDefaults({ ...DEFAULTS, ...next }));
  // The change is already saved, so one failed subscriber must not fail the save
  // for its caller, nor stop the subscribers after it.
  for (const listener of configWriteListeners) {
    try { listener(view); } catch { /* a broken listener is not a failed save */ }
  }
  return next;
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  // RAW on purpose: merging onto readConfig() would bake this process's `--hive`
  // override into config.json, silently repointing every OTHER instance's home.
  const current = readConfigRaw();
  const next: HarnessConfig = { ...current, ...patch };
  // Project INGESTION — a registered repo is typed by hand ("~/dev/foo") as often
  // as it is picked from the folder dialog. Expand `~` here so the persisted list
  // (and therefore every agent's default cwd) is ABSOLUTE; Node's fs/spawn treat
  // `~` as a literal directory name and the spawn dies with `cwd does not exist`.
  if (Array.isArray(patch.registeredRepos)) {
    const seen = new Set<string>();
    next.registeredRepos = patch.registeredRepos
      .map((r) => expandTilde(r))
      .filter((r) => r && !seen.has(r) && (seen.add(r), true));
  }
  // The HIVE HOME needs the exact same treatment as registeredRepos above, and for
  // years it did not get it (#140). Onboarding SUGGESTS `~/HarnessAgents` and the
  // field is free text, so the common path — accept the default, press Finish —
  // persisted a literal `~`. The first thing the finish step does is create the
  // directory, and Node's mkdir has no idea what `~` means: it tried to make a
  // folder actually named "~", which fails as
  //   ENOENT: no such file or directory, mkdir '~/HarnessAgents'
  // and left the wizard wedged on its last step with no way forward. Expand BEFORE
  // the value is persisted or copied into recentHives, so every downstream reader
  // (mkdir, the hive root, the launch picker) sees one absolute path.
  if (typeof patch.harnessHome === 'string' && patch.harnessHome) {
    const { home, recentHives } = normalizeHiveHome(patch.harnessHome, current.recentHives ?? []);
    next.harnessHome = home;
    next.recentHives = recentHives;
  }
  return persistConfig(next);
}

/** Set or clear one agent's token ceiling against the latest config on disk.
 *
 * Renderer config objects are snapshots. Replacing `agentTokenCaps` from one of
 * those snapshots loses caps written since the snapshot was read (most visibly
 * while reviewing a batch of imported hires). Keep the read-modify-write in the
 * synchronous main process so each call merges with the result of the previous
 * one before returning the updated config to the renderer. */
export function setAgentTokenCap(agentId: unknown, tokenCap: unknown): HarnessConfig {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error('invalid agent token cap');
  }
  if (
    tokenCap !== undefined
    && (
      typeof tokenCap !== 'number'
      || !Number.isInteger(tokenCap)
      || tokenCap <= 0
      || tokenCap > MAX_AGENT_TOKEN_CAP
    )
  ) throw new Error('invalid agent token cap');

  const current = readConfig();
  const agentTokenCaps = { ...(current.agentTokenCaps ?? {}) };
  if (tokenCap === undefined) delete agentTokenCaps[agentId];
  else agentTokenCaps[agentId] = tokenCap;
  return persistConfig({
    ...current,
    agentTokenCaps
  });
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  // Saved like any other change, so a reset announces itself too.
  persistConfig({ ...DEFAULTS });
  // Drop the migration latch too: the file on disk is back to `triggersMigratedV1:
  // false`, and a latch left set would keep the flag from ever being written again
  // in this process. The migration itself is a no-op on defaults either way.
  triggersMigrationRan = false;
  return withTriggerDefaults({ ...DEFAULTS });
}

/** Model ids by tier (Lane A #6.4). Kept in sync with AGENT_MODELS in
 *  src/renderer/src/store/config.ts. */
const MODEL_GOD = 'claude-opus-4-8';                  // orchestration — highest capability
const MODEL_WORKER = 'claude-sonnet-4-6';             // general execution
const MODEL_HELPER = 'claude-haiku-4-5-20251001';     // narrow, cheap helpers

/** Minimal structural shape for tiering — a subset of AgentMeta so config.ts
 *  stays free of a hive.ts import. */
export interface RoleHint {
  isGod?: boolean;
  role?: string;
  capabilities?: string[];
}

/** Default model for an agent given its role (Lane A #6.4): Opus for the god,
 *  Haiku for narrow helpers (triage / routing / verification / formatting),
 *  Sonnet for general workers. Returns a model id (matching AGENT_MODELS) or
 *  undefined to fall back to the CLI default. This is only a DEFAULT — an
 *  explicit per-agent model selection always wins. */
export function modelForRole(
  meta: RoleHint,
  config?: Pick<HarnessConfig, 'godProvider' | 'godModel'>
): string | undefined {
  if (meta.isGod) {
    // GOD engine is selectable: an explicit godModel wins, else the chosen
    // provider's recommended orchestrator model, else the legacy Opus default.
    const preset = providerPreset(config?.godProvider ?? 'claude');
    return config?.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD;
  }
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}

/** Ensure harnessHome exists on disk. Expands `~` first — the onboarding wizard
 *  lets the user type the path, and mkdir treats a literal `~` as a plain
 *  directory name (issue #140's `ENOENT: mkdir '~/HarnessAgents'`). */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    // Expand HERE too, not only at the config write (#140). This runs FIRST —
    // onboarding calls it before updateConfig — so normalizing only at the write
    // boundary left the actual mkdir still receiving a literal `~`. Depending on
    // the process cwd that either fails outright or, worse, quietly succeeds by
    // creating a directory genuinely named "~" somewhere nobody will look, and
    // the hive then lives at a path the user cannot find. This is the
    // "defense-in-depth at the consumers" the expandTilde doc calls for: the
    // ingestion point normalizes, and the consumer refuses to trust that it did.
    mkdirSync(expandTilde(path), { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Idempotently pre-accept Claude Code's first-run prompts so agents spawned with
 *  `--permission-mode bypassPermissions` start cleanly. Without this, a fresh
 *  install shows an interactive "WARNING: Bypass Permissions mode … 1. No, exit /
 *  2. Yes, I accept" prompt that the PTY can't answer in time, so the agent exits
 *  code 1 on its own (reported by multiple users).
 *
 *  Two separate gates, written only when they aren't already satisfied (so we
 *  rarely touch files a running `claude` also writes):
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt` — these gate the bypass-mode warning (global).
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted` — the per-folder
 *      "do you trust the files in this folder?" dialog. */
export function ensureClaudePermissionsAccepted(cwd?: string): void {
  const home = homedir();
  if (!home) return;
  // 1) Global bypass-mode warning gate.
  try {
    const dir = join(home, '.claude');
    const p = join(dir, 'settings.json');
    let s: Record<string, unknown> = {};
    if (existsSync(p)) {
      try { s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { s = {}; }
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch { /* best-effort; never block a spawn */ }
  // 2) Per-folder trust dialog gate (only when this cwd isn't already trusted).
  if (cwd) {
    try {
      const p = join(home, '.claude.json');
      let c: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> } = {};
      if (existsSync(p)) {
        try { c = JSON.parse(readFileSync(p, 'utf8')); } catch { c = {}; }
      }
      if (c.projects?.[cwd]?.hasTrustDialogAccepted !== true) {
        c.projects = c.projects ?? {};
        c.projects[cwd] = { ...(c.projects[cwd] ?? {}), hasTrustDialogAccepted: true };
        writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
      }
    } catch { /* best-effort */ }
  }
}
