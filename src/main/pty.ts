import * as pty from 'node-pty';
import type { WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface PtySession {
  id: string;
  proc: pty.IPty;
  cwd: string;
  command: string;
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
      try {
        const res = spawnSync('where', [command], { encoding: 'utf8', timeout: 3000, shell: true });
        const path = (res.stdout ?? '').trim().split(/\r?\n/)[0];
        if (path && existsSync(path)) return path;
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

      const proc = pty.spawn(resolved, opts.args ?? [], {
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

      this.sessions.set(opts.id, { id: opts.id, proc, cwd: opts.cwd, command: resolved });

      proc.onData((data) => {
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

  list(): Array<{ id: string; cwd: string; command: string; pid: number }> {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      cwd: s.cwd,
      command: s.command,
      pid: s.proc.pid
    }));
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
