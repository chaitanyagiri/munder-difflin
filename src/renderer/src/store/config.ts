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

/** The models offered in the "add agent" picker and the per-agent selector.
 *  `[1m]` selects the 1M-token context window variant. */
// Deliberately has NO "pass no --model flag" entry. Every option here names a
// real model, because the whole reason to open this picker is to know which
// model an agent is on — and a no-flag option resolves to whatever Claude Code
// happens to choose, which the UI cannot show and the user cannot predict. The
// harness default is marked ` · default` instead, and it names a real model.
export const AGENT_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5', label: 'Opus 5 · 1M' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: ASSISTANT_MODEL, label: 'Sonnet 4.6 · 1M' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
];

/** Current OpenAI models offered by Codex for coding agents. The command field
 *  stays editable and `codex --model <id>` is the source of truth. */
export const CODEX_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
];

/** Models offered when an agent runs on the Antigravity CLI (`agy`). agy's
 *  `--model` takes the DISPLAY-NAME LABEL exactly as `agy models` prints it
 *  (verified: agy logs `Propagating selected model override … label="…"`), not a
 *  slug — so these ids ARE the labels (spaces/parens included; buildSpawnCommand
 *  quotes them and the command tokenizer keeps them whole). The command field
 *  stays editable; `agy models` is the source of truth for the live list. */
export const ANTIGRAVITY_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro · High' },
  { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro · Low' },
  { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash · High' },
  { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash · Med' },
  { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash · Low' },
  { id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6' },
  { id: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6' },
  { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B' }
];

/** Stable model aliases accepted by the official Google Gemini CLI. The aliases
 *  intentionally follow the CLI instead of pinning preview model ids that drift. */
export const GEMINI_MODELS: ModelOption[] = [
  { id: undefined, label: 'CLI default' },
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite' }
];

/** Models offered when an agent runs on qwen-code (`qwen`), the proxy-bridge CLI
 *  driving an OpenAI-compatible endpoint. Starting suggestions only (editable
 *  command field). // TODO-verify the live list (`qwen` model ids). */
export const QWEN_MODELS: ModelOption[] = [
  { id: undefined, label: 'default' },
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
  { id: 'qwen3-coder', label: 'Qwen3 Coder' },
  { id: 'qwen-max', label: 'Qwen Max' }
];

/** Models offered when an agent runs on OpenCode (`opencode`). OpenCode's `--model`
 *  takes a `provider/model` slug; these are curated BYOK suggestions (the command
 *  field stays editable; `opencode models` / models.dev is the source of truth).
 *  // TODO-verify exact live slugs (humanQA — they drift). */
export const OPENCODE_MODELS: ModelOption[] = [
  // "CLI default", not "default" — the distinction ANTIGRAVITY_MODELS already
  // draws: pass NO --model and run whatever OpenCode itself is configured and
  // authenticated for. That is not the harness's own default model, and calling
  // both "default" is what made the two impossible to tell apart. This is now the
  // PRESELECTED entry for OpenCode, because a BYOK slug the user holds no key for
  // fails silently — see the recommendedOrchestratorModel note in agentProvider.ts.
  { id: undefined, label: 'CLI default' },
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Anthropic)' },
  { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (Anthropic)' },
  { id: 'openai/gpt-5', label: 'GPT-5 (OpenAI)' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini (OpenAI)' },
  { id: 'openrouter/anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (OpenRouter)' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google)' },
  { id: 'local/llama3', label: 'Local · OpenAI-compatible (set base-URL)' }
];

/** Models offered when an agent runs on Crush (`crush`). Crush's `--model` takes a
 *  `provider/model-id` slug; free-text editable (Crush accepts arbitrary slugs).
 *  // TODO-verify exact live ids (humanQA). */
export const CRUSH_MODELS: ModelOption[] = [
  { id: undefined, label: 'Crush default (config)' },
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Anthropic)' },
  { id: 'anthropic/claude-opus-4-1', label: 'Claude Opus (Anthropic)' },
  { id: 'openai/gpt-4o', label: 'GPT-4o (OpenAI)' },
  { id: 'openai/o3', label: 'o3 (OpenAI)' },
  { id: 'gemini/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'openrouter/auto', label: 'OpenRouter (auto)' },
  // OpenAI-wire local slug so traffic routes through the proxy (the harness overrides
  // the `openai` provider's base_url → loopback → your configured Crush base-URL).
  // An `ollama/*` slug would bypass the proxy (Dwight verify-crush NIT-2).
  { id: 'openai/local', label: 'Local · OpenAI-compatible (set base-URL)' }
];

/** Models offered when an agent runs on Pi (`pi`). Pi's `--model` takes a
 *  `provider/model` slug (thinking via a `:high` suffix). Curated BYOK suggestions;
 *  free-text editable. // TODO-verify exact live slugs (humanQA). */
export const PI_MODELS: ModelOption[] = [
  { id: undefined, label: 'default' },
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Anthropic)' },
  { id: 'anthropic/claude-opus-4-1', label: 'Claude Opus (Anthropic)' },
  { id: 'openai/gpt-5', label: 'GPT-5 (OpenAI)' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google)' },
  { id: 'groq/llama-3.3-70b', label: 'Llama 3.3 70B (Groq)' },
  { id: 'local/llama3', label: 'Local · OpenAI-compatible (set base-URL)' }
];

/** Models offered when an agent runs on GitHub Copilot (`copilot`). Copilot's
 *  `--model` takes a plain model id ('auto' lets Copilot pick); these are curated
 *  suggestions and the command field stays editable. // TODO-verify exact live ids
 *  (the /model picker is the source of truth; they drift). */
export const COPILOT_MODELS: ModelOption[] = [
  { id: undefined, label: 'default (Claude Sonnet 4.5)' },
  { id: 'auto', label: 'Auto (Copilot picks)' },
  { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5', label: 'GPT-5' }
];

/** Models offered when an agent runs on Cursor Agent CLI (`cursor-agent`). Ids match
 *  `cursor-agent models` / `--model` (Cursor account catalog). Luna is the cheap,
 *  high-context default for Michael; other entries are curated quick-picks —
 *  the command field stays editable for any live slug. */
export const CURSOR_MODELS: ModelOption[] = [
  { id: undefined, label: 'CLI default (auto)' },
  { id: 'auto', label: 'Auto' },
  { id: 'gpt-5.6-luna-high', label: 'GPT-5.6 Luna 1M High (cheap)' },
  { id: 'gpt-5.6-sol-medium', label: 'GPT-5.6 Sol 1M' },
  { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' },
  { id: 'composer-2.5', label: 'Composer 2.5' },
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
  { id: 'claude-opus-4-8-high', label: 'Opus 4.8 1M' },
  { id: 'claude-sonnet-5-thinking-high', label: 'Sonnet 5 1M Thinking' }
];

/** Models reported by the installed Grok CLI (`grok models`). */
export const GROK_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'grok-4.5', label: 'Grok 4.5' }
];

/** Managed Kimi Code aliases accepted by `kimi --model <alias>`. */
export const KIMI_MODELS: ModelOption[] = [
  // No `--model` flag at all — whatever the CLI itself defaults to. NOT the
  // harness's `config.defaultModel`; the pickers mark that one separately, and
  // labelling both "default" is what made the two impossible to tell apart.
  { id: undefined, label: 'CLI default' },
  { id: 'kimi-code/k3', label: 'Kimi K3' },
  { id: 'kimi-code/kimi-for-coding', label: 'Kimi K2.7 Code' },
  { id: 'kimi-code/kimi-for-coding-highspeed', label: 'Kimi K2.7 · HighSpeed' }
];

// tokenizeCommand moved to src/shared/commandLine.ts so main's spawn-request
// path splits command lines with the SAME rules as the renderer's spawn flows
// (they used to carry byte-identical copies). Re-exported here so existing
// importers keep their path.
export { tokenizeCommand } from '@shared/commandLine';

/** The model preset list for a given provider's picker. */
export function modelsForProvider(provider: AgentProvider): ModelOption[] {
  if (provider === 'codex') return CODEX_MODELS;
  if (provider === 'grok') return GROK_MODELS;
  if (provider === 'kimi') return KIMI_MODELS;
  if (provider === 'gemini') return GEMINI_MODELS;
  if (provider === 'antigravity') return ANTIGRAVITY_MODELS;
  if (provider === 'qwen') return QWEN_MODELS;
  if (provider === 'opencode') return OPENCODE_MODELS;
  if (provider === 'crush') return CRUSH_MODELS;
  if (provider === 'pi') return PI_MODELS;
  if (provider === 'copilot') return COPILOT_MODELS;
  if (provider === 'cursor') return CURSOR_MODELS;
  if (provider === 'custom') return [];
  return AGENT_MODELS;
}

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
