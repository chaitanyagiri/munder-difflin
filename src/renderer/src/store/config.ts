// Mirrors src/main/config.ts. Kept as a renderer-side type-only module
// so we don't have to reach into the preload package to type-check.
import {
  AGENT_PROVIDER_PRESETS,
  providerPreset,
  inferAgentProvider,
  isClaudeProvider,
  type AgentProvider
} from '@shared/agentProvider';

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
export const AGENT_MODELS: ModelOption[] = [
  { id: undefined, label: 'default' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: ASSISTANT_MODEL, label: 'Sonnet 4.6 · 1M' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
];

/** Models offered when an agent runs on the OpenAI Codex CLI (`codex`). Codex's
 *  `--model` takes a model slug (e.g. `codex --model o4-mini`). These are the
 *  curated suggestions surfaced in the picker — the command field stays editable,
 *  and `codex --model <id>` is the source of truth. // TODO-verify the exact live
 *  slug list once the codex CLI can be installed to confirm. */
export const CODEX_MODELS: ModelOption[] = [
  { id: undefined, label: 'default' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { id: 'o4-mini', label: 'o4-mini' },
  { id: 'o3', label: 'o3' }
];

/** Models offered when an agent runs on the Antigravity CLI (`agy`). agy's
 *  `--model` takes the DISPLAY-NAME LABEL exactly as `agy models` prints it
 *  (verified: agy logs `Propagating selected model override … label="…"`), not a
 *  slug — so these ids ARE the labels (spaces/parens included; buildSpawnCommand
 *  quotes them and the command tokenizer keeps them whole). The command field
 *  stays editable; `agy models` is the source of truth for the live list. */
export const ANTIGRAVITY_MODELS: ModelOption[] = [
  { id: undefined, label: 'default' },
  { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro · High' },
  { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro · Low' },
  { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash · High' },
  { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash · Med' },
  { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash · Low' },
  { id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6' },
  { id: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6' },
  { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B' }
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
  { id: undefined, label: 'default' },
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

/** Split a command string into argv, respecting double/single quotes so a model
 *  value with spaces (agy's `--model "Gemini 3.1 Pro (High)"`) stays one token.
 *  Quotes are stripped from the result. */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The model preset list for a given provider's picker. */
export function modelsForProvider(provider: AgentProvider): ModelOption[] {
  if (provider === 'codex') return CODEX_MODELS;
  if (provider === 'antigravity') return ANTIGRAVITY_MODELS;
  if (provider === 'qwen') return QWEN_MODELS;
  if (provider === 'opencode') return OPENCODE_MODELS;
  if (provider === 'crush') return CRUSH_MODELS;
  if (provider === 'pi') return PI_MODELS;
  return AGENT_MODELS;
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
  // too; every other provider (codex, agy) uses its preset binary so the app
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
  // bypassPermissions, codex's `--dangerously-bypass-approvals-and-sandbox`, agy's skip flag.
  if (config.autoMode && preset.autoFlag) cmd = `${cmd} ${preset.autoFlag}`;
  return cmd;
}
