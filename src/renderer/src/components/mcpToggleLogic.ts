import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG } from '@shared/mcpCatalog';

export function resolveEnabledFor(
  mcpDefaults: HarnessConfig['mcpDefaults'],
  id: string,
  catalog = MCP_CATALOG
): boolean {
  return mcpDefaults?.[id]?.enabled ?? catalog.find((e) => e.id === id)?.defaultEnabled ?? false;
}

interface ApplyToggleDeps {
  updateConfig: (patch: Partial<HarnessConfig>) => Promise<unknown>;
  getConfig: () => Promise<{ mcpDefaults?: Record<string, { enabled: boolean }> }>;
}

/**
 * Persist the toggle, then RE-READ what actually landed and return that.
 *
 * The returned config is the value the component renders, so a stale prop does
 * not survive a save or a settings-panel remount.
 */
export async function applyToggle(
  id: string,
  next: boolean,
  currentDefaults: HarnessConfig['mcpDefaults'],
  deps: ApplyToggleDeps
): Promise<Record<string, { enabled: boolean }>> {
  await deps.updateConfig({ mcpDefaults: { ...(currentDefaults ?? {}), [id]: { enabled: next } } });
  const fresh = await deps.getConfig();
  return fresh.mcpDefaults ?? {};
}
