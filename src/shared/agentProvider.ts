export type AgentProvider = 'claude' | 'codex' | 'custom';

export interface AgentProviderPreset {
  id: AgentProvider;
  label: string;
  defaultCommand: string;
  supportsModels: boolean;
}

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  { id: 'claude', label: 'Claude Code', defaultCommand: 'claude', supportsModels: true },
  { id: 'codex', label: 'Codex', defaultCommand: 'codex', supportsModels: false },
  { id: 'custom', label: 'Custom', defaultCommand: '', supportsModels: false }
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return value === 'claude' || value === 'codex' || value === 'custom';
}

export function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  return isAgentProvider(value) ? value : undefined;
}

export function isClaudeProvider(provider: AgentProvider | undefined): boolean {
  return provider === 'claude';
}

function commandBinary(command: string | undefined): string {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.(cmd|exe)$/i, '').toLowerCase();
}

export function inferAgentProvider(command: string | undefined, explicit?: unknown): AgentProvider {
  const normalized = normalizeAgentProvider(explicit);
  if (normalized) return normalized;
  const bin = commandBinary(command);
  if (bin === 'codex') return 'codex';
  if (bin === 'claude' || !bin) return 'claude';
  return 'custom';
}

export function defaultCommandForProvider(provider: AgentProvider, fallback = ''): string {
  if (provider === 'custom') return fallback;
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider)?.defaultCommand ?? fallback;
}
