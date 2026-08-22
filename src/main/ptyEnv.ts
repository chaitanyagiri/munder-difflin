/**
 * Environment construction for agent PTYs, as a pure function so the layering
 * is testable off-process (the same trick `buildMissingCliScript` uses for its
 * `platform` parameter).
 *
 * The layering rule, bottom to top:
 *   1. the inherited environment, minus the parent Claude session's identity
 *      and minus any name the caller asked to `omit`
 *   2. the app's own defaults (PATH, terminal identity, locale)
 *   3. per-agent values (`opts.env`) — always win, even over the strips below
 */

/**
 * The app is often launched from INSIDE a Claude Code session (`npm run dev`
 * typed into a claude terminal), so that session's identity markers arrive via
 * `process.env` and would flow into every agent CLI. CLAUDE_CODE_CHILD_SESSION
 * makes the agent believe it is a child session and silently DISABLES
 * transcript saving ("Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker"), which breaks --resume for every agent of
 * that run: their sessions never reach disk (bit us live 2026-08-16/17 — no
 * worker transcript ever existed). The session id, pid, messaging socket+token,
 * effort, execpath and entrypoint likewise all describe the PARENT session,
 * never a fresh agent.
 *
 * Stripped by PREFIX rather than by name: the CLI grows new markers faster
 * than a hardcoded list keeps up (a five-name list was already seven short of
 * a live session's dump when review caught it). Agents are top-level sessions
 * regardless of how the app was launched, so they inherit NONE of the parent's
 * Claude identity.
 */
const CLAUDE_MARKER_RE = /^CLAUDE(CODE|_)/;

/**
 * Configuration, not identity: these share the prefix but are the OPERATOR's
 * own choices — where the CLI keeps its config, how it authenticates, which
 * backend serves it. An operator who exported them wants agents to see them,
 * and stripping them breaks agents in exactly the quiet way the strip above
 * exists to prevent. Everything session-scoped stays out of this list.
 */
const CLAUDE_CONFIG_KEEP = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
]);

/**
 * Names the caller wants GONE from the child rather than overwritten (`omitEnv`).
 * `agentEnv` can only ever ADD a value, and for a credential that is the wrong
 * tool: handing a `*.ghe.com` agent an EMPTY GH_TOKEN is not the same as handing
 * it no GH_TOKEN, and "a token scoped to another host must not reach this child"
 * only has one honest implementation. See shared/githubHost.ts for the caller.
 *
 * The strip applies to layer 1 ONLY, exactly like the Claude-marker strip above:
 * an explicit `agentEnv` value for the same name still wins, so a deliberate
 * per-agent override can never be silently erased by an omit list.
 */
export function buildPtyEnv(
  parentEnv: NodeJS.ProcessEnv,
  userPath: string,
  agentEnv?: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  omitEnv?: string[]
): Record<string, string> {
  // Layer 1 — inherit, minus the parent session's Claude identity. Only this
  // layer is stripped: a marker set deliberately via `agentEnv` below survives,
  // so per-agent environment overrides (and future per-agent env features)
  // cannot be silently wiped by the strip.
  const omit = new Set(omitEnv ?? []);
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (CLAUDE_MARKER_RE.test(k) && !CLAUDE_CONFIG_KEEP.has(k)) continue;
    if (omit.has(k)) continue;
    inherited[k] = v;
  }
  return {
    ...inherited,
    PATH: userPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Help apps that look for a real interactive shell
    FORCE_COLOR: '1',
    // A Finder/Dock-launched Electron app inherits NO locale from launchd
    // (`launchctl getenv LANG` is empty), so without this every child runs in
    // the C/POSIX locale — where macOS's CoreFoundation default text encoding
    // is Mac OS Roman (__CF_USER_TEXT_ENCODING=<uid>:0:0). Any locale-sensitive
    // tool an agent runs then decodes UTF-8 as MacRoman and paints mojibake
    // into the grid ("—" → "‚Äî"), which copy faithfully reproduces. This
    // terminal IS UTF-8 (xterm.js + Unicode11), so say so.
    //
    // LC_CTYPE only, deliberately: it is the character-encoding category. Using
    // LC_ALL would also override collation and date formatting for every user
    // who never exported a locale. A locale the user really did export wins.
    ...(platform === 'win32'
      ? {}
      : {
          LANG: parentEnv.LANG ?? 'en_US.UTF-8',
          LC_CTYPE:
            parentEnv.LC_ALL ?? parentEnv.LC_CTYPE ?? parentEnv.LANG ?? 'en_US.UTF-8'
        }),
    // Per-agent hive identity (AGENT_ID, HIVE_ROOT, …) when provided.
    ...(agentEnv ?? {})
  };
}
