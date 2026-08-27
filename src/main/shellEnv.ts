import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// These helpers mirror the resolution logic in pty.ts. They exist separately so
// headless child processes can launch `claude` with the same PATH the user's
// interactive shell sees — Electron on macOS starts without the login-shell PATH,
// so a bare `claude` would otherwise fail
// with ENOENT in a packaged build.

let cachedPath: string | null = null;

/** script → captured output, memoised for the process lifetime. Every capture
 *  boots a full interactive login shell (rc files and all) — hundreds of ms of
 *  BLOCKING spawnSync on the main process — and shell PATH / binary locations
 *  don't change mid-session. Only successful captures are cached, so a null
 *  (shell failed / fence missing) stays retryable. */
const shellCapture = new Map<string, string>();

/** Run `script` in the user's INTERACTIVE login shell and return only what the
 *  script itself printed.
 *
 *  An interactive shell is required to pick up nvm/asdf/brew PATH edits, but it
 *  also runs the user's rc files, which are free to print. Some zsh setups emit
 *  `Restored session: <date>` from a session-save plugin BEFORE the script's
 *  own output, which silently poisons every value read back: a plain `.trim()`
 *  on `echo "$PATH"` yields `"Restored session: …\n/opt/homebrew/bin:…"` and
 *  that whole string gets handed to every agent as its PATH. Fencing the output
 *  between two markers makes rc-file chatter (before, after, or both)
 *  impossible to mistake for a result. Returns null when the shell fails or the
 *  fence never appears. */
export function captureFromLoginShell(script: string): string | null {
  const cached = shellCapture.get(script);
  if (cached !== undefined) return cached;
  const value = captureFromLoginShellUncached(script);
  if (value !== null) shellCapture.set(script, value);
  return value;
}

function captureFromLoginShellUncached(script: string): string | null {
  const mark = '__MD_SHELL_FENCE__';
  try {
    const res = spawnSync(
      process.env.SHELL ?? '/bin/zsh',
      ['-ilc', `printf %s ${mark}; ${script}; printf %s ${mark}`],
      { encoding: 'utf8', timeout: 3000 }
    );
    const out = res.stdout ?? '';
    const start = out.indexOf(mark);
    const end = out.lastIndexOf(mark);
    if (start < 0 || end <= start) return null;
    return out.slice(start + mark.length, end);
  } catch {
    return null;
  }
}

/** The user's interactive-shell PATH, queried once and cached for the session. */
export function userShellPath(): string {
  if (cachedPath !== null) return cachedPath;
  // Windows has no interactive login-shell PATH problem — use the process PATH directly.
  if (process.platform === 'win32') {
    cachedPath = process.env.PATH || '';
    return cachedPath;
  }
  const shellPath = captureFromLoginShell('printf %s "$PATH"')?.trim();
  // A PATH is a single colon-joined line. Anything multi-line is rc-file noise
  // that slipped the fence — fall back rather than hand the agent a corrupt
  // PATH it would carry into every subprocess it spawns.
  cachedPath = shellPath && !shellPath.includes('\n') ? shellPath : process.env.PATH || '';
  return cachedPath;
}

/** Resolve a bare command (e.g. 'claude') against the user's PATH + common
 *  install locations. Returns the input unchanged if it already looks like a path. */
/** A plain executable name — the only shape we resolve against the user's PATH.
 *  A resolver may interpolate this token into a shell (`$SHELL -ilc "… which
 *  <it> …"`), so it is constrained to characters that are unambiguously part of
 *  a binary name (`[A-Za-z0-9._+-]`); anything else is not a command name and is
 *  refused rather than resolved. Callers early-return real paths (containing `/`
 *  or `\`) before this, so the only input that reaches a resolver is meant to be
 *  a bare binary name. */
export function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(command);
}

export function resolveCommand(command: string): string {
  // Already an absolute/relative path (Unix `/` or Windows `\`) — pass through.
  if (command.includes('/') || command.includes('\\')) return command;
  // Not a plain command name → nothing to resolve. Returned unchanged so the
  // caller's spawn ENOENTs it, and no shell ever sees it.
  if (!isSafeCommandName(command)) return command;
  if (process.platform === 'win32') {
    // `where` is the Windows equivalent of `which`. No `shell:true`: the command
    // is already proven metacharacter-free above, and running `where` directly
    // (libuv resolves it to where.exe via PATHEXT) keeps cmd.exe out of the loop.
    try {
      const res = spawnSync('where', [command], { encoding: 'utf8', timeout: 3000 });
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
  const which = captureFromLoginShell(`which ${command}`);
  if (which) {
    const path = which.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (path && existsSync(path)) return path;
  }
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
