import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { CommandCenterPanel } from './CommandCenterPanel';
import { disposeTerminal } from './terminalPool';
import { SidebarTabs } from './SidebarTabs';
import { ThreadsPanel } from './ThreadsPanel';
import { ToolWaterfall } from './ToolWaterfall';
import { AgentControlStrip } from './AgentControlStrip';
import { EditAgentModal } from './EditAgentModal';
import { GitTab } from './GitTab';
import { Icon } from './Icon';
import { AgentNameEditor } from './AgentNameEditor';
import { useStore, type Agent } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';

export interface AgentDetailPanelProps {
  agent: Agent;
}

export function AgentDetailPanel({ agent }: AgentDetailPanelProps) {
  const { t } = useTranslation();
  const [openTerminalState, setOpenTerminalState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');
  const [openTerminalError, setOpenTerminalError] = useState<string | undefined>();
  const [editOpen, setEditOpen] = useState(false);

  /**
   * 当侧栏被拖进来时，顶部操作条必须让出一些东西。
   *
   * 四个「图标 + 文字」按钮本身大约需要 246px，头像和间距还要再占 72。
   * 侧栏最窄可以拖到 320px 总宽（SidebarSplitter 的 `min`），所以超过某个
   * 点之后，放得下文字标签就放不下代理的名字。
   *
   * 总得有东西让步，而这行里唯一不能让的就是名字：它是你判断「正在看哪个
   * 代理」的依据。因此在阈值以下时，按钮只保留图标、去掉文字——每个按钮的
   * tooltip 和 aria-label 已经带有完整说明，实际上并没有丢失信息，腾出的
   * ~110px 全部还给了名字。
   *
   * 这里按操作条本身的宽度测量，而不是 `sidebarWidth`，因为操作条的宽度由
   * 它的容器决定，而不是由内部内容决定。这正是单个阈值在此安全的原因：
   * 把文字换成图标不会改变被比较的那个数，因此这一行不会来回抖动。
   *
   * 440 从何而来。除名字外的所有东西大约占 318px：四个按钮在 Inter 13px
   * 下实测约 246，头像 32，五个 8px 间距又占 40。名字使用 Press Start 2P
   * 这种等宽像素字体——在 fontSize 10 下每个字符恰好 10px，再加上旁边重命名
   * 铅笔的 17。十个可读字符因此需要 117，318 + 117 四舍五入就是 440。
   *
   * 这个阈值有意让默认的 420px 侧栏进入紧凑模式。必须如此：在 420 时，带
   * 文字标签的行只能给名字留约 67px，也就是六个像素字宽——这正是被报告为
   * "DWIGHT S." 截断的情况。默认宽度下只显示图标才是修复，而非副作用。
   *
   * 如果这一行再加入第五个按钮，或某个标签变长，请重新计算这个数值。
   */
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [compactHeader, setCompactHeader] = useState(false);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setCompactHeader(w < 440);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const archiveAgent = useStore(s => s.archiveAgent);
  const updateAgent = useStore(s => s.updateAgent);
  const renameAgent = useStore(s => s.renameAgent);
  const setFullscreen = useStore(s => s.setFullscreen);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const sidebarTab = useStore(s => s.sidebarTab);
  const setSidebarTab = useStore(s => s.setSidebarTab);
  const isReal = !!agent.ptyId;
  // 当此代理显示在全屏浮层中时，全屏视图拥有这个 pty（它会调整大小以铺满
  // 屏幕）。如果同时挂载内嵌终端，两个 xterm 会争抢 pty 的 cols/rows——
  // 导致显示损坏、滚动失灵。所以这里卸载内嵌终端；全屏关闭后它会重新挂载
  // 并重新适配。
  const isFullscreenedHere = fullscreenAgentId === agent.id;

  const onPtyStream = usePtyParser(agent.id);

  // Michael 会看到完整的指挥中心仪表盘，而不是普通面板。
  if (agent.isGod) return <CommandCenterPanel agent={agent} />;

  const openTerminal = async () => {
    setOpenTerminalState('opening');
    setOpenTerminalError(undefined);
    try {
      const result = await window.cth.openTerminalAt(agent.cwd);
      if (result.ok) {
        setOpenTerminalState('ok');
        setTimeout(() => setOpenTerminalState('idle'), 1500);
      } else {
        setOpenTerminalState('error');
        setOpenTerminalError(result.error ?? '未知错误');
        setTimeout(() => setOpenTerminalState('idle'), 4000);
      }
    } catch (e) {
      setOpenTerminalState('error');
      setOpenTerminalError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setOpenTerminalState('idle'), 4000);
    }
  };

  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(t('agentDetail.killConfirm', { name: agent.name }))) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
  };

  return (
    <PixelPanel
      variant="default"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 0,
        overflow: 'hidden'
      }}
      noPadding
    >
      {/* 细头部条 */}
      <div ref={headerRef} style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)',
        flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
          flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', minWidth: 0, lineHeight: '14px' }}>
            <AgentNameEditor
              name={agent.name}
              onCommit={(name) => renameAgent(agent.id, name)}
              uppercase
              fontSize={10}
            />
          </div>
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center', marginTop: 1,
            minWidth: 0, overflow: 'hidden'
          }}>
            <PixelBadge status={agent.status} />
            <span style={{
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>{agent.project}</span>
          </div>
        </div>
        <PixelButton variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={`Edit ${agent.name}: their name and face, which engine they run on, and the briefing that tells them what they are for.`}
            aria-label={t('agentDetail.editAria')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="edit" />{!compactHeader && ' edit'}
          </span>
        </PixelButton>
        {/* v0.3.4：IDE 位于 agent 层级（取代了旧的 files 标签）——
            打开以该 agent 工作区为根的整窗 Monaco 编辑器。 */}
        <PixelButton variant="secondary" size="sm" onClick={() => useStore.getState().setIdeOpen(true, agent.id)}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('agentDetail.ideTip', { project: agent.project })}
            aria-label={t('agentDetail.openIde')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="code" />{!compactHeader && t('agentDetail.ide')}
          </span>
        </PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={openTerminal} disabled={openTerminalState === 'opening'}>
          {/* "open" 没说明打开的是什么，而这排里 IDE 和 Talk
              也都会打开某种东西。标签写清楚你得到什么；
              提示则写明你在哪个文件夹里得到它。 */}
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('agentDetail.terminalTip', { cwd: agent.cwd })}
            aria-label={t('agentDetail.openTerminalAria')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="terminal" />
            {/* 瞬时状态在紧凑模式下保留：它们是对你刚做的点击的反馈，
                且只有两个字符宽。只有静止的 "terminal" 一词才值得占据空间。 */}
            {openTerminalState === 'opening' ? t('agentDetail.opening')
              : openTerminalState === 'ok' ? t('agentDetail.ok')
              : openTerminalState === 'error' ? t('agentDetail.err')
              : compactHeader ? '' : t('agentDetail.open')}
          </span>
        </PixelButton>
        {isReal && (
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            <Icon name="x" />
          </PixelButton>
        )}
      </div>

      {openTerminalError && (
        <div style={{
          fontSize: 12, color: 'var(--cth-coral)',
          padding: '2px 8px',
          background: 'var(--cth-coral-light)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{openTerminalError}</div>
      )}

      {/* #7C —— 在线 agent 的操作控制（暂停 / 停止 / 引导） */}
      {isReal && <AgentControlStrip agentId={agent.id} />}

      {/* 标签页 */}
      <SidebarTabs current={sidebarTab} accent={agent.accent} onChange={setSidebarTab} />

      {/* 当前标签页主体 —— 填充剩余空间 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {sidebarTab === 'terminal' && (
          isReal && agent.ptyId ? (
            isFullscreenedHere ? (
              <EmptyTab title={t('agentDetail.inFullscreen')}>
                {t('agentDetail.fullscreenDesc')}
              </EmptyTab>
            ) : (
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
                  onToggleFullscreen={() => setFullscreen(agent.id)}
                  fullscreen={false}
                  embedded
                />
              </div>
              <MessageQueueComposer agent={agent} />
            </div>
            )
          ) : (
            <EmptyTab title={t('agentDetail.noPty')}>
              {t('agentDetail.noPtyDesc')}
            </EmptyTab>
          )
        )}

        {sidebarTab === 'git' && (
          <GitTab cwd={agent.cwd} />
        )}

        {sidebarTab === 'messages' && (
          <ThreadsPanel agentId={agent.id} />
        )}

        {sidebarTab === 'traces' && (
          <ToolWaterfall agentId={agent.id} />
        )}
      </div>

      {editOpen && (
        <EditAgentModal agent={agent} onClose={() => setEditOpen(false)} />
      )}
    </PixelPanel>
  );
}

function EmptyTab({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 16, gap: 8,
      background: 'var(--cth-paper-200)'
    }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
        color: 'var(--cth-ink-500)'
      }}>{title.toUpperCase()}</div>
      <p style={{
        margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)',
        maxWidth: 280
      }}>{children}</p>
    </div>
  );
}
