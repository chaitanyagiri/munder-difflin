import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isInboxNudge } from '../shared/hiveNudge';
import { isCompactionCommand } from '../shared/providerAutomation';
import { isHiveIdentityPrompt } from '../shared/hivePrompt';

/** One plain-text turn extracted from an agent's transcript — a user prompt or
 * an assistant reply, with every tool_use/tool_result block stripped out. This
 * is the "desktop-app view": just the conversation, none of the raw TUI noise
 * (spinners, tool logs, box drawing) the terminal panel shows. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/** Bounds how many turns a single tab keeps in memory/render — a long-running
 * agent's transcript can hold thousands; the chat tab only needs recent ones.
 * Exported so every provider's reader caps at the same depth. */
export const MAX_CHAT_MESSAGES = 300;

/**
 * Is this user turn the HARNESS talking, rather than the human?
 *
 * Three things the app types into an agent land in the transcript shaped exactly
 * like a typed prompt, and the Chat tab must show none of them:
 *   - the identity/protocol brief injected at spawn (`--prompt`, for every
 *     provider that cannot take it as a system prompt),
 *   - the inbox-wake nudge the mail poll queues,
 *   - the `/compact` the context cap triggers.
 * Each predicate lives with the code that WRITES that text (hivePrompt.ts /
 * hiveNudge.ts / providerAutomation.ts — the same ones the message queue dedupes
 * against), so a reworded nudge cannot leave a stale copy behind here.
 */
export function isAppGeneratedPrompt(text: string): boolean {
  return isHiveIdentityPrompt(text) || isInboxNudge(text) || isCompactionCommand(text);
}

/** Turn one parsed JSONL record into a chat turn, or null to skip it. Each
 * provider's transcript has its own record shape; the tailer below is shared. */
export type ChatRecordParser = (rec: unknown) => ChatMessage | null;

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

/** Concatenate the `text` of every text-bearing block. Claude Code's blocks are
 * `{type:'text', text}`; Codex's are `{type:'input_text'|'output_text', text}`.
 * Anything without a string `text` — tool_use, tool_result, images — is exactly
 * the traffic the Chat tab exists to hide, so it contributes nothing. */
export function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (typeof type === 'string' && /text$/.test(type) && typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  return parts.join('\n\n');
}

function tsOf(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Claude Code's JSONL: `{type:'user'|'assistant', message:{content}, timestamp}`.
 * A record whose content is ONLY tool_use/tool_result blocks yields no text and
 * is skipped — that is exactly the raw tool traffic the chat view exists to hide. */
export const parseClaudeRecord: ChatRecordParser = (rec) => {
  const r = rec as { type?: unknown; message?: { content?: unknown }; timestamp?: unknown };
  if (r.type !== 'user' && r.type !== 'assistant') return null;
  const body = textOfBlocks(r.message?.content);
  if (!body) return null;
  if (r.type === 'user' && isAppGeneratedPrompt(body)) return null;
  return { role: r.type, text: body, ts: tsOf(r.timestamp) };
};

/** Parse complete JSONL lines into chat turns, appending to `out`. */
function parseChatLines(text: string, parse: ChatRecordParser, out: ChatMessage[]): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = parse(rec);
    if (msg) out.push(msg);
  }
}

/** Read the plain-text conversation out of a live JSONL transcript, tailed
 * incrementally like readAgentUsage's per-file cache: unchanged size+mtime is a
 * cache hit, growth parses only the appended bytes, and a shrink (rewrite)
 * forces a full re-parse. Returns at most MAX_CHAT_MESSAGES, newest last. The
 * cache is keyed by path, so one file is only ever read with one parser. */
export function tailChatJsonl(transcriptPath: string, parse: ChatRecordParser): ChatMessage[] {
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
          parseChatLines(complete, parse, entry.messages);
          entry.offset += Buffer.byteLength(complete, 'utf8');
        }
      }
    } finally {
      closeSync(fd);
    }

    if (entry.messages.length > MAX_CHAT_MESSAGES) {
      entry.messages = entry.messages.slice(entry.messages.length - MAX_CHAT_MESSAGES);
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

/** The Claude Code transcript behind the Chat tab — the path every Claude hook
 * payload carries as `transcript_path`. */
export function readChatTranscript(transcriptPath: string): ChatMessage[] {
  return tailChatJsonl(transcriptPath, parseClaudeRecord);
}
