import { useEffect, useRef } from 'react';
import { useStore, type Agent, type StationKind, type ToolKind } from '@/store/store';
import { buildSpawnCommand, ASSISTANT_MODEL, type HarnessConfig } from '@/store/config';

const GOD_ID = 'god';
const GOD_PTY = `pty-${GOD_ID}`;
const ASSISTANT_ID = 'assistant';
const ASSISTANT_PTY = `pty-${ASSISTANT_ID}`;

// How long to let Claude Code's TUI finish booting before we type the first
// thing into Michael's terminal, and the gap between the remote-control command
// and the orientation prompt so the slash command settles first.
const GOD_BOOT_MS = 4000;
const GOD_STEP_MS = 1800;

// The first thing Michael (god) is told on a fresh spawn — orient him and put
// him to work running the floor. Kept terse and action-oriented.
const INITIAL_GOD_PROMPT = [
  "You're online as Michael, the orchestrator of the hive. Get oriented, then start running the floor:",
  '1. Read your memory.md and drain every message in your inbox.',
  '2. Review board.md and the current roster of agents (active vs archived).',
  '3. Run `mempalace wake-up` for a memory digest if the CLI is available.',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

/**
 * Type a message into an agent's Claude Code TUI and actually submit it.
 *
 * The text is wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) so the
 * TUI treats it as ONE paste: embedded newlines land as literal newlines
 * inside the input box. Without the markers, every "\n" in a multi-line
 * message acted as Enter — the message was submitted line by line in
 * fragments, and the agent effectively only saw the last chunk. This affected
 * every harness delivery: queued composer messages, inbox-wake nudges, the
 * god agent's own multi-line boot orientation prompt, and enrich tasks.
 *
 * The closing Enter is still sent as a separate keystroke a tick later: inside
 * the paste it would also just be a newline, so the prompt would sit there
 * unsubmitted. Idle autonomous agents thus act on a dispatched instruction on
 * their own. */
async function submitToPty(ptyId: string, text: string): Promise<void> {
  await window.cth.writePty(ptyId, `\x1b[200~${text}\x1b[201~`);
  await new Promise((r) => setTimeout(r, 140));
  await window.cth.writePty(ptyId, '\r');
}

/** Wrap a user message as an enrich task for the assistant. The assistant's
 *  system prompt has the full instructions; this just frames the one task. */
function enrichTaskPrompt(text: string): string {
  return [
    `ENRICH TASK: ${text}`,
    '',
    '(Identify the relevant project, cd in, gather READ-ONLY context, then send the improved,',
    'self-contained prompt to Michael via an outbox message with "to":"god". Do not do the task yourself.)'
  ].join('\n');
}

/** Tool name → where the avatar walks + what it carries. */
const TOOL_STATION: Record<string, { station: StationKind; carry?: ToolKind }> = {
  Read: { station: 'shelf', carry: 'Read' },
  Edit: { station: 'desk', carry: 'Edit' },
  Write: { station: 'desk', carry: 'Write' },
  Bash: { station: 'terminal', carry: 'Bash' },
  Grep: { station: 'shelf', carry: 'Grep' },
  Glob: { station: 'shelf', carry: 'Glob' },
  WebFetch: { station: 'web', carry: 'WebFetch' },
  WebSearch: { station: 'web', carry: 'WebSearch' },
  TodoWrite: { station: 'board', carry: 'TodoWrite' }
};

/**
 * The renderer-side glue for the hive:
 *   1. spawns the god agent into Michael's room when none is running,
 *   2. drives avatar state from real Claude Code hook events, and
 *   3. wakes idle agents that have unread inbox messages so collaboration
 *      doesn't stall while an agent sits at its prompt.
 */
export function useHive(config: HarnessConfig | null): void {
  // Per-agent dedup key for the inbox-wake nudge: the newest inbox message id we
  // last nudged about. Keyed by id (not count) so an oscillating count after a
  // drain doesn't re-nudge for the same message set.
  const nudged = useRef<Record<string, string>>({});
  // Per-agent timestamp of the last queued-message we submitted. Guards against
  // re-sending the next message before the agent's hooks have flipped it to
  // 'working' (there's a short window where it still reads 'idle' right after we
  // type into it). One message per cooldown keeps delivery strictly one-by-one.
  const lastFlush = useRef<Record<string, number>>({});
  // In-flight spawn guards so a re-render / StrictMode double-mount can't spawn
  // Michael or the assistant twice (the window between the listPtys check and
  // the spawnPty call is otherwise racy).
  const godSpawning = useRef(false);
  const assistantSpawning = useRef(false);
  // Reactive so the assistant bootstrap (effect #1b) re-runs once Michael is ready.
  const godStatus = useStore((s) => s.godStatus);

  // 1) Bootstrap the god agent (source of truth = live PTYs, to dodge restarts).
  useEffect(() => {
    if (!config?.onboardingComplete || !config.harnessHome) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    useStore.getState().setGodStatus('booting');
    const t = setTimeout(async () => {
      if (cancelled) return;
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === GOD_PTY)) { // already running — keep restored entry
        if (!cancelled) useStore.getState().setGodStatus('ready');
        return;
      }
      // Synchronous guard (no await between check and set) → exactly one spawn.
      if (cancelled || godSpawning.current) return;
      godSpawning.current = true;
      useStore.getState().removeAgent(GOD_ID); // clear any stale restored entry

      const command = buildSpawnCommand(config, config.defaultModel);
      const [exe, ...args] = command.trim().split(/\s+/);
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.harnessHome!,
        command: exe,
        args,
        cols: 100,
        rows: 30,
        hive: { id: GOD_ID, name: 'Michael', cwd: config.harnessHome!, isGod: true, role: 'orchestrator (god)' }
      });
      if (cancelled) { godSpawning.current = false; return; }
      if (!res.ok) { godSpawning.current = false; useStore.getState().setGodStatus('failed'); return; }
      const god: Agent = {
        id: GOD_ID,
        name: 'Michael',
        character: 'michael',
        accent: 'lemon',
        description: 'god — runs the floor, triages requests, escalates only critical calls to you',
        project: 'hive',
        tmuxTarget: '',
        cwd: config.harnessHome!,
        status: 'idle',
        action: 'running the floor',
        progress: 0,
        currentStation: 'desk',
        ptyId: GOD_PTY,
        command: command.trim(),
        model: config.defaultModel,
        isGod: true,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(god);
      useStore.getState().setGodStatus('ready');

      // Fresh spawn → kick Michael off once his TUI is up. First enable remote
      // control so the human can approve permission prompts from their phone
      // (best-effort — a failed/unknown slash command just prints to his terminal
      // and is harmless), then hand him the orientation prompt to start running
      // the floor. Restored sessions (the live-PTY branch above) skip this.
      timers.push(setTimeout(() => {
        if (cancelled) return;
        submitToPty(GOD_PTY, '/remote-control').catch(() => { /* best-effort */ });
        timers.push(setTimeout(() => {
          if (cancelled) return;
          submitToPty(GOD_PTY, INITIAL_GOD_PROMPT).catch(() => { /* pty may have died */ });
        }, GOD_STEP_MS));
      }, GOD_BOOT_MS));
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); timers.forEach(clearTimeout); };
  }, [config?.onboardingComplete, config?.harnessHome]);

  // 1b) Bootstrap Michael's prep assistant ("Dwight") — only after Michael is
  //     ready, and only once. Same live-PTY idempotency + spawn-guard as #1.
  useEffect(() => {
    if (!config?.onboardingComplete || !config.harnessHome) return;
    if (godStatus !== 'ready') return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === ASSISTANT_PTY)) return; // already running
      if (cancelled || assistantSpawning.current) return;
      assistantSpawning.current = true;
      useStore.getState().removeAgent(ASSISTANT_ID); // clear any stale restored entry

      const command = buildSpawnCommand(config, ASSISTANT_MODEL);
      const [exe, ...args] = command.trim().split(/\s+/);
      const res = await window.cth.spawnPty({
        id: ASSISTANT_PTY,
        cwd: config.harnessHome!,
        command: exe,
        args,
        cols: 100,
        rows: 30,
        hive: { id: ASSISTANT_ID, name: 'Dwight', cwd: config.harnessHome!, isAssistant: true, role: "Michael's prep assistant" }
      });
      if (cancelled || !res.ok) { assistantSpawning.current = false; return; }
      const assistant: Agent = {
        id: ASSISTANT_ID,
        name: 'Dwight',
        character: 'dwight',
        accent: 'sky',
        description: "assistant — enriches prompts with repo context, forwards them to Michael",
        project: 'hive',
        tmuxTarget: '',
        cwd: config.harnessHome!,
        status: 'idle',
        action: 'standing by',
        progress: 0,
        currentStation: 'desk',
        ptyId: ASSISTANT_PTY,
        command: command.trim(),
        model: ASSISTANT_MODEL,
        isAssistant: true,
        recentTextTs: Date.now()
      };
      // addAgent auto-selects the new agent; restore the prior selection so the
      // assistant booting in the background doesn't yank focus off Michael.
      const prevSel = useStore.getState().selectedId;
      useStore.getState().addAgent(assistant);
      useStore.getState().select(prevSel ?? GOD_ID);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [config?.onboardingComplete, config?.harnessHome, godStatus]);

  // 2) Drive avatars from real hook events emitted by each agent's shim.
  useEffect(() => {
    return window.cth.onHiveHookEvent((e) => {
      if (!e.agentId) return;
      const { updateAgent, agents } = useStore.getState();
      const self = agents.find((a) => a.id === e.agentId);
      if (!self) return;
      // Hook events are the authoritative status source for real agents (the
      // pty-stream parser only refines the on-floor action/station).
      if (e.event === 'PreToolUse' && e.tool) {
        const m = TOOL_STATION[e.tool] ?? { station: 'desk' as StationKind };
        updateAgent(e.agentId, { status: 'working', currentStation: m.station, carrying: m.carry, action: `using ${e.tool}` });
        useStore.getState().bumpToolCount(e.agentId); // usage proxy for the command center
      } else if (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit') {
        // A turn is in progress (prompt submitted / tool just finished) — keep
        // it working so it doesn't flicker idle between tool calls.
        updateAgent(e.agentId, { status: 'working' });
      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {
        // A blocked Stop means the agent is being re-engaged to process its
        // inbox — it's NOT idle, so keep it working until it genuinely stops.
        if (e.blocked) {
          updateAgent(e.agentId, { status: 'working', action: 'reading inbox', carrying: undefined });
        } else {
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      } else if (e.event === 'Notification') {
        // Claude Code fires Notification for two very different situations:
        //   1. it genuinely needs the human (a permission / approval prompt), or
        //   2. the prompt has merely gone idle ("Claude is waiting for your
        //      input") — i.e. the agent answered and has nothing queued.
        // Only (1) is a real "needs you". Treating (2) as blocked made Michael
        // march to the door with a red "!" right after finishing, so detect the
        // idle case and let him linger on the floor instead.
        const msg = (e.message ?? '').toLowerCase();
        const idleWaiting = !msg
          || msg.includes('waiting for your input')
          || msg.includes('is idle')
          || msg.includes('waiting for input');
        const needsHuman = msg.includes('permission')
          || msg.includes('approve')
          || msg.includes('confirm')
          || msg.includes('needs your');
        if (needsHuman && !idleWaiting) {
          // Only the god agent escalates to the human; sub-agents are autonomous
          // and read as "waiting" (parked on god, not on you).
          updateAgent(e.agentId, { status: self.isGod ? 'blocked' : 'waiting' });
        } else {
          // Idle notification — responded, nothing to do. Linger, don't flag.
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    });
  }, []);

  // 3) Wake idle agents holding unread inbox messages. The assistant is
  //    send-only (it never receives inbox mail), so it's excluded.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const agents = useStore.getState().agents.filter(
        (a) => a.ptyId && !a.isAssistant && (a.status === 'idle' || a.status === 'waiting')
      );
      for (const a of agents) {
        try {
          const inbox = await window.cth.hiveInbox(a.id);
          // Dedup by the newest message id, not the count — a count can oscillate
          // as messages drain and re-arrive, which would re-nudge for the same set.
          const newest = inbox.length
            ? inbox.map((m) => m.id).sort().slice(-1)[0]
            : '';
          if (newest && nudged.current[a.id] !== newest) {
            nudged.current[a.id] = newest;
            await submitToPty(
              a.ptyId!,
              'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.'
            );
          } else if (!newest) {
            nudged.current[a.id] = '';
          }
        } catch { /* ignore */ }
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 4) Drain each agent's queued messages to its terminal, one at a time, the
  //    moment the agent goes idle. This is what lets the user keep sending
  //    messages while the agent's "cloud terminal" is mid-run: the messages
  //    park in the store and get typed in (and submitted) as soon as it's free.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const FLUSH_COOLDOWN_MS = 4500;

    // Send the front of `srcId`'s queue into `target`'s pty (verbatim or wrapped),
    // gated on the target being idle + off cooldown. Keyed cooldown per target so
    // strict one-by-one delivery holds. Returns true if it dispatched.
    const dispatch = (srcId: string, target: Agent | undefined, wrap?: (t: string) => string): boolean => {
      const { messageQueues, removeQueuedMessage } = useStore.getState();
      const next = messageQueues[srcId]?.[0];
      if (!next || !target?.ptyId || target.status !== 'idle') return false;
      const now = Date.now();
      if (now - (lastFlush.current[target.id] ?? 0) < FLUSH_COOLDOWN_MS) return false;
      lastFlush.current[target.id] = now;
      // Remove first so a burst of store updates can't double-send the same one.
      removeQueuedMessage(srcId, next.id);
      submitToPty(target.ptyId, wrap ? wrap(next.text) : next.text).catch(() => { /* pty may have died */ });
      return true;
    };

    const flush = () => {
      const { agents, messageQueues, enrichEnabled } = useStore.getState();
      const byId = (id: string) => agents.find((a) => a.id === id);

      // Sub-agents (and the assistant's own direct queue): flush verbatim into
      // their own terminal. Michael's queue is handled specially below.
      for (const a of agents) {
        if (a.id === GOD_ID) continue;
        if (!a.ptyId || a.status !== 'idle') continue;
        if (!messageQueues[a.id]?.length) continue;
        dispatch(a.id, a);
      }

      // Michael's queue: enrich OFF → straight to Michael; enrich ON → wrap as an
      // ENRICH TASK and route to the assistant, which forwards to Michael's inbox.
      if (messageQueues[GOD_ID]?.length) {
        if (enrichEnabled) dispatch(GOD_ID, byId(ASSISTANT_ID), enrichTaskPrompt);
        else dispatch(GOD_ID, byId(GOD_ID));
      }
    };

    // Run on every store change (status flips, new queue items) — debounced so a
    // burst of pty-stream updates coalesces — plus a periodic backstop.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; flush(); }, 200);
    };
    const unsub = useStore.subscribe(schedule);
    const iv = setInterval(flush, 3000);
    schedule();
    return () => { unsub(); if (debounce) clearTimeout(debounce); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 5) Pipe inbound Slack messages into Michael's queue. The main-process Slack
  //    webhook server pushes each verified message here via IPC; enqueueing to
  //    GOD_ID lands it in Michael's queue exactly as if the user had typed it
  //    into the composer — effect #4 above then drains it to his PTY.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onSlackMessage((msg) => {
      if (!msg?.text?.trim()) return;
      useStore.getState().enqueueMessage(GOD_ID, msg.text.trim());
    });
  }, [config?.onboardingComplete]);
}
