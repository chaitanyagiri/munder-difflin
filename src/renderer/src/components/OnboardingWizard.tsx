import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon, type IconName } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { ProviderLogo } from './ProviderLogo';
import { AGENT_PROVIDER_PRESETS, modelsForProvider, type AgentProvider, type HarnessConfig } from '@/store/config';
import { canReceiveInbox, providerPreset } from '@shared/agentProvider';
import {
  classifyEngineAvailability, engineAvailabilityBadge, engineAvailabilityMessage, engineBlocksOnboarding
} from '@shared/engineAvailability';
import type { ToolStatus } from '@shared/toolCatalog';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';

export interface OnboardingWizardProps {
  onComplete: (config: HarnessConfig) => void;
}

type Audience = 'technical' | 'non-technical';
type Step = 'persona' | 'welcome' | 'home' | 'orchestrator' | 'repos' | 'permissions' | 'done';

// 首次运行的展示——一个全新用户在任何设置前就该掌握的最高价值功能。
// 标签和文案放在 i18n 里（两个语域：`desc` 面向技术受众，`descPlain`
// 面向平实语言受众——第 1 项）。
interface Feature {
  icon: IconName;
  labelKey: string;
  descKey: string;       // 技术语域
  descPlainKey: string;  // 非技术语域
  tint: string;          // 磁贴背景 token
  edge: string;          // 磁贴边框 token
}
const FEATURES: Feature[] = [
  {
    icon: 'mcp',
    labelKey: 'onboarding.welcome.features.engines.label',
    descKey: 'onboarding.welcome.features.engines.desc',
    descPlainKey: 'onboarding.welcome.features.engines.descPlain',
    tint: 'var(--cth-lilac-light)', edge: 'var(--cth-lilac)'
  },
  {
    icon: 'gear',
    labelKey: 'onboarding.welcome.features.clone.label',
    descKey: 'onboarding.welcome.features.clone.desc',
    descPlainKey: 'onboarding.welcome.features.clone.descPlain',
    tint: 'var(--cth-sky-light)', edge: 'var(--cth-sky)'
  },
  {
    icon: 'web',
    labelKey: 'onboarding.welcome.features.memory.label',
    descKey: 'onboarding.welcome.features.memory.desc',
    descPlainKey: 'onboarding.welcome.features.memory.descPlain',
    tint: 'var(--cth-mint-light)', edge: 'var(--cth-mint)'
  },
  {
    icon: 'terminal',
    labelKey: 'onboarding.welcome.features.commandCenter.label',
    descKey: 'onboarding.welcome.features.commandCenter.desc',
    descPlainKey: 'onboarding.welcome.features.commandCenter.descPlain',
    tint: 'var(--cth-lemon-light)', edge: 'var(--cth-lemon)'
  },
  {
    icon: 'pause',
    labelKey: 'onboarding.welcome.features.guardrails.label',
    descKey: 'onboarding.welcome.features.guardrails.desc',
    descPlainKey: 'onboarding.welcome.features.guardrails.descPlain',
    tint: 'var(--cth-coral-light)', edge: 'var(--cth-coral)'
  },
  {
    icon: 'sparkle',
    labelKey: 'onboarding.welcome.features.hires.label',
    descKey: 'onboarding.welcome.features.hires.desc',
    descPlainKey: 'onboarding.welcome.features.hires.descPlain',
    tint: 'var(--cth-peach-light)', edge: 'var(--cth-peach)'
  }
];

// 每个引擎的一句话简介，显示在 orchestrator 步骤对应行下方，
// 让非技术用户知道自己在选什么（第 3 项）。
const PROVIDER_BLURB_KEYS: Partial<Record<AgentProvider, string>> = {
  claude: 'onboarding.providerBlurb.claude',
  codex: 'onboarding.providerBlurb.codex',
  qwen: 'onboarding.providerBlurb.qwen'
};

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { t } = useTranslation();
  // Onboarding 运行时 god 尚未在 store 里，所以读取持久化的名字。
  const godName = useResolvedGodName();
  const [step, setStep] = useState<Step>('persona');
  // 自我识别的受众（第 1 项）。在第一屏做出选择前保持 undefined；
  // 向导其余部分读 `plain` 来切换文案语域。
  const [audience, setAudience] = useState<Audience | undefined>();
  const plain = audience === 'non-technical';

  const [home, setHome] = useState<string>('');
  const [repos, setRepos] = useState<string[]>([]);
  const [autoMode, setAutoMode] = useState<boolean>(true);
  // 匿名使用统计（TELEMETRY.md）。默认开启（opt-out）；由 finish()
  // 持久化，所以只要在完成前取消勾选，就什么都不会发送。
  const [shareStats, setShareStats] = useState<boolean>(true);
  const [godProvider, setGodProvider] = useState<AgentProvider>('claude');
  const [godModel, setGodModel] = useState<string | undefined>(
    providerPreset('claude').recommendedOrchestratorModel
  );
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // 这台机器上实际装有哪些引擎 CLI。选择器过去是盲记选择；第一次检查
  // 发生在 Michael spawn 时，对一个没有安装器的 provider 来说，那意味着
  // 首次运行什么都不曾启动。`undefined` = 探测还没回来（或失败）：
  // 行不显示徽章、什么都不被阻塞，因为一个坏掉的探测绝不能把新用户锁在外面。
  const [engines, setEngines] = useState<ToolStatus[] | undefined>();
  const [probing, setProbing] = useState(false);
  const probeEngines = async () => {
    setProbing(true);
    try { setEngines(await window.cth.toolsStatus()); }
    catch { /* 保持 undefined：未知，绝不阻塞 */ }
    finally { setProbing(false); }
  };
  useEffect(() => { void probeEngines(); }, []);
  const selectedEngine = classifyEngineAvailability(engines, godProvider);
  const engineBlocked = engineBlocksOnboarding(selectedEngine);

  // 权限与可靠性开关。这些在变更时 IMMEDIATELY 生效（它们各自的
  // IPC / OS 状态）——它们不属于 finish() 的 config 写入。首次运行默认值：
  // 通知关（config 默认）、登录项关（全新安装）；每一项都会与 IPC
  // 返回的真实状态对齐。
  const [strongKeepalive, setStrongKeepalive] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);

  const toggleStrongKeepalive = async (v: boolean) => {
    setStrongKeepalive(v); // 乐观更新
    try { setStrongKeepalive((await window.cth.updateConfig({ strongKeepalive: v })).strongKeepalive === true); }
    catch { setStrongKeepalive(!v); }
  };
  const toggleNotifications = async (v: boolean) => {
    setNotifications(v); // 乐观更新
    try { await window.cth.setNotifications(v); }
    catch { setNotifications(!v); } // 失败时回滚
  };
  const toggleOpenAtLogin = async (v: boolean) => {
    setOpenAtLogin(v); // 乐观更新
    try { setOpenAtLogin(await window.cth.setLoginItem(v)); } // 与 OS 真实状态对齐
    catch { setOpenAtLogin(!v); }
  };
  const openSettings = (url: string) => { void window.cth.openExternal(url); };

  // 首次渲染时默认建议一个合理的 harness home。
  //
  // 这里以前读 `window.process.env.HOME`，它在渲染器里 ALWAYS 是 undefined：
  // 窗口以 `contextIsolation: true` / `nodeIntegration: false` 运行，preload
  // 只桥接一个对象（`cth`），所以渲染器的主世界没有 `process`。因此这个
  // 建议总是塌缩成 ''，字段渲染为空——上方的文案承诺着一个用户无法接受的
  // 默认值，Finish 也以 "Pick a harness home folder first." 失败。
  //
  // 改为建议字面量 `~/HarnessAgents`。那正是 #140 的
  // normalizeHiveHome()/expandTilde() 生来就要吸收的字符串：它既在
  // config 写入边界展开、也在 ensureHarnessHome 的 mkdir 处展开，
  // 所以每个下游读者看到的仍是一个绝对路径。没有新增 IPC 表面。
  useEffect(() => {
    if (!home) setHome('~/HarnessAgents');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickHome = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setHome(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  const pickRepo = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok && !repos.includes(res.path)) setRepos([...repos, res.path]);
    else if (!res.ok && res.error !== 'cancelled') setError(res.error);
  };

  const removeRepo = (path: string) => setRepos(repos.filter(r => r !== path));

  const finish = async () => {
    setBusy(true);
    setError(undefined);
    const harnessHome = home.trim(); // 纯空白不算文件夹
    if (!harnessHome) { setError(t('onboarding.errPickHome')); setBusy(false); setStep('home'); return; }
    // orchestrator 步骤已经拒绝在此继续，但迟到的探测结果可以在用户
    // 前进之后改变答案。绝不写入一个已知无法启动的 godProvider。
    if (engineBlocked) {
      setError(t('onboarding.errEngineNotInstalled', { label: providerPreset(godProvider).label }));
      setBusy(false); setStep('orchestrator'); return;
    }
    const ensure = await window.cth.ensureHarnessHome(harnessHome);
    if (!ensure.ok) {
      setError(ensure.error ?? t('onboarding.errCreateHome'));
      setBusy(false);
      return;
    }
    const next = await window.cth.updateConfig({
      onboardingComplete: true,
      audience: audience ?? 'technical',
      harnessHome, // 就是我们刚 mkdir 过的同一修剪值，而非原始字段
      registeredRepos: repos,
      autoMode,
      godProvider,
      godModel,
      telemetryEnabled: shareStats
    });
    setBusy(false);
    onComplete(next);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-200)',
      backgroundImage:
        `repeating-linear-gradient(45deg, rgba(232, 217, 160, 0.4) 0 1px, transparent 1px 8px)`,
      // 滚动 overlay 而不是裁剪向导。第 2 步列出每个已安装的 CLI 引擎
      //（8 行 + 一个模型选择），减去 OS chrome 后比 1080p 级窗口还高——
      // 面板过去在 BOTH 边缘都被截断，按钮完全够不到。
      display: 'flex',
      overflowY: 'auto',
      zIndex: 200,
      padding: 32
    }}>
      {/* `margin: auto` 居中，不是 `align-items: center`。一个居中的 flex
          元素溢出容器时会在 TOP 被裁剪，而且滚动够不到它（溢出越过滚动
          原点溢出）；auto margin 在放得下时居中，放不下时塌缩成普通滚动。 */}
      <div style={{ width: 640, maxWidth: '94vw', margin: 'auto' }}>
        <PixelPanel
          variant="dialog"
          title={
            step === 'persona' ? t('onboarding.titles.persona')
            : step === 'welcome' ? t('onboarding.titles.welcome')
            : step === 'home' ? (plain ? t('onboarding.titles.homePlain') : t('onboarding.titles.home'))
            : step === 'orchestrator' ? (plain ? t('onboarding.titles.orchestratorPlain') : t('onboarding.titles.orchestrator'))
            : step === 'repos' ? (plain ? t('onboarding.titles.reposPlain') : t('onboarding.titles.repos'))
            : step === 'permissions' ? t('onboarding.titles.permissions')
            : t('onboarding.titles.done')
          }
          noPadding
        >
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '86vh', overflowY: 'auto' }}>

            {step === 'persona' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 56, height: 56, flexShrink: 0,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '18px' }}>
                      {t('onboarding.persona.headline')}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '19px' }}>
                      {t('onboarding.persona.body')}
                      <span style={{ color: 'var(--cth-ink-500)' }}>{t('onboarding.persona.bodyLocal')}</span>
                    </div>
                  </div>
                </div>

                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  {t('onboarding.persona.ask')}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <PersonaCard
                    icon="code"
                    title={t('onboarding.persona.technicalTitle')}
                    desc={t('onboarding.persona.technicalDesc')}
                    selected={audience === 'technical'}
                    onClick={() => { setAudience('technical'); setError(undefined); }}
                  />
                  <PersonaCard
                    icon="sparkle"
                    title={t('onboarding.persona.nonTechnicalTitle')}
                    desc={t('onboarding.persona.nonTechnicalDesc')}
                    selected={audience === 'non-technical'}
                    onClick={() => { setAudience('non-technical'); setError(undefined); }}
                  />
                </div>
              </>
            )}

            {step === 'welcome' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{
                    width: 56, height: 56, flexShrink: 0,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '18px'
                    }}>{t('onboarding.welcome.headline')}</div>
                    <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
                      {plain ? t('onboarding.welcome.descPlain') : t('onboarding.welcome.desc')}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {FEATURES.map((f) => (
                    <div key={f.labelKey} style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: 10,
                      background: f.tint,
                      boxShadow: `inset 0 0 0 2px ${f.edge}`
                    }}>
                      <div style={{
                        width: 28, height: 28, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--cth-paper-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                      }}>
                        <Icon name={f.icon} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 10, lineHeight: '14px', marginBottom: 3
                          // 这些标签是字面大写，以与兄弟标签一致，所以
                          // orchestrator 的名字也必须以大写形式到达。
                        }}>{t(f.labelKey, { godName: godName.toUpperCase() })}</div>
                        <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                          {plain ? t(f.descPlainKey) : t(f.descKey)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 'home' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {plain ? t('onboarding.home.descPlain') : t('onboarding.home.desc')}
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={home}
                    onChange={(e) => setHome(e.target.value)}
                    placeholder={t('onboarding.home.placeholder')}
                    style={inputStyle}
                  />
                  <PixelButton variant="secondary" size="md" onClick={pickHome}>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <Icon name="folder" /> {plain ? t('onboarding.home.createPick') : t('onboarding.home.pick')}
                    </span>
                  </PixelButton>
                </div>
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                  {plain ? t('onboarding.home.notePlain') : t('onboarding.home.note')}
                </div>
              </>
            )}

            {step === 'orchestrator' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {plain ? t('onboarding.orchestrator.descPlain') : t('onboarding.orchestrator.desc')}
                </p>

                {/* 什么是 CLI agent / 你的克隆——第 3 项 */}
                <div style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)'
                }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="sparkle" /></span>
                  <span>
                    {plain ? (
                      <Trans i18nKey="onboarding.orchestrator.cliAgentPlain" components={{ strong: <strong /> }}>
                        A <strong>CLI agent</strong> is an AI coding assistant that runs on your
                        computer — popular ones are Claude Code (Anthropic), Codex (OpenAI) and
                        Antigravity (Google Gemini). <strong>Your clone</strong> is the always-on
                        one that runs your whole office. We recommend Claude Code on Opus 4.8 (1M).
                        You can add or switch the others later.
                      </Trans>
                    ) : (
                      <Trans i18nKey="onboarding.orchestrator.cliAgent" components={{ strong: <strong /> }}>
                        Each option is a <strong>CLI engine</strong> (Claude Code, Codex,
                        Antigravity/Gemini, or a local proxy like Qwen). Engines marked
                        INSTALLED are already on this machine; INSTALLS ON FIRST RUN means the app
                        sets it up when Michael first starts.
                        <strong> Your clone</strong> (Michael) is the engine that orchestrates the whole
                        hive. Recommended: Claude Code · Opus 4.8 · 1M. Other providers can be wired
                        per agent later.
                      </Trans>
                    )}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id) || p.id === 'kimi').map((p) => {
                    const sel = godProvider === p.id;
                    return (
                      <label key={p.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px',
                        background: sel ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                        boxShadow: `inset 0 0 0 ${sel ? 2 : 1}px ${sel ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
                        cursor: 'pointer'
                      }}>
                        <input
                          type="radio"
                          name="godProvider"
                          value={p.id}
                          checked={sel}
                          onChange={() => {
                            setGodProvider(p.id);
                            // 把模型重置为新 provider 的推荐选择，让下面的
                            // 下拉框始终为所选引擎显示一个有效模型。
                            setGodModel(p.recommendedOrchestratorModel);
                          }}
                          style={{ width: 16, height: 16, flexShrink: 0 }}
                        />
                        <span style={{
                          width: 22, height: 22, flexShrink: 0, display: 'flex',
                          alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-900)'
                        }}>
                          <ProviderLogo provider={p.id} size={18} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 11 }}>
                            {p.label.toUpperCase()}
                          </span>
                          {PROVIDER_BLURB_KEYS[p.id] && (
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                              {t(PROVIDER_BLURB_KEYS[p.id]!)}
                            </span>
                          )}
                        </span>
                        {(() => {
                          const a = classifyEngineAvailability(engines, p.id);
                          const badge = a.state === 'installed' ? t('onboarding.orchestrator.badgeInstalled')
                            : a.state === 'installs-on-first-run' ? t('onboarding.orchestrator.badgeInstallsFirstRun')
                            : a.state === 'not-installable' ? t('onboarding.orchestrator.badgeNotInstalled') : null;
                          if (!badge) return null;
                          const bad = a.state === 'not-installable';
                          return (
                            <span title={a.path ?? undefined} style={{
                              fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                              background: a.state === 'installed' ? 'var(--cth-mint-light)' : bad ? 'var(--cth-paper-100)' : 'var(--cth-cream-200)',
                              color: bad ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                              fontFamily: 'var(--cth-font-display)', flexShrink: 0
                            }}>{badge}</span>
                          );
                        })()}
                        {p.id === 'claude' && (
                          <span style={{
                            fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                            background: 'var(--cth-lemon)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-display)', flexShrink: 0
                          }}>{t('onboarding.orchestrator.recommended')}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
                {engineBlocked && (
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                    fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                  }}>
                    <span>{t('onboarding.orchestrator.blockedMessage', { label: providerPreset(godProvider).label, godName: godName })}</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <PixelButton variant="secondary" size="sm" onClick={() => { void probeEngines(); }} disabled={probing}>
                        {probing ? t('onboarding.orchestrator.checking') : t('onboarding.orchestrator.checkAgain')}
                      </PixelButton>
                      {selectedEngine.docsUrl && (
                        <PixelButton variant="ghost" size="sm" onClick={() => { void window.cth.openExternal(selectedEngine.docsUrl!); }}>
                          {t('onboarding.orchestrator.installInstructions')}
                        </PixelButton>
                      )}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('onboarding.orchestrator.model')}</div>
                  <select
                    value={godModel ?? ''}
                    onChange={(e) => setGodModel(e.target.value || undefined)}
                    style={inputStyle}
                  >
                    {modelsForProvider(godProvider).map((m) => (
                      <option key={m.label} value={m.id ?? ''}>{m.label}</option>
                    ))}
                  </select>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                    {t('onboarding.orchestrator.modelNote')}
                  </div>
                </div>
              </>
            )}

            {step === 'repos' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {plain ? t('onboarding.repos.descPlain') : t('onboarding.repos.desc')}
                </p>
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  maxHeight: 200, overflowY: 'auto'
                }}>
                  {repos.length === 0 && (
                    <div style={{
                      padding: 12,
                      fontSize: 13,
                      color: 'var(--cth-ink-500)',
                      background: 'var(--cth-paper-200)',
                      textAlign: 'center'
                    }}>
                      {plain ? t('onboarding.repos.emptyPlain') : t('onboarding.repos.empty')}
                    </div>
                  )}
                  {repos.map((r) => (
                    <div key={r} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                    }}>
                      <Icon name="folder" />
                      <span style={{
                        flex: 1,
                        fontFamily: 'var(--cth-font-mono)', fontSize: 13,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>{r}</span>
                      <PixelButton variant="ghost" size="sm" onClick={() => removeRepo(r)}>
                        <Icon name="x" />
                      </PixelButton>
                    </div>
                  ))}
                </div>
                <PixelButton variant="secondary" size="md" onClick={pickRepo}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="plus" /> {plain ? t('onboarding.repos.addProject') : t('onboarding.repos.addRepo')}
                  </span>
                </PixelButton>
              </>
            )}

            {step === 'permissions' && (
              <>
                {/* AUTONOMY——由旧的"auto mode"步骤合并而来（第 5 项）。一个选择
                    映射到每个引擎的标志（第 6 项）：autoMode → claude
                    bypassPermissions / codex -a never -s danger-full-access（保留 sandbox），
                    等等；关 → 每个引擎的"先询问"默认值。 */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  {t('onboarding.permissions.autonomyHead')}
                </div>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: 12,
                  background: autoMode ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 2px ${autoMode ? 'var(--cth-mint)' : 'var(--cth-ink-500)'}`,
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={autoMode}
                    onChange={(e) => setAutoMode(e.target.checked)}
                    style={{ width: 18, height: 18, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px' }}>
                      {plain ? t('onboarding.permissions.autoLabelPlain') : t('onboarding.permissions.autoLabel')}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>
                      {plain
                        ? (autoMode ? t('onboarding.permissions.autoOnPlain') : t('onboarding.permissions.autoOffPlain'))
                        : (autoMode ? t('onboarding.permissions.autoOn') : t('onboarding.permissions.autoOff'))}
                    </div>
                  </div>
                </label>
                <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                  {plain ? t('onboarding.permissions.autoNotePlain') : t('onboarding.permissions.autoNote')}
                </div>

                <div style={{ height: 1, background: 'var(--cth-ink-300)', margin: '2px 0' }} />

                {/* RELIABILITY——让你离开时工作仍在持续。 */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  {t('onboarding.permissions.reliabilityHead')}
                </div>
                <p style={{ margin: 0, lineHeight: '20px', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                  {plain ? t('onboarding.permissions.reliabilityDescPlain') : t('onboarding.permissions.reliabilityDesc')}
                </p>

                <ToggleRow
                  icon="clock"
                  label={t('onboarding.permissions.keepAwake')}
                  desc={t('onboarding.permissions.keepAwakeDesc')}
                  on={strongKeepalive}
                  tint="var(--cth-mint-light)"
                  edge="var(--cth-mint)"
                  onChange={toggleStrongKeepalive}
                />

                <ToggleRow
                  icon="bell"
                  label={t('onboarding.permissions.notifications')}
                  desc={t('onboarding.permissions.notificationsDesc')}
                  on={notifications}
                  tint="var(--cth-peach-light)"
                  edge="var(--cth-peach)"
                  onChange={toggleNotifications}
                />

                <ToggleRow
                  icon="play"
                  label={t('onboarding.permissions.openAtLogin')}
                  desc={t('onboarding.permissions.openAtLoginDesc')}
                  on={openAtLogin}
                  tint="var(--cth-sky-light)"
                  edge="var(--cth-sky)"
                  onChange={toggleOpenAtLogin}
                />

                <ToggleRow
                  icon="info"
                  label={t('onboarding.permissions.shareStats')}
                  desc={t('onboarding.permissions.shareStatsDesc')}
                  on={shareStats}
                  tint="var(--cth-lemon-light)"
                  edge="var(--cth-lemon)"
                  onChange={() => setShareStats(!shareStats)}
                />

                {/* LEVER 4——仅指示：macOS 不让应用翻转 Energy，所以我们深链到该面板。 */}
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>
                  <span style={{
                    width: 28, height: 28, flexShrink: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                  }}>
                    <Icon name="gear" />
                  </span>
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', marginBottom: 3 }}>
                        {t('onboarding.permissions.stayAwake')}
                      </div>
                      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                        {t('onboarding.permissions.stayAwakeDesc')}
                      </div>
                    </div>
                    <PixelButton variant="secondary" size="sm"
                      onClick={() => openSettings('x-apple.systempreferences:com.apple.preference.battery')}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="arrow-right" /> {t('onboarding.permissions.openBattery')}
                      </span>
                    </PixelButton>
                  </div>
                </div>
              </>
            )}

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)',
                overflowWrap: 'anywhere'
              }}>{error}</div>
            )}

            {/* 页脚 / 导航 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <Dots step={step} />
              <div style={{ display: 'flex', gap: 8 }}>
                {step !== 'persona' && step !== 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep(prevStep(step))} disabled={busy}>
                    {t('common.back')}
                  </PixelButton>
                )}
                {step === 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep('persona')} disabled={busy}>
                    {t('common.back')}
                  </PixelButton>
                )}
                {step !== 'permissions' && (
                  <PixelButton
                    variant="primary"
                    size="md"
                    onClick={() => {
                      // 在这里校验 home 步骤。没有它，唯一的检查在 finish() 里，
                      // 于是空的字段会带你走完四步，然后把你弹回第 1 步才告诉你。
                      if (step === 'home' && !home.trim()) {
                        setError(t('onboarding.errPickHome'));
                        return;
                      }
                      // 引擎同理：在这里拒绝并显示理由，
                      // 而不是让一个无法启动的选择一路走到一个永不启动的 Michael。
                      if (step === 'orchestrator' && engineBlocked) {
                        setError(`${providerPreset(godProvider).label} 未安装。请安装它并按"重新检查"，或选择其它引擎。`);
                        return;
                      }
                      setError(undefined);
                      setStep(nextStep(step));
                    }}
                    disabled={(step === 'persona' && !audience) || (step === 'orchestrator' && engineBlocked)}
                  >
                    {step === 'welcome' ? t('onboarding.permissions.setItUp') : t('common.next')}
                  </PixelButton>
                )}
                {step === 'permissions' && (
                  <PixelButton variant="primary" size="md" onClick={finish} disabled={busy}>
                    {busy ? t('common.saving') : t('common.finish')}
                  </PixelButton>
                )}
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function PersonaCard({ icon, title, desc, selected, onClick }: {
  icon: IconName;
  title: string;
  desc: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', border: 'none',
        padding: 12, display: 'flex', flexDirection: 'column', gap: 6,
        background: selected ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
        boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${selected ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`
      }}
    >
      <span style={{
        width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <Icon name={icon} />
      </span>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-900)' }}>
        {title}
      </span>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
        {desc}
      </span>
    </button>
  );
}

function ToggleRow({ icon, label, desc, on, tint, edge, onChange }: {
  icon: IconName;
  label: string;
  desc: string;
  on: boolean;
  tint: string; // 开启时的背景 token
  edge: string; // 开启时的边框 token
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
      background: on ? tint : 'var(--cth-paper-100)',
      boxShadow: `inset 0 0 0 ${on ? 2 : 1}px ${on ? edge : 'var(--cth-ink-300)'}`,
      cursor: 'pointer'
    }}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, flexShrink: 0, marginTop: 5 }}
      />
      <span style={{
        width: 28, height: 28, flexShrink: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <Icon name={icon} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', marginBottom: 3 }}>
          {label}
        </span>
        <span style={{ display: 'block', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
          {desc}
        </span>
      </span>
    </label>
  );
}

function Dots({ step }: { step: Step }) {
  const order: Step[] = ['persona', 'welcome', 'home', 'orchestrator', 'repos', 'permissions'];
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {order.map((s) => (
        <span key={s} style={{
          width: 8, height: 8,
          background: s === step ? 'var(--cth-ink-900)' : 'var(--cth-cream-300)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </div>
  );
}

function nextStep(s: Step): Step {
  return s === 'persona' ? 'welcome'
    : s === 'welcome' ? 'home'
    : s === 'home' ? 'orchestrator'
    : s === 'orchestrator' ? 'repos'
    : s === 'repos' ? 'permissions'
    : 'done';
}
function prevStep(s: Step): Step {
  return s === 'permissions' ? 'repos'
    : s === 'repos' ? 'orchestrator'
    : s === 'orchestrator' ? 'home'
    : s === 'home' ? 'welcome'
    : s === 'welcome' ? 'persona'
    : 'persona';
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
