/**
 * Command reference for the OpenAI Codex CLI.
 *
 * Mirrors the shape of claudeCommands.ts so any component that renders a
 * command reference can switch on provider. Curated from the Codex CLI
 * reference + slash-commands docs (developers.openai.com/codex/cli/).
 *
 * `kind` semantics match claudeCommands.ts:
 *   - `slash`  — typed inside the Codex interactive REPL session
 *   - `cli`    — shell flags / sub-commands passed at launch
 */
import type { CmdGroup } from './claudeCommands';

export const CODEX_COMMAND_GROUPS: CmdGroup[] = [
  {
    title: 'SESSION',
    items: [
      { cmd: '/clear', kind: 'slash', desc: 'Start a fresh chat without quitting — clears the conversation context.' },
      { cmd: '/help', kind: 'slash', desc: 'List every available slash command.' },
      { cmd: '/copy', kind: 'slash', desc: 'Copy the latest model output to the clipboard.' },
      { cmd: '/logout', kind: 'slash', desc: 'Clear locally stored credentials.' },
      { cmd: '/rename', kind: 'slash', desc: 'Rename the current conversation.' }
    ]
  },
  {
    title: 'UI & PREFERENCES',
    items: [
      { cmd: '/theme', kind: 'slash', desc: 'Toggle between light and dark themes.' },
      { cmd: '/vim', kind: 'slash', desc: 'Toggle Vim key-bindings in the input box.' },
      { cmd: '/raw', kind: 'slash', desc: 'Toggle raw (unformatted) output for the model response.' }
    ]
  },
  {
    title: 'MEMORY & SKILLS',
    items: [
      { cmd: '/memories', kind: 'slash', desc: 'View and manage what Codex has remembered about you.' },
      { cmd: '/skills', kind: 'slash', desc: 'Browse and manage installed Codex skills / extensions.' },
      { cmd: '/hooks', kind: 'slash', desc: 'View the configured lifecycle hooks.' }
    ]
  },
  {
    title: 'APPROVALS & PERMISSIONS',
    items: [
      { cmd: 'codex -a never -s workspace-write', kind: 'cli', desc: 'Auto mode: never prompt for approval (-a never) and scope the sandbox to the workspace (-s workspace-write). Used by Munder Difflin when auto mode is on.' },
      { cmd: 'codex --dangerously-bypass-approvals-and-sandbox', kind: 'cli', desc: 'Skip all approval prompts AND disable the OS sandbox entirely. CI-only full-bypass override — for externally-isolated environments (Docker, CI VM) only.' },
      { cmd: 'codex -a untrusted', kind: 'cli', desc: 'Only run trusted commands without asking; escalate to the user for anything else.' },
      { cmd: 'codex -s danger-full-access', kind: 'cli', desc: 'Remove all sandbox restrictions (fine-grained flag — pair with -a for full control).' }
    ]
  },
  {
    title: 'AUTOMATION (HEADLESS)',
    items: [
      { cmd: 'codex -p "your prompt"', kind: 'cli', desc: 'Non-interactive print mode: run one prompt and exit.', usage: 'codex -p "summarise this file"' },
      { cmd: 'CODEX_NON_INTERACTIVE=1 codex', kind: 'cli', desc: 'Suppress all interactive installer / first-run prompts. Set automatically by Munder Difflin in auto mode.' }
    ]
  },
  {
    title: 'CONFIG',
    items: [
      { cmd: 'codex --model <model>', kind: 'cli', desc: 'Choose the model (e.g. gpt-5.5).', usage: 'codex --model gpt-5.5' },
      { cmd: 'codex --provider <provider>', kind: 'cli', desc: 'Select the API provider (openai, azure, anthropic…).', usage: 'codex --provider openai' }
    ]
  }
];
