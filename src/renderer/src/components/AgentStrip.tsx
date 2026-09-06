import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { type HarnessConfig } from '@/store/config';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useRtl } from '@/i18n/useDirection';

export interface AgentStripProps {
  /** 当可恢复 agent 早于持久化的 `command` 字段时，用于重建 spawn 命令。
   *  可选，使条带在无配置时也能渲染。 */
  config?: HarnessConfig | null;
}

export function AgentStrip({ config }: AgentStripProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const openTaskDetail = useStore(s => s.openTaskDetail);
  const reorderAgents = useStore(s => s.reorderAgents);
  const renameAgent = useStore(s => s.renameAgent);
  const setAgentNote = useStore(s => s.setAgentNote);
  // 与全屏花名册共享，让两侧都只显示一个"恢复中"状态。
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  // 单个恢复控件（右下角）：一个向上展开的按钮下拉菜单，
  // 列出上一会话的 agents 并支持逐个 dismiss。菜单用 position: fixed
  // （以按钮矩形为锚点）定位，因为条带随 overflow hidden 滚动——
  // 绝对定位的子元素会被裁剪。
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
  // 拖拽重排花名册：dragId = 正在拖拽的卡片，overId = 当前悬停作为
  // 放置目标的卡片（驱动插入线提示）。
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 备注编辑是显式的（✎ 切换编辑器）——悬停不会弹出任何东西。
  // 编辑器是卡片上方的固定弹层（以卡片矩形为锚点）：条带会裁剪
  // 溢出内容，而紧凑卡片也没有空间容纳内联输入框。
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // 每个 worker 正在执行中的台账任务，从 hive/tasks.json 轮询——
  // 渲染为头像卡片上的便利贴（点击 → 任务详情）。
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
      } catch { /* 保留上次有效数据 */ }
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
      // 高度要足以让 god 卡片在行中傲然挺立（它更高并带有投影），
      // 还要容纳每张卡片的悬停上浮，且不能裁剪。
      height: 112,
      minHeight: 112,
      alignItems: 'center'
    }}>
      {agents.map(a => (
        // 可拖拽包装：把一张卡片拖到另一张上来重排花名册。
        // 原生 HTML5 DnD（无依赖）。普通点击仍会选择——只有移动才会
        // 开始拖拽——因此 AgentCard 的 onClick 不受影响。
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
            // 悬停放置目标上的插入线提示。
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
          {/* 备注本身位于卡片内部（仪表上方自带一行）。
              这是瞬态编辑器：卡片上方的一个固定弹层——
              紧凑卡片没有容纳内联输入框的空间，且条带会裁剪溢出内容。
              ✎ 打开它；Esc / ✕ / 点击外部关闭。 */}
          {noteEditId === a.id && !dragId && (() => {
            const rect = cardRefs.current[a.id]?.getBoundingClientRect();
            if (!rect) return null;
            const width = 280;
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            const bottom = Math.max(8, window.innerHeight - rect.top + 8);
            return (
              <>
                {/* 点击外部关闭的背景层 */}
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
                  {/* 用 textarea 而非 input：备注是项目符号列表（每行一条），
                      全屏花名册会渲染每一行——用 <input> 会悄悄吞掉换行。 */}
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
      {/* 单个恢复控件，固定在条带右缘。忙碌时（手动 OR 开机自动恢复）
          折叠成单个禁用的"正在恢复你的团队…"；否则按钮打开一个
          向上展开的下拉菜单，列出上一会话的 agents（逐个 ✕ dismiss + 全部恢复）。
          之后不渲染任何结果说明——恢复出的 agents 出现本身就说明成功了。 */}
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
          {/* 点击外部关闭的背景层 */}
          <div
            onClick={() => setRestoreMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 349, background: 'transparent' }}
          />
          <div style={{
            position: 'fixed', right: restoreMenuPos.right, bottom: restoreMenuPos.bottom,
            zIndex: 350, minWidth: 240, maxHeight: '50vh', overflowY: 'auto',
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
            {/* 逐 agent dismiss 直接接到 removeRestorableAgent
                （过滤 + persistRestorable），因此被 dismiss 的 agent
                在重载后再也不会出现。 */}
            {restorableAgents.map((a: Agent) => (
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
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </span>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>
                  {a.description ? a.description.slice(0, 24) : ''}
                </span>
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
            ))}
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
