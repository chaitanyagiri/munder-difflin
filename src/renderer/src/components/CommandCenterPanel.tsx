import { useEffect, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { MessageQueueComposer } from './MessageQueueComposer';
import { TasksKanban } from './TasksKanban';
import { AskMeTab } from './AskMeTab';
import { TriggersTab } from './triggers/TriggersTab';
import { TriggerHistoryTab } from './triggers/TriggerHistoryTab';
import { WorkersTab } from './WorkersTab';
import { SkillsTab } from './SkillsTab';
import { acquireTerminal, disposeTerminal, resetTerminal } from './terminalPool';
import { terminalInstanceKey } from './terminalRecovery';
import { Icon } from './Icon';
import { MemoryGraphPanel } from './MemoryGraphPanel';
import { useFleetTelemetry } from '@/hooks/useTelemetry';
import { COMMAND_GROUPS } from '@shared/claudeCommands';
import { useStore, triggerHistoryVisible, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import {
  buildSpawnCommand,
  decodeProviderModel,
  encodeProviderModel,
  inferAgentProvider,
  isClaudeProvider,
  modelProvidersForAgent,
  modelsForProvider,
  providerPreset,
  tokenizeCommand,
  AGENT_PROVIDER_PRESETS,
  type AgentProvider
} from '@/store/config';
import { canReceiveInbox } from '@shared/agentProvider';

/** Michael's control surface. Shown instead of the plain terminal/files panel
 *  when the god agent is selected: terminal + queue, the floor roster (with
 *  per-agent model + dispatch + assistant access), a memory view, and a live
 *  activity feed / board / usage meter. */

// Both the AskMe (#human) tab and the Triggers tab live here. Triggers replaced
// the old Schedules tab: schedules are now one of four trigger types, and the
// whole surface lives in ./triggers (see src/shared/triggers.ts for the contract).
type CCTab = 'terminal' | 'floor' | 'tasks' | 'human' | 'triggers' | 'trigger-history'
  | 'memory' | 'graph' | 'activity' | 'skills' | 'workers';

/** Fallback denominator for the per-agent token meter when no floor token budget
 *  is configured — so the bar reads as a budget estimate (filled + remaining)
 *  rather than being pinned to 100% for whichever agent burns the most tokens. */
const DEFAULT_TOKEN_CAP = 1_000_000;

/** A GitHub issue as returned by `window.cth.githubIssues` (labels/assignees flattened). */
interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** Canonical tab order. Not every entry is always shown — see `visibleTabs`. */
const TABS: { key: CCTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'terminal', label: 'terminal', icon: 'terminal' },
  { key: 'floor', label: 'monitor', icon: 'mcp' },
  { key: 'tasks', label: 'tasks', icon: 'check' },
  { key: 'human', label: 'ask me', icon: 'bell' },
  { key: 'triggers', label: 'triggers', icon: 'clock' },
  { key: 'trigger-history', label: 'history', icon: 'ledger' },
  { key: 'memory', label: 'memory', icon: 'sparkle' },
  { key: 'graph', label: 'graph', icon: 'web' },
  { key: 'activity', label: 'activity', icon: 'bell' },
  { key: 'skills', label: 'skills', icon: 'sparkle' },
  { key: 'workers', label: 'workers', icon: 'gear' }
];

/** @param fullscreen this instance IS the fullscreen overlay, so it owns the pty
 *  and renders the real terminal. The docked instance renders the "open in
 *  fullscreen" placeholder instead — two live xterms on one pty fight over its
 *  cols/rows and corrupt the display. */
export function CommandCenterPanel({ agent, fullscreen = false }: { agent: Agent; fullscreen?: boolean }) {
  const [tab, setTab] = useState<CCTab>('terminal');
  // The trigger-history ledger has nothing to say until an outside party can
  // reach us, so its tab appears only once an org key or a webhook exists. This
  // is the first config-gated tab in the panel: TABS stays the canonical order
  // and the gate is applied at render, so nothing else has to know about it.
  // The rule itself lives in the store (`triggerHistoryVisible`) beside the two
  // mirrors it reads — a second copy here would drift from Settings.
  const showHistory = useStore(triggerHistoryVisible);
  // Never leave the panel parked on a tab that has just been hidden.
  useEffect(() => {
    if (!showHistory && tab === 'trigger-history') setTab('terminal');
  }, [showHistory, tab]);
  const visibleTabs = TABS.filter((t) => t.key !== 'trigger-history' || showHistory);

  // External tab requests (the office task board → 'tasks', the boss-room
  // calendar → 'triggers'). seq-keyed so clicking again re-opens the tab even
  // if it was already requested.
  const ccTabRequest = useStore((s) => s.ccTabRequest);
  useEffect(() => {
    if (!ccTabRequest) return;
    const key = ccTabRequest.tab as CCTab;
    if (!TABS.some((t) => t.key === key)) return;
    // Read the gate live rather than depending on it — as a dependency it would
    // re-fire a stale request the moment the tab appeared.
    if (key === 'trigger-history' && !triggerHistoryVisible(useStore.getState())) return;
    setTab(key);
  }, [ccTabRequest]);
  // A task-detail "assign" pre-fills the Floor dispatch box and jumps to it.
  // Seeded via the store one-shot (the detail overlay lives app-wide now);
  // { seq } makes every assign distinct so identical text re-seeds.
  const [dispatchSeed, setDispatchSeed] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const dispatchSeedRequest = useStore((s) => s.dispatchSeedRequest);
  useEffect(() => {
    if (!dispatchSeedRequest) return;
    setDispatchSeed({ text: dispatchSeedRequest.text, seq: dispatchSeedRequest.seq });
  }, [dispatchSeedRequest]);
  // Lifted so the memory-graph tab can jump to a specific agent's memory file.
  const [selectedMemoryAgent, setSelectedMemoryAgent] = useState<string | null>(null);
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const onPtyStream = usePtyParser(agent.id);
  // True only for the DOCKED panel while the overlay holds this agent.
  const isFullscreenedHere = fullscreenAgentId === agent.id && !fullscreen;
  // v0.3.4: ONE floor-wide auto-delivery switch, moved off the per-agent
  // control strips — toggling applies to every live agent, god included.
  // Seeded from the god's own control state (the floor is kept in sync by
  // this single control, so any agent's state reflects the floor's).
  const [floorDeliveryPaused, setFloorDeliveryPaused] = useState(false);
  useEffect(() => {
    let alive = true;
    window.cth.controlSnapshot(agent.id)
      .then((s) => { if (alive && s) setFloorDeliveryPaused(s.autoDeliveryPaused); })
      .catch(() => { /* none */ });
    return () => { alive = false; };
  }, [agent.id]);
  const toggleFloorDelivery = async () => {
    const next = !floorDeliveryPaused;
    setFloorDeliveryPaused(next);
    const all = useStore.getState().agents;
    await Promise.all(all.map((a) => window.cth.controlAutoDelivery(a.id, next).catch(() => null)));
  };

  return (
    <PixelPanel
      variant="default"
      noPadding
      style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0, overflow: 'hidden' }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32, background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        {/* Title + subtitle truncate; the control cluster never shrinks. At
            sidebar width the old header wrapped its 24-char display-font title
            onto three lines and "runs the floor" word-per-line under the two
            wide buttons — everything here is single-line by construction. */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-900)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>COMMAND CENTER</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1, minWidth: 0 }}>
            <PixelBadge status={agent.status} />
            <span style={{
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>Michael runs the floor</span>
          </div>
        </div>
        {/* v0.3.4: floor-wide auto-delivery lives HERE (one switch for every
            agent's queue), and the IDE opens from agent level, not the toolbar.
            Short labels — the tooltips carry the full explanation. */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <PixelButton
            variant={floorDeliveryPaused ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => { void toggleFloorDelivery(); }}
          >
            <span
              title={floorDeliveryPaused
                ? 'Automatic queue delivery is PAUSED for every agent — messages stay queued until resumed'
                : 'Automatic queue delivery is ON for every agent — click to pause the whole floor'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name={floorDeliveryPaused ? 'pause' : 'play'} />
              {floorDeliveryPaused ? 'paused' : 'auto'}
            </span>
          </PixelButton>
          {/* Floor-level surface with no agent of its own: the honest target is
              whoever is selected, stated explicitly rather than left to the
              IDE's fallback so the intent is visible at the call site. */}
          <PixelButton variant="secondary" size="sm" onClick={() => {
            const s = useStore.getState();
            s.setIdeOpen(true, s.selectedId);
          }}>
            <span title="Open the IDE — file editor + git diff" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="code" /> IDE
            </span>
          </PixelButton>
        </div>
      </div>

      {/* Tab bar — ONE row, tabs at their natural width, scrolling only if the
          panel is genuinely too narrow for all of them.

          This was an auto-fit grid of equal-width cells, which had a failure mode
          the equal widths caused: every column is sized to the WIDEST tab, so the
          track count is set by the longest label rather than by the total width
          the labels actually need. Adding a 12th tab tipped it over at fullscreen
          width and dropped `setup` onto a second row with most of the first row's
          space still unused — the tabs need ~1320px of content and had ~1610px.

          Content-sized tabs fit all twelve on one line with room to spare, and the
          `.cth-tabbar` rules in global.css (scrollbar-width: none, ::-webkit-
          scrollbar { height: 0 }) already exist for exactly this: a single row that
          scrolls with the scrollbar hidden. The grid never scrolled, so those rules
          have been dead code since it landed.

          Trade-off, deliberate: in the NARROW docked panel the far-right tabs now
          scroll out of view instead of wrapping to a visible second row. One row
          that sometimes needs a scroll beats two rows where one is nearly empty —
          and the grid's own reason for existing (keeping wrapped rows aligned)
          stops applying the moment there is only ever one row. */}
      <div className="cth-tabbar" style={{
        display: 'flex', gap: 4,
        // Docked in the sidebar the panel is narrow, so tabs WRAP: a second row
        // costs a few pixels of a tall column, while a horizontal scroll there
        // would hide half the tabs behind a gesture with no affordance.
        // In focus mode the panel is wide and vertical space is the scarce
        // resource, so it stays ONE row and scrolls instead. `.cth-tabbar` in
        // global.css already hides that scrollbar.
        flexWrap: fullscreen ? 'nowrap' : 'wrap',
        overflowX: fullscreen ? 'auto' : 'visible',
        padding: '6px 8px', background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              whiteSpace: 'nowrap',
              // grow to share any spare width (so the strip still spans the panel
              // exactly as the old grid did), never shrink below the label (a
              // squashed tab is unreadable — overflow into the scroll instead).
              flex: '1 0 auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '4px 8px 3px', border: 'none', cursor: 'pointer',
              background: tab === t.key ? `var(--cth-${agent.accent})` : 'var(--cth-cream-200)',
              // The selected tab is filled with the agent's accent, which is a
              // LIGHT colour in both themes. ink-900 flips to near-white in dark
              // mode, so the active tab's label was pale-on-pale — the one tab
              // you most need to read. On-accent text is dark in both themes.
              color: tab === t.key ? 'var(--cth-on-accent)' : 'var(--cth-ink-900)',
              boxShadow: tab === t.key
                ? 'inset 0 0 0 1px var(--cth-ink-300)'
                : 'inset 0 0 0 1px var(--cth-ink-100)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13
            }}
          >
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'terminal' && (
          isFullscreenedHere ? (
            <Centered>Terminal is open in fullscreen. Press Esc to bring it back.</Centered>
          ) : agent.ptyId ? (
            <>
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <PtyTerminalView
                  key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                  ptyId={agent.ptyId}
                  onStreamData={onPtyStream}
                  onUserPrompt={(t) => {
                    updateAgent(agent.id, { lastPrompt: t });
                    if (t.trim().toLowerCase() === '/clear') {
                      updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                    }
                    void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                  }}
                  onToggleFullscreen={() => setFullscreen(fullscreen ? null : agent.id)}
                  fullscreen={fullscreen}
                  embedded={!fullscreen}
                />
              </div>
              <MessageQueueComposer agent={agent} />
            </>
          ) : (
            <Centered>Michael has no live terminal.</Centered>
          )
        )}
        {tab === 'floor' && <FloorTab seed={dispatchSeed} />}
        {tab === 'tasks' && <TasksKanban />}
        {tab === 'human' && <AskMeTab />}
        {tab === 'triggers' && <TriggersTab />}
        {tab === 'trigger-history' && <TriggerHistoryTab />}
        {tab === 'memory' && (
          <MemoryTab godId={agent.id} who={selectedMemoryAgent ?? undefined} onWho={setSelectedMemoryAgent} />
        )}
        {tab === 'graph' && (
          <MemoryGraphPanel
            godId={agent.id}
            onJumpToMemory={(id) => { setSelectedMemoryAgent(id); setTab('memory'); }}
          />
        )}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'skills' && <SkillsTab agentCwd={agent.cwd} />}
        {tab === 'workers' && <WorkersTab />}
      </div>
    </PixelPanel>
  );
}

// ─── Floor tab — roster, model, dispatch, dirs, assistant ────────────────────

function FloorTab({ seed }: { seed: { text: string; seq: number } }) {
  const agents = useStore((s) => s.agents);
  const select = useStore((s) => s.select);
  const updateAgent = useStore((s) => s.updateAgent);
  const toolCounts = useStore((s) => s.toolCounts);
  // Live OpenTelemetry per agent — merged into each agent card below (the old
  // standalone Fleet tab folded in here so the roster shows identity + controls
  // AND live cost/usage in one place).
  const { samples, spark, rate, lastTool, breakers } = useFleetTelemetry();
  const [repos, setRepos] = useState<string[]>([]);
  // Floor-wide token budget (drives the breaker); also the token-meter denominator.
  const [tokenCap, setTokenCap] = useState<number | undefined>(undefined);
  // Per-agent token limit (overrides the floor budget for that agent), keyed by id.
  const [agentTokenCaps, setAgentTokenCaps] = useState<Record<string, number>>({});
  const [restarting, setRestarting] = useState<string | null>(null);
  const [engineProvider, setEngineProvider] = useState<AgentProvider>('claude');
  const [engineModel, setEngineModel] = useState<string | undefined>(undefined);
  const [restartErrors, setRestartErrors] = useState<Record<string, string>>({});
  // The harness's own default model (Settings → default model). Michael and every
  // new agent spawn on this, so the picker marks it — otherwise the only entry
  // reading "default" was the CLI's, which is a different thing entirely.
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [dispatchTo, setDispatchTo] = useState<string>(''); // '' = Michael decides
  const [dispatchText, setDispatchText] = useState('');
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  // ── ISSUES section state ──
  const [issueRepo, setIssueRepo] = useState<string>('');
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  useEffect(() => {
    window.cth.getConfig().then((c) => {
      setRepos(c.registeredRepos ?? []);
      setTokenCap(c.costCapTokens);
      setAgentTokenCaps(c.agentTokenCaps ?? {});
      setEngineProvider(c.godProvider ?? 'claude');
      setEngineModel(c.godModel);
      setDefaultModel(c.defaultModel);
    }).catch(() => { /* noop */ });
  }, []);

  // Seed the dispatch box from a task-card "assign" (keyed on seq so repeat
  // assigns re-prefill). seq === 0 is the untouched initial state — skip it.
  useEffect(() => {
    if (seed.seq > 0) setDispatchText(seed.text);
  }, [seed.seq, seed.text]);

  // Restart an agent's PTY in place. `resume:true` reattaches its prior Claude
  // conversation (`--resume <sessionId>`, resolved in the main process from the
  // hive registry by agent id) — this is "Restart & Continue": a clean re-draw
  // of the TUI in a fresh process WITHOUT losing the thread, which is the escape
  // hatch for a corrupted/garbled terminal (e.g. xterm reflow after dragging the
  // window between displays of different sizes). With `resume` unset it's the
  // old behavior: a model change that starts a fresh session.
  const restartWithModel = async (
    a: Agent,
    model: string | undefined,
    opts: {
      resume?: boolean;
      provider?: AgentProvider;
      /** Resume if we can, start fresh if we can't, instead of refusing.
       *  "Restart & Continue" wants the hard failure — continuing is the entire
       *  point, so silently starting a blank session would be worse than an
       *  error. A model change wants the soft one: the user asked to change
       *  model, and an agent with no recorded session still has to get one. */
      resumeOptional?: boolean;
    } = {}
  ) => {
    if (!a.ptyId) return;
    setRestarting(a.id);
    setRestartErrors((errors) => ({ ...errors, [a.id]: '' }));
    try {
      const cfg = await window.cth.getConfig();
      // Respawn on the same CLI this agent already runs on (inferred from its
      // command if not explicitly tagged) so an Antigravity/Codex worker stays
      // on its own binary. tokenizeCommand keeps quoted model labels one arg.
      // opts.provider overrides the inferred provider — used when changing GOD's engine.
      const previousProvider = inferAgentProvider(a.command, a.provider);
      const provider = opts.provider ?? previousProvider;
      let resume = opts.resume === true && provider === previousProvider;
      if (opts.resume && !resume && !opts.resumeOptional) {
        throw new Error('Cannot resume a session through a different provider.');
      }
      let resumeSessionId: string | undefined;
      if (resume) {
        // A precondition miss is fatal for an explicit "continue", and merely
        // means "start fresh" for an opportunistic one (see resumeOptional).
        const giveUpOnResume = (reason: string) => {
          if (!opts.resumeOptional) throw new Error(reason);
          resume = false;
          resumeSessionId = undefined;
        };
        const registry = await window.cth.hiveRegistry();
        resumeSessionId = registry.agents[a.id]?.sessionId;
        if (!resumeSessionId) {
          giveUpOnResume('No recorded session ID; current process was left running.');
        } else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeSessionId))) {
          giveUpOnResume('Session transcript not found; current process was left running.');
        }
      }
      // Capture the live grid before replacing anything. Restart & Continue
      // recreates only this agent's xterm; model changes retain the old
      // in-place reset behavior.
      const oldEntry = acquireTerminal(a.ptyId);
      let cols = oldEntry.term.cols || 100;
      let rows = oldEntry.term.rows || 30;
      try {
        oldEntry.fit.fit();
        cols = oldEntry.term.cols;
        rows = oldEntry.term.rows;
      } catch { /* host not sized yet */ }

      const killed = await window.cth.killPty(a.ptyId);
      // A pty that is ALREADY gone is the state this kill was trying to reach, so
      // it is not a failure. This is the single most common way to arrive at
      // "Restart & Continue": the session died on its own — a crash, or Ctrl-C
      // twice — main dropped it from the session map, and kill then answers
      // `no pty: <id>`. Treating that as fatal aborted before the respawn and
      // turned the one situation the button exists for into a dead end.
      if (!killed.ok && !/^no pty:/.test(killed.error ?? '')) {
        throw new Error(killed.error ?? 'Could not stop the current process.');
      }
      if (resume) {
        // A blank xterm can retain corrupt renderer/DOM/subscription state even
        // after its PTY is healthy. Throw that one terminal away, acquire its
        // replacement BEFORE spawning (so startup output has a listener), then
        // bump the key so React remounts only this agent's terminal card.
        disposeTerminal(a.ptyId);
        acquireTerminal(a.ptyId);
        updateAgent(a.id, {
          terminalGeneration: (a.terminalGeneration ?? 0) + 1,
          status: 'idle',
          action: 'recreating terminal…'
        });
      } else {
        resetTerminal(a.ptyId);
      }
      const command = buildSpawnCommand(cfg, model, provider);
      const [exe, ...args] = tokenizeCommand(command.trim());
      const hive = a.isGod
        ? { id: a.id, name: a.name, cwd: a.cwd, provider, isGod: true, role: 'orchestrator (god)' }
        : a.isAssistant
        ? { id: a.id, name: a.name, cwd: a.cwd, provider, isAssistant: true, role: "Michael's prep assistant" }
        : { id: a.id, name: a.name, cwd: a.cwd, provider, role: a.description };
      const res = await window.cth.spawnPty({
        id: a.ptyId,
        cwd: a.cwd,
        command: exe,
        args,
        provider,
        cols,
        rows,
        hive,
        resume,
        resumeSessionId,
        requireResume: resume
      });
      if (!res.ok) throw new Error(res.error ?? 'Restart failed.');
      if (resume && res.resumed !== true) {
        throw new Error('Resume was refused; no replacement session was accepted.');
      }
      if (res.ok) {
        // Record the model even on a resume. A same-provider model change now
        // RESUMES the session (that is the point — you keep the conversation and
        // just swap the model), so "resume ⇒ the model is unchanged" stopped
        // being true. Skipping the patch left the live process on the new model
        // while the selector and the persisted agent kept the old one, and the
        // next restore relaunched the old command. `command` is rebuilt from the
        // selected model above, so on a genuine no-change restart this is a no-op.
        const patch = resume
          ? {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: 'continuing…'
            }
          : {
              command: command.trim(),
              provider,
              model,
              status: 'idle' as const,
              action: provider === previousProvider ? 'restarting…' : `switching to ${providerPreset(provider).label}…`
            };
        updateAgent(a.id, patch);
      }
    } catch (error) {
      setRestartErrors((errors) => ({
        ...errors,
        [a.id]: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setRestarting(null);
    }
  };

  // ALL human dispatch flows through the god — never directly into a worker's
  // inbox. Direct dispatch bypassed the orchestrator's whole job: no 4-part
  // contract, no card in tasks.json, no board awareness — and the old
  // 'broadcast' DEFAULT sent the same task to every worker at once. A worker
  // picked in the dropdown is forwarded as a SUGGESTION the god may follow.
  const dispatch = async () => {
    const body = dispatchText.trim();
    if (!body) return;
    const suggested = dispatchTo ? agents.find((a) => a.id === dispatchTo) : undefined;
    const full = suggested
      ? `${body}\n\n(The human suggests ${suggested.name} (${suggested.id}) for this — your call as orchestrator.)`
      : body;
    const res = await window.cth.hiveSend(
      { to: 'god', act: 'request', subject: 'Task from the human', body: full },
      'human'
    );
    setDispatchText('');
    setDispatchMsg(res.ok
      ? `sent to Michael${suggested ? ` (suggesting ${suggested.name})` : ''}`
      : `failed: ${res.error ?? '?'}`);
    setTimeout(() => setDispatchMsg(null), 4000);
  };

  const fetchIssues = async () => {
    const repo = issueRepo || repos[0];
    if (!repo) { setIssuesError('No repo selected.'); return; }
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      const res = await window.cth.githubIssues(repo);
      if (res.ok) {
        setIssues((res.issues ?? []).slice(0, 10));
      } else {
        setIssues([]);
        setIssuesError(res.error ?? 'Failed to fetch issues.');
      }
    } catch (e) {
      setIssues([]);
      setIssuesError(e instanceof Error ? e.message : String(e));
    } finally {
      setIssuesLoading(false);
    }
  };

  const assignIssue = (issue: GHIssue) => {
    const body = (issue.body ?? '').slice(0, 200);
    setDispatchText(`GitHub Issue #${issue.number}: ${issue.title}\n\n${body}\n\nURL: ${issue.url}`);
    setDispatchTo(''); // Michael decomposes and assigns — no more broadcast blasts
  };

  // Set/clear one agent's token limit; persist the whole map (writeConfig replaces
  // the top-level key, so we send the full merged map). Drives that agent's meter
  // and the breaker's per-agent trip.
  const setAgentCap = (id: string, tokens: number | undefined) => {
    const next = { ...agentTokenCaps };
    if (tokens && tokens > 0) next[id] = tokens; else delete next[id];
    setAgentTokenCaps(next);
    void window.cth.updateConfig({ agentTokenCaps: next }).catch(() => { /* noop */ });
  };

  // The token meter is scaled to the agent's own limit when set, else the floor
  // token budget — so each bar reads as "tokens used vs budget" with the remaining
  // headroom visible, never pinned to a useless 100%.
  const floorCap = tokenCap && tokenCap > 0 ? tokenCap : DEFAULT_TOKEN_CAP;
  // Fleet totals across the roster (for the AGENTS summary band).
  let sumTokens = 0, sumInput = 0, sumCacheRead = 0, sumRate = 0;
  for (const a of agents) {
    const s = samples[a.id];
    if (s) {
      sumTokens += s.input + s.output + s.cacheRead + s.cacheCreation;
      sumInput += s.input + s.cacheRead + s.cacheCreation;
      sumCacheRead += s.cacheRead;
    }
    sumRate += rate[a.id] ?? 0;
  }
  const fleetCachePct = sumInput > 0 ? Math.round((sumCacheRead / sumInput) * 100) : 0;

  return (
    <Scroll>
      <Section title="DISPATCH — VIA MICHAEL">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
            SUGGESTED OWNER
          </span>
          <Select value={dispatchTo} onChange={setDispatchTo}>
            <option value="">Michael decides</option>
            {agents.filter((a) => !a.isGod).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </div>
        <textarea
          value={dispatchText}
          onChange={(e) => setDispatchText(e.target.value)}
          rows={2}
          placeholder="Describe the task… (Michael decomposes, writes the card, and assigns)"
          style={textareaStyle}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <PixelButton variant="primary" size="sm" onClick={dispatch} disabled={!dispatchText.trim()}>
            dispatch
          </PixelButton>
          {dispatchMsg && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{dispatchMsg}</span>}
        </div>
      </Section>

      <Section title="AGENTS">
        {agents.map((a) => {
          const agentProvider = inferAgentProvider(a.command, a.provider);
          const agentPreset = providerPreset(agentProvider);
          const sample = samples[a.id];
          const breaker = breakers[a.id];
          const armed = !!breaker && (breaker.level === 'constrained' || breaker.level === 'stopped');
          const tokens = sample ? sample.input + sample.output + sample.cacheRead + sample.cacheCreation : 0;
          const agentCap = agentTokenCaps[a.id]; // per-agent limit, if set
          const denom = agentCap && agentCap > 0 ? agentCap : floorCap;
          const pct = Math.min(100, Math.round((tokens / denom) * 100));
          const meterColor = armed || pct >= 90 ? 'var(--cth-coral)' : pct >= 60 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
          // Sparkline only when the agent is actually burning tokens; otherwise the
          // flat baseline is just a mystery line. Label it with the live rate.
          const sparkSeries = spark[a.id] ?? [];
          const hasSpark = sparkSeries.some((v) => v > 0);
          const rateVal = Math.round(rate[a.id] ?? 0);
          const rateLabel = rateVal > 0 ? `${fmtTokens(rateVal)}/m` : 'rate';
          const currentModelKnown = modelsForProvider(agentProvider)
            .some((model) => model.id === a.model);
          return (
          <div key={a.id} style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            padding: 6, marginBottom: 6,
            background: armed ? 'var(--cth-coral-light)' : 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
              }}>
                <SpritePortrait character={a.character} scale={1} />
              </div>
              <button
                onClick={() => select(a.id)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              >{a.name}{a.isGod ? ' (god)' : ''}</button>
              <PixelBadge status={armed ? 'looping' : a.status} />
              {armed && <span title={breaker?.reason} style={{ color: 'var(--cth-coral)', fontSize: 12 }}>⚠</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {(toolCounts[a.id] ?? 0)} tool calls
              </span>
              <TokenLimitEditor value={agentCap} onSet={(t) => setAgentCap(a.id, t)} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
            {/* Live telemetry (folded in from the old Fleet tab) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {hasSpark ? (
                <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{rateLabel}</span>
                  <Sparkline series={sparkSeries} />
                </span>
              ) : (
                <span style={{ flex: 1 }} />
              )}
              {lastTool[a.id] && (
                <span style={{
                  fontSize: 10, lineHeight: '14px', padding: '0 5px', flexShrink: 0,
                  background: 'var(--cth-paper-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-700)'
                }}>{lastTool[a.id]}</span>
              )}
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-300)', flexShrink: 0 }}>budget</span>
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>{fmtTokens(tokens)}</span>
              <div
                title={`CUMULATIVE session usage: ${tokens.toLocaleString()} of ${denom.toLocaleString()} tokens${agentCap ? ' (agent limit)' : ' (floor budget)'} — not the context window`}
                style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
              >
                <div style={{ width: `${pct}%`, height: '100%', background: meterColor }} />
              </div>
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>{pct}%</span>
            </div>
            {/* Context window — the SAME exact statusLine-fed numbers as the
                avatar-card gauge (tokens currently in the window vs the real
                200k/1M size). Distinct from the cumulative budget meter above,
                which keeps growing forever and pins at 100% — that one is
                spend, this one is headroom before compaction. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-300)', flexShrink: 0 }}>ctx</span>
              {a.contextTokens !== undefined && a.contextLimit ? (() => {
                const cpct = Math.min(100, Math.round((a.contextTokens! / a.contextLimit!) * 100));
                const ccolor = cpct >= 88 ? 'var(--cth-coral)' : cpct >= 75 ? 'var(--cth-lemon)' : `var(--cth-${a.accent})`;
                return (
                  <>
                    <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)', width: 56, textAlign: 'right' }}>
                      {fmtTokens(a.contextTokens!)}
                    </span>
                    <div
                      title={`Context window: ${a.contextTokens!.toLocaleString()} of ${a.contextLimit!.toLocaleString()} tokens (${cpct}%)`}
                      style={{ width: 96, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }}
                    >
                      <div style={{ width: `${cpct}%`, height: '100%', background: ccolor }} />
                    </div>
                    <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', width: 30, textAlign: 'right' }}>{cpct}%</span>
                  </>
                );
              })() : (
                <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-300)' }}>
                  no status tick yet
                </span>
              )}
            </div>
            {/* Non-god agents get the cross-provider model picker + restart controls
                here. The GOD agent's model lives in the engine row below
                (provider+model+apply), so we DON'T render this second selector for
                it — one model picker, not two. */}
            {!a.isGod && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Select
                value={encodeProviderModel(agentProvider, a.model)}
                disabled={restarting === a.id}
                onChange={(value) => {
                  const choice = decodeProviderModel(value);
                  if (!choice) return;
                  // Switching model within the SAME provider continues the
                  // conversation — that's the whole point of switching mid-task
                  // ("this got hard, go up a tier"), and starting fresh threw
                  // away the context that made the switch necessary.
                  // `resume` is best-effort: restartWithModel already refuses it
                  // across providers, and falls back to a fresh session when no
                  // session id or transcript is recorded.
                  void restartWithModel(a, choice.model, {
                    provider: choice.provider,
                    resume: choice.provider === agentProvider,
                    resumeOptional: true
                  });
                }}
              >
                {(!agentPreset.supportsModel || !currentModelKnown) && (
                  <option value={encodeProviderModel(agentProvider, a.model)}>
                    {agentPreset.label} · {a.model ?? 'current'}
                  </option>
                )}
                {modelProvidersForAgent(a.isGod).map((preset) => (
                  <optgroup key={preset.id} label={preset.label}>
                    {modelsForProvider(preset.id).map((model) => {
                      // `defaultModel` is a Claude model id, so it can only mark
                      // an entry in the Claude group.
                      const isHarnessDefault = preset.id === 'claude'
                        && !!defaultModel && model.id === defaultModel;
                      return (
                        <option
                          key={`${preset.id}:${model.id ?? 'cli-default'}`}
                          value={encodeProviderModel(preset.id, model.id)}
                        >
                          {model.label}{isHarnessDefault ? ' · default' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </Select>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {restarting === a.id
                  ? 'restarting…'
                  : `${agentPreset.label} model (restarts agent)`}
              </span>
              {/* Restart & Continue — kill + respawn keeping the SAME model and
                  resuming the prior conversation (--resume). Use this to redraw a
                  garbled TUI (e.g. after dragging the window across displays)
                  without losing the thread. */}
              {(agentProvider === 'claude' || agentPreset.resumeFlag || agentPreset.resumeSubcommand) && <>
                <span style={{ flex: 1 }} />
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={() => restartWithModel(a, a.model, { resume: true })}
                >
                  <span title="Kill and respawn this agent, resuming its current conversation — fixes a corrupted/garbled terminal without losing context">
                    restart &amp; continue
                  </span>
                </PixelButton>
              </>}
            </div>
            )}
            {restartErrors[a.id] && (
              <div style={{ fontSize: 11, color: 'var(--cth-coral)' }}>
                {restartErrors[a.id]}
              </div>
            )}
            {a.isGod && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>engine:</span>
                <Select
                  value={engineProvider}
                  disabled={restarting === a.id}
                  onChange={(v) => {
                    const p = v as AgentProvider;
                    setEngineProvider(p);
                    const preset = AGENT_PROVIDER_PRESETS.find((x) => x.id === p);
                    setEngineModel(preset?.recommendedOrchestratorModel);
                  }}
                >
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}{p.id === 'claude' ? ' ★' : ''}
                    </option>
                  ))}
                </Select>
                <Select
                  value={engineModel ?? ''}
                  disabled={restarting === a.id}
                  onChange={(v) => setEngineModel(v || undefined)}
                >
                  {modelsForProvider(engineProvider).map((m) => (
                    <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                  ))}
                </Select>
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={async () => {
                    const currentProvider = inferAgentProvider(a.command, a.provider);
                    if (engineProvider !== currentProvider) {
                      if (!window.confirm("This restarts Michael; a conversation on a different engine can't be resumed.")) return;
                    }
                    await window.cth.updateConfig({ godProvider: engineProvider, godModel: engineModel });
                    await restartWithModel(a, engineModel, { provider: engineProvider, resume: false });
                  }}
                >
                  {restarting === a.id ? 'restarting…' : 'apply'}
                </PixelButton>
                {/* Redraw a garbled terminal without losing the thread (resume the
                    SAME engine+model). Kept here since the god has no per-agent row above. */}
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={restarting === a.id}
                  onClick={() => restartWithModel(a, a.model, { resume: true })}
                >
                  <span title="Kill and respawn Michael, resuming the current conversation — fixes a corrupted/garbled terminal without losing context">
                    restart &amp; continue
                  </span>
                </PixelButton>
              </div>
            )}
          </div>
          );
        })}
        {/* Fleet summary band */}
        <div style={{
          display: 'flex', gap: 14, marginTop: 2, padding: '6px 8px',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)', flexWrap: 'wrap'
        }}>
          <span>Σ <strong>{fmtTokens(sumTokens)}</strong> tok</span>
          <span style={{ color: 'var(--cth-ink-700)' }}>inputs {fmtTokens(sumInput)} (cache {fleetCachePct}%)</span>
          <span style={{ color: 'var(--cth-ink-700)' }}>{Math.round(sumRate).toLocaleString()} tok/min</span>
        </div>
        <div style={{ marginTop: 6 }}>
          <Muted>
            live from each agent&apos;s OpenTelemetry · bars show tokens used vs each agent&apos;s limit, else the {fmtTokens(floorCap)} floor budget
            {tokenCap && tokenCap > 0 ? '' : ' (default — set a floor token budget in Settings)'}
          </Muted>
        </div>
      </Section>

      <ArchivedSection />


      <Section title="DIRECTORIES">
        {repos.length === 0 && <Muted>No registered repos.</Muted>}
        {repos.map((r) => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)', wordBreak: 'break-all' }}>{r}</span>
            <button
              onClick={() => window.cth.openTerminalAt(r)}
              title="Open in Terminal.app"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)' }}
            ><Icon name="terminal" /></button>
          </div>
        ))}
      </Section>

      <Section title="ISSUES">
        {repos.length === 0 && <Muted>No registered repos.</Muted>}
        {repos.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <Select value={issueRepo || repos[0]} onChange={setIssueRepo}>
                {repos.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </Select>
              <PixelButton variant="primary" size="sm" onClick={fetchIssues} disabled={issuesLoading}>
                {issuesLoading ? 'fetching…' : 'Fetch issues'}
              </PixelButton>
            </div>
            {issuesError && (
              <div style={{
                fontSize: 12, color: 'var(--cth-ink-700)', marginBottom: 6,
                padding: 6, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                wordBreak: 'break-word'
              }}>{issuesError}</div>
            )}
            {!issuesError && !issuesLoading && issues.length === 0 && <Muted>No issues fetched yet.</Muted>}
            {issues.map((issue) => (
              <div key={issue.number} style={{
                display: 'flex', flexDirection: 'column', gap: 4,
                padding: 6, marginBottom: 6,
                background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-900)', flex: 1, wordBreak: 'break-word' }}>
                    <strong>#{issue.number}</strong> {issue.title}
                  </span>
                  <PixelButton variant="secondary" size="sm" onClick={() => assignIssue(issue)}>
                    Assign
                  </PixelButton>
                </div>
                {issue.labels.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {issue.labels.map((label) => (
                      <span key={label} style={{
                        fontSize: 10, lineHeight: '14px', padding: '0 5px',
                        background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        color: 'var(--cth-ink-700)'
                      }}>{label}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </Section>
    </Scroll>
  );
}

// ─── Archived agents — retained + flagged, kept off the floor ────────────────

function ArchivedSection() {
  const archivedAgents = useStore((s) => s.archivedAgents);
  const removeArchivedAgent = useStore((s) => s.removeArchivedAgent);
  const [open, setOpen] = useState(false);
  if (archivedAgents.length === 0) return null;
  return (
    <Section title={`ARCHIVED (${archivedAgents.length})`}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
          marginBottom: open ? 6 : 0
        }}
      >{open ? '▾' : '▸'} {open ? 'hide' : 'show'} closed agents</button>
      {open && archivedAgents.map((a) => (
        <div key={a.id} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: 6, marginBottom: 6, opacity: 0.7,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <div style={{
            width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
          }}>
            <SpritePortrait character={a.character} scale={1} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>{a.name}</div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
          </div>
          <button
            onClick={() => removeArchivedAgent(a.id)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)', flexShrink: 0 }}
          ><Icon name="x" /></button>
        </div>
      ))}
    </Section>
  );
}

// ─── Memory tab ──────────────────────────────────────────────────────────────

function MemoryTab({ godId, who: controlledWho, onWho }: { godId: string; who?: string; onWho?: (id: string) => void }) {
  const agents = useStore((s) => s.agents);
  // Selection is controllable from the graph tab; falls back to local state.
  const [internalWho, setInternalWho] = useState<string>(godId);
  const who = controlledWho ?? internalWho;
  const setWho = onWho ?? setInternalWho;
  const [mem, setMem] = useState('');
  const [query, setQuery] = useState('');
  const [searchOut, setSearchOut] = useState('');
  const [busy, setBusy] = useState(false);
  // Full-text search across hive files (board, tasks, memory) — additive.
  const [textQuery, setTextQuery] = useState('');
  const [textResults, setTextResults] = useState<Array<{ source: string; excerpt: string }>>([]);
  const [textSearched, setTextSearched] = useState(false);
  const [textBusy, setTextBusy] = useState(false);

  useEffect(() => {
    window.cth.hiveMemory(who).then(setMem).catch(() => setMem(''));
  }, [who]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await window.cth.searchMemory(query.trim());
      setSearchOut(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally { setBusy(false); }
  };

  const textSearch = async () => {
    if (!textQuery.trim()) return;
    setTextBusy(true);
    try {
      const res = await window.cth.textSearch(textQuery.trim());
      setTextResults(res.ok ? res.results.slice(0, 10) : []);
    } catch { setTextResults([]); }
    finally { setTextBusy(false); setTextSearched(true); }
  };

  return (
    <Scroll>
      <Section title="TEXT SEARCH (board, tasks, memory)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={textQuery}
            onChange={(e) => setTextQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') textSearch(); }}
            placeholder="Find exact text across hive files…"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={textSearch} disabled={textBusy || !textQuery.trim()}>
            {textBusy ? '…' : 'search'}
          </PixelButton>
        </div>
        {textResults.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {textResults.map((r) => (
              <div key={r.source + '|' + r.excerpt.slice(0, 50)} style={{ marginBottom: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{r.source}</div>
                <Pre>{r.excerpt}</Pre>
              </div>
            ))}
          </div>
        )}
        {textSearched && textResults.length === 0 && <Muted>Nothing matched.</Muted>}
      </Section>

      <Section title="SEMANTIC SEARCH (MemPalace)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            placeholder="What does the hive know about…"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={search} disabled={busy || !query.trim()}>
            {busy ? '…' : 'search'}
          </PixelButton>
        </div>
        {searchOut && <Pre>{searchOut}</Pre>}
      </Section>

      <Section title="MEMORY FILE">
        <Select value={who} onChange={setWho}>
          {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </Select>
        <Pre>{mem || 'No memory recorded yet.'}</Pre>
      </Section>
    </Scroll>
  );
}

// ─── Fleet telemetry bits (folded into the Floor AGENTS cards) ───────────────

/** Block-character sparkline of recent token deltas — neo-brutalist mono. */
function Sparkline({ series }: { series: number[] }) {
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(1, ...series);
  const text = series.length
    ? series.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('')
    : '▁▁▁▁▁▁';
  return (
    <span style={{ flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '12px', color: 'var(--cth-sky)', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0 }}>
      {text}
    </span>
  );
}

/** Compact token count: 1K / 10K / 100K / 1M / 100M / 1B (trailing .0 trimmed). */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Per-agent token-limit control (top-right of each agent card). Shows the
 *  current limit as a lemon chip, or "set limit"; click to edit a token number.
 *  Enter / ✓ / blur commit; Escape cancels. */
function TokenLimitEditor({ value, onSet }: { value?: number; onSet: (tokens: number | undefined) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value != null ? String(value) : '');
  const skipBlur = useRef(false);
  const commit = () => {
    const raw = text.trim();
    const n = raw === '' ? undefined : Number(raw);
    onSet(typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        onClick={() => { setText(value != null ? String(value) : ''); setEditing(true); }}
        title="Set this agent's total token limit"
        style={{
          flexShrink: 0, padding: '1px 6px', border: 'none', cursor: 'pointer',
          background: value && value > 0 ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
          boxShadow: `inset 0 0 0 1px ${value && value > 0 ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
        }}
      >{value && value > 0
        ? <>limit <span style={{ fontFamily: 'var(--cth-font-mono)' }}>{fmtTokens(value)}</span></>
        : 'set limit'}</button>
    );
  }
  return (
    <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <input
        type="number" min="0" step="100000" value={text} autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { skipBlur.current = true; setEditing(false); }
        }}
        onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } commit(); }}
        placeholder="tokens"
        style={{
          width: 84, padding: '2px 4px', background: 'var(--cth-paper-100)', border: 'none',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-mono)',
          fontSize: 11, color: 'var(--cth-ink-900)', outline: 'none'
        }}
      />
      <button
        onMouseDown={(e) => e.preventDefault()} onClick={commit} title="Save limit"
        style={{ flexShrink: 0, padding: '1px 5px', border: 'none', cursor: 'pointer', background: 'var(--cth-mint)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 11, color: 'var(--cth-ink-900)' }}
      >✓</button>
    </span>
  );
}

// ─── Activity tab — hive event log + board ───────────────────────────────────

interface LogEntry { ts?: number; kind?: string; [k: string]: unknown }

function ActivityTab() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [board, setBoard] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try { setLog((await window.cth.hiveLog(60)) as LogEntry[]); } catch { /* noop */ }
      try { setBoard(await window.cth.hiveBoard()); } catch { /* noop */ }
    };
    refresh();
    timer.current = setInterval(refresh, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const fmt = (e: LogEntry): string => {
    switch (e.kind) {
      case 'spawn': return `spawned ${e.name ?? e.agentId}`;
      case 'message': return `${e.from} → ${e.to}: ${e.subject || e.act}`;
      case 'drain': return `${e.agentId} drained ${e.count} msg(s)`;
      case 'escalate': return `escalated to human: ${e.subject ?? ''}`;
      case 'approval': return `approval ${e.approve ? 'granted' : 'denied'}`;
      default: return JSON.stringify(e);
    }
  };

  return (
    <Scroll>
      <Section title="ACTIVITY">
        {log.length === 0 && <Muted>Nothing yet.</Muted>}
        {[...log].reverse().map((e) => {
          const key = e.ts != null ? String(e.ts) : JSON.stringify(e).slice(0, 100);
          return (
            <div key={key} style={{ fontSize: 12, color: 'var(--cth-ink-700)', padding: '2px 0', display: 'flex', gap: 6 }}>
              <span style={{ color: 'var(--cth-ink-300)', flexShrink: 0 }}>{e.kind ?? '·'}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(e)}</span>
            </div>
          );
        })}
      </Section>

      <Section title="BOARD">
        <Pre>{board || 'The board is empty.'}</Pre>
      </Section>
    </Scroll>
  );
}


// ─── small shared bits ───────────────────────────────────────────────────────

function Scroll({ children }: { children: React.ReactNode }) {
  // minWidth:0 + overflowX:hidden keep wide children (native selects, long paths,
  // budget rows) from forcing a horizontal scrollbar in the narrow sidebar — they
  // wrap/shrink instead. Vertical scroll stays.
  return <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 10, background: 'var(--cth-paper-200)' }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', color: 'var(--cth-ink-700)', fontSize: 13, background: 'var(--cth-paper-200)' }}>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre style={{
      margin: '6px 0 0', padding: 8, maxHeight: 200, overflow: 'auto',
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
      color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
    }}>{children}</pre>
  );
}

const textareaStyle: React.CSSProperties = {
  flex: 1, width: '100%', resize: 'none', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

function Select({ value, onChange, disabled, children }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '3px 6px', background: 'var(--cth-paper-100)',
        border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer',
        // Never let a long option name push the sidebar wider than it is.
        minWidth: 0, maxWidth: '100%'
      }}
    >{children}</select>
  );
}
