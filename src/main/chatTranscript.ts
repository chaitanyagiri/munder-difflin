import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isInboxNudge } from '../shared/hiveNudge';
import { isCompactionCommand } from '../shared/providerAutomation';

/** One plain-text turn extracted from a Claude Code transcript — a user prompt
 * or an assistant reply, with every tool_use/tool_result block stripped out.
 * This is the "desktop-app view": just the conversation, none of the raw TUI
 * noise (spinners, tool logs, box drawing) the terminal panel shows. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/** Bounds how many turns a single tab keeps in memory/render — a long-running
 * agent's transcript can hold thousands; the chat tab only needs recent ones. */
const MAX_MESSAGES = 300;

interface TailEntry {
  size: number;
  mtimeMs: number;
  /** Bytes parsed so far — always ends on a newline boundary, mirroring the
   * usage tailer in transcript.ts so a torn trailing line is simply re-read
   * once the writer completes it. */
  offset: number;
  messages: ChatMessage[];
}

const tailCache = new Map<string, TailEntry>();
/** Soft bound; when crossed, the oldest-inserted half is dropped (entries
 * rebuild on demand). Mirrors USAGE_CACHE_MAX in transcript.ts. */
const TAIL_CACHE_MAX = 512;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join('\n\n');
}

/** Parse complete JSONL lines into chat turns, appending to `out`. A record
 * whose content is ONLY tool_use/tool_result blocks yields no text and is
 * skipped — that is exactly the raw tool traffic the chat view exists to hide. */
function parseChatLines(text: string, out: ChatMessage[]): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: { type?: unknown; message?: { content?: unknown }; timestamp?: unknown };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const body = extractText(rec.message?.content);
    if (!body) continue;
    // The inbox-wake nudge and a /compact command are typed into the pty by the
    // app itself (mail poll / context-cap trigger), not by the human — same text
    // shape as a real prompt once it lands in the transcript, so the only way to
    // recognize it here is the fixed pattern each one shares (see hiveNudge.ts /
    // providerAutomation.ts, which the message queue already dedupes against).
    if (rec.type === 'user' && (isInboxNudge(body) || isCompactionCommand(body))) continue;
    const parsedTs = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    out.push({ role: rec.type, text: body, ts: Number.isFinite(parsedTs) ? parsedTs : Date.now() });
  }
}

/** Read the plain-text conversation out of a live Claude Code transcript,
 * tailed incrementally like readAgentUsage's per-file cache: unchanged
 * size+mtime is a cache hit, growth parses only the appended bytes, and a
 * shrink (rewrite) forces a full re-parse. Returns at most MAX_MESSAGES,
 * newest last. */
export function readChatTranscript(transcriptPath: string): ChatMessage[] {
  try {
    if (!existsSync(transcriptPath)) return [];
    const st = statSync(transcriptPath);
    const cached = tailCache.get(transcriptPath);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.messages;

    const fromScratch = !cached || st.size < cached.offset;
    const entry: TailEntry = fromScratch
      ? { size: st.size, mtimeMs: st.mtimeMs, offset: 0, messages: [] }
      : { size: st.size, mtimeMs: st.mtimeMs, offset: cached!.offset, messages: [...cached!.messages] };

    const fd = openSync(transcriptPath, 'r');
    try {
      const len = st.size - entry.offset;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, entry.offset);
        const text = buf.subarray(0, read).toString('utf8');
        const lastNl = text.lastIndexOf('\n');
        if (lastNl !== -1) {
          const complete = text.slice(0, lastNl + 1);
          parseChatLines(complete, entry.messages);
          entry.offset += Buffer.byteLength(complete, 'utf8');
        }
      }
    } finally {
      closeSync(fd);
    }

    if (entry.messages.length > MAX_MESSAGES) {
      entry.messages = entry.messages.slice(entry.messages.length - MAX_MESSAGES);
    }
    tailCache.set(transcriptPath, entry);
    if (tailCache.size > TAIL_CACHE_MAX) {
      let drop = tailCache.size - TAIL_CACHE_MAX / 2;
      for (const k of tailCache.keys()) {
        if (drop-- <= 0) break;
        tailCache.delete(k);
      }
    }
    return entry.messages;
  } catch {
    return [];
  }
}
