/**
 * The Chat tab's Codex reader.
 *
 * Codex keeps a JSONL "rollout" per session under its CODEX_HOME —
 * `sessions/YYYY/MM/DD/rollout-<started>-<sessionId>.jsonl` — and the hive gives
 * every codex agent a private CODEX_HOME (`<agentDir>/.codex`, see
 * installCodexHooks), so an agent's whole history sits in one directory tree we
 * already own. Same tailer as the Claude reader; only the record shape differs:
 *
 *   {"type":"response_item","payload":{"type":"message","role":"user"|"assistant"|"developer",
 *     "content":[{"type":"input_text"|"output_text","text":"…"}]}, "timestamp":"…"}
 *
 * plus tool calls, reasoning, token counts and event markers under other
 * `type`s, none of which is a conversation turn.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChatMessage, type ChatRecordParser, isAppGeneratedPrompt, tailChatJsonl, textOfBlocks
} from './chatTranscript';

/**
 * Codex's OWN injected user turns — text it puts in the user seat that no human
 * typed: the repo's AGENTS.md (headed `# AGENTS.md instructions for <path>`, or
 * wrapped in `<user_instructions>` on older builds) and the environment block.
 * Each begins with a fixed marker at column 0, so a human message that merely
 * mentions AGENTS.md is untouched. The hive's own injections (brief, nudge,
 * /compact) are the shared isAppGeneratedPrompt's business.
 */
export function isCodexInjectedPrompt(text: string): boolean {
  return /^(# AGENTS\.md instructions\b|<user_instructions>|<environment_context>)/.test(text);
}

/** `developer` is Codex's system-prompt seat (skills, tool guidance) and never
 * a conversation turn; anything else outside user/assistant is ignored too. */
export const parseCodexRecord: ChatRecordParser = (rec) => {
  const r = rec as {
    type?: unknown; timestamp?: unknown;
    payload?: { type?: unknown; role?: unknown; content?: unknown };
  };
  if (r.type !== 'response_item' || !r.payload || r.payload.type !== 'message') return null;
  const role = r.payload.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const body = textOfBlocks(r.payload.content);
  if (!body) return null;
  if (role === 'user' && (isAppGeneratedPrompt(body) || isCodexInjectedPrompt(body))) return null;
  const parsed = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  return { role, text: body, ts: Number.isFinite(parsed) ? parsed : Date.now() };
};

function walkRollouts(dir: string, out: string[]): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, out);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
}

/**
 * Which rollout is this agent's current conversation?
 *
 * Codex names the file after the session id, and that id reaches the app on
 * every hook payload (`session_id`, recorded by the hook server and persisted in
 * the registry), so a known id is an exact match. Without one — hooks not yet
 * fired, or a session that predates them — the most recently written rollout in
 * the agent's own CODEX_HOME is the right guess: the home is per agent, so
 * nothing else writes there.
 */
export function resolveCodexRollout(codexHome: string, sessionId?: string): string | null {
  const sessions = join(codexHome, 'sessions');
  if (!existsSync(sessions)) return null;
  const files: string[] = [];
  walkRollouts(sessions, files);
  if (!files.length) return null;
  if (sessionId) {
    const exact = files.find((f) => f.endsWith(`-${sessionId}.jsonl`));
    if (exact) return exact;
  }
  let newest = files[0];
  let newestMs = -1;
  for (const f of files) {
    try {
      const ms = statSync(f).mtimeMs;
      if (ms > newestMs) { newestMs = ms; newest = f; }
    } catch { /* vanished between walk and stat */ }
  }
  return newest;
}

/** Plain user/assistant turns of a codex agent's live session — the data behind
 * its Chat tab. Empty until Codex has written the first rollout line. */
export function readCodexChat(codexHome: string, sessionId?: string): ChatMessage[] {
  const rollout = resolveCodexRollout(codexHome, sessionId);
  return rollout ? tailChatJsonl(rollout, parseCodexRecord) : [];
}
