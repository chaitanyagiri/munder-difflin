import * as pty from 'node-pty';
import type { WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface PtySession {
  id: string;
  proc: pty.IPty;
  cwd: string;
  command: string;
  /** Epoch ms of the most recent byte this PTY emitted (bumped in onData). The
   *  heartbeat (Lane A #1) reads this for two things: floor-quiet detection (an
   *  agent printing/thinking counts as activity even before it writes a hive
   *  file) and the idle handshake that gates god's PTY nudge (never type into a
   *  PTY that produced output in the last few seconds = mid-stream). */
  lastOutputAt: number;
}

export interface SpawnOptions {
  id: string;
  cwd: string;
  command: string;       // e.g. 'claude'
  args?: string[];
  cols?: number;
  rows?: number;
  /** Extra environment for the child (merged over the resolved shell env). */
  env?: Record<string, string>;
}

/**
 * (#55) Build the single pre-escaped command-line STRING for routing a non-.exe
 * Windows target through cmd.exe. Returns the args portion only (everything after
 * `cmd.exe`), in Node's canonical `child_process` form:
 *
 *   /d /s /c "<target> <arg> <arg> ..."
 *
 * Each token (the resolved target + every user arg) is double-quoted only when it
 * contains a space/tab/quote, then the WHOLE inner command is wrapped in one more
 * outer quote pair. cmd.exe's `/s` strips exactly that outer pair and executes the
 * remainder literally, so a `C:\Program Files\...` target survives its space.
 *
 * This is handed to `pty.spawn(file, args, ...)` as a STRING, which node-pty treats
 * as a pre-escaped CommandLine and passes through VERBATIM (no per-arg re-escaping),
 * so the quoting here is never double-wrapped. Embedded `"` in a token is escaped as
 * `\"` (cmd's quote-escape) so a token like `a"b` round-trips.
 */
export function buildCmdCommandLine(resolved: string, args: string[]): string {
  const quoteToken = (s: string): string => {
    // Escape any embedded double-quote, then quote the token if it needs it.
    const escaped = s.replace(/"/g, '\\"');
    return /[ \t"]/.test(s) ? `"${escaped}"` : escaped;
  };
  const inner = [resolved, ...args].map(quoteToken).join(' ');
  return `/d /s /c "${inner}"`;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private webContents: WebContents | null = null;
  /** Fired when a PTY exits on its OWN (child finished/crashed/killed
   *  externally), so the main process can run the SAME lifecycle teardown
   *  (archive, worktree removal, map cleanup) that the explicit kill() path
   *  runs. Best-effort — set once by the main process. */
  private exitHandler: ((id: string) => void) | null = null;

  attachWebContents(wc: WebContents) {
    this.webContents = wc;
  }

  /** Register the natural-exit teardown callback. Invoked from inside node-pty's
   *  onExit after the session is cleaned up. */
  setExitHandler(handler: (id: string) => void): void {
    this.exitHandler = handler;
  }

  /** Send to the renderer only if it's still alive. During app quit, killing a
   *  PTY fires onExit asynchronously — by then app.quit() may have destroyed the
   *  window, and `.send()` on a destroyed webContents throws "Object has been
   *  destroyed", which surfaces as the main-process crash dialog. Guard it. */
  private safeSend(channel: string, payload: unknown): void {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch { /* window tore down mid-send */ }
  }

  /** Resolve a bare command (e.g. 'claude') against the user's PATH +
   *  common install locations. Needed because Electron's spawn env on
   *  macOS launches without the user's interactive shell PATH. */
  private resolveCommand(command: string): string {
    // Already an absolute/relative path (Unix `/` or Windows `\`) — pass through.
    if (command.includes('/') || command.includes('\\')) return command;
    if (process.platform === 'win32') {
      // `where` is the Windows equivalent of `which`; runs via cmd.exe (shell:true).
      // It can return MULTIPLE matches in PATH order; the first is often an
      // EXTENSIONLESS shim (bare `claude`). Skip extensionless hits and take
      // the first PATHEXT-eligible one (.CMD/.BAT/.EXE/…). NOTE: even .CMD/.BAT
      // files are not directly spawnable by node-pty's CreateProcess (error 193);
      // spawn() routes them through `cmd.exe /c` (see below).
      try {
        const res = spawnSync('where', [command], { encoding: 'utf8', timeout: 3000, shell: true });
        const lines = (res.stdout ?? '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const pathExts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';').map((e) => e.trim().toUpperCase()).filter(Boolean);
        const isExecutable = (p: string): boolean => {
          const dot = p.lastIndexOf('.');
          const sep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
          if (dot <= sep) return false; // no extension on the basename
          return pathExts.includes(p.slice(dot).toUpperCase());
        };
        const exe = lines.find((p) => isExecutable(p) && existsSync(p));
        if (exe) return exe;
      } catch { /* fall through */ }
      // Common Windows install locations (npm global = %APPDATA%\npm\<cmd>.cmd).
      const appData = process.env.APPDATA ?? '';
      const localAppData = process.env.LOCALAPPDATA ?? '';
      const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
      const winCandidates = [
        `${appData}\\npm\\${command}.cmd`,
        `${appData}\\npm\\${command}`,
        `${localAppData}\\Programs\\claude\\${command}.exe`,
        `${home}\\.claude\\local\\${command}.cmd`,
        `${home}\\.claude\\local\\${command}`
      ];
      for (const c of winCandidates) if (existsSync(c)) return c;
      // Last resort — let node-pty try; will fail with ENOENT if missing.
      return command;
    }
    // macOS / Linux — `which` against an interactive shell so we pick up nvm/asdf/brew paths.
    try {
      const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', `which ${command}`], {
        encoding: 'utf8',
        timeout: 3000
      });
      const path = res.stdout.trim().split('\n').pop();
      if (path && existsSync(path)) return path;
    } catch { /* fall through */ }
    // Common explicit locations
    const candidates = [
      `/opt/homebrew/bin/${command}`,
      `/usr/local/bin/${command}`,
      `${process.env.HOME ?? ''}/.local/bin/${command}`,
      `${process.env.HOME ?? ''}/.claude/local/${command}`,
      `${process.env.HOME ?? ''}/.volta/bin/${command}`
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    // Last resort — let node-pty try; will fail with ENOENT if missing.
    return command;
  }

  spawn(opts: SpawnOptions): { ok: boolean; error?: string } {
    if (this.sessions.has(opts.id)) {
      return { ok: false, error: `pty already exists for id ${opts.id}` };
    }
    if (!existsSync(opts.cwd)) {
      return { ok: false, error: `cwd does not exist: ${opts.cwd}` };
    }
    const resolved = this.resolveCommand(opts.command);
    try {
      // Build a user-shell PATH so child can resolve subprocess deps.
      const userPath = (() => {
        // Windows has no interactive login-shell PATH problem — use the process PATH directly.
        if (process.platform === 'win32') return process.env.PATH || '';
        try {
          const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', 'echo -n "$PATH"'], {
            encoding: 'utf8',
            timeout: 3000
          });
          return res.stdout.trim() || process.env.PATH || '';
        } catch {
          return process.env.PATH || '';
        }
      })();

      // On Windows, .cmd/.bat files (and extensionless shims) cannot be executed
      // directly by CreateProcess — only .exe/.com can. Route them through cmd.exe.
      const isWin = process.platform === 'win32';
      const lower = resolved.toLowerCase();
      const directExe = lower.endsWith('.exe') || lower.endsWith('.com');
      const needsCmd = isWin && !directExe;
      const file = needsCmd ? (process.env.ComSpec || 'cmd.exe') : resolved;
      // #55: when routing through cmd.exe we must NOT pass `resolved` as a bare,
      // unquoted array element. A Program-Files path (`C:\Program Files\nodejs\node`)
      // would split on its space under cmd.exe → "C:\Program is not recognized" and
      // every Windows agent terminal dies. Build a single, fully-quoted command line
      // and hand it to node-pty as a STRING (not an array): node-pty's
      // argsToCommandLine() only re-escapes ARRAY args; a string is passed through
      // verbatim (isCommandLine === true → `file + " " + args`), so our quoting is
      // never double-wrapped. We mirror Node's own child_process form,
      // `cmd.exe /d /s /c "<command>"`, wrapping the WHOLE inner command in one outer
      // quote pair — cmd's /s flag strips exactly that pair and runs the remainder
      // (where the resolved path keeps its own quotes) literally. /d skips AutoRun.
      const spawnArgs: string[] | string = needsCmd
        ? buildCmdCommandLine(resolved, opts.args ?? [])
        : (opts.args ?? []);
      const proc = pty.spawn(file, spawnArgs, {
        name: 'xterm-256color',
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30,
        cwd: opts.cwd,
        env: {
          ...process.env,
          PATH: userPath,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          // Help apps that look for a real interactive shell
          FORCE_COLOR: '1',
          // Per-agent hive identity (AGENT_ID, HIVE_ROOT, …) when provided.
          ...(opts.env ?? {})
        } as Record<string, string>
      });

      this.sessions.set(opts.id, { id: opts.id, proc, cwd: opts.cwd, command: resolved, lastOutputAt: Date.now() });

      proc.onData((data) => {
        const s = this.sessions.get(opts.id);
        if (s) s.lastOutputAt = Date.now();
        this.safeSend(`pty:data:${opts.id}`, data);
      });
      proc.onExit(({ exitCode, signal }) => {
        this.safeSend(`pty:exit:${opts.id}`, { exitCode, signal });
        this.sessions.delete(opts.id);
        // Natural exit must run the same lifecycle teardown as an explicit kill.
        // Guarded so a teardown error can never crash node-pty's exit callback.
        try { this.exitHandler?.(opts.id); } catch { /* never throw out of onExit */ }
      });

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  write(id: string, data: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.write(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  resize(id: string, cols: number, rows: number): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.resize(cols, rows);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  kill(id: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.kill();
      this.sessions.delete(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  list(): Array<{ id: string; cwd: string; command: string; pid: number; lastOutputAt: number }> {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      cwd: s.cwd,
      command: s.command,
      pid: s.proc.pid,
      lastOutputAt: s.lastOutputAt
    }));
  }

  /** Epoch ms of this PTY's most recent output, or undefined if no such PTY. */
  lastOutputAt(id: string): number | undefined {
    return this.sessions.get(id)?.lastOutputAt;
  }

  /** Milliseconds since this PTY last produced output (Date.now() - lastOutputAt),
   *  or undefined if no such PTY. The idle handshake: large value = safe to type. */
  idleFor(id: string): number | undefined {
    const s = this.sessions.get(id);
    return s ? Date.now() - s.lastOutputAt : undefined;
  }

  /** Bulk-kill every PTY for app quit / reset. This is wholesale shutdown, not
   *  individual agent lifecycle, so it suppresses the natural-exit teardown —
   *  we don't want to archive every agent or fire a storm of `git worktree
   *  remove` while the process is tearing down. */
  killAll() {
    this.exitHandler = null;
    for (const s of this.sessions.values()) {
      try { s.proc.kill(); } catch { /* noop */ }
    }
    this.sessions.clear();
  }
}
