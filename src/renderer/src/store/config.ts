// Mirrors src/main/config.ts. Kept as a renderer-side type-only module
// so we don't have to reach into the preload package to type-check.
import {
  AGENT_PROVIDER_PRESETS,
  providerPreset,
  inferAgentProvider,
  isClaudeProvider,
  type AgentProvider
} from '@shared/agentProvider';
import type {
  ContextTriggerConfig,
  OrgTriggerConfig,
  WebhookTrigger
} from '@shared/triggers';
import { isNewer } from '@shared/updateState';
import modelCatalog from '@shared/modelCatalog.json';

export {
  AGENT_PROVIDER_PRESETS,
  providerPreset,
  inferAgentProvider,
  isClaudeProvider,
  type AgentProvider
};

/** A recurring auto-dispatched mission (mirrors src/main/config.ts). */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  quietThresholdMs?: number;
}

/** Circuit-breaker thresholds (mirrors src/main/config.ts CircuitBreakerConfig). */
export interface CircuitBreakerConfig {
  enabled?: boolean;
  hardStop?: boolean;
  repeatedToolLimit?: number;
  errorStormLimit?: number;
  tokenVelocityPerMin?: number;
}

/** Enterprise Knowledge Graph config (mirrors src/main/config.ts KnowledgeGraphConfig). */
export interface KnowledgeGraphConfig {
  enabled?: boolean;
  rootPath?: string;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  /** Self-identified audience from the first onboarding screen ('technical' vs
   *  'non-technical') — drives the copy register across onboarding. Mirrors
   *  src/main/config.ts. */
  audience?: 'technical' | 'non-technical';
  harnessHome: string | null;
  /** Recently-opened hive home folders (most-recent first) for the launch picker.
   *  Mirrors src/main/config.ts. */
  recentHives?: string[];
  registeredRepos: string[];
  autoMode: boolean;
  /** May the orchestrator ("Michael") spin up agents on its own? Default FALSE,
   *  so an absent value reads as off. Mirrors src/main/config.ts. */
  orchestratorMaySpawn?: boolean;
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Which provider+model powers the GOD orchestrator ("Michael"). Default
   *  'claude' / 'claude-opus-4-8'. Mirrors src/main/config.ts. */
  godProvider?: AgentProvider;
  godModel?: string;
  /** Per-server consent for the default MCP bundle, keyed by catalog id (mirrors
   *  src/main/config.ts; seeded from MCP_CATALOG). */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  missions?: ScheduledMission[];
  opsStandupSeeded?: boolean;
  heartbeatSeeded?: boolean;
  notifications?: boolean;
  /** Opt-in "strong keep-alive": escalates the in-app power blocker to
   *  prevent-display-sleep so scheduled missions/terminals keep firing on time
   *  while away (battery cost; best on AC). Default off = survive + catch up on
   *  resume. Mirrors the main-process field (src/main/config.ts). */
  strongKeepalive?: boolean;
  /** Auto-update from GitHub releases (default ON; Settings → General). */
  autoUpdate?: boolean;
  /** Anonymous product analytics (default ON, opt-out; see TELEMETRY.md).
   *  Mirrors the main-process field (src/main/config.ts). */
  telemetryEnabled?: boolean;
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackPort?: number;
  /** Opt-in app/voice-initiated proactive Slack posting (default OFF). Mirrors
   *  src/main/config.ts; the Slack-origin done-reply round-trip is never gated. */
  slackProactivePosting?: boolean;
  /** Free Flow voice dictation (mirrors src/main/config.ts). */
  freeflowEnabled?: boolean;
  groqApiKey?: string;
  freeflowModel?: string;
  /** Realtime voice idle auto-disconnect (ms); default 180000 (3 min), 0 = never.
   *  Tuned in Settings → Realtime Michael; the cost cap stays the runaway guard. */
  realtimeIdleDisconnectMs?: number;
  costCapUsd?: number;
  /** Hard total-token ceiling across active agents (the user-facing budget). */
  costCapTokens?: number;
  /** Per-agent total-token ceiling, keyed by agent id. Overrides the floor budget
   *  for that agent's meter and trips the breaker for it alone. */
  agentTokenCaps?: Record<string, number>;
  autoDeliveryPausedAgents?: string[];
  maxTurns?: number;
  circuitBreaker?: CircuitBreakerConfig;
  /** Enterprise Knowledge Graph (multimodal context for agents). Default OFF. */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** TV-show office themes feature flag (Settings picker + switch flow). Default OFF. */
  tvShowOffices?: boolean;
  /** Active office map/cast theme (honored only when tvShowOffices is on). */
  officeTheme?: 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
  /** Frame-rate ceiling for the office scene, in fps (0 = uncapped). */
  floorMaxFps?: number;
  /** Per-CLI-provider local/self-hosted base URL (Ollama/LM Studio/vLLM, …) for the
   *  OpenCode/Crush/pi/qwen engines; applied at spawn. API KEYS are NOT stored here —
   *  they live write-only in the secret broker. */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** Per-CLI-provider default model slug, used to pre-fill the model picker. */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
  /** Legacy single-webhook fields (mirrors src/main/config.ts, where they are
   *  deprecated in favour of `webhookTriggers` but still read until the server is
   *  rewired). Declared here so the surfaces that show them can stop widening this
   *  type locally.
   *  @deprecated Use `webhookTriggers`. */
  webhookEnabled?: boolean;
  /** @deprecated Use `webhookTriggers[].secret`. */
  webhookSecret?: string;
  /** @deprecated The port belongs to the shared server, not to any one trigger. */
  webhookPort?: number;
  /** Auto-compaction / auto-clearing of agent terminal context. Main deep-fills
   *  both halves on read, so the renderer can treat the sub-keys as present
   *  (mirrors src/main/config.ts). */
  contextTrigger?: ContextTriggerConfig;
  /** Inbound HTTP endpoints, one per caller — replaces the legacy trio above. */
  webhookTriggers?: WebhookTrigger[];
  /** Peer messaging between teammates' clone nodes (persistence + UI only). */
  orgTrigger?: OrgTriggerConfig;
  /** One-time guard for the main-process triggers migration; read-only here. */
  triggersMigratedV1?: boolean;
}

/** The Sonnet model with the 1M-token context window — used for Michael's prep
 *  assistant (cheap, large-context context gathering). Mirrors ASSISTANT_MODEL
 *  in src/main/assistant.ts; keep the two in sync. */
export const ASSISTANT_MODEL = 'claude-sonnet-4-6[1m]';

export interface ModelOption {
  /** undefined = use the CLI default (no --model flag) */
  id?: string;
  label: string;
}

/** One row of the model catalog. `minAppVersion` / `maxAppVersion` are INCLUSIVE
 *  app-version bounds: the model is offered while the running build sits inside
 *  them, and null (or an absent key) means unbounded in that direction. That is
 *  what lets a release introduce or retire a model without a code change.
 *
 *  PRERELEASES COUNT AS THEIR RELEASE. The comparison is major.minor.patch only
 *  (`isNewer` discards a `-rc.N` suffix), so `minAppVersion: '0.4.6'` IS offered
 *  on `0.4.6-rc.1`. That is deliberate and ruled on: an rc of a release should
 *  count as that release, it matches the update badge's own comparison, and the
 *  alternative would hide a new model from exactly the testers meant to
 *  exercise it. Bound a model to the release, not to its rc. */
interface CatalogModel {
  /** absent = use the CLI default (no --model flag) */
  id?: string;
  label: string;
  minAppVersion?: string | null;
  maxAppVersion?: string | null;
}

interface ModelCatalog {
  version: number;
  providers: Record<string, CatalogModel[]>;
}

/** The model presets every provider picker offers.
 *
 *  These were a dozen hardcoded `ModelOption[]` arrays in this file, so shipping
 *  a model — one string — meant editing, type-checking and rebuilding renderer
 *  source. They now live in src/shared/modelCatalog.json, imported at BUILD time
 *  (no fs, no network, offline-safe) and filtered per running version, so adding
 *  a model is a one-line JSON edit and a model can name the releases it belongs
 *  to instead of appearing in builds whose CLI never shipped it.
 *
 *  What the arrays used to say — kept, because it explains why the entries look
 *  the way they do:
 *
 *  - claude: `[1m]` selects the 1M-token context-window variant. The list
 *    deliberately has NO "pass no --model flag" entry: every option names a real
 *    model, because the whole reason to open this picker is to know which model
 *    an agent is on, and a no-flag option resolves to whatever Claude Code
 *    happens to choose — which the UI cannot show and the user cannot predict.
 *    The harness default is marked ` · default` instead, and it names a real model.
 *  - The leading `CLI default` entry several providers carry means no `--model`
 *    flag at all — whatever the CLI itself defaults to. That is NOT the harness's
 *    `config.defaultModel`; the pickers mark that one separately, and labelling
 *    both "default" is what made the two impossible to tell apart.
 *  - codex: current OpenAI models offered by Codex. The command field stays
 *    editable and `codex --model <id>` is the source of truth.
 *  - antigravity: agy's `--model` takes the DISPLAY-NAME LABEL exactly as
 *    `agy models` prints it (verified: agy logs `Propagating selected model
 *    override … label="…"`), not a slug — so these ids ARE labels, spaces and
 *    parens included; buildSpawnCommand quotes them and the command tokenizer
 *    keeps them whole. `agy models` is the source of truth for the live list.
 *  - gemini: stable aliases accepted by the official Google Gemini CLI. They
 *    follow the CLI instead of pinning preview model ids that drift.
 *  - qwen: qwen-code (`qwen`), the proxy-bridge CLI driving an OpenAI-compatible
 *    endpoint. Starting suggestions only. // TODO-verify the live list.
 *  - opencode: `--model` takes a `provider/model` slug; curated BYOK suggestions
 *    (`opencode models` / models.dev is the source of truth). `CLI default` is the
 *    PRESELECTED entry, because a BYOK slug the user holds no key for fails
 *    silently — see the recommendedOrchestratorModel note in agentProvider.ts.
 *    // TODO-verify exact live slugs (they drift).
 *  - crush: `--model` takes a `provider/model-id` slug; free-text editable (Crush
 *    accepts arbitrary slugs). The local pick is an OpenAI-wire slug so traffic
 *    routes through the proxy (the harness overrides the `openai` provider's
 *    base_url → loopback → your configured Crush base-URL); an `ollama/*` slug
 *    would bypass the proxy. // TODO-verify exact live ids.
 *  - pi: `--model` takes a `provider/model` slug (thinking via a `:high` suffix).
 *    Curated BYOK suggestions; free-text editable. // TODO-verify exact live slugs.
 *  - copilot: `--model` takes a plain model id ('auto' lets Copilot pick); curated
 *    suggestions, editable command field. // TODO-verify exact live ids (the
 *    /model picker is the source of truth; they drift).
 *  - cursor: ids match `cursor-agent models` / `--model` (Cursor account catalog).
 *    Luna is the cheap, high-context default for Michael; the rest are curated
 *    quick-picks and the command field stays editable for any live slug.
 *  - grok: the models reported by the installed Grok CLI (`grok models`).
 *  - kimi: managed Kimi Code aliases accepted by `kimi --model <alias>`.
 *  - custom: no presets at all; the command field is the whole interface.
 */
const CATALOG: ModelCatalog = modelCatalog;

declare const __APP_VERSION__: string | undefined;

/** The version of the running build. electron-vite replaces `__APP_VERSION__`
 *  with package.json's version at build time — the same value the update badge
 *  shows — so the renderer knows it synchronously, with no round trip to main.
 *  Outside a build (unit tests) the define is absent and there is no version to
 *  compare against; see the fail-open note on `offeredAtVersion`. */
export function runningAppVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

/** Whether a catalog entry belongs in a picker on this build. Both bounds are
 *  inclusive of the release they name. Anything unparseable — an absent bound, a
 *  malformed one, an unknown app version — is ignored rather than hiding the
 *  model: a picker that silently loses every model is far worse than one that
 *  offers a model this build's CLI cannot run (the command field is editable and
 *  the CLI reports the bad slug). */
function offeredAtVersion(model: CatalogModel, appVersion: string): boolean {
  if (model.minAppVersion && isNewer(model.minAppVersion, appVersion)) return false;
  if (model.maxAppVersion && isNewer(appVersion, model.maxAppVersion)) return false;
  return true;
}

/** The model preset list for a provider's picker, as of a given app version.
 *  `providers` is injectable so the version filter can be exercised against
 *  bounded entries — the shipped catalog is deliberately all-unbounded. */
export function modelsForProviderAtVersion(
  provider: AgentProvider,
  appVersion: string,
  providers: Record<string, CatalogModel[]> = CATALOG.providers
): ModelOption[] {
  // An unknown provider falls back to the Claude list, as the hardcoded dispatch
  // did. 'custom' is a real key holding an empty list, not a missing one.
  const entries = providers[provider] ?? providers.claude ?? [];
  return entries
    .filter((model) => offeredAtVersion(model, appVersion))
    .map((model) => (model.id === undefined ? { label: model.label } : { id: model.id, label: model.label }));
}

// tokenizeCommand moved to src/shared/commandLine.ts so main's spawn-request
// path splits command lines with the SAME rules as the renderer's spawn flows
// (they used to carry byte-identical copies). Re-exported here so existing
// importers keep their path.
export { tokenizeCommand } from '@shared/commandLine';

/** The model preset list for a given provider's picker, on this build. */
export function modelsForProvider(provider: AgentProvider): ModelOption[] {
  return modelsForProviderAtVersion(provider, runningAppVersion());
}

/** The Claude presets, for the surfaces that only ever offer Claude models. */
export const AGENT_MODELS: ModelOption[] = modelsForProvider('claude');

/** Providers shown in the Command Center's cross-provider model picker.
 *  God must remain on a provider with a working inbox drain; otherwise switching
 *  to a terminal-only provider would silently disable orchestration. */
export function modelProvidersForAgent(isGod = false) {
  return AGENT_PROVIDER_PRESETS.filter((preset) =>
    preset.supportsModel && (!isGod || preset.canReceiveInbox)
  );
}

/** Native <select> values must carry both provider and model because each
 *  provider has its own "default" option and model namespace. */
export function encodeProviderModel(provider: AgentProvider, model?: string): string {
  return `${provider}:${encodeURIComponent(model ?? '')}`;
}

export function decodeProviderModel(value: string): {
  provider: AgentProvider;
  model?: string;
} | null {
  const split = value.indexOf(':');
  if (split < 1) return null;
  const provider = value.slice(0, split);
  if (!AGENT_PROVIDER_PRESETS.some((preset) => preset.id === provider)) return null;
  try {
    const model = decodeURIComponent(value.slice(split + 1));
    return { provider: provider as AgentProvider, model: model || undefined };
  } catch {
    return null;
  }
}

/** Build the command line to feed into spawnPty, honoring the provider's flags,
 *  autoMode, and an optional per-agent model override. Claude keeps the user's
 *  configured `defaultCommand`; other providers use their preset binary so the
 *  app works without Claude installed. */
export function buildSpawnCommand(
  config: Pick<HarnessConfig, 'defaultCommand' | 'autoMode'>,
  model?: string,
  provider: AgentProvider = inferAgentProvider(config.defaultCommand)
): string {
  const preset = providerPreset(provider);
  // Claude keeps the user's configured defaultCommand; custom falls back to it
  // too; every other provider (codex, grok, kimi, agy) uses its preset binary so the app
  // works even without Claude installed.
  const base =
    provider === 'claude'
      ? config.defaultCommand || preset.defaultCommand
      : provider === 'custom'
        ? config.defaultCommand || ''
        : preset.defaultCommand;
  let cmd = base;
  if (preset.supportsModel && model && preset.modelFlag) {
    // Quote model values that contain whitespace (agy labels like
    // "Gemini 3.1 Pro (High)") so the command tokenizer keeps them one arg.
    const m = /\s/.test(model) ? `"${model}"` : model;
    cmd = `${cmd} ${preset.modelFlag} ${m}`;
  }
  // Auto (skip-permissions) mode appends each provider's own flag — Claude's
  // bypassPermissions, Codex's dangerous bypass, Grok's always-approve, Kimi's
  // auto, or agy's skip flag.
  if (config.autoMode && preset.autoFlag) cmd = `${cmd} ${preset.autoFlag}`;
  return cmd;
}
