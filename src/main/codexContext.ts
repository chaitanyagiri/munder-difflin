/**
 * Codex context-gauge backfill.
 *
 * Context coverage has provider-specific inputs. Claude can report exact
 * readings through status hooks, while the renderer independently backfills
 * missing Claude readings from transcripts every 15 seconds. Fleet
 * tokens/lastTool use separate OpenTelemetry inputs. Codex supplies none of
 * those Claude-shaped context inputs, but its rollout logs contain a compatible
 * `token_count` reading. Hook delivery was traced through the shared shim
 * architecture, not empirically verified here; rollout polling is independent
 * of that path.
 *
 * HiveManager exposes each worker's isolated CODEX_HOME at
 * `<hive>/agents/<id>/.codex`. This module tails its latest rollout and feeds
 * the reading through `HookServer.reportContext()`.
 *
 * Pure Node - no `electron` import - so it runs standalone in `node --test`.
 */
import { readdirSync, statSync, existsSync, openSync, fstatSync, readSync, closeSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

export interface CodexContextReading {
  tokens: number;
  limit: number;
}

const MAX_WALK_DEPTH = 6;
const DISCOVERY_TTL_MS = 60_000;

interface RolloutFile {
  path: string;
  mtimeMs: number;
  size: number;
}

interface ContextCacheEntry {
  discoveredAt: number;
  selected: RolloutFile | null;
  reading: CodexContextReading | null;
}

const contextCache = new Map<string, ContextCacheEntry>();

function collectRolloutFiles(dir: string, depth = 0): RolloutFile[] {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: RolloutFile[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRolloutFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      try {
        const stat = statSync(full);
        found.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // The file can disappear between directory enumeration and stat.
      }
    }
  }
  return found;
}

function findLatestRollout(codexHome: string): RolloutFile | null {
  const sessionsDir = join(codexHome, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  const files = collectRolloutFiles(sessionsDir);
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0];
}

export function findLatestCodexRollout(codexHome: string): string | null {
  return findLatestRollout(codexHome)?.path ?? null;
}

const DEFAULT_TAIL_BYTES = 256 * 1024;

interface RolloutTokenCountPayload {
  type: 'token_count';
  info?: {
    last_token_usage?: { input_tokens?: unknown };
    model_context_window?: unknown;
  };
}

function isTokenCountPayload(value: unknown): value is RolloutTokenCountPayload {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'token_count';
}

export function readLatestTokenCount(
  filePath: string,
  tailBytes: number = DEFAULT_TAIL_BYTES
): CodexContextReading | null {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    let startsAtLineBoundary = start === 0;
    if (start > 0) {
      const previousByte = Buffer.alloc(1);
      readSync(fd, previousByte, 0, 1, start - 1);
      startsAtLineBoundary = previousByte[0] === 0x0a;
    }
    const usableLines = startsAtLineBoundary ? lines : lines.slice(1);
    for (let i = usableLines.length - 1; i >= 0; i--) {
      const line = usableLines[i].trim();
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = (event as { payload?: unknown } | null)?.payload;
      if (!isTokenCountPayload(payload)) continue;
      const tokens = payload.info?.last_token_usage?.input_tokens;
      const limit = payload.info?.model_context_window;
      if (typeof tokens === 'number' && Number.isFinite(tokens)
        && typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        return { tokens, limit };
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export function clearCodexContextCache(): void {
  contextCache.clear();
}

export function readCodexContext(
  codexHome: string,
  nowMs: number = Date.now()
): CodexContextReading | null {
  try {
    const cached = contextCache.get(codexHome);
    if (cached && nowMs - cached.discoveredAt < DISCOVERY_TTL_MS) {
      if (!cached.selected) return cached.reading;
      try {
        const stat = statSync(cached.selected.path);
        if (stat.mtimeMs === cached.selected.mtimeMs && stat.size === cached.selected.size) {
          return cached.reading;
        }
        const reading = readLatestTokenCount(cached.selected.path);
        contextCache.set(codexHome, {
          ...cached,
          selected: { path: cached.selected.path, mtimeMs: stat.mtimeMs, size: stat.size },
          reading
        });
        return reading;
      } catch {
        contextCache.delete(codexHome);
      }
    }

    const selected = findLatestRollout(codexHome);
    const reading = selected ? readLatestTokenCount(selected.path) : null;
    contextCache.set(codexHome, { discoveredAt: nowMs, selected, reading });
    return reading;
  } catch {
    return null;
  }
}

interface CodexRegistrySource {
  registry(): {
    agents: Record<string, { archived?: boolean; provider?: string }>;
  };
  codexHome(agentId: string): string | null;
}

export interface CodexAgentContextReading {
  agentId: string;
  reading: CodexContextReading;
}

export function readCodexRegistryContexts(source: CodexRegistrySource): CodexAgentContextReading[] {
  const readings: CodexAgentContextReading[] = [];
  for (const [agentId, agent] of Object.entries(source.registry().agents)) {
    if (agent.archived || agent.provider !== 'codex') continue;
    const codexHome = source.codexHome(agentId);
    if (!codexHome) continue;
    const reading = readCodexContext(codexHome);
    if (reading) readings.push({ agentId, reading });
  }
  return readings;
}
