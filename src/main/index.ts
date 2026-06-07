import { app, BrowserWindow, clipboard, dialog, ipcMain, powerSaveBlocker, screen, shell, Notification } from 'electron';
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PtyManager, type SpawnOptions } from './pty';
import {
  readConfig, writeConfig, resetConfig, ensureHarnessHome, ensureClaudePermissionsAccepted,
  modelForRole, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, type HarnessConfig, type ScheduledMission
} from './config';
import { listDir, readFileText, writeFileText } from './fs';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo,
  addWorktree, removeWorktree
} from './git';
import { HiveManager, type AgentMeta, type HiveMessage, type HiveTask } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker, type BreakerInput } from './breaker';
import type { UsageProvider } from './usage';
import { MemoryManager } from './memory';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { enrichMessage } from './assistant';
import { readAgentUsage, readContextTokens } from './transcript';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer } from './slack';
import { TelemetryCollector } from './telemetry';
import { ControlRegistry } from './control';
import { inferAgentProvider, isClaudeProvider, type AgentProvider } from '../shared/agentProvider';

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const ptyManager = new PtyManager();
/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } }
);
// #7C — operator control state (pause/gate/steer/halt), read by the HookServer
// when deciding hook returns.
const control = new ControlRegistry();
// Stage 7A — the live observability tap. Receives Claude Code's first-party OTel
// over loopback OTLP/JSON and exposes the locked usage-provider seam. resolveCwd
// lets the transcript fallback find an agent's cwd from the hive registry.
const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null
});
// Usage provider (Seam 1) — the INTEGRATION swap: Oscar's telemetry collector (#7)
// IS the provider, replacing Lane A's interim StubUsageProvider. Same
// getAgentUsage(agentId) pull seam, so the breaker + cost ledger consumers are
// untouched; telemetry has a transcript fallback built in, so it works before any
// live OTel arrives.
const usageProvider: UsageProvider = telemetry;
// Circuit breaker (Lane A #6.6b) — the REAL policy (replaces Lane C's interim
// glue). POLICY only; the heartbeat beat feeds it signals (via usageProvider) +
// enforces its decisions. Config read live so a settings change applies next beat.
const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
});
// Always-on beats (decoupled from the optional heartbeat): the live fleet snapshot
// Michael reads + the breaker beat, so guardrails + monitoring work even when the
// heartbeat mission is disabled (it ships off).
let fleetTimer: ReturnType<typeof setInterval> | null = null;
let breakerBeatTimer: ReturnType<typeof setInterval> | null = null;
// Feed the breaker's api_error-storm trip from Oscar's OTel api_error spans —
// Jim's one breaker input with no on-branch source (telemetry.onApiError seam).
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// HookServer needs BOTH: Oscar's control registry (HITL pause/gate/steer/halt via
// hook returns) AND Jim's breaker (feed recordToolUse on each PostToolUse).
const hookServer = new HookServer(hive, () => liveWebContents(), () => readConfig(), control, breaker);
const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
/** Reads the reflect tunables from config each tick (defaults baked in here so a
 *  pre-existing config.json without the keys still gets sane values). */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// Finishes the janitor's missing condense half: bounds each agent's memory.md
// (Haiku tail-summary, backup→verify→atomic-swap) so it never grows unbounded.
const reflector = new MemoryReflector(
  () => readConfig().harnessHome,
  () => readConfig().defaultCommand ?? 'claude',
  () => memory.env(),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } }
);
// Durable harness state (SQLite, main process). Phase A: window bounds (kv) +
// net-new command history. Opened in whenReady, closed in the teardown blocks.
const persist = new PersistStore();
let mainWindow: BrowserWindow | null = null;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so the second call (kill() also makes node-pty fire
 * onExit) is a harmless no-op. Best-effort — every step is wrapped so a teardown
 * error can never crash the caller (an IPC handler or node-pty's onExit).
 */
function teardownPty(id: string): void {
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    // Drop breaker state so a dead agent can't leak/zombie a tripped level.
    try { breaker.forget(agentId); } catch { /* best-effort */ }
    if (hive.enabled()) {
      try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    void removeWorktree(origCwd, wtPath)
      .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
      .catch(e => console.error('[worktree] removeWorktree threw:', e));
  }
  syncKeepAwake();
}
// A natural PTY exit must run the same teardown as an explicit kill.
ptyManager.setExitHandler(teardownPty);

/** Keep the system from suspending the harness while agents are running.
 *  Windows Modern Standby suspends desktop apps (and their child `claude`
 *  processes!) shortly after the display sleeps/locks — the whole hive froze
 *  mid-turn until unlock. `prevent-app-suspension` blocks exactly that while
 *  still letting the display turn off and the session lock. Held only while at
 *  least one PTY is alive, so an idle harness doesn't pin a laptop awake. */
let keepAwakeId: number | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  if (live && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[power] keep-awake ON — agents running');
  } else if (!live && keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* noop */ }
    keepAwakeId = null;
    console.log('[power] keep-awake off — no agents');
  }
}

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission honoring its lastFiredAt — a setTimeout for the
 *  time remaining until its next due fire, which then settles into a steady
 *  interval. Each tick dispatches the mission to its target agent and stamps
 *  lastFiredAt back into config. Called on boot (after the router starts) and
 *  after every missions:save. */
function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled || !(m.intervalMs > 0)) continue;
    // Heartbeat (Lane A #1) opts out of the fixed setInterval and self-reschedules
    // with an adaptive cadence. Registered into the same missionTimers map so
    // clearMissionTimers() tears it down identically on quit/reset.
    if (m.kind === 'heartbeat') { armHeartbeat(m); continue; }
    const fire = (): void => {
      try {
        if (hive.enabled()) {
          hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
        }
        // Auto-compact: do NOT jam /compact into busy terminals. Hand it to the
        // renderer, which queues a /compact per agent (deduped — never two at
        // once) and delivers it only when that agent goes idle (its drain loop),
        // so a working agent compacts between steps, never mid-step.
        if (m.autoCompact) {
          try { liveWebContents()?.send('mission:autoCompact'); } catch { /* window gone */ }
        }
        const current = readConfig().missions ?? [];
        const next = current.map((x) =>
          x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ missions: next });
        // Let the SCHEDULES panel refresh its "last fired" without a reload (#2.3).
        try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

/** One-time migration: ensure the built-in hourly ops standup exists for installs
 *  that predate it. Guarded by `opsStandupSeeded` so a user who later deletes the
 *  mission doesn't get it re-added on every boot. Stamps lastFiredAt = now so the
 *  first standup waits a full interval instead of firing (and compacting every
 *  terminal) immediately on launch. */
function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  // Seed the built-in heartbeat (Lane A #1) once. Shipped DISABLED, so it just
  // appears in the SCHEDULES panel for the user to turn on; lastFiredAt = now so
  // it doesn't fire on the very first launch after a user enables it.
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }
}

// ─── Heartbeat (Lane A #1) + circuit-breaker beat (#6.6b) ────────────────────

/** Is the floor quiet? Derived ONLY from signals the main process owns or can
 *  stat — log.jsonl mtime (the master signal: every routed msg/drain/spawn/task
 *  append touches it), each agent's inbox + outbox/.sent mtimes, and every live
 *  PTY's lastOutputAt (an agent printing/thinking counts as activity). Crucially
 *  NOT registry.status, which is written 'idle' once at spawn and never
 *  transitions in main — reading it would see the floor quiet forever. */
function isFloorQuiet(thresholdMs: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const times: number[] = [];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  pushMtime(join(root, 'log.jsonl'));
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      pushMtime(join(agentsDir, id, 'inbox'));
      pushMtime(join(agentsDir, id, 'outbox', '.sent'));
    }
  }
  for (const t of ptyManager.list()) times.push(t.lastOutputAt);
  if (times.length === 0) return false; // nothing to judge → don't fire
  return Date.now() - Math.max(...times) > thresholdMs;
}

/** Newest coordination-file mtime for one agent (inbox, outbox/.sent, memory.md)
 *  — FILES only, deliberately excluding PTY output, so "no-progress" means "not
 *  coordinating" even while the agent is busy printing tokens. */
function lastCoordinationAt(agentId: string): number {
  const root = hive.root();
  if (!root) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  const dir = join(root, 'agents', agentId);
  pushMtime(join(dir, 'inbox'));
  pushMtime(join(dir, 'outbox', '.sent'));
  pushMtime(join(dir, 'memory.md'));
  return Math.max(...times);
}

/** PTY id owning a given agent id, or undefined. */
function ptyForAgent(agentId: string): string | undefined {
  for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
  return undefined;
}

/** "Stuck" = some worker's PTY is actively printing (recent output) while its
 *  coordination files have gone stale — working-but-not-coordinating. Tightens
 *  the heartbeat cadence so we notice a wedged agent sooner. */
function looksStuck(windowMs: number): boolean {
  const reg = hive.registry();
  const now = Date.now();
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || a.isAssistant || id === reg.godId) continue;
    const ptyId = ptyForAgent(id);
    if (!ptyId) continue;
    const idle = ptyManager.idleFor(ptyId) ?? Infinity;
    if (idle < 15_000 && now - lastCoordinationAt(id) > windowMs) return true;
  }
  return false;
}

/** Bounded digest for god — paths + counts, never full files (reference-passing,
 *  #6.2). A few hundred tokens at most. */
function buildHeartbeatDigest(quietMs: number): string {
  const reg = hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && !a.isAssistant && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(', ') || '—';
  const boardHead = hive.board().split('\n').slice(0, 10).join('\n').trim();
  const log = hive.logTail(8).map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n');
  const withInbox = active.filter(([id]) => hive.inbox(id).length > 0).map(([, a]) => a.name);
  return [
    `Floor heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`,
    `Active agents (${active.length}): ${names}.`,
    withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
    '',
    'Board (head):',
    boardHead || '(empty)',
    '',
    'Recent log:',
    log || '(none)',
    '',
    'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
  ].join('\n');
}

/** Re-engage a quiet floor: drop a durable digest into god's inbox. We never
 *  type directly into god's PTY here — if he's busy that would jam mid-step. The
 *  inbox message is delivered by the renderer's busy-aware inbox-wake (it nudges
 *  god to read his inbox only once he's idle), so the heartbeat defers around a
 *  working god instead of interrupting him. */
function reengageGod(digest: string): void {
  if (!hive.enabled()) return;
  hive.send({ to: 'god', act: 'request', subject: 'Heartbeat', body: digest }, 'heartbeat');
}

/** A native toast for breaker constrain/stop, gated on the notifications setting. */
function breakerToast(title: string, body: string): void {
  if (!readConfig().notifications) return;
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
  catch { /* unsupported platform */ }
}

/** One circuit-breaker beat: pull a fresh usage sample per active agent, append
 *  it to the durable cost ledger (the SOLE durable cost store), tick the breaker,
 *  emit each BreakerState on control:breakerState (Seam 2), and enforce any
 *  escalation. God is in the LEDGER (cost visibility) but NOT the breaker inputs
 *  (the heartbeat manages god; we never auto-steer/kill the orchestrator). */
function runBreakerBeat(progressWindowMs: number): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  const now = Date.now();
  const inputs: BreakerInput[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || a.isAssistant) continue;
    const sample = usageProvider.getAgentUsage(id);
    if (sample) hive.appendCostLedger(sample); // ledger covers everyone incl. god
    if (id === reg.godId) continue;            // breaker skips god
    inputs.push({ agentId: id, sample, progressing: now - lastCoordinationAt(id) < progressWindowMs });
  }
  for (const d of breaker.tick(inputs, now)) {
    try { liveWebContents()?.send('control:breakerState', d.state); } catch { /* window gone */ }
    if (d.action === 'none') continue;
    const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
    const reason = d.state.reason;
    if (d.action === 'steer') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
        body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask god for direction.` }, 'breaker');
    } else if (d.action === 'constrain') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
        body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to god for sign-off BEFORE running more tools.` }, 'breaker');
      breakerToast(`${name} constrained`, reason);
    } else if (d.action === 'stop') {
      const ptyId = ptyForAgent(d.state.agentId);
      if (ptyId) { try { ptyManager.kill(ptyId); } catch { /* already gone */ } teardownPty(ptyId); }
      breakerToast(`${name} stopped by circuit breaker`, reason);
    }
  }
}

/** Build + write the live fleet snapshot Michael reads (`<hive>/fleet.json`).
 *  Always-on (independent of the heartbeat) since `claude agents` can't see the
 *  hive's sibling sessions. PII-free; never throws (called from a timer). */
function writeFleetSnapshot(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const u = usageById.get(id);
        const spans = snap.spans[id] ?? [];
        const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : a.isAssistant ? 'assistant' : 'agent'),
          cwd: a.cwd,
          isGod: !!a.isGod,
          isAssistant: !!a.isAssistant,
          breaker: breaker.levelFor(id),
          tokens,
          usd: u ? Number(u.usd.toFixed(4)) : 0,
          lastTool: spans.length ? spans[spans.length - 1].tool : null,
          lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
          inboxBacklog: hive.inboxBacklog(id)
        };
      });
    hive.writeFleetSnapshot({ ts: now, agents });
  } catch (e) {
    console.error('[fleet] snapshot failed:', e);
  }
}

/** Arm the heartbeat with an adaptive, self-rescheduling cadence (recursive
 *  setTimeout instead of a fixed setInterval). Each beat runs the cost/breaker
 *  pass, re-engages a quiet floor, stamps lastFiredAt, then re-arms: ~base on a
 *  normal beat, base/4 (min 30s) when an agent looks stuck, base*2.5 right after
 *  a re-engage. Registered into missionTimers so shutdown tears it down. */
function armHeartbeat(m: ScheduledMission): void {
  const base = m.intervalMs;
  const quiet = m.quietThresholdMs ?? 300_000;
  const beat = (): void => {
    let next = base;
    try {
      // (the breaker beat + cost ledger now run on their own always-on timer)
      if (isFloorQuiet(quiet)) {
        reengageGod(buildHeartbeatDigest(quiet));
        next = Math.round(base * 2.5);            // back off after re-engaging
      } else if (looksStuck(quiet)) {
        next = Math.max(30_000, Math.round(base / 4)); // tighten when an agent is wedged
      }
      const cur = readConfig().missions ?? [];
      writeConfig({ missions: cur.map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x)) });
      try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
    } catch (e) {
      console.error('[heartbeat]', e);
    }
    const entry = missionTimers.get(m.id) ?? {};
    entry.timeout = setTimeout(beat, next);
    missionTimers.set(m.id, entry);
  };
  const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
  missionTimers.set(m.id, { timeout: setTimeout(beat, remaining) });
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

// ─── Slack webhook server (Slack message → Michael's queue) ──────────────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    onMessage: (text) => {
      try { liveWebContents()?.send('slack:incomingMessage', { text }); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) slackServer = null;
  return res;
}

/** Stop and forget the Slack server. Best-effort; safe to call when not running. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
}

/** The persisted main-window geometry (kv key `window.bounds`). */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** Validate + clamp restored bounds: enforce the minimum size, and drop a
 *  position that no longer lands on any connected display (monitor unplugged) so
 *  the window can't open off-screen. Returns null for unusable input. */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // Keep the position only if the window rect overlaps some display's work area.
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** Minimal trailing-edge debounce for the move/resize flood. */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

function createWindow(): void {
  // Restore the last window geometry (kv), falling back to the default size.
  let saved: WindowBounds | null = null;
  try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; }

  const win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WIN.width,
    height: saved?.height ?? DEFAULT_WIN.height,
    ...(saved && saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: 'Munder Difflin',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs the hive's heartbeat loops (inbox nudge, message
      // flush, telemetry polls). Chromium throttles timers in occluded windows
      // — incl. behind the LOCK SCREEN — which silently stalls the hive while
      // the user is away. Don't.
      backgroundThrottling: false
    }
  });

  mainWindow = win;

  // Persist geometry as the user drags/resizes (debounced) and on close. Skip
  // while maximized/minimized so a restore doesn't save the fullscreen rect.
  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
  }, 400);
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // On macOS, the red-X "close" event by default destroys the window — and on
  // a single-window app, that effectively quits. Intercept it the same way we
  // intercept before-quit so PTY users get the warning.
  win.on('close', (e) => {
    if (allowQuit) return;
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    win.webContents.send('app:closeRequested', { ptyCount: count });
  });

  ptyManager.attachWebContents(win.webContents);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', async (_evt, opts: SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean; provider?: AgentProvider }) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
  opts.provider = provider;
  if (opts.hive) opts.hive = { ...opts.hive, provider };
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(readConfig().harnessHome ?? origCwd, 'worktrees');
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // If the agent carries hive metadata, provision its workspace and add
  // provider-specific spawn injection. Non-Claude providers get shared AGENT_*
  // env only; Claude Code also gets prompt/settings hook args.
  if (opts.hive && hive.enabled()) {
    try {
      const inj = hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        { semanticMemory: memory.active(), theme: readConfig().terminalTheme ?? 'light' }
      );
      opts.args = [...(opts.args ?? []), ...inj.args];
      // Point the agent's mempalace CLI at the shared palace (no-op if inactive).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env() };
    } catch (e) {
      // Hive provisioning is best-effort; never block a spawn on it.
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // Long-run guardrails + tiering (Lane A #6.4/#6.6). All additive to the args
  // already assembled (incl. the hive injection); an explicit choice always wins.
  if (opts.hive && isClaudeProvider(provider)) {
    const cfg = readConfig();
    const args = opts.args ?? [];
    // Model precedence: an explicit per-agent --model (from the renderer) wins;
    // else the user's global defaultModel; else the role-based default tier.
    if (!args.includes('--model')) {
      const m = cfg.defaultModel ?? modelForRole(opts.hive);
      if (m) args.push('--model', m);
    }
    // Coarse runaway cap.
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    // Idempotent resume (#6.6a): only when explicitly requested and we have a
    // prior session id for this agent.
    if (opts.resume === true) {
      const sid = hive.lastSession(opts.hive.id);
      if (sid && !args.includes('--resume')) args.push('--resume', sid);
    }
    opts.args = args;
  }
  // Remember which agent owns this PTY so closing the tab can archive it. A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) ptyToAgent.set(opts.id, opts.hive.id);
  // Pre-accept Claude Code's bypass-mode warning + folder-trust dialog so the
  // agent (spawned with --permission-mode bypassPermissions) doesn't stall on an
  // interactive prompt it can't answer and exit code 1. Best-effort, never blocks.
  if (isClaudeProvider(provider)) {
    try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* never block spawn */ }
  }
  const res = ptyManager.spawn(opts);
  syncKeepAwake(); // arm the power-save blocker while ≥1 agent PTY is alive (#18)
  return res;
});
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:readClipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
// NOTE: the terminal theme is mirrored into each agent's per-session Claude
// settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
// `claude config set -g theme`, which would also restyle the user's own
// Claude sessions outside the app.

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: Terminal.app at a folder ──────────────────────────────────────────
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('open', ['-a', 'Terminal', cwd]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
    });
  });
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => writeConfig(patch));
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// Change the harnessHome folder. Because every derived path (hive root, palace,
// sock, agent dirs) resolves lazily through getHome(), the only real work is
// optionally MOVING the existing hive + palace and relaunching so every service
// re-binds against the new root. mode: 'move' copies the data (old kept as a
// safety net), 'fresh' just re-points and bootstraps an empty home.
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  const newHome = resolve(p.newHome);
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // Guard against same-folder / nested-folder (a move would self-copy forever).
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;

  // Tear down everything bound to the OLD root before copying, so nothing writes
  // mid-copy — a live git commit into hive/.git would otherwise be copied as a
  // half-written object and corrupt the moved repo.
  try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }

  if (mode === 'move' && oldHome) {
    try {
      for (const sub of ['hive', 'palace']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
        // renameSync, which throws EXDEV across volumes). We COPY, never delete —
        // the old folder stays as a safety net the user removes manually.
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // Copy failed: recover IN PLACE against the unchanged old home (config never
      // repointed) so the user loses nothing, and surface the error — no relaunch.
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Repoint config and relaunch so every service re-bootstraps against newHome.
  // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
  app.relaunch();
  app.exit(0);
  return { ok: true as const }; // unreachable (process exits) — typed for the renderer
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const msg = hive.send(partial ?? {}, typeof from === 'string' ? from : 'system');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:writeTasks', (_evt, tasks: unknown) => {
  if (!Array.isArray(tasks)) return { ok: false, error: 'invalid tasks' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.writeTasks(tasks as HiveTask[]);
  return { ok: true };
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});

// ─── IPC: enrichment assistant (headless Sonnet 1M prompt prep) ─────────────
ipcMain.handle('assistant:enrich', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { message?: unknown; cwd?: unknown };
  if (typeof p.message !== 'string' || !p.message.trim()) {
    return { ok: false, error: 'empty message' };
  }
  const cfg = readConfig();
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : cfg.harnessHome;
  if (!cwd) return { ok: false, error: 'no working directory available' };
  try {
    return await enrichMessage({
      message: p.message,
      cwd,
      repos: cfg.registeredRepos ?? [],
      command: cfg.defaultCommand,
      env: memory.env()
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
ipcMain.handle('hive:memoryStatus', () => { memory.resetBinCache(); return memory.status(); });
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });
// Condense memory.md on demand: an explicit id condenses that one agent (skips
// the size trigger — a "condense now" button); no id runs a full threshold scan.
ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
  reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
ipcMain.handle('app:confirmClose', () => {
  allowQuit = true;
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  app.quit();
});
ipcMain.handle('app:cancelClose', () => {
  // no-op — modal will close on the renderer side
});

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  // Erase the hive (Michael's + every agent's memory, inboxes, tasks, board,
  // git history) and the semantic-memory palace. Only these harness-created
  // subdirs are removed — never the user's whole harnessHome folder.
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
// Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
// bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);
// Current context size (tokens) of an agent's LIVE session — the transcript
// path is learned from the agent's hook payloads (SessionStart fires right at
// spawn), so this works even when several agents share one cwd. Null until the
// first hook fires; a known-but-empty transcript reads as 0 so a freshly
// (re)started session zeroes the gauge instead of leaving a stale value up.
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  return readContextTokens(tp) ?? 0;
});

// ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
// The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
// consumes getAgentUsage in-process via the provider, not over IPC.
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

// ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
// Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
// on `control:breakerState`, where the avatar adapter gives it precedence over
// hook-derived status (#5C looping/zombie). Defined here so the channel exists
// before Jim's policy lands; he produces, this lane consumes.
ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
  try { liveWebContents()?.send('control:breakerState', state); } catch { /* window tore down */ }
  return { ok: true };
});

// ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
// All return the agent's fresh control snapshot so the UI can reflect state.
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.pause(agentId, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.resume(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  control.gateTool(agentId, tool, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  control.steer(agentId, text);
  return control.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.halt(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? control.snapshot(agentId) : null);

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
ipcMain.handle('slack:stop', () => { stopSlackServer(); return { ok: true }; });
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

/** Start every hive-bound background service against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). No-op without a home. */
function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  hive.ensureHive();
  hive.startRouter();
  ensureDefaultMissions(); // one-time: seed the built-in hourly ops standup
  syncMissions(); // arm recurring auto-dispatch missions now the router is live
  hookServer.start();
  // Bind the telemetry collector BEFORE the renderer spawns any agent, then point
  // the hive at it so every subsequent spawn is instrumented. Best-effort — a bind
  // failure just leaves telemetry off (transcript reconciler stays). No breaker.start():
  // the breaker is POLICY-only, ticked by the heartbeat beat (#1, ships disabled).
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) { hive.setOtelEndpoint(r.endpoint); console.log('[telemetry] collector listening', r.endpoint); }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  memory.start(); // init shared palace + mine loop (no-op without mempalace)
  reflector.start(); // bound oversized memory.md files on a timer (no-op until threshold)

  // Always-on beats (decoupled from the optional heartbeat): the live fleet
  // snapshot Michael reads (~8s) + the breaker/cost-ledger beat (~30s). Guarded so
  // a re-bootstrap (changeHome recovery) can't stack duplicate timers.
  if (fleetTimer) clearInterval(fleetTimer);
  writeFleetSnapshot();
  fleetTimer = setInterval(writeFleetSnapshot, 8_000);
  if (breakerBeatTimer) clearInterval(breakerBeatTimer);
  breakerBeatTimer = setInterval(() => { try { runBreakerBeat(300_000); } catch (e) { console.error('[breaker beat]', e); } }, 30_000);
}

app.whenReady().then(() => {
  // Open the durable store first — createWindow() reads the saved window bounds.
  // Guarded: a DB failure (e.g. a bad native build) must degrade to defaults,
  // never block app startup.
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  bootstrapHiveServices();
  createWindow();
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ptyManager.killAll();
    app.quit();
  }
});
