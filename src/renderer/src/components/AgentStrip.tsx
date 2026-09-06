import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import {
  AGENT_PROVIDER_PRESETS, buildSpawnCommand, inferAgentProvider,
  isClaudeProvider, modelsForProvider, type AgentProvider, type HarnessConfig
} from '@/store/config';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { useRtl } from '@/i18n/useDirection';
import { AGENT_DUTIES, normalizeDuty, type AgentDuty } from '@shared/agentDuty';
import { canReceiveInbox } from '@shared/agentProvider';

// One recipe for every picker row in the restore menu — duty, engine, model,
// the god's engine — so the dropdowns read as one control set.
const pickStyle = (maxWidth: number): CSSProperties => ({
  flexShrink: 0, maxWidth,
  padding: '2px 4px 1px', fontSize: 11,
  fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', cursor: 'pointer'
});

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
}

export function AgentStrip({ config }: AgentStripProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const godName = useResolvedGodName();
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const openTaskDetail = useStore(s => s.openTaskDetail);
  const reorderAgents = useStore(s => s.reorderAgents);
  const renameAgent = useStore(s => s.renameAgent);
  const setAgentNote = useStore(s => s.setAgentNote);
  // Shared with the fullscreen roster so both show one restore in progress.
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  // ONE restore control (bottom-right): a button whose dropdown OPENS UPWARD and
  // lists last session's agents with per-agent dismiss. The menu is position:
  // fixed (anchored off the button's rect) because the strip scrolls with
  // overflow hidden — an absolute child would be clipped.
  const [restoreMenuOpen, setRestoreMenuOpen] = useState(false);
  const [restoreMenuPos, setRestoreMenuPos] = useState<{ right: number; bottom: number } | null>(null);
  const restoreBtnRef = useRef<HTMLSpanElement>(null);
  const restoreBusy = restoring || autoRestoring;
  useEffect(() => {
    if (restorableAgents.length === 0 || restoreBusy) setRestoreMenuOpen(false);
  }, [restorableAgents.length, restoreBusy]);
  const toggleRestoreMenu = (anchor: HTMLElement | null) => {
    if (restoreMenuOpen) { setRestoreMenuOpen(false); return; }
    const rect = anchor?.getBoundingClientRect();
    if (!rect) return;
    setRestoreMenuPos({
      right: Math.max(8, window.innerWidth - rect.right),
      bottom: Math.max(8, window.innerHeight - rect.top + 6)
    });
    setRestoreMenuOpen(true);
  };
  // Drag-to-reorder the roster: dragId = the card being dragged, overId = the card
  // currently hovered as a drop target (drives the insertion-line cue).
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Note editing is EXPLICIT (✎ toggles the editor) — nothing appears on hover.
  // The editor is a fixed popover ABOVE the card (anchored off its rect): the
  // strip clips overflow and the compact cards have no room for an inline box.
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
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

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '14px 16px',
      overflowX: 'auto',
      overflowY: 'hidden',
      borderTop: '1px solid var(--cth-ink-300)',
      background: 'var(--cth-cream-200)',
      // Tall enough for the god card to stand proud of the row (it's taller and
      // rides a drop shadow) plus the hover-lift on every card, without clipping.
      height: 112,
      minHeight: 112,
      alignItems: 'center'
    }}>
      {agents.map(a => (
        // Draggable wrapper: reorder the roster by dragging one card onto another.
        // Native HTML5 DnD (no dep). A plain click still selects — a drag only
        // starts on movement — so AgentCard's onClick is unaffected.
        <div
          key={a.id}
          ref={(el) => { cardRefs.current[a.id] = el; }}
          draggable
          onDragStart={(e) => { setDragId(a.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => {
            if (!dragId || dragId === a.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overId !== a.id) setOverId(a.id);
          }}
          onDragLeave={() => { if (overId === a.id) setOverId(null); }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== a.id) reorderAgents(dragId, a.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
          style={{
            position: 'relative',
            flexShrink: 0,
            cursor: 'grab',
            opacity: dragId === a.id ? 0.4 : 1,
            // Insertion-line cue on the hovered drop target.
            boxShadow: overId === a.id && dragId && dragId !== a.id
              ? 'inset 3px 0 0 0 var(--cth-ink-900)'
              : 'none',
            transition: 'opacity 120ms ease'
          }}
        >
          <AgentCard
            draggable
            name={a.name}
            character={a.character}
            accent={a.accent}
            status={a.status}
            ptyId={a.ptyId}
            project={a.project}
            action={a.action}
            progress={a.progress}
            contextTokens={a.contextTokens}
            contextLimit={a.contextLimit}
            selected={a.id === selectedId}
            isGod={a.isGod}
            onClick={() => select(a.id)}
            onRename={(name) => renameAgent(a.id, name)}
            doingCount={doingByAgent[a.id]?.length ?? 0}
            onTaskNoteClick={() => {
              const first = doingByAgent[a.id]?.[0];
              if (first) openTaskDetail(first);
            }}
            note={a.note}
            onEditNote={a.isGod ? undefined : () => setNoteEditId(a.id)}
          />
          {/* The note itself lives INSIDE the card (its own row above the gauge).
              This is the transient EDITOR: a fixed popover ABOVE the card —
              the compact card has no room for an inline box, and the strip
              clips overflow. ✎ opens it; Esc / ✕ / click-away closes. */}
          {noteEditId === a.id && !dragId && (() => {
            const rect = cardRefs.current[a.id]?.getBoundingClientRect();
            if (!rect) return null;
            const width = 280;
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            const bottom = Math.max(8, window.innerHeight - rect.top + 8);
            return (
              <>
                {/* click-away backdrop */}
                <div
                  onClick={() => setNoteEditId(null)}
                  style={{ position: 'fixed', inset: 0, zIndex: 349, background: 'transparent' }}
                />
                <div
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: 'fixed', left, bottom, width, zIndex: 350,
                    padding: 10, boxSizing: 'border-box',
                    background: 'var(--cth-paper-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300), 3px 3px 0 rgba(26,19,32,0.14)',
                    display: 'flex', flexDirection: 'column', gap: 6
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{
                      fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                      color: 'var(--cth-ink-500)'
                    }}>{t('agentStrip.privateNote', { name: a.name.toUpperCase() })}</span>
                    <button
                      onClick={() => setNoteEditId(null)}
                      title={t('agentStrip.done')}
                      aria-label={t('agentStrip.closeNoteEditor')}
                      style={{
                        flexShrink: 0, width: 18, height: 18, padding: 0, lineHeight: 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                        color: 'var(--cth-ink-500)', background: 'transparent',
                        border: 'none', cursor: 'pointer'
                      }}
                    >✕</button>
                  </div>
                  {/* A textarea, not an input: the note is a bullet list (one
                      line per bullet) and the fullscreen roster renders every
                      line — an <input> would silently eat the newlines. */}
                  <textarea
                    dir={rtl ? 'auto' : undefined}
                    autoFocus
                    rows={3}
                    value={a.note ?? ''}
                    onChange={(e) => setAgentNote(a.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setNoteEditId(null); }}
                    placeholder={t('agentStrip.notePlaceholder')}
                    aria-label={t('agentCard.noteAria', { name: a.name })}
                    style={{
                      width: '100%', padding: '6px 8px',
                      border: 'none', outline: 'none', resize: 'none', boxSizing: 'border-box',
                      background: 'var(--cth-cream-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                      lineHeight: '18px', color: 'var(--cth-ink-900)'
                    }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
                    {t('agentStrip.oneLineOneBullet')}
                  </span>
                </div>
              </>
            );
          })()}
        </div>
      ))}
      <PixelButton
        variant="secondary"
        size="lg"
        style={{ alignSelf: 'center', flexShrink: 0 }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <Icon name="plus" /> {t('agentStrip.addAgent')}
        </span>
      </PixelButton>
      {/* ONE restore control, pinned to the strip's right edge. Busy (manual OR
          boot auto-restore) collapses to a single disabled "restoring your
          team…"; otherwise the button opens an upward dropdown listing last
          session's agents (per-agent ✕ dismiss + restore all). No outcome note
          is rendered afterwards — the restored agents appearing IS the outcome. */}
      {(restorableAgents.length > 0 || restoreBusy) && (
        <span
          ref={restoreBtnRef}
          style={{ alignSelf: 'center', flexShrink: 0, marginLeft: 'auto' }}
          title={restoreBusy
            ? t('agentStrip.restoringTitle')
            : t('agentStrip.restoreTitle', { names: restorableAgents.map((a: Agent) => a.name).join(', ') })}
        >
          <PixelButton
            variant="primary"
            size="lg"
            disabled={restoreBusy}
            onClick={() => toggleRestoreMenu(restoreBtnRef.current)}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <Icon name="play" />
              {restoreBusy ? t('agentStrip.restoringTeam') : t('agentStrip.restoreTeam', { count: restorableAgents.length })}
            </span>
          </PixelButton>
        </span>
      )}
      {restoreMenuOpen && restoreMenuPos && restorableAgents.length > 0 && (
        <>
          {/* click-away backdrop */}
          <div
            onClick={() => setRestoreMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 349, background: 'transparent' }}
          />
          <div style={{
            position: 'fixed', right: restoreMenuPos.right, bottom: restoreMenuPos.bottom,
            zIndex: 350, minWidth: 470, maxWidth: 'min(92vw, 560px)', maxHeight: '50vh', overflowY: 'auto',
            background: 'var(--cth-cream-50)',
            boxShadow: '0 0 0 2px var(--cth-ink-900), 3px 4px 0 0 rgba(26,19,32,0.22)',
            padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
            fontFamily: 'var(--cth-font-ui)'
          }}>
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
              color: 'var(--cth-ink-500)', textTransform: 'uppercase'
            }}>
              {t('agentStrip.previousSession')}
            </span>
            {/* The god's engine — MODEL ONLY, never a duty. Michael routes the
                floor; he is not a stage in the workflow, and this panel must not
                offer appointing him into one. Writes godProvider / godModel —
                exactly what the boot path reads when Start spawns him — so his
                engine is picked from the same place the team's is. Provider
                switches follow the Command Center's god-engine rule: the model
                resets to the engine's recommended orchestrator model, and only
                inbox-capable engines are offered (a god that cannot drain his
                inbox cannot run the floor). */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              height: 26, padding: '0 4px 0 8px',
              fontSize: 12, color: 'var(--cth-ink-900)',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <span style={{ flex: 1, minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {godName}
              </span>
              <select
                value={config?.godProvider ?? 'claude'}
                disabled={!config}
                onChange={(e) => {
                  const p = e.target.value as AgentProvider;
                  void window.cth.updateConfig({
                    godProvider: p,
                    godModel: AGENT_PROVIDER_PRESETS.find((x) => x.id === p)?.recommendedOrchestratorModel
                  }).catch(() => { /* config save is best-effort here */ });
                }}
                title={t('agentStrip.engineFor', { name: godName })}
                style={pickStyle(92)}
              >
                {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.id === 'claude' ? ' ★' : ''}
                  </option>
                ))}
              </select>
              <select
                value={config?.godModel ?? ''}
                disabled={!config}
                onChange={(e) => {
                  void window.cth.updateConfig({ godModel: e.target.value || undefined })
                    .catch(() => { /* config save is best-effort here */ });
                }}
                title={t('agentStrip.modelFor', { name: godName })}
                style={pickStyle(110)}
              >
                {modelsForProvider(config?.godProvider ?? 'claude').map((m) => (
                  <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                ))}
              </select>
            </div>
            {/* Per-agent dismiss wires straight to removeRestorableAgent
                (filters + persistRestorable), so a dismissed agent never
                reappears after reload. */}
            {restorableAgents.map((a: Agent) => {
              // The engine this agent will respawn on. The command is the
              // recipe a restore runs, so a choice here REBUILDS it — the
              // stored command (old provider/model) would otherwise win and
              // silently undo the pick. Same split as Add Agent: Claude keeps
              // the configured default model, other engines take their own.
              const provider = inferAgentProvider(a.command, a.provider);
              const pickEngine = (nextProvider: AgentProvider, nextModel?: string): void => {
                if (!config) return;
                useStore.getState().setRestorableAgentEngine(a.id, {
                  provider: nextProvider,
                  model: nextModel,
                  command: buildSpawnCommand(config, nextModel, nextProvider)
                });
              };
              return (
              <span
                key={a.id}
                title={t('agentStrip.restorable', { name: a.name })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  height: 26, padding: '0 4px 0 8px',
                  fontSize: 12, color: 'var(--cth-ink-900)',
                  background: 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}
              >
                <span style={{ flex: 1, minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </span>
                {/* Engine + model before Start, per agent: the restore respawn
                    runs the stored command, so this rewrites it (and the
                    model/provider fields) rather than something downstream
                    having to remember. Disabled without config — no config,
                    no command to rebuild. */}
                <select
                  value={provider}
                  disabled={!config}
                  onChange={(e) => {
                    const p = e.target.value as AgentProvider;
                    const nextModel = isClaudeProvider(p) ? config?.defaultModel : config?.providerDefaultModels?.[p];
                    pickEngine(p, nextModel);
                  }}
                  title={t('agentStrip.engineFor', { name: a.name })}
                  style={pickStyle(92)}
                >
                  {AGENT_PROVIDER_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <select
                  value={a.model ?? ''}
                  disabled={!config}
                  onChange={(e) => pickEngine(provider, e.target.value || undefined)}
                  title={t('agentStrip.modelFor', { name: a.name })}
                  style={pickStyle(110)}
                >
                  {modelsForProvider(provider).map((m) => (
                    <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                  ))}
                </select>
                {/* The description snippet that used to sit here is dropped —
                    the row is 26px tall and had no room for both it and the
                    duty picker, and duty is the thing worth setting before
                    Start. Assigning a duty here never needed a live PTY — it always
                    wrote straight to the hive registry (hivePatchAgentDuty),
                    same as Edit Agent. What was missing was purely this
                    control, which is why "assign roles before Start" looked
                    supported (the TEAM PAUSED copy says so) but wasn't. */}
                <select
                  value={normalizeDuty(a.duty)}
                  onChange={(e) => {
                    const duty = normalizeDuty(e.target.value) as AgentDuty;
                    useStore.getState().setRestorableAgentDuty(a.id, duty);
                    void window.cth.hivePatchAgentDuty(a.id, duty).catch(() => { /* hive may be disabled */ });
                  }}
                  title={t(`duty.hint.${normalizeDuty(a.duty)}`)}
                  style={pickStyle(92)}
                >
                  {AGENT_DUTIES.map((duty) => (
                    <option key={duty} value={duty}>{t(`duty.label.${duty}`)}</option>
                  ))}
                </select>
                <button
                  onClick={() => useStore.getState().removeRestorableAgent(a.id)}
                  title={t('agentStrip.dismiss', { name: a.name })}
                  aria-label={t('agentStrip.dismissAria', { name: a.name })}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 18, height: 18, padding: 0, lineHeight: 1,
                    fontSize: 12, color: 'var(--cth-ink-500)',
                    background: 'transparent', border: 'none', cursor: 'pointer'
                  }}
                >✕</button>
              </span>
              );
            })}
            <PixelButton
              variant="primary"
              size="sm"
              onClick={() => { setRestoreMenuOpen(false); void restoreTeam(); }}
            >
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                <Icon name="play" /> {t('agentStrip.restoreAll', { count: restorableAgents.length })}
              </span>
            </PixelButton>
          </div>
        </>
      )}
    </div>
  );
}
