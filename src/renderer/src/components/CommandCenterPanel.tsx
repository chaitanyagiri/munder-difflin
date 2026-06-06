import { useEffect, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { MessageQueueComposer } from './MessageQueueComposer';
import { TasksKanban } from './TasksKanban';
import { disposeTerminal } from './terminalPool';
import { Icon } from './Icon';
import { MemoryGraphPanel } from './MemoryGraphPanel';
import { FleetGrid } from './FleetGrid';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import { buildSpawnCommand, AGENT_MODELS } from '@/store/config';

/** Michael's control surface. Shown instead of the plain terminal/files panel
 *  when the god agent is selected: terminal + queue, the floor roster (with
 *  per-agent model + dispatch + assistant access), a memory view, and a live
 *  activity feed / board / usage meter. */

type CCTab = 'terminal' | 'floor' | 'fleet' | 'tasks' | 'memory' | 'graph' | 'activity' | 'handbook';

/** A recurring auto-dispatched mission (mirrors the main-process config type). */
interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** 'heartbeat' (Lane A #1) is a context-aware adaptive beat, not a plain dispatch. */
  kind?: 'dispatch' | 'heartbeat';
  quietThresholdMs?: number;
}

/** Compact relative time, e.g. "4m ago" / "in 2m" / "just now". A positive ms is
 *  in the past, negative in the future. */
function relTime(ms: number): string {
  const past = ms >= 0;
  const a = Math.abs(ms);
  if (a < 45_000) return 'just now';
  const mins = Math.round(a / 60_000);
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return past ? `${unit} ago` : `in ${unit}`;
}

/** Interval presets offered in the SCHEDULES form / shown as badges. */
const INTERVAL_OPTS: { ms: number; label: string }[] = [
  { ms: 3600000, label: '1h' },
  { ms: 21600000, label: '6h' },
  { ms: 86400000, label: '24h' },
  { ms: 604800000, label: 'weekly' }
];

/** A GitHub issue as returned by `window.cth.githubIssues` (labels/assignees flattened). */
interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** A CI run as returned by `window.cth.githubCIRuns` (GitHub Actions workflow runs). */
interface CIRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

const TABS: { key: CCTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'terminal', label: 'terminal', icon: 'terminal' },
  { key: 'floor', label: 'floor', icon: 'mcp' },
  { key: 'fleet', label: 'fleet', icon: 'gear' },
  { key: 'tasks', label: 'tasks', icon: 'check' },
  { key: 'memory', label: 'memory', icon: 'sparkle' },
  { key: 'graph', label: 'graph', icon: 'web' },
  { key: 'activity', label: 'activity', icon: 'bell' },
  { key: 'handbook', label: 'commands', icon: 'code' }
];

export function CommandCenterPanel({ agent }: { agent: Agent }) {
  const [tab, setTab] = useState<CCTab>('terminal');
  // A task-card "assign" pre-fills the Floor dispatch box and jumps to it. The
  // counter bumps so re-assigning the same card re-seeds the textarea (the seed
  // string alone wouldn't change). { seq } makes every assign distinct.
  const [dispatchSeed, setDispatchSeed] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  // Lifted so the memory-graph tab can jump to a specific agent's memory file.
  const [selectedMemoryAgent, setSelectedMemoryAgent] = useState<string | null>(null);
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const onPtyStream = usePtyParser(agent.id);
  const isFullscreenedHere = fullscreenAgentId === agent.id;

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
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-900)'
          }}>MICHAEL · COMMAND CENTER</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
            <PixelBadge status={agent.status} />
            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>runs the floor</span>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 4, padding: '6px 8px 0',
        background: 'var(--cth-cream-100)', borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 9px 3px', border: 'none', cursor: 'pointer',
              background: tab === t.key ? `var(--cth-${agent.accent})` : 'var(--cth-cream-200)',
              color: 'var(--cth-ink-900)',
              boxShadow: tab === t.key
                ? 'inset 0 0 0 1px var(--cth-ink-900)'
                : 'inset 0 0 0 1px var(--cth-ink-700)',
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
                  key={agent.ptyId}
                  ptyId={agent.ptyId}
                  onStreamData={onPtyStream}
                  onUserPrompt={(t) => updateAgent(agent.id, { lastPrompt: t })}
                  onToggleFullscreen={() => setFullscreen(agent.id)}
                  fullscreen={false}
                  embedded
                />
              </div>
              <MessageQueueComposer agent={agent} />
            </>
          ) : (
            <Centered>Michael has no live terminal.</Centered>
          )
        )}
        {tab === 'floor' && <FloorTab seed={dispatchSeed} />}
        {tab === 'fleet' && <FleetTab />}
        {tab === 'tasks' && (
          <TasksKanban
            onAssign={(prefill) => {
              setDispatchSeed((s) => ({ text: prefill, seq: s.seq + 1 }));
              setTab('floor');
            }}
          />
        )}
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
        {tab === 'handbook' && <HandbookTab />}
      </div>
    </PixelPanel>
  );
}

// ─── Floor tab — roster, model, dispatch, dirs, assistant ────────────────────

function FloorTab({ seed }: { seed: { text: string; seq: number } }) {
  const agents = useStore((s) => s.agents);
  const select = useStore((s) => s.select);
  const updateAgent = useStore((s) => s.updateAgent);
  const enrichEnabled = useStore((s) => s.enrichEnabled);
  const setEnrichEnabled = useStore((s) => s.setEnrichEnabled);
  const toolCounts = useStore((s) => s.toolCounts);
  const [repos, setRepos] = useState<string[]>([]);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [dispatchTo, setDispatchTo] = useState<string>('broadcast');
  const [dispatchText, setDispatchText] = useState('');
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  // ── ISSUES section state ──
  const [issueRepo, setIssueRepo] = useState<string>('');
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  // ── Scheduled missions (recurring auto-dispatch) ──
  const [missions, setMissions] = useState<ScheduledMission[]>([]);
  const [mLabel, setMLabel] = useState('');
  const [mInterval, setMInterval] = useState<string>(String(INTERVAL_OPTS[0].ms));
  const [mTo, setMTo] = useState<string>('god');
  const [mBody, setMBody] = useState('');

  useEffect(() => {
    window.cth.getConfig().then((c) => setRepos(c.registeredRepos ?? [])).catch(() => { /* noop */ });
    window.cth.listMissions().then(setMissions).catch(() => { /* noop */ });
    // Refresh "last fired" when the scheduler stamps a beat/dispatch (#2.3).
    const off = window.cth.onMissionsUpdated(() => {
      window.cth.listMissions().then(setMissions).catch(() => { /* noop */ });
    });
    return off;
  }, []);

  // Seed the dispatch box from a task-card "assign" (keyed on seq so repeat
  // assigns re-prefill). seq === 0 is the untouched initial state — skip it.
  useEffect(() => {
    if (seed.seq > 0) setDispatchText(seed.text);
  }, [seed.seq, seed.text]);

  const persistMissions = async (next: ScheduledMission[]) => {
    setMissions(next);
    await window.cth.saveMissions(next).catch(() => { /* noop */ });
  };
  const toggleMission = (id: string) =>
    persistMissions(missions.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)));
  const addMission = () => {
    if (!mLabel.trim() || !mBody.trim()) return;
    const next: ScheduledMission = {
      id: `m_${Date.now().toString(36)}`,
      label: mLabel.trim(),
      intervalMs: Number(mInterval),
      to: mTo,
      body: mBody.trim(),
      enabled: true
    };
    persistMissions([...missions, next]);
    setMLabel(''); setMBody('');
  };
  const targetName = (to: string) =>
    to === 'broadcast' ? 'everyone' : to === 'god' ? 'Michael' : agents.find((a) => a.id === to)?.name ?? to;
  const intervalLabel = (ms: number) => INTERVAL_OPTS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 3600000)}h`;

  const restartWithModel = async (a: Agent, model: string | undefined) => {
    if (!a.ptyId) return;
    setRestarting(a.id);
    try {
      const cfg = await window.cth.getConfig();
      await window.cth.killPty(a.ptyId);
      disposeTerminal(a.ptyId);
      const command = buildSpawnCommand(cfg, model);
      const [exe, ...args] = command.trim().split(/\s+/);
      const hive = a.isGod
        ? { id: a.id, name: a.name, cwd: a.cwd, isGod: true, role: 'orchestrator (god)' }
        : a.isAssistant
        ? { id: a.id, name: a.name, cwd: a.cwd, isAssistant: true, role: "Michael's prep assistant" }
        : { id: a.id, name: a.name, cwd: a.cwd, role: a.description };
      const res = await window.cth.spawnPty({ id: a.ptyId, cwd: a.cwd, command: exe, args, cols: 100, rows: 30, hive });
      if (res.ok) updateAgent(a.id, { command: command.trim(), model, status: 'idle', action: 'restarting…' });
    } catch { /* noop */ } finally {
      setRestarting(null);
    }
  };

  const dispatch = async () => {
    const body = dispatchText.trim();
    if (!body) return;
    const res = await window.cth.hiveSend(
      { to: dispatchTo, act: 'request', subject: 'Task from you', body },
      'human'
    );
    setDispatchText('');
    setDispatchMsg(res.ok ? `sent to ${dispatchTo}` : `failed: ${res.error ?? '?'}`);
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
    setDispatchTo('broadcast');
  };

  return (
    <Scroll>
      <Section title="DISPATCH">
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <Select value={dispatchTo} onChange={setDispatchTo}>
            <option value="broadcast">everyone (broadcast)</option>
            <option value="god">Michael</option>
            {agents.filter((a) => !a.isGod).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </div>
        <textarea
          value={dispatchText}
          onChange={(e) => setDispatchText(e.target.value)}
          rows={2}
          placeholder="Assign a task… (delivered to the chosen agent's inbox)"
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
        {agents.map((a) => (
          <div key={a.id} style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            padding: 6, marginBottom: 6,
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
              }}>
                <SpritePortrait character={a.character} scale={1} />
              </div>
              <button
                onClick={() => select(a.id)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)'
                }}
              >{a.name}{a.isGod ? ' (god)' : a.isAssistant ? ' (assistant)' : ''}</button>
              <PixelBadge status={a.status} />
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {(toolCounts[a.id] ?? 0)} tool calls
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Select
                value={a.model ?? ''}
                disabled={restarting === a.id}
                onChange={(v) => restartWithModel(a, v || undefined)}
              >
                {AGENT_MODELS.map((m) => (
                  <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                ))}
              </Select>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {restarting === a.id ? 'restarting…' : 'model (restarts agent)'}
              </span>
            </div>
          </div>
        ))}
      </Section>

      <ArchivedSection />

      <Section title="ASSISTANT">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>Route Michael's queue through Dwight</span>
          <button
            onClick={() => setEnrichEnabled(!enrichEnabled)}
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
              background: enrichEnabled ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
              boxShadow: `inset 0 0 0 1px ${enrichEnabled ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
              fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
            }}
          ><Icon name="sparkle" /> enrich {enrichEnabled ? 'on' : 'off'}</button>
        </div>
      </Section>

      <Section title="SCHEDULES">
        {missions.length === 0 && <Muted>No scheduled missions.</Muted>}
        {missions.map((m) => {
          const hb = m.kind === 'heartbeat';
          const fired = m.lastFiredAt ? `fired ${relTime(Date.now() - m.lastFiredAt)}` : 'not yet fired';
          const next = m.enabled && m.lastFiredAt
            ? ` · next ${relTime(Date.now() - (m.lastFiredAt + m.intervalMs))}` : '';
          return (
          <div key={m.id} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: 6, marginBottom: 6,
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 9, padding: '2px 5px 1px',
              background: hb ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
              boxShadow: `inset 0 0 0 1px ${hb ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
              color: 'var(--cth-ink-900)', flexShrink: 0
            }}>{hb ? '♥ beat' : intervalLabel(m.intervalMs)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</div>
              <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                → {targetName(m.to)}{hb ? ` · adaptive ~${intervalLabel(m.intervalMs)} · auto digest` : ''}
              </div>
              <div style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>{fired}{next}</div>
            </div>
            <button
              onClick={() => toggleMission(m.id)}
              style={{
                padding: '2px 8px 1px', border: 'none', cursor: 'pointer', flexShrink: 0,
                background: m.enabled ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
                boxShadow: `inset 0 0 0 1px ${m.enabled ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}
            >{m.enabled ? 'on' : 'off'}</button>
          </div>
          );
        })}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, marginBottom: 6 }}>
          <input
            value={mLabel}
            onChange={(e) => setMLabel(e.target.value)}
            placeholder="mission label"
            style={{ ...textareaStyle, flex: 1, fontFamily: 'var(--cth-font-ui)' }}
          />
          <Select value={mInterval} onChange={setMInterval}>
            {INTERVAL_OPTS.map((o) => <option key={o.ms} value={String(o.ms)}>{o.label}</option>)}
          </Select>
          <Select value={mTo} onChange={setMTo}>
            <option value="broadcast">everyone</option>
            <option value="god">Michael</option>
            {agents.filter((a) => !a.isGod).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </div>
        <textarea
          value={mBody}
          onChange={(e) => setMBody(e.target.value)}
          rows={2}
          placeholder="Recurring task body… (dispatched on each interval)"
          style={textareaStyle}
        />
        <div style={{ marginTop: 6 }}>
          <PixelButton variant="primary" size="sm" onClick={addMission} disabled={!mLabel.trim() || !mBody.trim()}>
            add mission
          </PixelButton>
        </div>
      </Section>

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
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
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
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
          }}>
            <SpritePortrait character={a.character} scale={1} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)' }}>{a.name}</div>
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
            {textResults.map((r, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
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

// ─── Fleet tab — the live control-room overview (#7B.1) ──────────────────────

function FleetTab() {
  return (
    <Scroll>
      <Section title="FLEET (live telemetry)">
        <FleetGrid />
        <div style={{ marginTop: 6 }}>
          <Muted>live from each agent&apos;s OpenTelemetry · cost is Claude&apos;s own per-model figure</Muted>
        </div>
      </Section>
    </Scroll>
  );
}

// ─── Activity tab — log feed + board + usage ─────────────────────────────────

interface LogEntry { ts?: number; kind?: string; [k: string]: unknown }

function ActivityTab() {
  const agents = useStore((s) => s.agents);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [board, setBoard] = useState('');
  // Per-agent estimated cost, reported up by each UsageRow so the bars can be
  // normalized against the most-expensive agent in the office.
  const [costs, setCosts] = useState<Record<string, number>>({});
  const reportCost = (id: string) => (cost: number) =>
    setCosts((prev) => (prev[id] === cost ? prev : { ...prev, [id]: cost }));
  const maxCost = Math.max(0.0001, ...agents.map((a) => costs[a.id] ?? 0));
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
      <CIStatusSection />

      <Section title="USAGE (this session)">
        {agents.map((a) => (
          <UsageRow key={a.id} name={a.name} cwd={a.cwd} maxCost={maxCost} onCost={reportCost(a.id)} />
        ))}
        <Muted>tokens from ~/.claude/projects/ transcripts</Muted>
      </Section>

      <Section title="ACTIVITY">
        {log.length === 0 && <Muted>Nothing yet.</Muted>}
        {[...log].reverse().map((e, i) => (
          <div key={i} style={{ fontSize: 12, color: 'var(--cth-ink-700)', padding: '2px 0', display: 'flex', gap: 6 }}>
            <span style={{ color: 'var(--cth-ink-300)', flexShrink: 0 }}>{e.kind ?? '·'}</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(e)}</span>
          </div>
        ))}
      </Section>

      <Section title="BOARD">
        <Pre>{board || 'The board is empty.'}</Pre>
      </Section>
    </Scroll>
  );
}

/** One agent's real token usage, polled from its Claude Code transcripts on
 *  mount and every 10s. Renders: name | input Kt | output Kt | est $X.XX, with
 *  a bar normalized to the most-expensive agent (via the lifted-up cost). */
function UsageRow({ name, cwd, maxCost, onCost }: {
  name: string; cwd: string; maxCost: number; onCost: (cost: number) => void;
}) {
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const u = await window.cth.agentUsage(cwd);
        if (!alive || !u) return;
        setUsage(u);
        onCost(u.estimatedCostUsd);
      } catch { /* noop */ }
    };
    refresh();
    const id = setInterval(refresh, 10000);
    return () => { alive = false; clearInterval(id); };
    // onCost is recreated each render but stable in behavior; cwd is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const inK = usage ? (usage.inputTokens / 1000).toFixed(1) : '0.0';
  const outK = usage ? (usage.outputTokens / 1000).toFixed(1) : '0.0';
  const cost = usage?.estimatedCostUsd ?? 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
      <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', width: 90 }}>{name}</span>
      <Bar value={cost} max={maxCost} />
      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', width: 56, textAlign: 'right' }}>{inK}/{outK}Kt</span>
      <span style={{ fontSize: 11, color: 'var(--cth-ink-700)', width: 52, textAlign: 'right' }}>${cost.toFixed(2)}</span>
    </div>
  );
}

// ─── CI status — per-repo latest workflow run, polled every 30s ──────────────

/** Per-repo CI poll result: the latest run plus any error surfaced by the IPC. */
interface RepoCIState {
  run: CIRun | null;
  error: string | null;
}

/** A run failed if it completed with a non-success conclusion. */
function ciFailed(run: CIRun): boolean {
  return run.status === 'completed' && run.conclusion !== null && run.conclusion !== 'success';
}

/** Status chip: green=success, red=failure, yellow=in_progress/queued. */
function CIChip({ run }: { run: CIRun }) {
  let bg = 'var(--cth-lemon)';
  let label = run.status || 'queued';
  if (run.status === 'completed') {
    if (run.conclusion === 'success') { bg = 'var(--cth-mint)'; label = 'success'; }
    else { bg = 'var(--cth-coral)'; label = run.conclusion || 'failed'; }
  }
  return (
    <span style={{
      fontSize: 10, lineHeight: '14px', padding: '0 6px', flexShrink: 0,
      background: bg, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)', color: 'var(--cth-ink-900)'
    }}>{label}</span>
  );
}

/** Polls `githubCIRuns` for every registered repo every 30s. gh being missing
 *  or unauthenticated surfaces as a muted per-repo error — never a crash. */
function CIStatusSection() {
  const [repos, setRepos] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, RepoCIState>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    window.cth.getConfig().then((c) => setRepos(c.registeredRepos ?? [])).catch(() => { /* noop */ });
  }, []);

  useEffect(() => {
    if (repos.length === 0) return;
    let cancelled = false;
    const refresh = async () => {
      const next: Record<string, RepoCIState> = {};
      for (const repo of repos) {
        try {
          const res = await window.cth.githubCIRuns(repo);
          next[repo] = res.ok
            ? { run: (res.runs ?? [])[0] ?? null, error: null }
            : { run: null, error: res.error ?? 'Failed to fetch CI runs.' };
        } catch (e) {
          next[repo] = { run: null, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (!cancelled) setStates(next);
    };
    refresh();
    timer.current = setInterval(refresh, 30000);
    return () => { cancelled = true; if (timer.current) clearInterval(timer.current); };
  }, [repos]);

  const copyUrl = async (url: string) => {
    try {
      await window.cth.copyToClipboard(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1300);
    } catch { /* noop */ }
  };

  if (repos.length === 0) return null;

  return (
    <Section title="CI STATUS">
      {repos.map((repo) => {
        const st = states[repo];
        const short = repo.split('/').filter(Boolean).pop() || repo;
        const run = st?.run ?? null;
        return (
          <div key={repo} style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            padding: 6, marginBottom: 6,
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-900)', wordBreak: 'break-word' }}>{short}</span>
              {run && <CIChip run={run} />}
            </div>
            {run && (
              <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-word' }}>
                {run.name || 'workflow'}
              </div>
            )}
            {!st && <Muted>checking…</Muted>}
            {st && !run && !st.error && <Muted>No runs yet.</Muted>}
            {st?.error && (
              <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-word' }}>{st.error}</div>
            )}
            {run && ciFailed(run) && run.url && (
              <button
                onClick={() => copyUrl(run.url)}
                title="Copy the failing run's URL"
                style={{
                  alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
                  background: copied === run.url ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
                }}
              ><Icon name={copied === run.url ? 'check' : 'code'} /> {copied === run.url ? 'copied' : 'copy run URL'}</button>
            )}
          </div>
        );
      })}
    </Section>
  );
}

// ─── Handbook tab — copyable Claude command reference ────────────────────────

interface Cmd { cmd: string; kind: 'slash' | 'cli'; desc: string; usage?: string }
interface CmdGroup { title: string; items: Cmd[] }

const HANDBOOK: CmdGroup[] = [
  {
    title: 'SESSION',
    items: [
      { cmd: '/clear', kind: 'slash', desc: 'Wipe the conversation and reclaim the full context window. Start fresh.' },
      { cmd: '/compact', kind: 'slash', desc: 'Summarize the conversation so far to free up context without losing the thread.', usage: '/compact focus on the auth refactor' },
      { cmd: '/cost', kind: 'slash', desc: 'Show token usage and dollar cost for the current session.' },
      { cmd: '/status', kind: 'slash', desc: 'Show account, active model, and connection status.' },
      { cmd: 'claude -c', kind: 'cli', desc: 'Continue the most recent session in this directory.' },
      { cmd: 'claude -r', kind: 'cli', desc: 'Resume — pick a past session to continue.' }
    ]
  },
  {
    title: 'MODELS',
    items: [
      { cmd: '/model', kind: 'slash', desc: 'Switch the model for this session.', usage: '/model opus   ·   /model sonnet' },
      { cmd: 'claude --model claude-sonnet-4-6[1m]', kind: 'cli', desc: 'Launch on a specific model. The [1m] suffix selects the 1M-token context window (used by Dwight).' }
    ]
  },
  {
    title: 'CONTEXT & MEMORY',
    items: [
      { cmd: '/init', kind: 'slash', desc: 'Scan the repo and generate a CLAUDE.md capturing its conventions.' },
      { cmd: '/memory', kind: 'slash', desc: 'Open the project & user memory files for editing.' },
      { cmd: '# ', kind: 'slash', desc: 'Quick memory: start a message with # to append a durable note to memory.', usage: '# always run prettier before committing' },
      { cmd: 'claude --add-dir ../other-repo', kind: 'cli', desc: 'Grant the session read/write access to an extra directory.' }
    ]
  },
  {
    title: 'TOOLS & PERMISSIONS',
    items: [
      { cmd: '/permissions', kind: 'slash', desc: 'View and edit which tools are allowed or denied.' },
      { cmd: '/hooks', kind: 'slash', desc: 'Configure lifecycle hooks (PreToolUse, Stop, etc.).' },
      { cmd: 'claude --permission-mode bypassPermissions', kind: 'cli', desc: 'Run without per-tool approval prompts (this is what "auto mode" uses).' }
    ]
  },
  {
    title: 'MCP',
    items: [
      { cmd: '/mcp', kind: 'slash', desc: 'List/manage connected MCP servers and authenticate.' },
      { cmd: 'claude mcp list', kind: 'cli', desc: 'List configured MCP servers.' },
      { cmd: 'claude mcp add <name> <command>', kind: 'cli', desc: 'Register a new MCP server.' }
    ]
  },
  {
    title: 'AUTOMATION (HEADLESS)',
    items: [
      { cmd: 'claude -p "your prompt"', kind: 'cli', desc: 'Print mode: run one prompt non-interactively and exit.' },
      { cmd: 'claude -p "your prompt" --output-format json', kind: 'cli', desc: 'Headless with structured JSON output (result, usage, cost) — the mechanism behind enrichment.' },
      { cmd: 'claude -c -p "follow-up"', kind: 'cli', desc: 'Continue the last session headlessly with a follow-up prompt.' }
    ]
  },
  {
    title: 'REVIEW · GIT · AGENTS',
    items: [
      { cmd: '/review', kind: 'slash', desc: 'Review the current diff / PR for issues.' },
      { cmd: '/pr-comments', kind: 'slash', desc: 'Fetch and work through PR review comments.' },
      { cmd: '/agents', kind: 'slash', desc: 'Create and manage subagents for delegated work.' }
    ]
  },
  {
    title: 'HELP',
    items: [
      { cmd: '/help', kind: 'slash', desc: 'List every available slash command.' },
      { cmd: '/doctor', kind: 'slash', desc: 'Diagnose installation / health issues.' },
      { cmd: '/vim', kind: 'slash', desc: 'Toggle vim keybindings in the prompt box.' }
    ]
  }
];

function HandbookTab() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (cmd: string) => {
    try { await window.cth.copyToClipboard(cmd); setCopied(cmd); setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1300); }
    catch { /* noop */ }
  };
  return (
    <Scroll>
      <Muted>Click any command to copy it. Slash commands run inside Claude Code; CLI commands run in a shell.</Muted>
      <div style={{ height: 8 }} />
      {HANDBOOK.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.items.map((it) => (
            <div key={it.cmd} style={{
              padding: 6, marginBottom: 6,
              background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '12px',
                  padding: '1px 4px 0', flexShrink: 0,
                  background: it.kind === 'slash' ? 'var(--cth-sky-light)' : 'var(--cth-mint-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', color: 'var(--cth-ink-900)'
                }}>{it.kind === 'slash' ? 'SLASH' : 'CLI'}</span>
                <code style={{
                  flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 13,
                  color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>{it.cmd.trim() || '#'}</code>
                <button
                  onClick={() => copy(it.cmd)}
                  title="Copy command"
                  style={{
                    flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
                    background: copied === it.cmd ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
                  }}
                >
                  <Icon name={copied === it.cmd ? 'check' : 'code'} /> {copied === it.cmd ? 'copied' : 'copy'}
                </button>
              </div>
              <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)', marginTop: 4 }}>{it.desc}</div>
              {it.usage && (
                <div style={{
                  marginTop: 3, fontFamily: 'var(--cth-font-mono)', fontSize: 11,
                  color: 'var(--cth-ink-500)'
                }}>e.g. {it.usage}</div>
              )}
            </div>
          ))}
        </Section>
      ))}
    </Scroll>
  );
}

// ─── small shared bits ───────────────────────────────────────────────────────

function Scroll({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, background: 'var(--cth-paper-200)' }}>{children}</div>;
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
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', color: 'var(--cth-ink-700)', fontSize: 14, background: 'var(--cth-paper-200)' }}>
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

function Bar({ value, max }: { value: number; max: number }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div style={{ flex: 1, height: 8, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--cth-mint)' }} />
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  flex: 1, width: '100%', resize: 'none', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 13, lineHeight: '17px',
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
        border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
      }}
    >{children}</select>
  );
}
