import { useEffect, useRef } from 'react';
import { useStore, type Agent, type StationKind, type ToolKind } from '@/store/store';
import {
  buildSpawnCommand,
  ASSISTANT_MODEL,
  inferAgentProvider,
  isClaudeProvider,
  type HarnessConfig
} from '@/store/config';

const GOD_ID = 'god';
const GOD_PTY = `pty-${GOD_ID}`;
const ASSISTANT_ID = 'assistant';
const ASSISTANT_PTY = `pty-${ASSISTANT_ID}`;

// How long to let Claude Code's TUI finish booting before we type the first
// thing into Michael's terminal, and how long to PAUSE after the /remote-control
// command so the slash command lands + executes on its own line before the
// orientation prompt follows (otherwise they jam into one line and the TUI shows
// "Unknown command: /remote-control…").
const GOD_BOOT_MS = 4000;
const REMOTE_CONTROL_SETTLE_MS = 1500;
// After a god/agent spawn, hold off the inbox-wake + queue-drain typers for this
// long so they can't interleave with the boot sequence (remote-control +
// orientation) and jam the input line.
const BOOT_GRACE_MS = GOD_BOOT_MS + REMOTE_CONTROL_SETTLE_MS + 2500;

// The first thing Michael (god) is told on a fresh spawn — orient him and put
// him to work running the floor. Kept terse and action-oriented.
const INITIAL_GOD_PROMPT = [
  "You're online as Michael, the orchestrator of the hive. Get oriented, then start running the floor:",
  '1. Read your memory.md and drain every message in your inbox.',
  '2. Review board.md + tasks.json and the current roster of agents (active vs archived).',
  '3. Check fleet health: read fleet.json in the hive root for every agent\'s live tokens, cost, status, breaker level, and inbox backlog (`claude agents` will NOT show your hive\'s agents). Flag anyone stalled, over-budget, or breaker-armed.',
  '4. Skim COMMANDS.md (hive root) for the Claude Code commands you can use — and run `mempalace wake-up` for a memory digest if the CLI is available.',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

// Scheduled auto-compact command (from the ops standup). Queued per agent and
// delivered when idle, so it never interrupts a working agent. The focus
// instructions make the agent record its current task + next step into the
// summary, so it resumes from the same point after compacting.
const COMPACT_CMD =
  '/compact Summarise exactly what you are currently working on and the next step, ' +
  'so you can resume from the same point — then continue that work after compacting.';

// Per-pty submission chain. Every submitToPty for a given pty is appended here so
// two callers (e.g. the boot sequence's /remote-control and the inbox-wake nudge)
// can NEVER interleave their text + Enter — which jammed them onto one line and
// produced "Unknown command: /remote-control<next prompt>".
const writeChains = new Map<string, Promise<void>>();

/**
 * Type a line into an agent's Claude Code TUI and actually submit it.
 *
 * Writing the text and the carriage return in a single chunk makes the TUI
 * treat the whole thing as a paste, so the "\r" lands as a newline inside the
 * input box instead of submitting — the command just sits there as text. We
 * send the text first, then the Enter as a separate keystroke a tick later so
 * the prompt is registered and executed. Idle autonomous agents thus act on a
 * dispatched instruction on their own.
 *
 * Submissions to the same pty are serialized (and each settles for `settleMs`
 * after Enter) so concurrent callers can't jam their input together.
 *
 * The text is wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) so the
 * TUI treats it as ONE paste: embedded newlines land as literal newlines in the
 * input box. Without them, every "\n" in a multi-line message acted as Enter —
 * the message submitted line-by-line in fragments (the agent saw only the last
 * chunk). The closing Enter, sent a tick later, submits the whole block. (#24) */
function submitToPty(ptyId: string, text: string, settleMs = 250): Promise<void> {
  const prev = writeChains.get(ptyId) ?? Promise.resolve();
  const next = prev.catch(() => { /* a failed prior write must not stall the chain */ }).then(async () => {
    await window.cth.writePty(ptyId, `\x1b[200~${text}\x1b[201~`);
    await new Promise((r) => setTimeout(r, 140));
    await window.cth.writePty(ptyId, '\r');
    await new Promise((r) => setTimeout(r, settleMs));
  });
  writeChains.set(ptyId, next);
  return next;
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
  TodoWrite: { station: 'board', carry: 'TodoWrite' },
  // #5A — delegating to a sub-agent reads as "handing off at the outbox".
  Task: { station: 'mailbox', carry: 'TodoWrite' }
};

/** Resolve a tool name to its station/glyph. Falls back: any `mcp__*` tool →
 *  the MCP station (previously these silently sat at the desk, #5A gap); anything
 *  else → the desk. */
function stationForTool(tool: string): { station: StationKind; carry?: ToolKind } {
  return TOOL_STATION[tool]
    ?? (tool.startsWith('mcp__') ? { station: 'mcp', carry: 'MCP' } : { station: 'desk' });
}

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
  // Per-agent timestamp until which auto-typers (inbox-wake #3, queue-drain #4)
  // must leave the agent alone — set while its boot sequence is typing so nothing
  // collides with /remote-control + the orientation prompt.
  const bootGraceUntil = useRef<Record<string, number>>({});
  // Reactive so the assistant bootstrap (effect #1b) re-runs once Michael is ready.
  const godStatus = useStore((s) => s.godStatus);
  // #5C/#7C.4 — latest circuit-breaker level per agent. When 'constrained'/
  // 'stopped' the avatar is pinned to 'looping' and hook events must NOT flip it
  // back to 'working' (the flicker the spec calls out); only a genuine Stop clears it.
  const breakerLevel = useRef<Record<string, string>>({});

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

      const command = buildSpawnCommand(config, config.defaultModel, 'claude');
      const [exe, ...args] = command.trim().split(/\s+/);
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.harnessHome!,
        command: exe,
        provider: 'claude',
        args,
        cols: 100,
        rows: 30,
        hive: { id: GOD_ID, name: 'Michael', provider: 'claude', cwd: config.harnessHome!, isGod: true, role: 'orchestrator (god)' }
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
        provider: 'claude',
        model: config.defaultModel,
        isGod: true,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(god);
      useStore.getState().setGodStatus('ready');

      // Fresh spawn → kick Michael off once his TUI is up. First enable remote
      // control so the human can approve permission prompts from their phone
      // (best-effort — a failed/unknown slash command just prints to his terminal
      // and is harmless), PAUSE so it lands on its own line, then hand him the
      // orientation prompt. Both go through the per-pty submit chain, so they're
      // strictly sequential and can't jam together; the boot-grace window keeps
      // the inbox-wake/drain loops off Michael until he's oriented. Restored
      // sessions (the live-PTY branch above) skip this.
      bootGraceUntil.current[GOD_ID] = Date.now() + BOOT_GRACE_MS;
      timers.push(setTimeout(() => {
        if (cancelled) return;
        // settleMs pauses the chain ~1.5s after /remote-control before the
        // orientation prompt is submitted next.
        submitToPty(GOD_PTY, '/remote-control', REMOTE_CONTROL_SETTLE_MS).catch(() => { /* best-effort */ });
        submitToPty(GOD_PTY, INITIAL_GOD_PROMPT).catch(() => { /* pty may have died */ });
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

      const command = buildSpawnCommand(config, ASSISTANT_MODEL, 'claude');
      const [exe, ...args] = command.trim().split(/\s+/);
      const res = await window.cth.spawnPty({
        id: ASSISTANT_PTY,
        cwd: config.harnessHome!,
        command: exe,
        provider: 'claude',
        args,
        cols: 100,
        rows: 30,
        hive: { id: ASSISTANT_ID, name: 'Dwight', provider: 'claude', cwd: config.harnessHome!, isAssistant: true, role: "Michael's prep assistant" }
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
        provider: 'claude',
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
      // Breaker precedence (#5C): a constrained/stopped agent stays 'looping'
      // regardless of in-flight tool/prompt/compact events.
      const blevel = breakerLevel.current[e.agentId];
      const breakerArmed = blevel === 'constrained' || blevel === 'stopped';
      // Hook events are the authoritative status source for real agents (the
      // pty-stream parser only refines the on-floor action/station).
      if (e.event === 'PreCompact') {
        // #5C — agent entered /compact; show it's boxing up context, not frozen.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'compacting', action: 'compacting context', carrying: undefined });
      } else if (e.event === 'PostCompact') {
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'resumed', carrying: undefined });
      } else if (e.event === 'PreToolUse' && e.tool) {
        const m = stationForTool(e.tool);
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', currentStation: m.station, carrying: m.carry, action: `using ${e.tool}` });
        useStore.getState().bumpToolCount(e.agentId); // usage proxy for the command center
      } else if (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit') {
        // A turn is in progress (prompt submitted / tool just finished) — keep
        // it working so it doesn't flicker idle between tool calls.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working' });
      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {
        // A blocked Stop means the agent is being re-engaged to process its
        // inbox — it's NOT idle, so keep it working until it genuinely stops.
        if (e.blocked) {
          if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'reading inbox', carrying: undefined });
        } else {
          // A genuine stop clears any breaker override — the run is over.
          breakerLevel.current[e.agentId] = 'healthy';
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      } else if (e.event === 'Notification' && !breakerArmed) {
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

  // 2b) Consume circuit-breaker state (#7C.4/#5C). Lane A's breaker policy (#6)
  //     pushes BreakerState on `control:breakerState`; this gives it PRECEDENCE
  //     over hook-derived status: a constrained/stopped agent is pinned to
  //     'looping' (see the breakerArmed guard above) until it genuinely Stops.
  useEffect(() => {
    return window.cth.onBreakerState((s) => {
      breakerLevel.current[s.agentId] = s.level;
      const { updateAgent, agents } = useStore.getState();
      if (!agents.some((a) => a.id === s.agentId)) return;
      if (s.level === 'constrained' || s.level === 'stopped') {
        updateAgent(s.agentId, { status: 'looping', action: s.reason || 'breaker armed', carrying: undefined });
      }
      // 'healthy'/'steering' clear the pin; the next hook event refreshes status.
    });
  }, []);

  // 2c) Context gauge backfill: poll each live agent's current context size
  //     (tokens) from its session transcript — only until the status line
  //     (effect 2d) has delivered exact numbers for that agent.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const poll = async () => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId) continue;
        // The status line pushes exact numbers after every response (effect
        // 2d) — this transcript poll only backfills agents whose status line
        // hasn't fired yet (e.g. freshly restored, no response so far).
        if (a.contextLimit !== undefined) continue;
        try {
          const ctx = await window.cth.agentContext(a.id);
          if (ctx === null) continue;
          const hinted = /1m/i.test(a.model ?? '') ? 1_000_000 : 200_000;
          const limit = Math.max(hinted, ctx > 200_000 ? 1_000_000 : 0);
          const progress = Math.max(0, Math.min(8, Math.round((ctx / limit) * 8)));
          updateAgent(a.id, { contextTokens: ctx, progress });
        } catch { /* ignore — try again next tick */ }
      }
    };
    const t = setTimeout(poll, 3000); // first fill shortly after boot
    const iv = setInterval(poll, 15000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 2d) Push-based context gauge: the status-line shim forwards the session's
  //     EXACT context accounting (tokens + real window size) after every
  //     response — no probing, no transcript guesswork.
  useEffect(() => {
    return window.cth.onHiveContextUpdate(({ agentId, tokens, limit }) => {
      // Defense-in-depth: the main process already filters limit > 0, but the
      // renderer must not trust IPC blindly — limit 0 would put NaN progress
      // into the store (NaN survives the Math.min/max clamp).
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(tokens)) return;
      const progress = Math.max(0, Math.min(8, Math.round((tokens / limit) * 8)));
      useStore.getState().updateAgent(agentId, { contextTokens: tokens, contextLimit: limit, progress });
    });
  }, []);

  // 3) Wake idle agents holding unread inbox messages. The assistant is
  //    send-only (it never receives inbox mail), so it's excluded.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const now = Date.now();
      const agents = useStore.getState().agents.filter(
        (a) => a.ptyId && !a.isAssistant && (a.status === 'idle' || a.status === 'waiting')
          // Don't type into an agent still running its boot sequence — the nudge
          // would collide with /remote-control + the orientation prompt.
          && (bootGraceUntil.current[a.id] ?? 0) < now
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
      // Hold queued messages until the target finishes its boot sequence.
      if ((bootGraceUntil.current[target.id] ?? 0) >= now) return false;
      if (now - (lastFlush.current[target.id] ?? 0) < FLUSH_COOLDOWN_MS) return false;
      lastFlush.current[target.id] = now;
      // Remove first so a burst of store updates can't double-send the same one.
      removeQueuedMessage(srcId, next.id);
      // Zero the gauge instantly on /clear — the new session's context isn't
      // known until statusLine fires after the first post-clear response, so
      // leaving it at the old value shows a stale-full bar during that window.
      if (next.text.trim().toLowerCase() === '/clear') {
        useStore.getState().updateAgent(target.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
      }
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
      // A slash command (e.g. a queued /compact) is NEVER enriched — it must hit
      // Michael's own session verbatim.
      if (messageQueues[GOD_ID]?.length) {
        const isCmd = messageQueues[GOD_ID][0].text.startsWith('/');
        if (enrichEnabled && !isCmd) dispatch(GOD_ID, byId(ASSISTANT_ID), enrichTaskPrompt);
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

  // 6) Auto-compact (scheduled standup). Main fires this per tick; we queue a
  //    /compact for each live agent so the drain (#4) delivers it only when the
  //    agent is idle — never jamming a working terminal. Deduped: if a /compact
  //    is already queued for an agent, skip it (no second one piles up).
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onAutoCompact(() => {
      const { agents, messageQueues, enqueueMessage } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId) continue;
        if (!isClaudeProvider(inferAgentProvider(a.command, a.provider))) continue;
        const queued = messageQueues[a.id] ?? [];
        if (queued.some((m) => m.text.trimStart().startsWith('/compact'))) continue;
        enqueueMessage(a.id, COMPACT_CMD);
      }
    });
  }, [config?.onboardingComplete]);
}
