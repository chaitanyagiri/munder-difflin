/**
 * Claude Code 命令参考的唯一权威来源。
 *
 * 被 renderer（Command Center 的 "commands" 标签页）和 main
 * 进程（渲染到 `<hive>/COMMANDS.md`，编排 agent 会读取它）双方消费，
 * 因此人的速查表与 agent 的参考永不偏离。
 *
 * 已对照 Claude Code 文档（斜杠 + CLI 参考）v2.1.x 做网络核实。
 * 精选到广泛有用的一档——别名与琐碎内容被刻意省略。
 *
 * `kind` 兼任编排者需要的范围提示：
 *   - `slash` 只作用于被敲入的那个会话（你不能在另一个 agent 的终端上运行它）。
 *   - `cli` 在 shell 中运行，可以针对 fleet / spawn / query，
 *     因此可以用它去定位 fleet / 派生 / 查询。
 */
export type CmdKind = 'slash' | 'cli';

export interface Cmd {
  cmd: string;
  kind: CmdKind;
  desc: string;
  usage?: string;
}

export interface CmdGroup {
  title: string;
  items: Cmd[];
}

export const COMMAND_GROUPS: CmdGroup[] = [
  {
    title: 'SESSION',
    items: [
      { cmd: '/clear', kind: 'slash', desc: 'Start a fresh conversation and reclaim the full context window. The old one stays in /resume.' },
      { cmd: '/resume', kind: 'slash', desc: 'Pick or search a past session to continue.', usage: '/resume auth refactor' },
      { cmd: '/rewind', kind: 'slash', desc: 'Roll code AND conversation back to an earlier checkpoint.' },
      { cmd: '/compact', kind: 'slash', desc: 'Summarize the conversation so far to free context without losing the thread.', usage: '/compact keep the auth decisions' },
      { cmd: 'claude -c', kind: 'cli', desc: 'Continue the most recent session in this directory.' },
      { cmd: 'claude -r', kind: 'cli', desc: 'Resume — pick or search a past session.', usage: 'claude -r auth' },
      { cmd: 'claude --fork-session', kind: 'cli', desc: 'When resuming, branch into a new session id instead of reusing the original.' }
    ]
  },
  {
    title: 'CONTEXT & MEMORY',
    items: [
      { cmd: '/context', kind: 'slash', desc: 'Visualize what is filling the context window, with optimization hints.' },
      { cmd: '/memory', kind: 'slash', desc: 'Open the project & user CLAUDE.md memory files for editing.' },
      { cmd: '/init', kind: 'slash', desc: 'Scan the repo and generate a CLAUDE.md capturing its conventions.' },
      { cmd: '# ', kind: 'slash', desc: 'Quick memory: start a line with # to append a durable note to memory.', usage: '# always run prettier before committing' },
      { cmd: 'claude --add-dir ../other-repo', kind: 'cli', desc: 'Grant the session read/write access to an extra directory.' }
    ]
  },
  {
    title: 'MODELS & EFFORT',
    items: [
      { cmd: '/model', kind: 'slash', desc: 'Switch the model for this session (saved as default); arrows tune effort.', usage: '/model opus' },
      { cmd: '/effort', kind: 'slash', desc: 'Set reasoning effort: low / medium / high / xhigh / max.', usage: '/effort high' },
      { cmd: '/fast', kind: 'slash', desc: 'Toggle fast mode — Opus with faster output, no model downgrade.' },
      { cmd: 'claude --model claude-sonnet-4-6[1m]', kind: 'cli', desc: 'Launch on a specific model. The [1m] suffix selects the 1M-token window (Dwight).' },
      { cmd: 'claude --fallback-model sonnet', kind: 'cli', desc: 'Auto-fall back to another model when the primary is unavailable.' }
    ]
  },
  {
    title: 'PLAN & EXECUTE',
    items: [
      { cmd: '/plan', kind: 'slash', desc: 'Enter plan mode — design the change before any edits.', usage: '/plan refactor the auth module' },
      { cmd: '/goal', kind: 'slash', desc: 'Set a goal condition; Claude keeps working across turns until it is met.', usage: '/goal all tests pass' },
      { cmd: '/batch', kind: 'slash', desc: 'Decompose a large change into parallel units in git worktrees.', usage: '/batch migrate components to v2' },
      { cmd: '/diff', kind: 'slash', desc: 'Open the interactive diff viewer for the current changes.' },
      { cmd: '/run', kind: 'slash', desc: 'Launch and drive the project app to see a change actually working.' },
      { cmd: '/verify', kind: 'slash', desc: 'Build, run, and observe to confirm a change does what it should.' },
      { cmd: 'claude --worktree feat/x', kind: 'cli', desc: 'Start the session in an isolated git worktree.' }
    ]
  },
  {
    title: 'REVIEW & GIT',
    items: [
      { cmd: '/code-review', kind: 'slash', desc: 'Hunt correctness bugs in the diff. --fix applies them, --comment posts inline; "ultra" runs a cloud deep review.', usage: '/code-review high --fix' },
      { cmd: '/simplify', kind: 'slash', desc: 'Cleanup-only pass over changed code (reuse/simplify) — no bug hunt.' },
      { cmd: '/review', kind: 'slash', desc: 'Review a pull request in this session.', usage: '/review 123' },
      { cmd: '/security-review', kind: 'slash', desc: 'Scan pending changes for security vulnerabilities.' },
      { cmd: '/ultrareview', kind: 'slash', desc: 'Multi-agent cloud review of the current branch / a PR.' }
    ]
  },
  {
    title: 'SUBAGENTS & BACKGROUND',
    items: [
      { cmd: 'claude agents', kind: 'cli', desc: 'Open the agent view across your live + background Claude sessions.' },
      { cmd: 'claude agents --json', kind: 'cli', desc: 'Print live sessions as JSON — scriptable fleet status.' },
      { cmd: '/agents', kind: 'slash', desc: 'Create and manage custom subagents for delegated work.' },
      { cmd: '/fork', kind: 'slash', desc: 'Spawn a background subagent that inherits the full conversation.', usage: '/fork implement the perf fix' },
      { cmd: '/background', kind: 'slash', desc: 'Detach the current session so it keeps running in the background.' },
      { cmd: '/tasks', kind: 'slash', desc: 'View and manage everything running in the background.' },
      { cmd: '/stop', kind: 'slash', desc: 'Stop the current background session (when attached).' },
      { cmd: 'claude --agent reviewer', kind: 'cli', desc: 'Start the session using a specific agent configuration.' }
    ]
  },
  {
    title: 'TOOLS & PERMISSIONS',
    items: [
      { cmd: '/permissions', kind: 'slash', desc: 'View and edit which tools are allowed / asked / denied.' },
      { cmd: '/hooks', kind: 'slash', desc: 'View the configured lifecycle hooks (PreToolUse, Stop, etc.).' },
      { cmd: 'claude --permission-mode bypassPermissions', kind: 'cli', desc: 'Run without per-tool approval prompts (this is what "auto mode" uses).' },
      { cmd: 'claude --allowedTools "Bash(git *) Edit Read"', kind: 'cli', desc: 'Pre-allow specific tools so they never prompt.' }
    ]
  },
  {
    title: 'MCP & PLUGINS',
    items: [
      { cmd: '/mcp', kind: 'slash', desc: 'List/manage connected MCP servers and authenticate (OAuth).' },
      { cmd: '/plugin', kind: 'slash', desc: 'Manage plugins (list, install, enable, disable).' },
      { cmd: 'claude mcp list', kind: 'cli', desc: 'List configured MCP servers and their health.' },
      { cmd: 'claude mcp add <name> <command>', kind: 'cli', desc: 'Register a new MCP server (stdio or HTTP).' }
    ]
  },
  {
    title: 'USAGE & COST',
    items: [
      { cmd: '/usage', kind: 'slash', desc: 'Session cost, plan limits, and a breakdown by skill / subagent / MCP.' },
      { cmd: '/status', kind: 'slash', desc: 'Account, active model, version, and connection status.' },
      { cmd: 'claude -p "..." --max-budget-usd 5', kind: 'cli', desc: 'Cap the dollar spend for a headless run.' },
      { cmd: 'claude --max-turns 20', kind: 'cli', desc: 'Limit agentic turns (a coarse runaway guard).' }
    ]
  },
  {
    title: 'AUTOMATION (HEADLESS)',
    items: [
      { cmd: 'claude -p "your prompt"', kind: 'cli', desc: 'Print mode: run one prompt non-interactively and exit.', usage: 'cat log | claude -p "summarize"' },
      { cmd: 'claude -p "..." --output-format json', kind: 'cli', desc: 'Headless with structured JSON (result, usage, cost).' },
      { cmd: 'claude -p "..." --output-format stream-json', kind: 'cli', desc: 'Streaming JSON events for live consumption.' },
      { cmd: 'claude -p "..." --json-schema <schema>', kind: 'cli', desc: 'Force the headless result to match a JSON Schema.' },
      { cmd: 'claude --append-system-prompt "..."', kind: 'cli', desc: 'Append extra instructions to the default system prompt.' }
    ]
  },
  {
    title: 'CONFIG',
    items: [
      { cmd: '/config', kind: 'slash', desc: 'Open Settings: theme, model, output style, preferences.' },
      { cmd: '/theme', kind: 'slash', desc: 'Change the color theme (auto / light / dark / colorblind / custom).' },
      { cmd: '/statusline', kind: 'slash', desc: 'Configure the Claude Code status line.' }
    ]
  },
  {
    title: 'HELP & DIAGNOSTICS',
    items: [
      { cmd: '/help', kind: 'slash', desc: 'List every available slash command.' },
      { cmd: '/doctor', kind: 'slash', desc: 'Diagnose installation / health issues (press f to auto-fix).' },
      { cmd: '/debug', kind: 'slash', desc: 'Enable debug logging and troubleshoot the current session.' },
      { cmd: '/release-notes', kind: 'slash', desc: 'Browse the Claude Code changelog by version.' },
      { cmd: '/remote-control', kind: 'slash', desc: 'Expose this session for control from claude.ai / your phone.' }
    ]
  }
];
