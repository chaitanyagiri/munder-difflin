/**
 * Command reference for the xAI Grok CLI.
 *
 * Kept in the same shape as the Claude/Codex references so the Command Center
 * and generated hive command guide can render provider-native commands.
 */
import type { CmdGroup } from './claudeCommands';

export const GROK_COMMAND_GROUPS: CmdGroup[] = [
  {
    title: 'SESSION',
    items: [
      { cmd: '/new', kind: 'slash', desc: 'Start a fresh session and clear the current context.' },
      { cmd: '/load', kind: 'slash', desc: 'Load a previous workspace session.', usage: '/load [workspace] [session]' },
      { cmd: '/compact', kind: 'slash', desc: 'Compact conversation history while retaining the important working context.', usage: '/compact keep the current task and next step' },
      { cmd: 'grok --resume <session-id>', kind: 'cli', desc: 'Resume an existing Grok session by ID or title.' }
    ]
  },
  {
    title: 'MODELS & PERMISSIONS',
    items: [
      { cmd: '/model', kind: 'slash', desc: 'Switch the model used by the current session.' },
      { cmd: 'grok --model grok-4.5', kind: 'cli', desc: 'Launch Grok with the Grok 4.5 coding model.' },
      { cmd: '/always-approve', kind: 'slash', desc: 'Toggle automatic approval of tool executions.' },
      { cmd: 'grok --permission-mode bypassPermissions', kind: 'cli', desc: 'Launch in always-approve mode. Planet Express uses this when Auto Mode is on.' }
    ]
  },
  {
    title: 'TOOLS & WORKFLOW',
    items: [
      { cmd: '/rewind', kind: 'slash', desc: 'Rewind to a previous prompt and restore its file state.' },
      { cmd: '/hooks-list', kind: 'slash', desc: 'Show lifecycle hooks active in this session.' },
      { cmd: '/skills', kind: 'slash', desc: 'List or load installed skills.' },
      { cmd: '/multiline', kind: 'slash', desc: 'Toggle multiline prompt entry.' }
    ]
  }
];
