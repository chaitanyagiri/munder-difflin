import * as pty from 'node-pty';
import type { WebContents } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureKilled, hardKillTree } from './procKill';
import { expandTilde } from './fs';
import { buildPtyEnv } from './ptyEnv';
import { captureFromLoginShell, userShellPath } from './shellEnv';
import { isCbcodeCommand } from '../shared/agentProvider';

/** APPEND the hive's bundled-node dir (`<HIVE_ROOT>/bin/runtime`, which holds a
 *  shim literally named `node`) to a child's PATH.
 *
 *  Layer 1 routed the commands WE generate through `hive-node`. This covers the
 *  ones we don't: an MCP server declared as `node ./server.js`, a provider CLI
 *  that shells out to node, a helper script the agent wrote itself. With no
 *  system node those all die with 127 — the same bug, one level down.
 *
 *  APPENDED, never prepended: a user who has their own node keeps it, and we are
 *  only the fallback. Prepending would silently swap the node version under the
 *  user's own projects for Electron's, which is a different (and wrong) product
 *  decision. No-ops when there is no hive root or the dir was never written. */
export function withHiveRuntimeFallback(path: string, hiveRoot?: string): string {
  if (!hiveRoot) return path;
  const dir = join(hiveRoot, 'bin', 'runtime');
  if (!existsSync(dir)) return path;
  const entries = path.split(delimiter).filter(Boolean);
  if (entries.includes(dir)) return path; // re-spawn of a live agent
  return [...entries, dir].join(delimiter);
}

interface PtySession {
  id: string;
  proc: pty.IPty;
  cwd: string;
  command: string;
  /** The window (webContents) that spawned this PTY and should receive its
   *  output. Multi-window: each floor owns its own terminals, so `pty:data:<id>`
   *  / `pty:exit:<id>` route ONLY here — never broadcast — so one floor's stream
   *  never leaks into another. Null falls back to the default attached sink
   *  (the primary window), preserving single-window behavior. */
  owner: WebContents | null;
  /** Epoch ms of the most recent byte this PTY emitted (bumped in onData). The
   *  heartbeat (Lane A #1) reads this for two things: floor-quiet detection (an
   *  agent printing/thinking counts as activity even before it writes a hive
   *  file) and the idle handshake that gates god's PTY nudge (never type into a
   *  PTY that produced output in the last few seconds = mid-stream). */
  lastOutputAt: number;
  /** True after the child has emitted at least one frame. Automation waits for
   *  this before typing, so startup prompts cannot outrun the TUI subscription. */
  hasOutput: boolean;
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
  /** When set, run this string as a VISIBLE shell script instead of resolving/
   *  spawning `command`. Used by the missing-CLI auto-install path: the script
   *  (a banner + an install command) streams to the same Terminal tab. Routed
   *  through `$SHELL -lc` on unix and `cmd.exe /d /s /c` on Windows. The script
   *  MUST contain no embedded double-quotes (it is wrapped verbatim on Windows).
   *  `command` is still recorded for display but is not executed. */
  shellScript?: string;
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
 * so the quoting here is never double-wrapped.
 *
 * ⚠️ LAST-RESORT PATH — DO NOT PUT AN AGENT PROMPT THROUGH IT. Two hard limits of
 * cmd.exe's parser that no amount of escaping here can work around:
 *
 *  1. **cmd.exe has NO backslash escape.** An earlier version of this comment
 *     claimed `\"` was "cmd's quote-escape". It is not: to cmd, `\` is an ordinary
 *     character and every `"` TOGGLES quote state. So `\"` does not embed a quote —
 *     it closes (or opens) the quoted run and dumps everything after it back into
 *     bare, metacharacter-interpreting context. The `\"` produced below survives
 *     only because the CRT of the *final* program un-escapes it; the intermediate
 *     cmd.exe still mis-tracks quote state across it.
 *  2. **A newline can never survive.** cmd.exe treats CR/LF as a statement
 *     separator before quoting is even considered, so a multi-line argument is
 *     TRUNCATED at its first newline and the remainder is executed as commands.
 *     That is exactly how the Windows hive protocol prompt (multi-line, full of
 *     `(`/`)` which cmd reads as block delimiters) was being destroyed: the agent
 *     booted looking healthy but never received the HIVE PROTOCOL block, so it
 *     never knew its inbox/outbox existed and no agent could message another.
 *
 * There is also cmd.exe's ~8191-character command-line ceiling, which the injected
 * hive prompt (~6.1k chars) sits uncomfortably close to.
 *
 * Prompt-carrying spawns therefore go through `parseNpmCmdShim` instead (spawn the
 * shim's real interpreter with an ARRAY of args, so node-pty's own CRT-correct
 * `argsToCommandLine` runs and no shell parser is involved). This function remains
 * the fallback for every target we cannot decode — strictly no worse than before.
 */
export function buildCmdCommandLine(resolved: string, args: string[]): string {
  const quoteToken = (s: string): string => {
    // Escape any embedded double-quote, then quote the token if it needs it.
    // Quote on whitespace/quote AND on cmd.exe metacharacters (& | ^ < > ( ) % !):
    // an unquoted `&`/`|`/etc. would let one token chain a second command once this
    // string is executed by cmd.exe. Quoting neutralizes them — cmd does not
    // interpret metacharacters inside a double-quoted run.
    const escaped = s.replace(/"/g, '\\"');
    return /[ \t"&|^<>()%!]/.test(s) ? `"${escaped}"` : escaped;
  };
  const inner = [resolved, ...args].map(quoteToken).join(' ');
  return `/d /s /c "${inner}"`;
}

/** What an npm-style Windows `.cmd` shim actually runs, decoded from its text. */
export interface NpmShimTarget {
  /** BARE interpreter name — `node`, `bun` or `deno` — to be resolved off PATH by
   *  the caller (kept bare deliberately: see parseNpmCmdShim), or NULL when the
   *  shim runs a native executable directly and there is no interpreter at all. */
  interpreter: string | null;
  /** Absolute, normalized win32 path to the script that interpreter should run —
   *  or to the executable itself when `interpreter` is null. */
  scriptPath: string;
}

/** Interpreters we are willing to spawn directly. Deliberately a tiny allowlist:
 *  anything else (a hand-written batch file, a python/ruby shim, a shape we have
 *  not seen) resolves to null and falls back to the cmd.exe path — never worse
 *  than today's behaviour. */
const SHIM_INTERPRETERS = new Set(['node', 'bun', 'deno']);
/** The shim's target must look like a JS entry point. A shim that points at
 *  something else is not a shape we understand → null. */
const SHIM_SCRIPT_EXT = /\.(?:c|m)?js$/i;

/**
 * Decode an npm-generated Windows `.cmd` shim into the interpreter + script it
 * would have run. PURE (no filesystem, no `process.platform`): it takes the shim's
 * path and its CONTENT so it is unit-testable on macOS/Linux, where every Windows
 * build is authored.
 *
 * WHY THIS EXISTS. On Windows a `.cmd`/`.bat` cannot be handed to CreateProcess,
 * so the spawn path used to route it through `cmd.exe /d /s /c "<line>"`. That
 * turns argv into a single string parsed by cmd.exe — which cannot carry a newline
 * (statement separator), reads `(`/`)` as block delimiters, has no backslash escape,
 * and caps out near 8191 chars. The hive protocol prompt is a ~6.1k-char, 11-line,
 * 62-paren argument, so on Windows it was truncated at its first newline: every
 * npm-installed CLI (OpenCode always; `claude.cmd` whenever there is no native
 * `claude.exe`) started up looking perfectly healthy but never received the HIVE
 * PROTOCOL block, never learned that `inbox/`/`outbox/` existed, and so no agent
 * ever heard from another. Claude appeared to work only because its native
 * `claude.exe` skipped cmd.exe entirely.
 *
 * Spawning the shim's own interpreter with an ARRAY of args removes cmd.exe from
 * the picture: node-pty's `argsToCommandLine` applies MSDN/CRT escaping (backslash
 * doubling before a quote, whole-arg quoting on whitespace) and hands the result
 * straight to CreateProcess, which passes the raw command line to the child. A
 * newline inside a quoted CRT argument is just a character there, and the limit
 * becomes CreateProcess's 32767 rather than cmd's 8191.
 *
 * SHAPES HANDLED (npm's cmd-shim, across its historical revisions; pnpm/yarn emit
 * the same families):
 *
 *   modern (cmd-shim ≥4 / npm ≥7) — dp0 captured into a variable, program chosen
 *   into %_prog%, single trailing exec line:
 *       SET dp0=%~dp0
 *       IF EXIST "%dp0%\node.exe" ( SET "_prog=%dp0%\node.exe" ) ELSE ( SET "_prog=node" … )
 *       endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
 *
 *   classic (cmd-shim 2/3, npm 5/6) — IF/ELSE with the exec inlined in both arms:
 *       @IF EXIST "%~dp0\node.exe" (
 *         "%~dp0\node.exe"  "%~dp0\node_modules\pkg\bin\cli.js" %*
 *       ) ELSE ( … node  "%~dp0\node_modules\pkg\bin\cli.js" %* )
 *
 *   ancient single-line:
 *       @"%~dp0\node.exe"  "%~dp0\node_modules\pkg\bin\cli.js" %*
 *
 * The interpreter is returned BARE (`node`), not as the shim's `%dp0%\node.exe`
 * candidate, on purpose: that candidate only exists for an npm install that ships a
 * colocated node, and that directory is on PATH by construction — so resolving the
 * bare name finds the same binary while also going through the caller's existing
 * PATH/candidate-dir resolution and cache.
 *
 * Returns null — meaning "fall back to the cmd.exe path" — for ANY shape that is
 * not fully understood: unknown interpreter, unexpanded `%VAR%` left in the target,
 * a relative target, extra interpreter flags we would otherwise silently drop, a
 * non-JS target, a file too large to be a shim, or plain garbage.
 */
export function parseNpmCmdShim(shimPath: string, content: string): NpmShimTarget | null {
  if (typeof shimPath !== 'string' || typeof content !== 'string') return null;
  if (!shimPath || !content) return null;
  // A cmd-shim is ~1KB. Anything larger is somebody's real batch script (or a
  // binary someone named `.cmd`) and is not ours to reinterpret.
  if (content.length > 8192 || content.includes('\0')) return null;

  // win32.* explicitly — these paths are Windows paths regardless of the host we
  // are running (or testing) on.
  const dir = win32.dirname(shimPath);
  if (!dir || dir === '.') return null;

  /** Expand a shim token's `%~dp0` / `%dp0%` (the shim's OWN directory, which cmd
   *  expands WITH a trailing backslash) into an absolute, normalized path. Any
   *  other surviving `%` means a variable we did not model → refuse. */
  const expand = (raw: string): string | null => {
    let s = raw.replace(/%~dp0%?|%dp0%/gi, `${dir}\\`);
    if (s.includes('%')) return null;
    if (!s.trim()) return null;
    // `<dir>\` + `\node_modules\…` produces a doubled separator that Windows
    // tolerates; collapse it so the path we hand to existsSync is clean. A leading
    // UNC `\\server\share` prefix must survive that collapse.
    const unc = /^[\\/]{2}/.test(s);
    s = s.replace(/[\\/]+/g, '\\');
    if (unc) s = `\\${s}`;
    if (!win32.isAbsolute(s)) return null;
    return win32.normalize(s);
  };

  // Every `SET "_prog=…"` the shim performs (the IF-EXISTS arm and the PATH arm).
  const progValues: string[] = [];
  for (const m of content.matchAll(/^\s*@?SET\s+"?_prog=([^"\r\n]*)"?/gim)) progValues.push(m[1]);

  // The exec line is the LAST line carrying `%*` (cmd's "forward all args"): in the
  // modern shim that is the single `endLocal & … & "%_prog%" "<script>" %*` line;
  // in the classic IF/ELSE shim it is the ELSE arm, which runs the same script.
  const lines = content.split(/\r?\n/);
  let execLine: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('%*')) { execLine = lines[i]; break; }
  }
  if (!execLine) return null;

  const head = execLine.slice(0, execLine.lastIndexOf('%*'));
  const quoted = [...head.matchAll(/"([^"]*)"/g)].map((m) => ({
    text: m[1],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length
  }));
  if (quoted.length === 0) return null;

  const scriptTok = quoted[quoted.length - 1];
  // Locate the program token and PROVE nothing sits between it and the script.
  // Interpreter flags baked into a shebang (`#!/usr/bin/env node --flag`) land
  // there; dropping them silently would change how the CLI runs, so we bail out
  // to the cmd.exe fallback instead.
  let progRaw: string;
  if (quoted.length >= 2) {
    const progTok = quoted[quoted.length - 2];
    if (head.slice(progTok.end, scriptTok.start).trim() !== '') return null;
    progRaw = progTok.text;
  } else {
    // Two one-token shapes share this branch, told apart by what precedes the quote.
    const before = head.slice(0, scriptTok.start).trim().replace(/^@/, '').trim();
    if (before === '') {
      // DIRECT-EXECUTABLE shim: nothing before the quoted target, so there is no
      // interpreter — the shim runs a native binary. npm writes this whenever the
      // package's bin has no shebang, which is the norm for a compiled CLI:
      //
      //   "%dp0%\..\opencode-ai\bin\opencode.exe"   %*
      //
      // opencode-ai is exactly that (its bin is ./bin/opencode.exe, a real
      // binary), so EVERY Windows OpenCode install hit this shape, fell through to
      // null, and got the cmd.exe fallback that truncates the hive protocol at its
      // first newline. The agent then booted looking healthy with no idea it had
      // an inbox. Handing the binary straight to CreateProcess with an argv array
      // is strictly better than routing it through cmd.exe — same program, no
      // shell parser in between.
      const exe = expand(scriptTok.text);
      if (!exe) return null;
      // Only a real executable. Anything else here is a shape we have not modelled.
      if (!/\.(exe|com)$/i.test(exe)) return null;
      return { interpreter: null, scriptPath: exe };
    }
    // Classic ELSE arm: `node  "<script>" %*` — the program is an unquoted word.
    const word = before.split(/\s+/).filter(Boolean).pop();
    if (!word || word !== before) return null; // anything else before it → unknown shape
    progRaw = word;
  }

  // `"%_prog%"` → the value the shim SET. Prefer the bare-name arm (the PATH
  // fallback); a `%dp0%\node.exe` value still reduces to the same basename below.
  if (/^%_prog%$/i.test(progRaw)) {
    if (progValues.length === 0) return null;
    progRaw = progValues.find((v) => !/[%\\/]/.test(v)) ?? progValues[progValues.length - 1];
  }
  const interpreter = (progRaw.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  if (!SHIM_INTERPRETERS.has(interpreter)) return null;

  const scriptPath = expand(scriptTok.text);
  if (!scriptPath || !SHIM_SCRIPT_EXT.test(scriptPath)) return null;
  return { interpreter, scriptPath };
}

export function normalizePermissionMode(resolved: string, args: string[]): string[] {
  if (!isCbcodeCommand(resolved)) return args;
  return args.map((a, i) => {
    if (a === 'bypassPermissions' && args[i - 1] === '--permission-mode') return 'auto';
    if (a === '--permission-mode=bypassPermissions') return '--permission-mode=auto';
    return a;
  });
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private webContents: WebContents | null = null;
  /** Fired when a PTY exits on its OWN (child finished/crashed/killed
   *  externally), so the main process can run the SAME lifecycle teardown
   *  (archive, worktree removal, map cleanup) that the explicit kill() path
   *  runs. Best-effort — set once by the main process. */
  private exitHandler: ((id: string, exitCode?: number) => void) | null = null;

  /** The default/fallback output sink — set to the PRIMARY window. Used only for
   *  sessions with no recorded owner; owned sessions route to their owner. */
  attachWebContents(wc: WebContents) {
    this.webContents = wc;
  }

  /** Count live PTYs owned by a given window — used to scope a floor's
   *  close-confirmation to its OWN terminals, not the whole app's. */
  countByOwner(wc: WebContents): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.owner === wc) n++;
    return n;
  }

  /** Kill every PTY owned by a window (its onExit runs the normal teardown:
   *  archive + worktree cleanup). Called when a floor window closes so its
   *  terminals don't linger as orphaned processes writing to a dead webContents. */
  killByOwner(wc: WebContents): void {
    for (const [id, s] of [...this.sessions.entries()]) {
      if (s.owner === wc) {
        try {
          const pid = s.proc.pid;
          s.proc.kill();
          ensureKilled(pid);
        } catch { /* already gone */ }
        void id;
      }
    }
  }

  /** Register the natural-exit teardown callback. Invoked from inside node-pty's
   *  onExit after the session is cleaned up. The exit code is forwarded so the
   *  handler can distinguish a clean exit (e.g. a successful first-time CLI
   *  install → auto restart-and-continue) from a crash. */
  setExitHandler(handler: (id: string, exitCode?: number) => void): void {
    this.exitHandler = handler;
  }

  /** Send to the renderer only if it's still alive. During app quit, killing a
   *  PTY fires onExit asynchronously — by then app.quit() may have destroyed the
   *  window, and `.send()` on a destroyed webContents throws "Object has been
   *  destroyed", which surfaces as the main-process crash dialog. Guard it. */
  private safeSend(channel: string, payload: unknown, target?: WebContents | null): void {
    // Route to the session's owner window when known (multi-window: keeps each
    // floor's stream private); fall back to the default attached sink otherwise.
    const wc = target ?? this.webContents;
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch { /* window tore down mid-send */ }
  }

  /** Whether an engine CLI is actually installed/locatable on this machine.
   *  Used PRE-SPAWN by the missing-CLI auto-install path: a bare `claude`/`codex`
   *  that resolveCommand can't locate would otherwise be spawned and die with
   *  "process exited (code 1)". Reuses the exact same `which`/`where` +
   *  candidate-dir logic as spawn(), so detection and spawning never disagree. */
  isCommandAvailable(command: string): boolean {
    return this.resolveCommand(command).found;
  }

  /** The absolute path a bare command resolves to for THIS user, or null when it
   *  isn't installed. Same resolution + cache as spawn(), so a caller that probes
   *  a binary (e.g. `node --version`, to decide whether it is too old to keep)
   *  inspects exactly the executable an agent would have run. */
  commandPath(command: string): string | null {
    const r = this.resolveCommand(command);
    return r.found ? r.path : null;
  }

  /** Session cache of SUCCESSFUL command resolutions. Each miss costs a full
   *  interactive-shell launch (`$SHELL -ilc which …` sources the user's whole
   *  zshrc — nvm/asdf init is routinely ~1s) run synchronously on the main
   *  process, and every agent spawn used to pay it TWICE (pre-check + spawn) —
   *  a multi-second all-windows freeze per spawn, ×N on a team restore.
   *  Negatives are deliberately NOT cached: the missing-CLI auto-install path
   *  must see a just-installed binary on its re-check. */
  private readonly resolvedCommands = new Map<string, { path: string; found: boolean }>();

  /** Resolve a bare command (e.g. 'claude') against the user's PATH +
   *  common install locations. Needed because Electron's spawn env on
   *  macOS launches without the user's interactive shell PATH. Returns the
   *  best path AND whether an existing executable was actually located (`found`):
   *  when nothing is found, `path` falls back to the bare command (spawn would
   *  ENOENT) and `found` is false — the signal the missing-CLI path keys on. */
  private resolveCommand(command: string): { path: string; found: boolean } {
    const cached = this.resolvedCommands.get(command);
    // Trust a positive hit only while the binary still exists (uninstall/update
    // between spawns must re-probe rather than hand out a dead path).
    if (cached && existsSync(cached.path)) return cached;
    const res = this.resolveCommandUncached(command);
    if (res.found) this.resolvedCommands.set(command, res);
    else this.resolvedCommands.delete(command);
    return res;
  }

  private resolveCommandUncached(command: string): { path: string; found: boolean } {
    // Already an absolute/relative path (Unix `/` or Windows `\`) — pass through;
    // `found` reflects whether that path actually exists on disk.
    if (command.includes('/') || command.includes('\\')) return { path: command, found: existsSync(command) };
    if (process.platform === 'win32') {
      // `where` is the Windows equivalent of `which`; runs via cmd.exe (shell:true).
      // It can return MULTIPLE matches in PATH order; the first is often an
      // EXTENSIONLESS shim (bare `claude`). Skip extensionless hits and take
      // the first PATHEXT-eligible one (.CMD/.BAT/.EXE/…). NOTE: even .CMD/.BAT
      // files are not directly spawnable by node-pty's CreateProcess (error 193);
      // spawn() either decodes the shim to its real interpreter or, failing that,
      // routes it through `cmd.exe /c` (see resolveWindowsShimSpawn below).
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
        if (exe) return { path: exe, found: true };
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
      for (const c of winCandidates) if (existsSync(c)) return { path: c, found: true };
      // Last resort — let node-pty try; will fail with ENOENT if missing.
      return { path: command, found: false };
    }
    // macOS / Linux — `which` against an interactive shell so we pick up nvm/asdf/brew paths.
    // Fenced capture (shellEnv): rc-file chatter can't poison the which output.
    const which = captureFromLoginShell(`which ${command}`);
    if (which) {
      const path = which.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (path && existsSync(path)) return { path, found: true };
    }
    // Common explicit locations
    const candidates = [
      `/opt/homebrew/bin/${command}`,
      `/usr/local/bin/${command}`,
      `${process.env.HOME ?? ''}/.local/bin/${command}`,
      `${process.env.HOME ?? ''}/.claude/local/${command}`,
      `${process.env.HOME ?? ''}/.volta/bin/${command}`
    ];
    for (const c of candidates) if (existsSync(c)) return { path: c, found: true };
    // Last resort — let node-pty try; will fail with ENOENT if missing.
    return { path: command, found: false };
  }

  /**
   * WINDOWS ONLY. Decide whether `resolved` is an npm-style shim we can spawn
   * DIRECTLY (its real interpreter + script, as an argv ARRAY) instead of routing
   * it through `cmd.exe /d /s /c "<one big string>"`.
   *
   * The cmd.exe route destroys any multi-line argument (see buildCmdCommandLine),
   * which is what silently stripped the HIVE PROTOCOL block out of every
   * npm-installed agent CLI's system prompt on Windows — agents booted fine and
   * then never messaged each other because they never learned inbox/outbox exist.
   *
   * Returns null for anything not fully understood, and EVERY failure mode here
   * (not a shim, unreadable, unknown shape, script missing on disk, interpreter
   * not installed or itself not a real .exe) degrades to exactly today's cmd.exe
   * behaviour. Never throws.
   */
  private resolveWindowsShimSpawn(resolved: string): { file: string; script: string | null } | null {
    if (process.platform !== 'win32') return null;
    try {
      const lower = resolved.toLowerCase();
      // The `.cmd` IS the shim. An extensionless npm shim (`%APPDATA%\npm\claude`)
      // is a POSIX **sh** script that cmd.exe cannot run at all; npm always writes a
      // `.cmd` sibling naming the same target, so read that instead — strictly an
      // improvement over handing sh syntax to cmd.exe.
      const shimPath = lower.endsWith('.cmd') || lower.endsWith('.bat')
        ? resolved
        : (existsSync(`${resolved}.cmd`) ? `${resolved}.cmd` : null);
      if (!shimPath) return null;
      const st = statSync(shimPath);
      if (!st.isFile() || st.size > 8192) return null;

      const target = parseNpmCmdShim(shimPath, readFileSync(shimPath, 'utf8'));
      if (!target) return null;
      // The shim can outlive the package it points at (a half-removed global
      // install). Falling back to cmd.exe then at least reproduces today's error.
      if (!existsSync(target.scriptPath)) return null;

      // Direct-executable shim: the target IS the program. No interpreter to
      // resolve, and no script argument to prepend — spawning it with an argv
      // array is exactly what the cmd.exe route was standing in the way of.
      if (target.interpreter === null) {
        return { file: target.scriptPath, script: null };
      }

      const interp = this.resolveCommand(target.interpreter);
      if (!interp.found) return null;
      // Must be a REAL executable: if `node` itself only resolves to a `.cmd`
      // (e.g. our own bundled-runtime shim appended to PATH), spawning it directly
      // would hit the very CreateProcess limitation we are routing around.
      const il = interp.path.toLowerCase();
      if (!il.endsWith('.exe') && !il.endsWith('.com')) return null;

      return { file: interp.path, script: target.scriptPath };
    } catch {
      return null; // unreadable/racing shim — fall back, never break the spawn
    }
  }

  spawn(opts: SpawnOptions, owner: WebContents | null = null): { ok: boolean; error?: string } {
    if (this.sessions.has(opts.id)) {
      return { ok: false, error: `pty already exists for id ${opts.id}` };
    }
    // Defense-in-depth: cwd is already tilde-expanded at ingestion (spawnAgentCore),
    // but any other caller reaching the PTY directly gets the same treatment —
    // `existsSync('~/dev/foo')` is always false, only a shell expands `~`.
    opts = { ...opts, cwd: expandTilde(opts.cwd) };
    if (!existsSync(opts.cwd)) {
      return { ok: false, error: `cwd does not exist: ${opts.cwd}` };
    }
    const resolved = this.resolveCommand(opts.command).path;
    if (opts.args) opts.args = normalizePermissionMode(resolved, opts.args);
    try {
      // Build a user-shell PATH so child can resolve subprocess deps. Cached
      // for the session (shellEnv.userShellPath, fenced against rc-file noise) —
      // the interactive-shell launch it replaces cost ~1s of main-thread freeze
      // on EVERY spawn.
      const userPath = withHiveRuntimeFallback(
        process.platform === 'win32' ? (process.env.PATH || '') : userShellPath(),
        opts.env?.HIVE_ROOT
      );

      // On Windows, .cmd/.bat files (and extensionless shims) cannot be executed
      // directly by CreateProcess — only .exe/.com can. Two ways out, in order of
      // preference: (1) decode an npm shim to the interpreter + script it wraps and
      // spawn THAT with an argv array (correct escaping, newlines survive); or
      // (2) the legacy fallback, route the whole thing through cmd.exe as one
      // pre-escaped string (loses newlines — see buildCmdCommandLine).
      const isWin = process.platform === 'win32';
      const lower = resolved.toLowerCase();
      const directExe = lower.endsWith('.exe') || lower.endsWith('.com');
      const needsCmd = isWin && !directExe;
      // Prefer decoding an npm shim to its interpreter over the cmd.exe route (see
      // resolveWindowsShimSpawn). win32-only and null-on-anything-unexpected, so
      // macOS/Linux and every undecodable Windows target keep today's behaviour.
      // Skipped entirely for a shellScript spawn, which never executes `resolved`.
      const shimSpawn = needsCmd && typeof opts.shellScript !== 'string'
        ? this.resolveWindowsShimSpawn(resolved)
        : null;
      let file: string;
      let spawnArgs: string[] | string;
      if (typeof opts.shellScript === 'string') {
        // Missing-CLI auto-install: run a banner + install command through the
        // platform shell so it streams to this same Terminal tab. On Windows we
        // hand cmd.exe a verbatim STRING (`/d /s /c "<script>"`) — node-pty passes
        // strings through unescaped, and `/s` strips exactly the outer quote pair,
        // so the `&`-chained script runs as-is (the script carries no embedded `"`).
        // On unix we use `$SHELL -lc <script>` (login, non-interactive): npm is
        // already on PATH because spawn() sets env.PATH to the captured interactive
        // shell PATH (nvm/asdf/brew included), and skipping `-i` avoids dumping the
        // user's interactive-rc session-restore noise into the install terminal. The
        // script is one argv element, so no shell-quoting is needed here.
        if (isWin) {
          file = process.env.ComSpec || 'cmd.exe';
          spawnArgs = `/d /s /c "${opts.shellScript}"`;
        } else {
          file = process.env.SHELL || '/bin/sh';
          spawnArgs = ['-lc', opts.shellScript];
        }
      } else if (needsCmd && shimSpawn) {
        // WINDOWS, npm-shim target: spawn the shim's own interpreter with an ARRAY
        // of args. node-pty then runs its `argsToCommandLine` (MSDN/CRT escaping:
        // backslash doubling before a quote, whole-arg quoting on whitespace) and
        // hands the result straight to CreateProcess — no shell parser anywhere in
        // the chain. That is what lets the hive protocol prompt through intact:
        // its newlines, parentheses and embedded quotes are just characters inside
        // one quoted CRT argument, and the ceiling becomes CreateProcess's 32767
        // instead of cmd.exe's 8191. Routing the same prompt through cmd.exe
        // truncated it at the first newline, which is why Windows agents never
        // learned they had an inbox/outbox and could not message each other.
        file = shimSpawn.file;
        // `script` is null for a direct-executable shim — there is nothing to
        // prepend, the args go straight to the binary.
        spawnArgs = shimSpawn.script === null
          ? [...(opts.args ?? [])]
          : [shimSpawn.script, ...(opts.args ?? [])];
      } else {
        file = needsCmd ? (process.env.ComSpec || 'cmd.exe') : resolved;
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
        spawnArgs = needsCmd
          ? buildCmdCommandLine(resolved, opts.args ?? [])
          : (opts.args ?? []);
        // The cmd.exe fallback is LOSSY and was previously SILENT, which is how a
        // Windows agent could look perfectly healthy while never having received
        // the hive protocol: cmd.exe cuts a multi-line argument at its first
        // newline, and the whole protocol block rides on one such argument.
        // resolveWindowsShimSpawn returns null for any shim shape it does not
        // fully understand, so this path is reachable on a real machine while
        // every unit test passes. Say so, loudly, with the two facts needed to
        // diagnose it: which target refused to decode, and whether a multi-line
        // argument is actually at risk in THIS spawn.
        if (needsCmd) {
          const multiline = (opts.args ?? []).some((a) => a.includes('\n'));
          console.warn(
            `[pty] Windows: "${resolved}" could not be decoded as an npm shim — falling back to cmd.exe.` +
            (multiline
              ? ' A MULTI-LINE ARGUMENT IS PRESENT AND WILL BE TRUNCATED AT ITS FIRST NEWLINE.' +
                ' The agent will start and look healthy without ever receiving the hive protocol.'
              : ' No multi-line argument in this spawn, so nothing is lost here.')
          );
        }
      }
      const proc = pty.spawn(file, spawnArgs, {
        name: 'xterm-256color',
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30,
        cwd: opts.cwd,
        // Inherited env minus the parent Claude session's identity markers,
        // then the app's defaults and locale, then per-agent values — see
        // ptyEnv.ts for why the strip exists and why it is prefix-based.
        env: buildPtyEnv(process.env, userPath, opts.env)
      });

      // Capture THIS session object so the proc's callbacks can tell whether the
      // id still belongs to them. A model change / restart does kill()+spawn()
      // reusing the SAME id: the old process's kill is asynchronous, so its
      // onData/onExit can fire AFTER the replacement session is already in the
      // map. Without the identity guard the dying process would (a) spray its
      // final bytes into the new agent's fresh TUI frame — scattered/overlapping
      // text — and (b) on exit delete the replacement session and emit a false
      // `pty:exit`, killing input to the agent that just started.
      const session: PtySession = {
        id: opts.id,
        proc,
        cwd: opts.cwd,
        command: resolved,
        lastOutputAt: Date.now(),
        hasOutput: false,
        owner
      };
      this.sessions.set(opts.id, session);

      proc.onData((data) => {
        // Drop trailing output from a process whose id was already reclaimed by
        // a respawn (or killed) — it would corrupt the new session's screen.
        if (this.sessions.get(opts.id) !== session) return;
        session.hasOutput = true;
        session.lastOutputAt = Date.now();
        // Route to the session's owner window (multi-window owner routing).
        this.safeSend(`pty:data:${opts.id}`, data, session.owner);
      });
      proc.onExit(({ exitCode, signal }) => {
        // Stale exit from a process whose id was reclaimed (kill()+respawn) — do
        // NOT touch the live session or tell the renderer the new pty died.
        if (this.sessions.get(opts.id) !== session) return;
        this.safeSend(`pty:exit:${opts.id}`, { exitCode, signal }, session.owner);
        this.sessions.delete(opts.id);
        // Natural exit must run the same lifecycle teardown as an explicit kill.
        // Guarded so a teardown error can never crash node-pty's exit callback.
        try { this.exitHandler?.(opts.id, exitCode); } catch { /* never throw out of onExit */ }
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

  /** Ask the foreground TUI for a fresh frame without changing its geometry.
   *  Startup output may predate the renderer subscription, and a same-sized
   *  first fit otherwise emits no resize. */
  redraw(id: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.resize(s.proc.cols, s.proc.rows);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  kill(id: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      const pid = s.proc.pid;
      s.proc.kill();
      ensureKilled(pid); // verify + sweep the process group so no PID leaks
      this.sessions.delete(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  list(): Array<{ id: string; cwd: string; command: string; pid: number; lastOutputAt: number; hasOutput: boolean }> {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      cwd: s.cwd,
      command: s.command,
      pid: s.proc.pid,
      lastOutputAt: s.lastOutputAt,
      hasOutput: s.hasOutput
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
   *  remove` while the process is tearing down.
   *
   *  On Windows the tree sweep runs SYNCHRONOUSLY here, unlike kill():
   *  ensureKilled's grace timer is unref'd, and on the quit path the main
   *  process exits (will-quit caps the analytics flush at ~1.2s) long before
   *  the 4s grace — so the deferred `taskkill /T /F` never ran and agent trees
   *  survived the app. conpty's own kill is async and best-effort (and our
   *  conpty patch degrades a failed console enumeration to killing nothing),
   *  so the synchronous sweep is the only reliable reaper at quit. POSIX keeps
   *  the graceful path: closing the pty HUPs the foreground process group, so
   *  trees die without us SIGKILLing mid-cleanup. */
  killAll() {
    this.exitHandler = null;
    const sweepNow = process.platform === 'win32';
    for (const s of this.sessions.values()) {
      const pid = s.proc.pid;
      if (sweepNow) {
        // Capture and kill the intact Windows process tree before closing
        // ConPTY: once the root exits, taskkill may no longer be able to find
        // descendants by that PID. Keep node-pty cleanup independent so a
        // failure in either operation cannot prevent the other.
        try { hardKillTree(pid); } catch { /* noop */ }
        try { s.proc.kill(); } catch { /* noop */ }
      } else {
        try { s.proc.kill(); } catch { /* noop */ }
        ensureKilled(pid);
      }
    }
    this.sessions.clear();
  }
}
