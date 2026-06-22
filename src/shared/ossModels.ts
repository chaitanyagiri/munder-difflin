import type { AgentProvider } from './agentProvider';

/**
 * Open-source model quick-picks for the Add-Agent modal (ondev-c part-2).
 *
 * Curated, STABLE shortlist transcribed verbatim from the verified catalog
 * `hive/shared/cli-agents/oss-models-catalog.md` §7 (frozen by Jim). Robust slugs
 * only — bleeding-edge frontier models (GLM-5.2, Kimi-K2.7) are intentionally
 * EXCLUDED from code defaults (catalog §8 = verify-live) and left to the blogs.
 *
 * Two buckets: LOCAL (Mac-runnable via Ollama/LM Studio, no key) and THIRD-PARTY
 * OSS PROVIDER (BYOK). Every engine consumes the same upstream id; only the
 * local prefix differs (§6): OpenCode names its local provider `local`; Crush and
 * pi use `ollama`. Provider-routed slugs are identical across the three engines.
 */

/** A Mac-runnable local model (Ollama tag). Slug is engine-prefixed via localSlugFor. */
export interface OssLocalPick {
  label: string;
  /** Ollama tag — keep the colon (e.g. `gpt-oss:20b`). */
  tag: string;
  /** Rough minimum unified memory to run it. */
  minRam: string;
}

/** A third-party OSS-provider model (BYOK). Slug used as-is across all three engines. */
export interface OssProviderPick {
  label: string;
  /** `provider/model` slug (native provider prefix where possible). */
  slug: string;
  /** The backend key env var this route reads (set in Settings → AI Engines). */
  keyEnv: string;
}

/** §7.A — Local quick-picks (Mac-runnable, no key) — Ollama tags. */
export const OSS_LOCAL_PICKS: OssLocalPick[] = [
  { label: 'gpt-oss 20B', tag: 'gpt-oss:20b', minRam: '16 GB' },
  { label: 'Qwen3 30B-A3B', tag: 'qwen3:30b-a3b', minRam: '32 GB' },
  { label: 'Qwen3-Coder 30B', tag: 'qwen3-coder:30b', minRam: '32 GB' },
  { label: 'DeepSeek-R1 32B', tag: 'deepseek-r1:32b', minRam: '32 GB' },
  { label: 'Mistral Small 24B', tag: 'mistral-small:24b', minRam: '16–32 GB' },
  { label: 'GLM-4.7-Flash', tag: 'glm-4.7-flash', minRam: '32 GB' },
  { label: 'Llama 3.3 70B', tag: 'llama3.3:70b', minRam: '64 GB' },
  { label: 'gpt-oss 120B', tag: 'gpt-oss:120b', minRam: '96 GB' }
];

/** §7.B — Third-party OSS-provider quick-picks (BYOK). */
export const OSS_PROVIDER_PICKS: OssProviderPick[] = [
  { label: 'gpt-oss 120B · Groq', slug: 'groq/openai/gpt-oss-120b', keyEnv: 'GROQ_API_KEY' },
  { label: 'Llama 3.3 70B · Groq', slug: 'groq/llama-3.3-70b-versatile', keyEnv: 'GROQ_API_KEY' },
  { label: 'DeepSeek-V4-Flash · OpenRouter', slug: 'openrouter/deepseek/deepseek-v4-flash', keyEnv: 'OPENROUTER_API_KEY' },
  { label: 'DeepSeek-V4-Flash · DeepSeek', slug: 'deepseek/deepseek-v4-flash', keyEnv: 'DEEPSEEK_API_KEY' },
  { label: 'GLM-4.6 · OpenRouter', slug: 'openrouter/z-ai/glm-4.6', keyEnv: 'OPENROUTER_API_KEY' },
  { label: 'Kimi K2.6 · OpenRouter', slug: 'openrouter/moonshotai/kimi-k2.6', keyEnv: 'OPENROUTER_API_KEY' },
  { label: 'Qwen3-Coder 480B · OpenRouter', slug: 'openrouter/qwen/qwen3-coder', keyEnv: 'OPENROUTER_API_KEY' },
  { label: 'Qwen3 235B · OpenRouter', slug: 'openrouter/qwen/qwen3-235b-a22b-2507', keyEnv: 'OPENROUTER_API_KEY' },
  { label: 'gpt-oss 120B · OpenRouter', slug: 'openrouter/openai/gpt-oss-120b', keyEnv: 'OPENROUTER_API_KEY' }
];

/** Engine-correct slug for a local Ollama tag (§6): OpenCode → `local/<tag>`;
 *  Crush and pi → `ollama/<tag>`. The tag keeps its colon. */
export function localSlugFor(provider: AgentProvider, tag: string): string {
  return provider === 'opencode' ? `local/${tag}` : `ollama/${tag}`;
}

/** Whether to surface the OSS quick-picks for this engine — the local-capable CLI
 *  engines integrated in v0.3.1. (Claude/Codex/Antigravity use their own logins.) */
export function hasOssQuickPicks(provider: AgentProvider): boolean {
  return provider === 'opencode' || provider === 'crush' || provider === 'pi';
}

/** Canonical blog URLs the local-setup UI hyperlinks to (ondev-c part-3). */
export const OSS_BLOG_LINKS = {
  openModels: 'https://munderdiffl.in/blog/run-munder-difflin-on-open-models/',
  macMini: 'https://munderdiffl.in/blog/run-munder-difflin-on-a-mac-mini/'
} as const;
