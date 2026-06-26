/**
 * Realtime Michael — voice ACTION tools (card rt-5, Phase 2).
 *
 * The write-side function-tools that turn voice-Michael into an orchestrator: ping
 * / dispatch / steer / task CRUD / spawn-hire / kill / pause / halt / edit-schedule.
 * These are THIN — every tool just forwards a {verb, ...args} to the main process
 * (src/main/realtimeActions.ts), which owns the entire safety spine: the soft-vs-
 * destructive tiering, the two-step verbal echo-back confirm, the distinct-token
 * rule, the hard allowlist (kill-god / mass-ops forbidden), and the michael-voice
 * attribution. The renderer is the untrusted side, so it holds NO policy — it only
 * speaks back what main returns (`res.spoken`).
 *
 * Confirm flow: a destructive tool returns an echo-back ("…say 'confirm' or 'kill'")
 * and main stages a single pending action. The model then calls `confirm_action`
 * with the user's spoken phrase to commit, or `cancel_action` to drop it. Because
 * each tool call mutes the mic (session.ts agent_tool_start), the commit inside
 * confirm_action happens mic-idle — no stray audio can inject consent.
 *
 * Registered alongside the read-tools: session.ts uses
 *   tools: [...realtimeReadTools(), ...realtimeActionTools()]
 */
import { tool } from '@openai/agents-realtime';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** Forward a verb + args to the main action spine and return its spoken result.
 *  Instrumented for the rt-5 live-bug: any failure is logged to the (human-visible)
 *  renderer console with the verb + raw args so the next repro is self-diagnosing. */
async function act(verb: string, input: unknown): Promise<string> {
  // Graceful guard: if the preload bridge is missing (e.g. a dev hot-reload left the
  // renderer ahead of a stale preload), say so instead of throwing an opaque error.
  if (typeof window.cth?.realtimeAction !== 'function') {
    console.error('[realtime-action] window.cth.realtimeAction is not available — restart the app to load the rt-5 preload.', { verb });
    return 'Voice actions are not available in this build yet — try restarting the app.';
  }
  try {
    const res = await window.cth.realtimeAction({ verb, ...obj(input) });
    if (!res?.ok) console.warn('[realtime-action] verb=%s rejected: %s', verb, res?.spoken, { input });
    return res?.spoken || 'Done.';
  } catch (e) {
    console.error('[realtime-action] verb=%s threw:', verb, e, { input });
    const msg = e instanceof Error ? e.message : 'an unknown error';
    return `I couldn't do that (${msg}).`;
  }
}

export function realtimeActionTools(): ReturnType<typeof tool>[] {
  return [
    // ── soft writes (execute immediately) ─────────────────────────────────
    tool({
      name: 'ping_agent',
      description:
        'Send a short message to one agent (a nudge or note). Soft action — runs immediately, no confirm. Use for "tell Oscar X" or "check in with Jim".',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent name or id to message.' },
          message: { type: 'string', description: 'What to say to them.' }
        },
        required: ['agentId', 'message'],
        additionalProperties: false
      },
      execute: (input) => act('ping', input)
    }),
    tool({
      name: 'dispatch_agent',
      description:
        'Give an agent a task as a structured 4-part work order (objective, context, constraints, done-when) delivered to their inbox. Soft action — runs immediately. Use for "have Jim build X" or "ask Oscar to investigate Y".',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent name or id to dispatch to.' },
          objective: { type: 'string', description: 'The goal — what they should accomplish.' },
          context: { type: 'string', description: 'Optional. Background they need.' },
          constraints: { type: 'string', description: 'Optional. Limits / guardrails to respect.' },
          doneWhen: { type: 'string', description: 'Optional. The definition of done.' }
        },
        required: ['agentId', 'objective'],
        additionalProperties: false
      },
      execute: (input) => act('dispatch', input)
    }),
    tool({
      name: 'steer_agent',
      description:
        'Inject live guidance into a running agent to redirect it without stopping it. Soft action — runs immediately. This is the priority verb: "tell Jim to focus on the bug first", "steer Oscar away from that approach".',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent name or id to steer.' },
          text: { type: 'string', description: 'The steering guidance to inject.' }
        },
        required: ['agentId', 'text'],
        additionalProperties: false
      },
      execute: (input) => act('steer', input)
    }),
    tool({
      name: 'create_task',
      description:
        'Add a new card to the task board. Soft action — runs immediately. Use for "make a task to X", optionally assigned to someone.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The task title.' },
          description: { type: 'string', description: 'Optional. More detail.' },
          assignee: { type: 'string', description: 'Optional. Agent id/name to own it.' },
          priority: { type: 'number', description: 'Optional. 1 (highest) to 10.' }
        },
        required: ['title'],
        additionalProperties: false
      },
      execute: (input) => act('create_task', input)
    }),
    tool({
      name: 'assign_task',
      description: 'Assign an existing task to an agent. Soft action — runs immediately.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task id or title to assign.' },
          assignee: { type: 'string', description: 'Agent id/name to own it.' }
        },
        required: ['taskId', 'assignee'],
        additionalProperties: false
      },
      execute: (input) => act('assign_task', input)
    }),
    tool({
      name: 'update_task',
      description:
        'Change an existing task: its status (todo/doing/blocked/done), result note, or assignee. Soft action — runs immediately.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task id or title to update.' },
          status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'], description: 'Optional new status.' },
          result: { type: 'string', description: 'Optional outcome note.' },
          assignee: { type: 'string', description: 'Optional new owner.' }
        },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: (input) => act('update_task', input)
    }),

    // ── wait for a dispatched task to finish (rt-12 await-in-session) ──────
    tool({
      name: 'wait_for',
      description:
        'Wait until a task you dispatched completes, then report it. Use for "tell me when X is done" or "let me know once that finishes". Bounded by a timeout. (For fire-and-forget you do not need this — completions are announced automatically.)',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task id (or dispatch correlation id) to wait on.' },
          timeoutSeconds: { type: 'number', description: 'Optional max wait in seconds (default 120, max 600).' }
        },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: async (input) => {
        try {
          const a = obj(input);
          const taskId = str(a.taskId);
          if (!taskId) return 'I need a task id to wait on.';
          const secs = typeof a.timeoutSeconds === 'number' && a.timeoutSeconds > 0 ? Math.min(a.timeoutSeconds, 600) : 120;
          const res = await window.cth.realtimeWaitFor(taskId, secs * 1000);
          if (res && 'timedOut' in res && res.timedOut) {
            return `That one's still running after the wait — I'll let you know the moment it finishes.`;
          }
          return (res && 'summary' in res && res.summary) || 'That task completed.';
        } catch (e) {
          console.error('[realtime-action] wait_for threw:', e);
          const msg = e instanceof Error ? e.message : 'an unknown error';
          return `I couldn't wait on that (${msg}).`;
        }
      }
    }),

    // ── destructive / expensive (echo-back confirm required) ──────────────
    tool({
      name: 'spawn_agent',
      description:
        'Hire a NEW agent worker (provider engine + optional role). This does NOT run immediately; it asks for verbal confirmation first. After the user confirms, call confirm_action.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'Engine: claude (default), codex, gemini, opencode, crush, pi, qwen.' },
          role: { type: 'string', description: 'Optional. The role/job for the new agent.' },
          name: { type: 'string', description: 'Optional. A name for the agent.' },
          cwd: { type: 'string', description: 'Optional. Working directory; defaults to the hive root.' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) => act('spawn', input)
    }),
    tool({
      name: 'kill_agent',
      description:
        'Terminate a running agent (closes its terminal, archives it). DESTRUCTIVE — does NOT run immediately; returns an echo-back and asks for verbal confirmation. After the user confirms, call confirm_action. Killing the god orchestrator or all agents at once is forbidden.',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: 'Agent name or id to kill.' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('kill', input)
    }),
    tool({
      name: 'pause_agent',
      description:
        'Pause a running agent (it stops acting until resumed). DESTRUCTIVE — does NOT run immediately; returns an echo-back and asks for verbal confirmation. After the user confirms, call confirm_action.',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: 'Agent name or id to pause.' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('pause', input)
    }),
    tool({
      name: 'halt_agent',
      description:
        'Halt a running agent (a hard stop of its current work). DESTRUCTIVE — does NOT run immediately; returns an echo-back and asks for verbal confirmation. After the user confirms, call confirm_action.',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: 'Agent name or id to halt.' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('halt', input)
    }),
    tool({
      name: 'edit_schedule',
      description:
        'Enable, disable, or delete a recurring scheduled mission. DESTRUCTIVE — does NOT run immediately; returns an echo-back and asks for verbal confirmation. After the user confirms, call confirm_action.',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', description: 'The schedule id or label to edit.' },
          action: { type: 'string', enum: ['enable', 'disable', 'delete'], description: 'What to do to it.' }
        },
        required: ['missionId', 'action'],
        additionalProperties: false
      },
      execute: (input) => act('edit_schedule', input)
    }),

    // ── confirm / cancel (drive the two-phase commit) ─────────────────────
    tool({
      name: 'confirm_action',
      description:
        'Commit the destructive action that is currently awaiting confirmation, using the EXACT words the user just spoke. Only call this right after a destructive tool returned an echo-back and the user verbally confirmed. Main rejects a bare "yes" — pass the user\'s real phrase.',
      parameters: {
        type: 'object',
        properties: { phrase: { type: 'string', description: 'The confirmation words the user actually said.' } },
        required: ['phrase'],
        additionalProperties: false
      },
      execute: async (input) => {
        if (typeof window.cth?.realtimeActionConfirm !== 'function') {
          console.error('[realtime-action] window.cth.realtimeActionConfirm is not available — restart the app.');
          return 'Voice actions are not available in this build yet — try restarting the app.';
        }
        try {
          const res = await window.cth.realtimeActionConfirm({ phrase: str(obj(input).phrase) });
          if (!res?.ok) console.warn('[realtime-action] confirm rejected: %s', res?.spoken, { input });
          return res?.spoken || 'Done.';
        } catch (e) {
          console.error('[realtime-action] confirm threw:', e, { input });
          const msg = e instanceof Error ? e.message : 'an unknown error';
          return `I couldn't confirm that (${msg}).`;
        }
      }
    }),
    tool({
      name: 'cancel_action',
      description: 'Cancel the destructive action that is awaiting confirmation. Call this when the user declines or changes their mind.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        try {
          const res = await window.cth?.realtimeActionCancel?.();
          return res?.spoken || 'Cancelled.';
        } catch (e) {
          console.error('[realtime-action] cancel threw:', e);
          return 'Cancelled.';
        }
      }
    })
  ];
}
