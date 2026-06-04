import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// These helpers mirror the resolution logic in pty.ts. They exist separately so
// headless child processes (e.g. the enrichment assistant) can launch `claude`
// with the same PATH the user's interactive shell sees — Electron on macOS
// starts without the login-shell PATH, so a bare `claude` would otherwise fail
// with ENOENT in a packaged build.

let cachedPath: string | null = null;

/** The user's interactive-shell PATH, queried once and cached for the session. */
export function userShellPath(): string {
  if (cachedPath !== null) return cachedPath;
  // Windows has no interactive login-shell PATH problem — use the process PATH directly.
  if (process.platform === 'win32') {
    cachedPath = process.env.PATH || '';
    return cachedPath;
  }
  try {
    const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', 'echo -n "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000
    });
    cachedPath = res.stdout.trim() || process.env.PATH || '';
  } catch {
    cachedPath = process.env.PATH || '';
  }
  return cachedPath;
}

/** Resolve a bare command (e.g. 'claude') against the user's PATH + common
 *  install locations. Returns the input unchanged if it already looks like a path. */
export function resolveCommand(command: string): string {
  // Already an absolute/relative path (Unix `/` or Windows `\`) — pass through.
  if (command.includes('/') || command.includes('\\')) return command;
  if (process.platform === 'win32') {
    // `where` is the Windows equivalent of `which`; runs via cmd.exe (shell:true).
    try {
      const res = spawnSync('where', [command], { encoding: 'utf8', timeout: 3000, shell: true });
      const path = (res.stdout ?? '').trim().split(/\r?\n/)[0];
      if (path && existsSync(path)) return path;
    } catch { /* fall through */ }
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
    return command;
  }
  try {
    const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', `which ${command}`], {
      encoding: 'utf8',
      timeout: 3000
    });
    const path = res.stdout.trim().split('\n').pop();
    if (path && existsSync(path)) return path;
  } catch { /* fall through */ }
  const candidates = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    `${process.env.HOME ?? ''}/.local/bin/${command}`,
    `${process.env.HOME ?? ''}/.claude/local/${command}`,
    `${process.env.HOME ?? ''}/.volta/bin/${command}`
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return command;
}
