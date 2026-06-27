import { useEffect, useRef } from 'react';
import { useStore, type Agent, type QueuedMessage, type StationKind, type ToolKind } from '@/store/store';
import {
  buildSpawnCommand,
  ASSISTANT_MODEL,
  inferAgentProvider,
  isClaudeProvider,
  tokenizeCommand,
  type HarnessConfig
} from '@/store/config';
import { acquireTerminal, resetTerminal } from '@/components/terminalPool';
import { OFFICE_CAST, DEFAULT_CHARACTER } from '@/scene/office/cast';

const GOD_ID = 'god';
/** Accent palette for MAIN-spawned (voice-hired) agents — picked deterministically
 *  from the agent id so the same agent always gets the same colour. Mirrors the
 *  AddAgentModal palette. */
const SPAWN_ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'] as const;
const GOD_PTY = `pty-${GOD_ID}`;

// How long to let Claude Code's TUI finish booting before we type the first
// thing into Michael's terminal, and how long to PAUSE after the /remote-control
// command so the slash command lands + executes on its own line before the
// orientation prompt follows (otherwise they jam into one line and the TUI shows
// "Unknown command: /remote-control…").
const GOD_BOOT_MS = 4000;
const REMOTE_CONTROL_SETTLE_MS = 1500;
// Provider-agnostic PTY-quiescence idle fallback (#2e). A non-Claude bridge that
// fires a 'working' event but never its turn-end signal (Stop / session.idle /
// agent_end) would pin the agent 'working' forever → the idle-only inbox-wake nudge
// never fires → a god stops draining mail and the floor stalls. So a 'working'
// agent whose PTY has emitted NOTHING for this window is treated as turn-done and
// flipped idle. A streaming turn (incl. a long tool) keeps emitting bytes → stays
// working; only true silence drifts it idle. Hook events still win — a fresh
// PreToolUse/Stop refreshes status on the next event. Checked on QUIESCE_POLL_MS.
const QUIESCE_IDLE_MS = 12000;
const QUIESCE_POLL_MS = 4000;
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

// Auto-compact only fires once an agent's live context has filled to at least
// this fraction of its model's window. It's a FRACTION of contextLimit (which is
// per-agent/per-model), so a 200k session and a 1M session both compact at the
// same 30% relative fill — not at a fixed token count. Agents below this, or with
// no context telemetry yet, are left alone — so the hourly standup no longer
// compacts every terminal unconditionally.
const COMPACT_CONTEXT_THRESHOLD = 0.3;

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
    // Bracketed paste (ESC[200~ … ESC[201~) only matters for MULTI-LINE text, so a
    // stray "\n" doesn't submit early (#24). Single-line text (nudges, slash
    // commands) is sent raw — some TUIs (Antigravity's agy) treat the paste
    // markers as literal input and never submit, so skipping them is more robust.
    const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
    await window.cth.writePty(ptyId, payload);
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

function terminalWorkOrderPrompt(msg: {
  id: string;
  from: string;
  act: string;
  subject: string;
  body: string;
  requiresReply: boolean;
  createdAt: string;
}): string {
  return [
    'WORK ORDER FROM HIVE',
    `Message: ${msg.id}`,
    `From: ${msg.from}`,
    `Subject: ${msg.subject}`,
    `Act: ${msg.act}${msg.requiresReply ? ' (reply expected)' : ''}`,
    `Issued: ${msg.createdAt}`,
    '',
    msg.body,
    '',
    'Notes:',
    '- This arrived through your terminal because this provider does not support hive inbox.',
    '- Work in your current cwd.',
    '- When done, report changes, validation, blockers, and next step in this terminal.'
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
  if (TOOL_STATION[tool]) return TOOL_STATION[tool];
  if (tool.startsWith('mcp__')) return { station: 'mcp', carry: 'MCP' };
  // Heuristic fallback for non-Claude tool names (Antigravity sends run_command,
  // ListDir, write_file, … — its hook names differ from Claude's exact tags).
  // Match write/edit BEFORE read so "write_file" → desk, not shelf.
  const t = tool.toLowerCase();
  if (/command|bash|shell|exec|terminal|run_/.test(t)) return { station: 'terminal', carry: 'Bash' };
  if (/web|fetch|browser|http|url/.test(t)) return { station: 'web', carry: 'WebFetch' };
  if (/write|edit|create|patch|replace|apply/.test(t)) return { station: 'desk', carry: 'Write' };
  if (/read|list|view|dir|glob|grep|search|find|file|cat|\bls\b/.test(t)) return { station: 'shelf', carry: 'Read' };
  return { station: 'desk' };
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
  // In-flight spawn guard so a re-render / StrictMode double-mount can't spawn
  // Michael twice (the window between the listPtys check and spawnPty is racy).
  const godSpawning = useRef(false);
  // Per-agent timestamp until which auto-typers (inbox-wake #3, queue-drain #4)
  // must leave the agent alone — set while its boot sequence is typing so nothing
  // collides with /remote-control + the orientation prompt.
  const bootGraceUntil = useRef<Record<string, number>>({});
  // Agents whose one-time TUI protocol seed (Crush, seedDelivery:'type-into-tui')
  // has already been typed — guards effect #3b against re-seeding. (ondev-b)
  const seeded = useRef<Set<string>>(new Set());
  const seenTerminalHandoffs = useRef<Set<string>>(new Set());
  // Per-pty timestamp guarding auto-revive (effect #7) against a double-respawn
  // when power-resume + screen-unlock arrive back-to-back: an id revived (or
  // mid-revive) within REVIVE_DEBOUNCE_MS is skipped. Set BEFORE the async spawn
  // so a re-entrant event can't race a second respawn for the same id.
  const reviving = useRef<Record<string, number>>({});
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

      const godProvider = config.godProvider ?? 'claude';
      const godModel = config.godModel;
      const command = buildSpawnCommand(config, godModel, godProvider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.harnessHome!,
        command: exe,
        provider: godProvider,
        args,
        cols: 100,
        rows: 30,
        // Restore Michael's prior conversation across an app restart. His session
        // id lives in the hive registry (recorded from his hooks), so the main
        // process attaches `--resume <id>`; a missing transcript falls back to a
        // fresh session. Without this the most important context on the floor —
        // the orchestrator's — was lost on every restart.
        resume: true,
        hive: { id: GOD_ID, name: 'Michael', provider: godProvider, cwd: config.harnessHome!, isGod: true, role: 'orchestrator (god)' }
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
        provider: godProvider,
        model: godModel,
        isGod: true,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(god);
      useStore.getState().setGodStatus('ready');

      // Kick Michael off once his TUI is up. Always re-enable remote control so
      // the human can approve permission prompts from their phone (best-effort — a
      // failed/unknown slash command just prints to his terminal and is harmless).
      // Then, ONLY on a genuinely fresh spawn, hand him the orientation prompt —
      // a RESUMED Michael already has his full context and must not be re-oriented
      // mid-thread (that would reset the floor's situational awareness). Both go
      // through the per-pty submit chain, so they're strictly sequential and can't
      // jam together; the boot-grace window keeps the inbox-wake/drain loops off
      // Michael until he's settled. The live-PTY branch above skips this entirely.
      const resumedGod = res.resumed === true;
      bootGraceUntil.current[GOD_ID] = Date.now() + BOOT_GRACE_MS;
      timers.push(setTimeout(() => {
        if (cancelled) return;
        // settleMs pauses the chain ~1.5s after /remote-control before the
        // orientation prompt (fresh spawns only) is submitted next.
        submitToPty(GOD_PTY, '/remote-control', REMOTE_CONTROL_SETTLE_MS).catch(() => { /* best-effort */ });
        if (!resumedGod) {
          // A type-into-tui god (Crush) can't ride its hive protocol on argv, so the
          // main process hands it back as seedPrompt — type it FIRST (identity), then
          // the orientation kick. Serialized via writeChains so they can't jam. (ondev-b)
          if (res.seedPrompt) submitToPty(GOD_PTY, res.seedPrompt).catch(() => { /* pty may have died */ });
          submitToPty(GOD_PTY, INITIAL_GOD_PROMPT).catch(() => { /* pty may have died */ });
        }
      }, GOD_BOOT_MS));
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); timers.forEach(clearTimeout); };
  }, [config?.onboardingComplete, config?.harnessHome]);

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
      } else if (e.event === 'PreInvocation') {
        // Antigravity (agy): the model is being called — it's thinking/working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'thinking' });
      } else if (e.event === 'PostInvocation') {
        // agy's per-turn boundary. Unlike Claude, agy's Stop fires only on process
        // EXIT, so without this an agy worker would never register as idle and the
        // inbox-wake nudge (idle-only) could never reach it — its mail would sit
        // undrained. Treat it as idle; a follow-up tool/turn re-sets working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
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

  // 2e) Non-Claude providers cannot drain hive inbox. Direct hive mail to them
  //     arrives here as a terminal work order and is queued through the same
  //     idle-only PTY drain as human-composed messages.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveTerminalHandoff((msg) => {
      if (seenTerminalHandoffs.current.has(msg.id)) return;
      const { agents, enqueueMessage, messageQueues } = useStore.getState();
      const target = agents.find((a) => a.id === msg.to);
      if (target?.ptyId) {
        const marker = `Message: ${msg.id}`;
        if ((messageQueues[target.id] ?? []).some((queued) => queued.text.includes(marker))) return;
        seenTerminalHandoffs.current.add(msg.id);
        enqueueMessage(target.id, terminalWorkOrderPrompt(msg));
        return;
      }
      seenTerminalHandoffs.current.add(msg.id);
      enqueueMessage(
        GOD_ID,
        [
          `Terminal handoff failed for ${msg.to}: ${msg.subject}`,
          '',
          `Message ${msg.id} from ${msg.from} could not be queued because ${msg.to} has no live PTY. Route it manually or respawn the agent.`
        ].join('\n')
      );
    });
  }, [config?.onboardingComplete]);

  // 2e) PROVIDER-AGNOSTIC PTY-QUIESCENCE IDLE FALLBACK (the linchpin that makes
  //     canReceiveInbox:true safe for the live-unverified OpenCode/Crush/pi bridges).
  //     Hook events are the authoritative status source, but a bridge whose turn-end
  //     signal (Stop/session.idle/agent_end) doesn't fire leaves the agent pinned
  //     'working' — and BOTH delivery paths (#3 nudge, #4 queue-drain) are idle-gated,
  //     so the agent silently stops draining mail. usePtyParser has a 4s idle drift,
  //     but it's Claude-TUI-tuned AND only runs for the mounted terminal — a
  //     backgrounded god gets none. This is the floor-wide, provider-agnostic backstop:
  //     it reads each live PTY's lastOutputAt (already tracked in the main process) and
  //     flips any 'working' agent quiet for QUIESCE_IDLE_MS to idle so the nudge can
  //     drain it. Safe because a genuinely-working agent (incl. a long streaming tool)
  //     keeps emitting bytes; a false idle self-corrects on the next hook event.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const ptys = await window.cth.listPtys().catch(() => []);
      if (!ptys.length) return;
      const lastOut: Record<string, number> = {};
      for (const p of ptys) lastOut[p.id] = p.lastOutputAt;
      const now = Date.now();
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.status !== 'working') continue;
        // Never fight the breaker pin (a constrained/stopped agent stays 'looping')
        // or a still-booting agent (its boot sequence is mid-type).
        const bl = breakerLevel.current[a.id];
        if (bl === 'constrained' || bl === 'stopped') continue;
        if ((bootGraceUntil.current[a.id] ?? 0) > now) continue;
        const last = lastOut[a.ptyId];
        if (typeof last === 'number' && last > 0 && now - last > QUIESCE_IDLE_MS) {
          updateAgent(a.id, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    }, QUIESCE_POLL_MS);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 3) Wake idle agents holding unread inbox messages. The assistant is
  //    send-only (it never receives inbox mail), so it's excluded.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const now = Date.now();
      const agents = useStore.getState().agents.filter(
        (a) => a.ptyId && (a.status === 'idle' || a.status === 'waiting')
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

  // 3b) Seed a fresh "type-into-tui" worker (Crush) with the hive protocol. Its
  //     bare TUI rejects a positional seed (Cobra reads it as a subcommand →
  //     `Unknown command`), so the main process spawns it bare and hands the
  //     protocol back as `seedPrompt`; we TYPE it as the worker's first turn after a
  //     boot-grace (TUI finished painting), ONCE per agent. Routed through the SAME
  //     per-pty submit chain + boot-grace as the inbox-wake nudge so the seed and a
  //     nudge can never jam onto one line. (god-as-Crush is seeded in its own boot
  //     sequence above; this covers workers.) (ondev-b)
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(() => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId || a.isGod || !a.seedPrompt || seeded.current.has(a.id)) continue;
        seeded.current.add(a.id);
        const ptyId = a.ptyId;
        const seed = a.seedPrompt;
        // Hold the nudge/quiesce typers off this agent until the seed lands + settles.
        bootGraceUntil.current[a.id] = Date.now() + BOOT_GRACE_MS;
        // Clear the record now so it isn't re-seen (the ref also guards) or persisted.
        updateAgent(a.id, { seedPrompt: undefined });
        setTimeout(() => {
          submitToPty(ptyId, seed).catch(() => { /* pty may have died */ });
        }, GOD_BOOT_MS);
      }
    }, 1500);
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
    const dispatch = (srcId: string, target: Agent | undefined, wrap?: (m: QueuedMessage) => string): boolean => {
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
      // `instruction` (when present) is the authoritative text to type into the
      // PTY — e.g. Slack-origin work carries the autonomy preamble there while the
      // kanban card keeps `text` (raw) as its readable title. UI/card surfaces
      // never read `instruction`, so this stays invisible to the human board.
      submitToPty(target.ptyId, wrap ? wrap(next) : (next.instruction ?? next.text)).catch(() => { /* pty may have died */ });
      return true;
    };

    // Promote a genuine Slack-origin work item to a stamped kanban card the first
    // time it's dispatched to the office. The card carries slack:{channel,thread_ts}
    // (origin thread) so the main-process done-observer can post its one summary
    // reply in-thread once the card later reaches 'done'. ADDITIVE + idempotent +
    // best-effort: a failure here never affects the dispatch that already happened,
    // and only dispatched work items land here (slash commands/acks never do).
    type SlackTaskCard = Parameters<typeof window.cth.hiveWriteTasks>[0][number];
    const ensureSlackCard = async (m: QueuedMessage): Promise<void> => {
      const slack = m.slack;
      if (!slack) return;
      try {
        const raw = await window.cth.hiveTasks();
        const existing: SlackTaskCard[] =
          raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
            ? (raw as { tasks: SlackTaskCard[] }).tasks
            : [];
        const id = `slack-${slack.thread_ts}-${m.id}`;
        if (existing.some((t) => t.id === id)) return; // already promoted — no dup
        const title = m.text.length > 80 ? `${m.text.slice(0, 79)}…` : m.text;
        const card: SlackTaskCard = {
          id,
          title,
          description: m.text,
          status: 'todo',
          dependsOn: [],
          priority: 1,
          createdAt: new Date().toISOString(),
          slack
        };
        await window.cth.hiveWriteTasks([...existing, card]);
      } catch { /* best-effort: card promotion must never sink dispatch */ }
    };

    const flush = () => {
      const { agents, messageQueues } = useStore.getState();
      const byId = (id: string) => agents.find((a) => a.id === id);

      for (const a of agents) {
        if (!a.ptyId || a.status !== 'idle') continue;
        if (!messageQueues[a.id]?.length) continue;
        const head = messageQueues[a.id][0];
        if (dispatch(a.id, a) && head.slack) void ensureSlackCard(head);
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
  //    We immediately ack in the triggering thread and stash the thread coords
  //    so the office can post its summary back later.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onSlackMessage((msg) => {
      const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
      if (!msg?.text?.trim() && !hasFiles) return;
      let text = msg.text.trim();
      // Append local file paths so the agent (Claude Code) can Read them directly.
      if (hasFiles) {
        const fileLines = msg.files!.map((f) => `- ${f.path} (${f.name})`).join('\n');
        text = text ? `${text}\n\nAttached files:\n${fileLines}` : `Attached files:\n${fileLines}`;
      }
      const slack = { channel: msg.channel, thread_ts: msg.thread_ts };
      // `text` (raw user request + any attachment lines) drives the human-facing
      // kanban card title/description. The autonomy preamble — supplied verbatim
      // by main, the authoritative source — is prepended ONLY to god's working
      // instruction (what gets typed into his PTY), so the board stays readable
      // while every Slack-origin god-session runs under the autonomy policy. When
      // main sends no preamble (older build), god just gets the raw text.
      const instruction = msg.autonomyPreamble ? `${msg.autonomyPreamble}${text}` : undefined;
      useStore.getState().enqueueMessage(GOD_ID, text, { slack, instruction });
      // Immediate "queued" acknowledgement in the originating Slack thread.
      void window.cth.slackReply({
        channel: msg.channel,
        thread_ts: msg.thread_ts,
        text: ':hourglass_flowing_sand: *Received.* Your request has been queued — the team is on it and will reply here when done.'
      });
    });
  }, [config?.onboardingComplete]);

  // 5b) Pipe hive tasks addressed to non-Claude agents (e.g. Codex) into their
  //     terminal queues. When main routes a message to a non-claude provider it
  //     emits 'hive:enqueueToAgent' instead of bouncing; we enqueue the raw
  //     task text here so effect #4 types it into the REPL when the agent idles.
  //     No inbox nudge, no /compact — just the verbatim subject+body text.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveEnqueue?.((msg) => {
      if (!msg?.targetId || !msg?.text?.trim()) return;
      useStore.getState().enqueueMessage(msg.targetId, msg.text.trim());
    });
  }, [config?.onboardingComplete]);

  // 5b) MAIN-initiated roster changes (rt-5 voice spawn/kill). The renderer store is
  //     only mutated by renderer-initiated hires (AddAgentModal); a voice hire/kill
  //     runs in MAIN (spawnAgentCore / teardownPty, owner=null) and would otherwise
  //     be invisible on the floor. Main broadcasts; we build/archive the card here.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const offSpawn = window.cth.onHiveAgentSpawned?.((rec) => {
      if (!rec?.id) return;
      // addAgent is idempotent, but bail early if the renderer already carded it.
      if (useStore.getState().agents.some((a) => a.id === rec.id)) return;
      const key = (rec.name || rec.id).toLowerCase();
      const character =
        OFFICE_CAST.find((m) => m.name === key || m.displayName.toLowerCase() === key)?.name ??
        DEFAULT_CHARACTER;
      let h = 0;
      for (const ch of rec.id) h = (h + ch.charCodeAt(0)) % SPAWN_ACCENTS.length;
      const project = (rec.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'hive';
      const agent: Agent = {
        id: rec.id,
        name: rec.name || rec.id,
        character,
        accent: SPAWN_ACCENTS[h],
        description: rec.role || 'a fresh harness',
        project,
        tmuxTarget: '',
        cwd: rec.cwd,
        status: 'idle',
        action: 'starting up',
        progress: 0,
        currentStation: 'desk',
        ptyId: rec.id,
        command: rec.command,
        provider: rec.provider as Agent['provider'],
        isGod: false,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(agent);
    });
    const offArchive = window.cth.onHiveAgentArchived?.((e) => {
      if (e?.id) useStore.getState().archiveAgent(e.id);
    });
    return () => { offSpawn?.(); offArchive?.(); };
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
        // /compact is a Claude Code slash command — non-Claude CLIs (agy, codex)
        // would just receive it as literal prompt text. Skip them.
        if (!isClaudeProvider(inferAgentProvider(a.command, a.provider))) continue;
        // Only compact agents whose context has actually filled past the
        // threshold. contextLimit is per-model (200k vs the 1M window), so this
        // gate scales to each agent's own window instead of a fixed token count.
        // Unknown telemetry (limit not polled yet) ⇒ skip — never compact blind.
        const limit = a.contextLimit ?? 0;
        const used = a.contextTokens ?? 0;
        if (limit <= 0 || used / limit < COMPACT_CONTEXT_THRESHOLD) continue;
        const queued = messageQueues[a.id] ?? [];
        if (queued.some((m) => m.text.trimStart().startsWith('/compact'))) continue;
        enqueueMessage(a.id, COMPACT_CMD);
      }
    });
  }, [config?.onboardingComplete]);

  // 7) Auto-revive wedged PTYs after the Mac sleeps/locks. Kevin's main-process
  //    keepalive catches up its schedules on wake and DETECTS terminals that were
  //    live before sleep but went silent after resume — it reports those ids on
  //    `power:resume`. We respawn EXACTLY those, resuming each agent's prior CLI
  //    session (--resume) so the terminal self-heals instead of the user clicking
  //    "Restart & Continue". This reuses the same resume-spawn flow as that button
  //    (CommandCenterPanel.restartWithModel) and restoreTeam's worktree handling.
  //    Pure addition: an empty `dead[]` is a no-op; healthy PTYs are never touched.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    // Skip an id we revived (or are mid-reviving) within this window — coalesces
    // a resume + unlock that arrive back-to-back (main also coalesces on its side).
    const REVIVE_DEBOUNCE_MS = 8000;

    const revive = async (deadId: string): Promise<void> => {
      const now = Date.now();
      if (now - (reviving.current[deadId] ?? 0) < REVIVE_DEBOUNCE_MS) return;
      reviving.current[deadId] = now; // claim BEFORE any await so re-entry can't double-spawn
      // Only respawn a PTY we actually own; never touch an unknown/healthy id.
      const a = useStore.getState().agents.find((x) => x.ptyId === deadId);
      if (!a) return;
      try {
        const cfg = await window.cth.getConfig();
        // Isolated agents run inside their worktree (a.cwd is the base repo); re-enter
        // it if it still exists, else fall back to the base cwd — same as restoreTeam.
        let cwd = a.cwd;
        if (a.worktreePath && (await window.cth.gitIsRepo(a.worktreePath))) cwd = a.worktreePath;
        await window.cth.killPty(deadId);
        // Soft-reset the pooled xterm in place (no-op if none): re-arm input and
        // clear the stale frame so the revived TUI paints clean — like the button.
        resetTerminal(deadId);
        const provider = inferAgentProvider(a.command, a.provider);
        // Prefer the agent's exact recorded command (same model/flags); fall back to
        // a rebuilt one only if it predates the persisted `command` field.
        const command = (a.command ?? '').trim() || buildSpawnCommand(cfg, a.model, provider);
        const [exe, ...args] = tokenizeCommand(command);
        const hive = a.isGod
          ? { id: a.id, name: a.name, cwd, provider, isGod: true, role: 'orchestrator (god)' }
          : a.isAssistant
          ? { id: a.id, name: a.name, cwd, provider, isAssistant: true, role: "Michael's prep assistant" }
          : { id: a.id, name: a.name, cwd, provider, role: a.description };
        // Spawn at the terminal's real grid so the TUI's absolute cursor moves land
        // in the right cells (a size mismatch scatters the redraw).
        const entry = acquireTerminal(deadId);
        let cols = 100, rows = 30;
        try { entry.fit.fit(); cols = entry.term.cols; rows = entry.term.rows; } catch { /* host not sized yet */ }
        const res = await window.cth.spawnPty({
          id: deadId,
          cwd,
          command: exe,
          provider,
          args,
          cols,
          rows,
          // The worktree (if any) already exists on disk — re-enter it, do NOT
          // re-isolate (that conflicts on the existing path/branch).
          isolate: false,
          // Reattach the agent's prior session so no context is lost on revive.
          resume: true,
          hive
        });
        if (res.ok) {
          reviving.current[deadId] = Date.now(); // re-stamp so the debounce covers the spawn
          useStore.getState().updateAgent(a.id, { status: 'idle', action: 'revived after sleep' });
        } else {
          delete reviving.current[deadId]; // let a later power:resume retry it
          console.error('[autorevive] respawn failed for', a.id, res.error);
        }
      } catch (err) {
        delete reviving.current[deadId];
        console.error('[autorevive] respawn threw for', deadId, err);
      }
    };

    return window.cth.onPowerResume?.((e) => {
      const dead = Array.isArray(e?.dead) ? e.dead : [];
      if (!dead.length) return; // healthy wake — nothing wedged, no-op
      for (const id of dead) void revive(id);
    });
  }, [config?.onboardingComplete]);
}
