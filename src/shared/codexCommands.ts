/**
 * OpenAI Codex CLI 的命令参考。
 *
 * 镜像 claudeCommands.ts 的形态，这样任何渲染命令参考的组件都可以
 * 按提供商切换。从 Codex CLI 参考 + slash 命令文档
 * （developers.openai.com/codex/cli/）整理而成。
 *
 * `kind` 语义与 claudeCommands.ts 一致：
 *   - `slash`  — 在 Codex 交互式 REPL 会话中输入
 *   - `cli`    — 启动时传入的 shell 标志 / 子命令
 */
import type { CmdGroup } from './claudeCommands';

export const CODEX_COMMAND_GROUPS: CmdGroup[] = [
  {
    title: 'SESSION',
    items: [
      { cmd: '/clear', kind: 'slash', desc: 'Start a fresh chat without quitting — clears the conversation context.' },
      // 已在 codex 0.137.0 二进制自身的命令表中确认存在。此前
      // providerAutomation 会发送它，而这里缺失，所以二者不一致。
      // 与 Claude 的不同，这一条会忽略任何尾随的焦点文本。
      { cmd: '/compact', kind: 'slash', desc: 'Summarize the conversation so far to stay under the context limit.' },
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
      { cmd: 'codex --dangerously-bypass-approvals-and-sandbox', kind: 'cli', desc: 'Skip ALL approval prompts AND drop the OS sandbox (full filesystem access). Munder Difflin no longer uses this for auto mode; it keeps the sandbox and adds the hive agent folder via --add-dir.' },
      { cmd: 'codex -a never -s danger-full-access', kind: 'cli', desc: 'Never prompt for approval (-a never) but keep the sandbox on (-s danger-full-access, which allows --add-dir <dir>). What Munder Difflin uses for auto mode; the hive agent folder is added with --add-dir.' },
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
      { cmd: 'codex --model <model>', kind: 'cli', desc: 'Choose the model (e.g. o4-mini, o3).', usage: 'codex --model o4-mini' },
      { cmd: 'codex --provider <provider>', kind: 'cli', desc: 'Select the API provider (openai, azure, anthropic…).', usage: 'codex --provider openai' }
    ]
  }
];
