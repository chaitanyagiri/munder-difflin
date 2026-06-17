import { useEffect, useState } from 'react';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
}

export function AgentStrip({ config }: AgentStripProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const openTaskDetail = useStore(s => s.openTaskDetail);
  const [restoring, setRestoring] = useState(false);
  // Each worker's actively-DOING ledger tasks, polled from hive/tasks.json —
  // rendered as a sticky note on the avatar card (click → task detail).
  const [doingByAgent, setDoingByAgent] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await window.cth.hiveTasks() as { tasks?: Array<{ id?: string; status?: string; assignee?: string }> } | null;
        if (cancelled) return;
        const map: Record<string, string[]> = {};
        for (const t of (raw && Array.isArray(raw.tasks)) ? raw.tasks : []) {
          if (t?.status === 'doing' && typeof t.assignee === 'string' && t.assignee && typeof t.id === 'string') {
            (map[t.assignee] = map[t.assignee] ?? []).push(t.id);
          }
        }
        setDoingByAgent(map);
      } catch { /* keep last good */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace (memory.md, inbox, registry
   *  entry) reattaches by itself, no memory transplant needed. */
  const restoreTeam = async () => {
    if (restoring) return;
    setRestoring(true);
    const prevSel = useStore.getState().selectedId;
    try {
      for (const a of [...restorableAgents]) {
        const provider = inferAgentProvider(a.command, a.provider);
        const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');
        if (!command || !a.cwd) { useStore.getState().removeRestorableAgent(a.id); continue; }
        const [exe, ...args] = tokenizeCommand(command);
        const ptyId = a.ptyId ?? `pty-${a.id}`;
        // An isolated agent's worktree SURVIVES an app restart on disk (it's only
        // torn down on per-tab close / mid-session exit, not on quit). So re-enter
        // that exact worktree as the cwd rather than re-isolating — `git worktree
        // add` would conflict with the existing path/branch, and re-isolating would
        // also lose the worktree's uncommitted work. cwd = the worktree means
        // resume + seedSessionTranscript land in the CORRECT checkout.
        // But the user may have manually pruned/deleted the worktree between runs —
        // gitIsRepo (git rev-parse) returns false for a missing/invalid dir, so
        // fall back to the base repo cwd rather than spawning into a dead path.
        let cwd = a.cwd;
        let worktreeGone = false;
        if (a.worktreePath) {
          if (await window.cth.gitIsRepo(a.worktreePath)) {
            cwd = a.worktreePath;
          } else {
            worktreeGone = true;
            console.warn(`[restore] worktree gone for ${a.id} (${a.worktreePath}); falling back to base repo ${a.cwd}`);
          }
        }
        const res = await window.cth.spawnPty({
          id: ptyId,
          cwd,
          command: exe,
          provider,
          args,
          cols: 100,
          rows: 30,
          // Worktree (if any) already exists on disk — cd into it, don't create a
          // new one (re-isolating would conflict on the existing path/branch and
          // lose its uncommitted work).
          isolate: false,
          // Continue the worker's prior CLI session if one was recorded — the
          // main process picks the provider's resume flag (Claude --resume,
          // agy --conversation) and for Claude reattaches the transcript. The
          // agent id is preserved across restart, so its registry entry,
          // memory.md and inbox reattach by id. No-op without a recorded session.
          resume: true,
          hive: { id: a.id, name: a.name, provider, cwd, role: a.description }
        });
        if (res.ok) {
          useStore.getState().addAgent({
            ...a,
            provider,
            ptyId,
            archived: false,
            status: 'idle',
            // Surface the worktree fallback on the floor card; otherwise normal.
            action: worktreeGone ? 'worktree gone — using base repo' : 'starting up',
            // The worktree is no longer on disk — drop it so this agent is treated
            // as a plain base-cwd agent going forward (a future restore won't keep
            // re-probing a dead path).
            worktreePath: worktreeGone ? undefined : a.worktreePath,
            carrying: undefined,
            currentStation: 'desk',
            recentTextTs: Date.now()
          });
        } else {
          // Leave it restorable so the user can retry; don't block the rest.
          console.error('[restore] spawn failed for', a.id, res.error);
        }
      }
    } finally {
      // addAgent auto-selects each spawn; put the user back where they were.
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      setRestoring(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '12px 16px',
      overflowX: 'auto',
      overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)',
      background: 'var(--cth-cream-200)',
      height: 124,
      minHeight: 124,
      alignItems: 'center'
    }}>
      {agents.map(a => (
        <AgentCard
          key={a.id}
          name={a.name}
          character={a.character}
          accent={a.accent}
          status={a.status}
          project={a.project}
          action={a.action}
          progress={a.progress}
          contextTokens={a.contextTokens}
          contextLimit={a.contextLimit}
          selected={a.id === selectedId}
          isGod={a.isGod}
          onClick={() => select(a.id)}
          doingCount={doingByAgent[a.id]?.length ?? 0}
          onTaskNoteClick={() => {
            const first = doingByAgent[a.id]?.[0];
            if (first) openTaskDetail(first);
          }}
        />
      ))}
      {restorableAgents.length > 0 && (
        <span
          style={{ alignSelf: 'center', flexShrink: 0 }}
          title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}
        >
          <PixelButton
            variant="primary"
            size="lg"
            onClick={restoreTeam}
            disabled={restoring}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <Icon name="play" /> {restoring ? 'restoring…' : `restore team (${restorableAgents.length})`}
            </span>
          </PixelButton>
        </span>
      )}
      <PixelButton
        variant="secondary"
        size="lg"
        style={{ alignSelf: 'center', flexShrink: 0 }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <Icon name="plus" /> add agent
        </span>
      </PixelButton>
    </div>
  );
}
