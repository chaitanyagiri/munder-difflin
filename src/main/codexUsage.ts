import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative } from 'node:path';

export interface CodexUsageTail {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  ts: number;
}

const MAX_TAIL_BYTES = 1024 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && Number.isInteger(value) && value >= 0;
}

/** Parse the newest valid cumulative token_count event in a JSONL tail. */
export function parseCodexUsageTail(text: string): CodexUsageTail | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let row: unknown;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const event = row as { timestamp?: unknown; type?: unknown; payload?: unknown };
    if (event.type !== 'event_msg' || !event.payload || typeof event.payload !== 'object') continue;
    const payload = event.payload as { type?: unknown; info?: unknown };
    if (payload.type !== 'token_count' || !payload.info || typeof payload.info !== 'object') continue;
    const usage = (payload.info as { total_token_usage?: unknown }).total_token_usage;
    if (!usage || typeof usage !== 'object') continue;
    const totals = usage as Record<string, unknown>;
    const inputTokens = totals.input_tokens;
    const cachedTokens = totals.cached_input_tokens;
    const outputTokens = totals.output_tokens;
    const cacheWriteTokens = totals.cache_write_input_tokens ?? 0;
    const ts = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    if (!tokenCount(inputTokens) || !tokenCount(cachedTokens) || !tokenCount(outputTokens)
      || !tokenCount(cacheWriteTokens) || cachedTokens > inputTokens || !Number.isFinite(ts)) continue;
    return {
      input: inputTokens - cachedTokens,
      output: outputTokens,
      cacheRead: cachedTokens,
      cacheCreation: cacheWriteTokens,
      ts
    };
  }
  return null;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Read at most the final 1 MiB after resolving all symlinks/junctions. */
export async function readCodexUsage(path: string, agentCodexHome?: string): Promise<CodexUsageTail | null> {
  try {
    const resolvedPath = await realpath(path);
    if (extname(resolvedPath).toLowerCase() !== '.jsonl') return null;

    const roots = [join(homedir(), '.codex', 'sessions'), agentCodexHome].filter((v): v is string => !!v);
    const resolvedRoots = await Promise.all(roots.map(async (root) => {
      try { return await realpath(root); } catch { return null; }
    }));
    if (!resolvedRoots.some((root) => root !== null && isWithin(root, resolvedPath))) return null;

    const file = await open(resolvedPath, 'r');
    try {
      const size = (await file.stat()).size;
      const firstByte = Math.max(0, size - MAX_TAIL_BYTES);
      let position = size;
      let tail = Buffer.alloc(0);
      while (position > firstByte) {
        const length = Math.min(READ_BLOCK_BYTES, position - firstByte);
        position -= length;
        const block = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(block, 0, length, position);
        if (!bytesRead) break;
        tail = Buffer.concat([block.subarray(0, bytesRead), tail]);
        const text = tail.toString('utf8');
        const firstNewline = text.indexOf('\n');
        const completeTail = position === 0 ? text : firstNewline === -1 ? '' : text.slice(firstNewline + 1);
        const usage = parseCodexUsageTail(completeTail);
        if (usage) return usage;
      }
      return null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
