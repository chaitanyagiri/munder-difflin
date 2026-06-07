import * as pty from 'node-pty';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveCommand, userShellPath } from './shellEnv';
import { projectDir } from './transcript';

/**
 * Shared helper: run a HIDDEN interactive claude session (ephemeral PTY) and
 * return the assistant's final text response.
 *
 * "Hidden" means: not added to the PtyManager, not emitted to the renderer,
 * not visible in the agent list or OfficeFloor scene. Each call spawns its own
 * session and kills it after capture — no /clear needed, no context bleed.
 *
 * Uses an interactive PTY (not `claude -p`) so calls draw from the user's
 * normal interactive plan quota, not the Agent SDK credit that moves to a
 * separate claim-required pool from 2026-06-15.
 *
 * Session lifecycle:
 *   spawn → boot-quiet detect → bracketed-paste prompt + \r → idle-settle →
 *   transcript JSONL extract (last assistant text block) → kill
 */

/** ms of PTY silence that signals the TUI is ready for input (boot complete). */
const BOOT_QUIET_MS = 1500;

export interface HiddenClaudeOptions {
  /** Model to use (e.g. 'claude-haiku-4-5'). */
  model: string;
  /** Working directory for the claude session. */
  cwd: string;
  /** Base claude command/binary. Defaults to 'claude'. */
  command?: string;
  /** Tools the session is forbidden to use. Defaults to ['Edit','Write','NotebookEdit']. */
  disallowedTools?: string[];
  /** Directories added via --add-dir (for context gathering). */
  addDirs?: string[];
  /** Hard cap ms before forcing prompt send regardless of boot activity. Default 7000. */
  bootCapMs?: number;
  /** ms of PTY silence after the prompt that signals response is complete. Default 3500. */
  idleMs?: number;
  /** Total timeout ms. Default 180000. */
  timeoutMs?: number;
  /** Extra env merged over the resolved shell env (e.g. the shared MemPalace). */
  env?: Record<string, string>;
}

export interface HiddenClaudeResult {
  ok: boolean;
  /** The assistant's final text response (stripped of any TUI framing). */
  text?: string;
  error?: string;
}

/**
 * Extract the last assistant text block from the transcript JSONL written
 * at or after `spawnedAt`. Reuses projectDir() from transcript.ts.
 */
function extractLastAssistantText(cwd: string, spawnedAt: number): string | null {
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return null;

    const candidates: { f: string; mtime: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const mtime = statSync(path.join(dir, f)).mtimeMs;
        // 5 s slack: include files that already existed at spawn but were
        // updated by this session. Sort by mtime and take the newest.
        if (mtime >= spawnedAt - 5000) candidates.push({ f, mtime });
      } catch { /* file removed between readdir and stat — skip */ }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);

    const lines = readFileSync(path.join(dir, candidates[0].f), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let rec: { type?: unknown; message?: { content?: unknown[] } };
      try { rec = JSON.parse(trimmed); } catch { continue; }
      if (rec.type !== 'assistant') continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j] as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return block.text.trim();
        }
      }
    }
    return null;
  } catch { return null; }
}

export function runHiddenClaude(prompt: string, opts: HiddenClaudeOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    if (!opts.cwd || !existsSync(opts.cwd)) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }

    const binary = (opts.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    const disallowed = opts.disallowedTools ?? ['Edit', 'Write', 'NotebookEdit'];
    const addDirs = (opts.addDirs ?? []).filter((d) => d && existsSync(d));

    const args: string[] = [
      '--model', opts.model,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', ...disallowed,
    ];
    for (const d of addDirs) { args.push('--add-dir', d); }

    const bootCapMs = opts.bootCapMs ?? 7000;
    const idleMs = opts.idleMs ?? 3500;
    const timeoutMs = opts.timeoutMs ?? 180_000;

    const spawnedAt = Date.now();
    // Windows: node-pty's CreateProcess can't exec the npm `.cmd`/extensionless
    // `claude` shim directly (ERROR_BAD_EXE_FORMAT, error 193) — route non-.exe
    // targets through cmd.exe. A real claude.exe (WinGet) launches directly. (#22)
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(exe);
    const spawnFile = winWrap ? (process.env.ComSpec || 'cmd.exe') : exe;
    const spawnArgs = winWrap ? ['/c', exe, ...args] : args;
    let ptyProc: pty.IPty;
    try {
      ptyProc = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd: opts.cwd,
        env: {
          ...process.env,
          PATH: userShellPath(),
          ...(opts.env ?? {}),
        } as Record<string, string>,
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let settled = false;
    let promptSent = false;
    let bootTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let bootMaxTimer: NodeJS.Timeout;
    let globalTimer: NodeJS.Timeout;

    const kill = () => { try { ptyProc.kill(); } catch { /* noop */ } };

    const finish = (r: HiddenClaudeResult) => {
      if (settled) return;
      settled = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      clearTimeout(bootMaxTimer);
      clearTimeout(globalTimer);
      kill();
      resolve(r);
    };

    const captureAndFinish = () => {
      const text = extractLastAssistantText(opts.cwd, spawnedAt);
      finish(text
        ? { ok: true, text }
        : { ok: false, error: 'no assistant response found in transcript' });
    };

    const sendPrompt = () => {
      if (settled || promptSent) return;
      promptSent = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      // Bracketed paste + enter — same mechanism as submitToPty in useHive.ts.
      ptyProc.write(`\x1b[200~${prompt}\x1b[201~`);
      setTimeout(() => { if (!settled) ptyProc.write('\r'); }, 140);
    };

    bootMaxTimer = setTimeout(sendPrompt, bootCapMs);
    globalTimer = setTimeout(
      () => finish({ ok: false, error: 'hidden session timed out' }),
      timeoutMs,
    );

    ptyProc.onData(() => {
      if (!promptSent) {
        // Boot phase: reset quiet timer; send prompt once output goes quiet.
        if (bootTimer) clearTimeout(bootTimer);
        bootTimer = setTimeout(sendPrompt, BOOT_QUIET_MS);
      } else {
        // Response phase: reset idle timer; capture when output settles.
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(captureAndFinish, idleMs);
      }
    });

    // Session exited cleanly before idle — try to capture the transcript anyway.
    ptyProc.onExit(() => { if (!settled) captureAndFinish(); });
  });
}
