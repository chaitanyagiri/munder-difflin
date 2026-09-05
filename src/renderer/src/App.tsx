import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, selectedAgent } from '@/store/store';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { DEFAULT_ORG_TRIGGER } from '@shared/triggers';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { useHive } from '@/hooks/useHive';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { useGodNameSync } from '@/i18n/useGodNameSync';
import { useDirectionSync } from '@/i18n/useDirection';
import { useArabicTerminalSync } from '@/terminal/useArabicTerminalSync';
import { MemoryPanel } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { AddAgentModal } from '@/components/AddAgentModal';
import { MichaelBooting } from '@/components/MichaelBooting';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { HivePicker } from '@/components/HivePicker';
import { QuitWarningModal, type ClosingTimeState } from '@/components/QuitWarningModal';
import { CompletionToast } from '@/realtime/CompletionToast';
import { UpdateToast } from '@/components/UpdateToast';
import { UpdateBadge } from '@/components/UpdateBadge';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { SettingsModal, type Section as SettingsSection } from '@/components/SettingsModal';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { acquireTerminal, notifyThemeChangeAll } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { TaskDetailOverlay } from '@/components/TaskDetailOverlay';
import { IdePanel } from '@/ide/IdePanel';
import { useHoldOptionToTalk } from '@/freeflow/holdOption';
import brandLogo from '@brand/logo.png?url';

// 构建时从 package.json 注入（见 electron.vite.config.ts）。
declare const __APP_VERSION__: string;

export function App() {
  const { t } = useTranslation();
  // 将每个 {{godName}} 字符串指向编排器的真实、可重命名名称。
  useGodNameSync();
  // 仅为用户选择的 RTL 应用语言镜像文档方向。
  useDirectionSync();
  // 让已打开的终端也跟随语言切换。
  useArabicTerminalSync();
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  const bootingGodName = useResolvedGodName();
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const clearPendingHires = useStore(s => s.clearPendingHires);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const appThemeNow = useAppTheme();
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const setSidebarWidth = useStore(s => s.setSidebarWidth);
  const ideOpen = useStore(s => s.ideOpen);
  const setIdeOpen = useStore(s => s.setIdeOpen);

  const [config, setConfig] = useState<HarnessConfig | null>(null);
  // 用户是否在本会话中已通过启动时的蜂巢选择器。在蜂巢切换后立即设为
  // true（跳过选择器）——changeHome 重新拉起后留下一次性 localStorage 标记，
  // 避免回到刚选择的蜂巢选择器。也在入门完成时设为 true（见下文）。
  const [hiveOpened, setHiveOpened] = useState<boolean>(() => {
    try {
      if (window.localStorage.getItem('cth.skipHivePickerOnce')) {
        window.localStorage.removeItem('cth.skipHivePickerOnce');
        return true;
      }
    } catch { /* localStorage 不可用 — 显示选择器 */ }
    return false;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置面板打开到哪个标签页。由 `cth:open-settings` 深度链接设置，正常打开
   *  时重置为 undefined（→ 常规）。 */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [closing, setClosing] = useState<ClosingTimeState | null>(null);
  const [vpWidth, setVpWidth] = useState<number>(window.innerWidth);

  // 从树中任意位置深度链接到设置。设置的打开状态
  // 是 App 本地的，因此嵌套控件（如禁用"对话"
  // 按钮旁的"立即设置"）没有路径访问它，除非在每个层之间传递 prop；
  // window 事件将这种管道逻辑保持在组件之外，
  // 匹配现有的 `cth:` CustomEvent 约定。
  useEffect(() => {
    const onOpenSettings = (e: Event): void => {
      const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener('cth:open-settings', onOpenSettings);
    return () => window.removeEventListener('cth:open-settings', onOpenSettings);
  }, []);

  // 初始配置加载
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      setConfig(c);
      // 预配置安装：配置已包含入门信息和
      // harnessHome（D:盘上的用户数据），因此冷启动不应反弹
      // 通过启动时的蜂巢选择器——直接进入蜂巢，恰好
      // 如入门完成时一样（见下文）。
      if (c.onboardingComplete && c.harnessHome) setHiveOpened(true);
      // 将 Free Flow 标志镜像到存储中，使作曲家麦克风按钮仅在启用时显示
      // （设置保存时保持同步）。
      useStore.getState().setFreeflowEnabled(!!c.freeflowEnabled);
      // 仅镜像布尔键存在性（从不键值），使作曲家可以
      // 在 Free Flow 开启但没有设置
      // Groq 密钥时显示禁用带提示的语音按钮（设置保存时保持同步）。
      useStore.getState().setHasGroqKey(!!c.groqApiKey);
      // 镜像活跃的办公室主题以便 OfficeFloor 渲染（由 tvShowOffices 标志控制；
      // 关闭 = 始终是办公室）。设置保持同步。
      // 镜像触发器，使设置 → 连接 和指挥中心
      // 触发器标签页读取一个列表，而不是两个可能漂移的副本——哪个表面
      // 保存会调用这些相同的设置器，另一个重绘。无额外 IPC：主进程
      // 在每次配置读取时深度填充两个字段（withTriggerDefaults），因此
      // getConfig() 已提供 listWebhooks()/getOrgTrigger() 会提供的服务。
      // `c` 类型化为预加载的 HarnessConfig，尚未获取这两个
      // 字段（另一路径的文件）；渲染器镜像类型声明了它们。
      const withTriggers = c as HarnessConfig;
      useStore.getState().setWebhookTriggers(withTriggers.webhookTriggers ?? []);
      useStore.getState().setOrgTrigger(withTriggers.orgTrigger ?? DEFAULT_ORG_TRIGGER);
    });
    // 镜像 BYOK OpenAI 密钥存在性（仅布尔值；密钥永远不会离开主进程）以便
    // 实时迈克尔语音切换可以基于它。位于密钥代理器中，不在
    // 配置中——因此获取它而不是从 c 推导。
    window.cth.realtimeHasOpenAiKey().then(has => {
      if (!cancelled) useStore.getState().setHasOpenAiKey(has);
    });
    return () => { cancelled = true; };
  }, []);

  // Free Flow 入口 B —— 按住 Option (⌥) 说话。渲染器内针对
  // 用户正在查看的任一代理的即时通话；由标志控制，终端安全
  // （单人按住阈值，其他按键时中止）。见 freeflow/holdOption.ts。
  useHoldOptionToTalk();

  // 配置订阅——上面加载的副本否则会在
  // 保存任何设置时立即过期。
  useEffect(() => window.cth.onConfigChanged(setConfig), []);

  // 退出警告订阅
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // 可共享招聘：通过 munderdifflin://
  // 深度链接（或文件导入）到达的已验证清单预填充添加代理模态。从不自行生成。
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const closeAddAgentReview = () => {
    clearPendingHires();
    setAddAgentOpen(false);
  };
  useEffect(() => {
    const unsub = window.cth.onHireImport?.((m) => {
      enqueuePendingHires([m]);
      setAddAgentOpen(true);
    });
    // 拉取在此订阅存在之前到达的任何内容（冷启动
    // 深度链接；打包渲染器加载太快，无法在加载时推送）。
    void window.cth.drainPendingHires?.().then((queued) => {
      if (queued && queued.length > 0) {
        enqueuePendingHires(queued);
        setAddAgentOpen(true);
      }
    });
    return unsub;
  }, [enqueuePendingHires, setAddAgentOpen]);
  useEffect(() => window.cth.onHireError?.((info) => {
    console.error('[hire] import failed:', info.error);
  }), []);

  // 关闭时间进度：驱动退出对话框的"正在收尾"视图。对话框
  // 在整个协议期间保持打开；在'complete'时主进程
  // 会自行销毁并在片刻后退出。
  useEffect(() => window.cth.onClosingTime?.((ev) => {
    if (ev.phase === 'cancelled') { setClosing(null); return; }
    setClosing({ phase: ev.phase, acked: ev.acked, total: ev.total });
    if (ev.phase === 'started' || ev.phase === 'progress') setQuitWarn((w) => w ?? { ptyCount: 0 });
  }), []);

  const startClosingTime = async () => {
    const res = await window.cth.startClosingTime();
    if (!res.ok) setClosing({ phase: 'error', acked: 0, total: 0, error: res.error });
  };
  const cancelClosingTime = () => {
    void window.cth.cancelClosingTime();
    setClosing(null);
  };

  // 蜂巢：神代理引导、钩子驱动头像、空闲代理唤醒。保持
  // 关闭直到用户在启动选择器中打开蜂巢（传递 null 使
  // 钩子无效）以便迈克尔不会在当前 home 上引导，而用户可能正在
  // 切换到不同的 home。
  useHive(hiveOpened ? config : null);

  // 为每个活动代理预热持久终端，使其输出在
  // 生成时缓冲。切换代理然后立即重新附加已渲染的
  // 终端（带完整历史），而不是构建空白终端。
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // 合成演示循环——CAGED (#5B)。绝不能与活动
  // 蜂巢一起动画（它会触发虚假信封交接和步进种子代理）。仅作为
  // 显式展示运行（VITE_CTH_DEMO=1 在开发中）或在真正空
  // 闲的地板，在第一真实 PTY 代理出现时立即停止
  // （迈克尔总是生成，因此在正常操作中它实际上从不运行）。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const DEMO = import.meta.env.DEV && import.meta.env.VITE_CTH_DEMO === '1';
    const evaluate = () => {
      const hasLive = useStore.getState().agents.some((a) => a.ptyId);
      if (DEMO || !hasLive) startMockLoop();
      else stopMockLoop();
    };
    evaluate();
    const unsub = useStore.subscribe(evaluate);
    return () => { unsub(); stopMockLoop(); };
  }, [config?.onboardingComplete]);

  // 将恢复的代理与主进程中仍然存活的 PTY 进行协调。
  // 渲染器重新加载后（例如笔记本电脑睡眠且 Vite 重新加载页面），
  // 这保留进程存活其的代理并丢弃真正死亡的代理。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* 忽略——保持恢复的代理原样 */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // 重新应用持久化的专注模式偏好，作为名单填充。
  //
  // 不是在存储构造时的一次性操作：在启动时每个恢复的代理仍然
  // 携带前一次会话的 PTY id，因此上面的协调修剪所有内容
  // 并正确将专注模式降为 null，直到神重新生成。因此
  // 一旦有活动终端的代理实际存在，必须重新检查偏好。`restoreFocusMode` 是一个 no-op，除非偏好开启且
  // 专注模式当前关闭，因此在每次名单更改时重新运行它是安全的
  // 按 Esc 保持粘滞。
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    useStore.getState().restoreFocusMode();
  }, [config?.onboardingComplete, agents]);

  // 跟踪视口宽度以进行分割器夹紧
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.onboardingComplete) {
    // 刚入门的用户直接进入他们设置的蜂巢——跳过选择器。
    return <OnboardingWizard onComplete={(next) => { setConfig(next); setHiveOpened(true); }} />;
  }

  // 启动时蜂巢选择器：重新打开时，让用户打开当前蜂巢，
  // 切换到最近的蜂巢，或打开/创建另一个。在入门后
  // 和切换重新拉起后立即跳过（见 hiveOpened 初始化）。
  if (!hiveOpened) {
    return <HivePicker config={config} onOpenCurrent={() => setHiveOpened(true)} />;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* rt-12: 语音迈克尔完成的全局固定覆盖通知（"Oscar
          完成 X"）。自我定位右下角；在到达前渲染 null。 */}
      <CompletionToast />
      {/* v0.3.4: 后台更新通知（"重启以更新"）；在主
          更新器推送状态前渲染 null。 */}
      <UpdateToast />
      {/* 标题栏 */}
      <div
        className="cth-titlebar-drag"
        style={{
          height: 36, minHeight: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 96,
          paddingRight: 12,
          gap: 12,
          userSelect: 'none'
        }}
      >
        <img
          src={brandLogo}
          alt="Munder Difflin"
          style={{ height: 20, width: 'auto', display: 'block' }}
        />
        {/* v0.3.7: 版本不再是惰性文本——它作为
            更新控件（检查/下载/重启更新）。 */}
        <UpdateBadge />
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          color: 'var(--cth-ink-500)'
        }}>
          {config.autoMode ? 'auto mode on' : 'auto mode off'}
        </span>
        {/* v0.3.4: 主题 + 全屏在此处（右上角），不埋在
            终端头部——主题变暗整个应用，包括终端
            （design/theme.ts + tokens.css 深色块）。 */}
        <button
          className="cth-titlebar-nodrag cth-tip"
          onClick={() => {
            const next = toggleAppTheme();
            // 告诉每个正在运行的程序主题已翻转。xterm 重绘自己的
            // 单元格，但用显式颜色绘制面板的 TUI 保持
            // 它们直到重绘，这使 OpenCode 的框留在旧调色板中
            // 直到代理重启。只有启用了 DEC 模式 2031 的程序
            // 才会被通知，并且是每个池化终端而不是可见的一个，
            // 因此后台代理在切换到时不会过期。
            notifyThemeChangeAll(next === 'dark' ? 'dark' : 'light');
            // 镜像到控制架配置：从现在开始每个代理（重新）生成时
            // 在其每个会话 Claude 设置中获得匹配的 `theme`，
            // 因此 TUI 的真彩色调色板适合终端。限制在
            // 控制架代理——用户的全球 Claude 主题永远不会触碰。
            void window.cth.updateConfig({ terminalTheme: next });
          }}
          data-tip={appThemeNow === 'dark' ? t('app.lightTheme') : t('app.darkTheme')}
          aria-label={t('app.toggleDarkMode')}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)', fontSize: 13, lineHeight: 1
          }}
        >
          {appThemeNow === 'dark' ? '☀' : '☾'}
        </button>
        {/* v0.3.4: IDE 按钮移到代理级别——每个代理的头
            （侧边栏详情、神指挥中心、全屏）携带它。 */}
        <button
          className="cth-titlebar-nodrag cth-settings-btn cth-tip"
          onClick={() => { setSettingsSection(undefined); setSettingsOpen(true); }}
          data-tip="Settings"
          aria-label={t('app.settingsAria')}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          <GearGlyph />
        </button>
        {/* 全屏。标题栏是 chrome，不是 canvas，因此这两个使用
            干净的描边图标而不是其余 UI 绘制的 16x16 像素集
            ——在 16-18px 时像素网格图标在 OS 窗口控件旁边
            读取为渲染伪像，而不是风格选择。 */}
        <button
          className="cth-titlebar-nodrag cth-tip"
          onClick={() => {
            if (fullscreenAgentId) { useStore.getState().setFullscreen(null); return; }
            const all = useStore.getState().agents;
            const target = all.find((x) => x.id === useStore.getState().selectedId && x.ptyId)
              ?? all.find((x) => x.isGod && x.ptyId)
              ?? all.find((x) => x.ptyId);
            if (target) useStore.getState().setFullscreen(target.id);
          }}
          data-tip={fullscreenAgentId ? t('app.exitFocusMode') : t('app.focusMode')}
          aria-label={t('app.toggleFocusMode')}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          {fullscreenAgentId ? <CollapseGlyph /> : <ExpandGlyph />}
        </button>

      </div>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        padding: 16,
        gap: 0
      }}>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
          <OfficeFloor />
          <MemoryPanel />
          {agentCount === 0 && godStatus === 'booting' && <MichaelBooting />}
          {agentCount === 0 && godStatus !== 'booting' && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none'
            }}>
              <div style={{ pointerEvents: 'auto', width: 360 }}>
                <PixelPanel variant="dialog" title={t('app.emptyFloorTitle')} noPadding>
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: '20px' }}>
                      {t('app.emptyFloorDesc')}
                    </p>
                    <PixelButton variant="primary" size="md" onClick={() => setAddAgentOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> {t('app.addAgent')}
                      </span>
                    </PixelButton>
                  </div>
                </PixelPanel>
              </div>
            </div>
          )}
        </div>

        <SidebarSplitter
          width={sidebarWidth}
          onChange={setSidebarWidth}
          viewportWidth={vpWidth}
        />

        <div style={{
          width: sidebarWidth, flexShrink: 0,
          minHeight: 0, display: 'flex', flexDirection: 'column'
        }}>
          {agent ? (
            <AgentDetailPanel agent={agent} />
          ) : godStatus === 'booting' ? (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>{t('app.wakingTheFloor')}</div>
              <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                {t('app.clockingIn', { name: bootingGodName })}<br />
                {t('app.terminalWillLand')}
              </p>
            </PixelPanel>
          ) : (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>{t('app.noAgentSelected')}</div>
              <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                {t('app.spawnFromStrip')}<br />
                {t('app.terminalAndCmdBar')}
              </p>
              <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> {t('app.addAgent')}
                </span>
              </PixelButton>
            </PixelPanel>
          )}
        </div>
      </div>

      <AgentStrip config={config} />

      {addAgentOpen && (
        <AddAgentModal
          onClose={closeAddAgentReview}
          config={config}
          onConfigChange={setConfig}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          initialSection={settingsSection}
          onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }}
        />
      )}

      {quitWarn && (
        <QuitWarningModal
          ptyCount={quitWarn.ptyCount}
          closing={closing}
          onCancel={() => {
            if (closing) cancelClosingTime();
            window.cth.cancelClose();
            setQuitWarn(null);
          }}
          onConfirm={async () => { await window.cth.confirmClose(); }}
          onClosingTime={startClosingTime}
        />
      )}

      {fullscreenAgentId && <FullscreenTerminal config={config} />}
      {ideOpen && <IdePanel />}
      <TaskDetailOverlay />
    </div>
  );
}

/* ── 标题栏图标 ────────────────────────────────────────────────────────
   在 16 单位框上绘制描边图标，继承 `currentColor` 以跟随主题，
   与像素集完全一致。故意不添加到
   components/Icon.tsx：该库是应用的像素艺术身份，用于标签和卡片
   比例，像素网格是重点。这三个图标位于
   OS 交通灯旁边，这是身份阅读模糊资产而非决策的唯一地方。 */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >{children}</svg>
  );
}

/** 四个向外角的括号——进入全屏。 */
function ExpandGlyph() {
  return (
    <Glyph>
      <path d="M6.2 3H3v3.2M9.8 3H13v3.2M6.2 13H3V9.8M9.8 13H13V9.8" />
    </Glyph>
  );
}

/** 相同的括号向内转——退出全屏。 */
function CollapseGlyph() {
  return (
    <Glyph>
      <path d="M3 6.2h3.2V3M13 6.2H9.8V3M3 9.8h3.2V13M13 9.8H9.8V13" />
    </Glyph>
  );
}

/** 一把扳手。之前的图标是一个有八条辐射辐条的轮毂，在
 *  18px 时与太阳无法区分——紧挨着一个主题
 *  切换按钮，其浅色模式图标就是一个太阳。工具形状传达"设置"
 *  而不与邻居竞争。在 24 框上绘制以保留曲线空间，
 *  渲染为 16px。 */
function GearGlyph() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M15.5 3.5a5 5 0 0 0-6.1 6.1l-5.6 5.6a2.3 2.3 0 1 0 3.2 3.2l5.6-5.6a5 5 0 0 0 6.1-6.1l-3 3-2.2-.6-.6-2.2z" />
    </svg>
  );
}
