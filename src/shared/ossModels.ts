import type { AgentProvider } from './agentProvider';

/**
 * 添加 Agent 弹窗中的开源模型快速选择（ondev-c part-2）。
 *
 * 精心挑选的、稳定的短名单，从已验证目录
 * `hive/shared/cli-agents/oss-models-catalog.md` §7 逐字转录（由 Jim 冻结）。
 * 只收录稳健的 slug——前沿的尖刺模型（GLM-5.2、Kimi-K2.7）被刻意
 * 从代码默认值中排除（目录 §8 = 上线前需实测），留给博客去讲。
 *
 * 两个桶：本地（LOCAL，Mac 可通过 Ollama/LM Studio 运行，无需 key）和
 * 第三方 OSS 提供商（THIRD-PARTY OSS PROVIDER，BYOK）。每个引擎消费
 * 相同的上游 id；只有本地前缀不同（§6）：OpenCode 把本地提供商命名为
 * `local`；Crush 和 pi 用 `ollama`。三个引擎中提供商路由的 slug 完全相同。
 */

/** Mac 可运行的本地模型（Ollama tag）。slug 经 localSlugFor 加引擎前缀。 */
export interface OssLocalPick {
  label: string;
  /** Ollama tag — 保留冒号（例如 `gpt-oss:20b`）。 */
  tag: string;
  /** 运行它所需的大致最小统一内存。 */
  minRam: string;
}

/** 第三方 OSS 提供商的模型（BYOK）。slug 在三个引擎中原样使用。 */
export interface OssProviderPick {
  label: string;
  /** `provider/model` slug（尽可能使用原生提供商前缀）。 */
  slug: string;
  /** 此路由读取的后端 key 环境变量（在 设置 → AI 引擎 中设置）。 */
  keyEnv: string;
}

/** §7.A — 本地快速选择（Mac 可运行，无需 key）— Ollama tags。 */
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

/** §7.B — 第三方 OSS 提供商快速选择（BYOK）。 */
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

/** 本地 Ollama tag 的引擎正确 slug：`ollama/<tag>`。tag 保留其冒号。 */
export function localSlugFor(_provider: AgentProvider, tag: string): string {
  return `ollama/${tag}`;
}

/** 是否为此引擎展示 OSS 快速选择——当前引擎集中只有 qwen 支持本地运行。 */
export function hasOssQuickPicks(provider: AgentProvider): boolean {
  return provider === 'qwen';
}

/** 本地设置 UI 超链接到的权威博客 URL（ondev-c part-3）。 */
export const OSS_BLOG_LINKS = {
  openModels: 'https://munderdiffl.in/blog/run-munder-difflin-on-open-models/',
  macMini: 'https://munderdiffl.in/blog/run-munder-difflin-on-a-mac-mini/'
} as const;
