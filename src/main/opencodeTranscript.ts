/**
 * The Chat tab's second reader: OpenCode.
 *
 * Claude Code writes a JSONL transcript file and hands its path to every hook,
 * which is what `chatTranscript.ts` tails. OpenCode has no such file — it keeps
 * the whole conversation in ONE SQLite database under its data dir, split across
 * `message` (one row per turn, role in a JSON blob) and `part` (one row per
 * content block: text, reasoning, tool call, step marker). So the Chat tab reads
 * it with a query instead of a tail, and everything downstream — the ChatMessage
 * shape, the "this text is the app's, not the human's" filter — is shared with
 * the Claude reader so both tabs behave identically.
 *
 * READ-ONLY, always. OpenCode is the only writer of this database and it is live
 * while we read; the connection is opened `readonly` so a bug here can never
 * corrupt an agent's history, and WAL means our reads never block its writes.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ChatMessage, MAX_CHAT_MESSAGES, isAppGeneratedPrompt } from './chatTranscript';

/** Where OpenCode keeps its store. It follows the XDG data convention on every
 *  platform, Windows included (observed: `%USERPROFILE%\.local\share\opencode`),
 *  so the per-agent `OPENCODE_CONFIG_DIR` the harness sets does NOT move it —
 *  config and data are separate, and every agent shares this one database. */
function dbPath(): string | null {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const roots = xdg ? [xdg, join(homedir(), '.local', 'share')] : [join(homedir(), '.local', 'share')];
  for (const root of roots) {
    const p = join(root, 'opencode', 'opencode.db');
    if (existsSync(p)) return p;
  }
  return null;
}

/** One handle for the process, reopened after any failure. Opening a SQLite
 *  connection is not free and the Chat tab polls; a stale handle is the only
 *  thing worth guarding against, and a closed/deleted database throws on use,
 *  which `read` turns back into a reopen. */
let handle: Database.Database | null = null;
let handlePath: string | null = null;

function connect(): Database.Database | null {
  const p = dbPath();
  if (!p) return null;
  if (handle && handlePath === p) return handle;
  try { handle?.close(); } catch { /* noop */ }
  handle = new Database(p, { readonly: true, fileMustExist: true });
  handlePath = p;
  return handle;
}

function drop(): void {
  try { handle?.close(); } catch { /* noop */ }
  handle = null;
  handlePath = null;
}

/** Windows path comparison: OpenCode stores `C:/Users/…` while the registry
 *  holds `C:\Users\…`, and neither case nor a trailing separator is meaningful. */
function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Which OpenCode session belongs to this agent?
 *
 * `sessionId` — learned from the bridge plugin, which stamps it on every payload
 * it posts — is exact, and the only answer that stays right when two agents run
 * in the SAME directory. The cwd match is the fallback for a session that
 * started before the plugin reported anything (an agent already running when the
 * app was updated): newest session in that directory wins, which is right for
 * one agent per directory and a guess for more than one.
 */
function resolveSession(db: Database.Database, sessionId?: string, cwd?: string): string | null {
  if (sessionId?.startsWith('ses_')) {
    const hit = db.prepare('SELECT id FROM session WHERE id = ?').get(sessionId) as { id: string } | undefined;
    if (hit) return hit.id;
  }
  if (!cwd) return null;
  const rows = db.prepare(
    'SELECT id, directory FROM session WHERE directory IS NOT NULL ORDER BY time_updated DESC LIMIT 200'
  ).all() as { id: string; directory: string }[];
  for (const r of rows) if (samePath(r.directory, cwd)) return r.id;
  return null;
}

interface CacheEntry { session: string; updated: number; messages: ChatMessage[] }
const cache = new Map<string, CacheEntry>();

/**
 * Read an agent's OpenCode conversation as plain turns.
 *
 * Only `text` parts are selected, IN SQL: a session's `tool` parts carry entire
 * file reads and command outputs, so pulling every part into memory to throw
 * most of it away would make each poll cost megabytes. `reasoning` parts are
 * dropped for the same reason the Claude reader drops thinking blocks — the tab
 * shows what was said, not how it was arrived at — and `synthetic` parts are
 * OpenCode's own turn-continuation nudges, which are exactly what this tab
 * exists to hide.
 */
export function readOpenCodeChat(sessionId?: string, cwd?: string): ChatMessage[] {
  let db: Database.Database | null;
  try {
    db = connect();
  } catch {
    drop();
    return [];
  }
  if (!db) return [];

  try {
    const session = resolveSession(db, sessionId, cwd);
    if (!session) return [];

    // `time_updated` on the session row moves on every write, so one indexed
    // lookup tells us whether the (much larger) turn query can be skipped. This
    // is the WAL-safe equivalent of the size+mtime check the Claude tailer uses:
    // a WAL commit need not touch the database file's own mtime.
    const meta = db.prepare('SELECT time_updated FROM session WHERE id = ?').get(session) as
      { time_updated: number } | undefined;
    const updated = meta?.time_updated ?? 0;
    const cached = cache.get(session);
    if (cached && cached.updated === updated) return cached.messages;

    const rows = db.prepare(`
      SELECT json_extract(m.data, '$.role')  AS role,
             json_extract(p.data, '$.text')  AS text,
             p.time_created                  AS ts
        FROM part p
        JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
         AND json_extract(p.data, '$.type') = 'text'
         AND json_extract(p.data, '$.synthetic') IS NULL
       ORDER BY p.time_created DESC
       LIMIT ?
    `).all(session, MAX_CHAT_MESSAGES) as { role: string; text: string | null; ts: number }[];

    const messages: ChatMessage[] = [];
    for (const r of rows.reverse()) {
      if (r.role !== 'user' && r.role !== 'assistant') continue;
      const body = (r.text ?? '').trim();
      if (!body) continue;
      if (r.role === 'user' && isAppGeneratedPrompt(body)) continue;
      messages.push({ role: r.role, text: body, ts: r.ts });
    }

    cache.set(session, { session, updated, messages });
    return messages;
  } catch {
    // A schema change, a JSON1-less build, or a handle that outlived its file.
    // Dropping the handle makes the next poll reconnect; an empty tab is the
    // right failure mode either way.
    drop();
    return [];
  }
}
