import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon, type IconName } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { ProviderLogo } from './ProviderLogo';
import { AGENT_PROVIDER_PRESETS, modelsForProvider, type AgentProvider, type HarnessConfig } from '@/store/config';
import { canReceiveInbox, providerPreset } from '@shared/agentProvider';

export interface OnboardingWizardProps {
  onComplete: (config: HarnessConfig) => void;
}

type Audience = 'technical' | 'non-technical';
type Step = 'persona' | 'welcome' | 'home' | 'orchestrator' | 'repos' | 'permissions' | 'done';

// First-run showcase — the highest-value features a brand-new user should grasp
// before any setup. Each carries a developer-register `desc` and a plain-language
// `descPlain` so the same grid speaks to both audiences (item 1).
interface Feature {
  icon: IconName;
  label: string;
  desc: string;       // technical register
  descPlain: string;  // non-technical register
  tint: string;       // tile background token
  edge: string;       // tile border token
}
const FEATURES: Feature[] = [
  {
    icon: 'mcp',
    label: 'MULTI-PROVIDER HIVE',
    desc: 'Claude Code, Antigravity & Codex run as live agents in one shared office.',
    descPlain: 'Use different AI assistants (Claude, Gemini, Codex) side by side in one shared office.',
    tint: 'var(--cth-lilac-light)', edge: 'var(--cth-lilac)'
  },
  {
    icon: 'gear',
    label: 'MICHAEL ORCHESTRATES',
    desc: 'An always-on GOD agent triages requests, routes tasks, and escalates only what needs you.',
    descPlain: 'A manager agent, Michael, takes your requests, hands work to the right agent, and only interrupts you when it matters.',
    tint: 'var(--cth-sky-light)', edge: 'var(--cth-sky)'
  },
  {
    icon: 'web',
    label: 'LONG-TERM MEMORY',
    desc: 'Each agent keeps notes, mined into a shared, searchable MemPalace.',
    descPlain: "Agents remember what they've done, so they don't start from scratch every time.",
    tint: 'var(--cth-mint-light)', edge: 'var(--cth-mint)'
  },
  {
    icon: 'terminal',
    label: 'COMMAND CENTER',
    desc: 'Terminal · Floor · Memory · Activity · Tasks · Schedules in one control surface.',
    descPlain: "One dashboard to watch the work, the agents' memory, tasks, and schedules.",
    tint: 'var(--cth-lemon-light)', edge: 'var(--cth-lemon)'
  },
  {
    icon: 'pause',
    label: 'GUARDRAILS',
    desc: 'Per-agent token budgets, a steer→constrain→stop circuit breaker, and human approvals.',
    descPlain: 'Spending limits and safety stops keep agents in check — and they can ask you before big actions.',
    tint: 'var(--cth-coral-light)', edge: 'var(--cth-coral)'
  },
  {
    icon: 'sparkle',
    label: 'READY-MADE HIRES',
    desc: 'Grab a pre-configured agent from the Agent Gallery and spawn it in one click.',
    descPlain: 'Hire a ready-made agent from the gallery in one click — no setup needed.',
    tint: 'var(--cth-peach-light)', edge: 'var(--cth-peach)'
  }
];

// One-liner of what each engine is, shown under its row on the orchestrator step
// so a non-technical user knows what they're picking (item 3).
const PROVIDER_BLURB: Partial<Record<AgentProvider, string>> = {
  claude: 'Claude Code — Anthropic',
  codex: 'Codex — OpenAI',
  antigravity: 'Antigravity — Google Gemini',
  qwen: 'Qwen — runs a local Qwen model on your machine'
};

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>('persona');
  // Self-identified audience (item 1). Undefined until chosen on the first screen;
  // the rest of the wizard reads `plain` to swap copy registers.
  const [audience, setAudience] = useState<Audience | undefined>();
  const plain = audience === 'non-technical';

  const [home, setHome] = useState<string>('');
  const [repos, setRepos] = useState<string[]>([]);
  const [autoMode, setAutoMode] = useState<boolean>(true);
  const [godProvider, setGodProvider] = useState<AgentProvider>('claude');
  const [godModel, setGodModel] = useState<string | undefined>(
    providerPreset('claude').recommendedOrchestratorModel
  );
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Permissions & reliability toggles. These apply IMMEDIATELY on change (their
  // own IPC / OS state) — they are NOT part of finish()'s config write. First-run
  // defaults: notifications off (config default), login-item off (fresh install);
  // each reconciles to the real state the IPC returns.
  const [strongKeepalive, setStrongKeepalive] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);

  const toggleStrongKeepalive = async (v: boolean) => {
    setStrongKeepalive(v); // optimistic
    try { setStrongKeepalive((await window.cth.updateConfig({ strongKeepalive: v })).strongKeepalive === true); }
    catch { setStrongKeepalive(!v); }
  };
  const toggleNotifications = async (v: boolean) => {
    setNotifications(v); // optimistic
    try { await window.cth.setNotifications(v); }
    catch { setNotifications(!v); } // revert on failure
  };
  const toggleOpenAtLogin = async (v: boolean) => {
    setOpenAtLogin(v); // optimistic
    try { setOpenAtLogin(await window.cth.setLoginItem(v)); } // reconcile to OS truth
    catch { setOpenAtLogin(!v); }
  };
  const openSettings = (url: string) => { void window.cth.openExternal(url); };

  // Default-suggest a sensible harness home on first render
  useEffect(() => {
    if (!home) {
      const homeDir = (window as any).process?.env?.HOME ?? '';
      // Without a HOME env in the renderer sandbox we fall back to a hint;
      // user can still pick whatever they want.
      setHome(homeDir ? `${homeDir}/HarnessAgents` : '');
    }
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
    if (!home) { setError('Pick a harness home folder first.'); setBusy(false); setStep('home'); return; }
    const ensure = await window.cth.ensureHarnessHome(home);
    if (!ensure.ok) {
      setError(ensure.error ?? 'could not create harness home');
      setBusy(false);
      return;
    }
    const next = await window.cth.updateConfig({
      onboardingComplete: true,
      audience: audience ?? 'technical',
      harnessHome: home,
      registeredRepos: repos,
      autoMode,
      godProvider,
      godModel
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
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
      padding: 32
    }}>
      <div style={{ width: 640, maxWidth: '94vw' }}>
        <PixelPanel
          variant="dialog"
          title={
            step === 'persona' ? 'WELCOME TO MUNDER DIFFLIN'
            : step === 'welcome' ? 'MEET YOUR OFFICE'
            : step === 'home' ? (plain ? 'STEP 1 OF 4 · A HOME FOR THE APP' : 'STEP 1 OF 4 · HARNESS HOME')
            : step === 'orchestrator' ? (plain ? 'STEP 2 OF 4 · YOUR MANAGER AGENT' : "STEP 2 OF 4 · MICHAEL'S ENGINE")
            : step === 'repos' ? (plain ? 'STEP 3 OF 4 · YOUR PROJECTS' : 'STEP 3 OF 4 · YOUR REPOS')
            : step === 'permissions' ? 'STEP 4 OF 4 · PERMISSIONS & RELIABILITY'
            : 'ALL SET'
          }
          noPadding
        >
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

            {step === 'persona' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 56, height: 56, flexShrink: 0,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '18px' }}>
                      RUN AN OFFICE OF AI AGENTS
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--cth-ink-700)', lineHeight: '19px' }}>
                      Munder Difflin lets you run an office of long-running, highly capable AI
                      agents that can take on almost any task. It uses the CLI agents you already
                      have and manages everything around them — their context, memory, tasks,
                      schedules, webhooks, environment, files, and integrations.
                      <span style={{ color: 'var(--cth-ink-500)' }}> (We call this harnessing your agents.)</span>
                    </div>
                  </div>
                </div>

                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  FIRST — WHO ARE YOU? (we'll tailor the setup)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <PersonaCard
                    icon="code"
                    title="I'M TECHNICAL"
                    desc="I write code or work in a terminal. Show me CLI commands, flags, and model ids."
                    selected={audience === 'technical'}
                    onClick={() => { setAudience('technical'); setError(undefined); }}
                  />
                  <PersonaCard
                    icon="sparkle"
                    title="I'M NON-TECHNICAL"
                    desc="I'm in marketing, sales, ops, or just starting out. Explain things in plain language."
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
                    boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '18px'
                    }}>A CONTROL ROOM FOR A TEAM OF AGENTS</div>
                    <div style={{ fontSize: 13, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
                      {plain
                        ? "Think of it as a small office of AI workers you manage from one screen. Here's what's inside:"
                        : "You run a hive of AI coding agents — coordinated, persistent, and watchable. Here's what's inside:"}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {FEATURES.map((f) => (
                    <div key={f.label} style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: 10,
                      background: f.tint,
                      boxShadow: `inset 0 0 0 2px ${f.edge}`
                    }}>
                      <div style={{
                        width: 28, height: 28, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--cth-paper-100)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
                      }}>
                        <Icon name={f.icon} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 10, lineHeight: '14px', marginBottom: 3
                        }}>{f.label}</div>
                        <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                          {plain ? f.descPlain : f.desc}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 'home' && (
              <>
                {plain ? (
                  <p style={{ margin: 0, lineHeight: '22px' }}>
                    Create a new, empty folder for the app to call home. Everything the app
                    remembers — its own settings and your agents' memory — is stored here.
                    Something like{' '}
                    <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                      ~/HarnessAgents
                    </code>{' '}
                    works well. We'll create it for you if it doesn't exist.
                  </p>
                ) : (
                  <p style={{ margin: 0, lineHeight: '22px' }}>
                    Pick a folder where the harness will keep its own files — agent metadata,
                    logs, and any new repos you create from here. Something like{' '}
                    <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                      ~/HarnessAgents
                    </code>{' '}
                    is a fine default. We'll create it if it doesn't exist.
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={home}
                    onChange={(e) => setHome(e.target.value)}
                    placeholder="/path/to/HarnessAgents"
                    style={inputStyle}
                  />
                  <PixelButton variant="secondary" size="md" onClick={pickHome}>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <Icon name="folder" /> {plain ? 'create / pick' : 'pick'}
                    </span>
                  </PixelButton>
                </div>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  {plain
                    ? "You won't need to open this folder day-to-day — it's just where the app keeps its notes so nothing is lost when you restart."
                    : 'Think of this as the "town hall." The harness pins agent state there so sessions can be picked back up after a restart.'}
                </div>
              </>
            )}

            {step === 'orchestrator' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {plain ? (
                    <><strong>Michael</strong> is the manager of your office — he reads your
                    requests, breaks them into tasks, and hands them to the right agent. Choose
                    which AI engine powers him.</>
                  ) : (
                    <><strong>Michael</strong>, the orchestrator you just met, coordinates the
                    whole floor — he triages your requests, assigns tasks, and manages the team.
                    Pick the engine and model that power him; give him a longer-context,
                    higher-capability model.</>
                  )}
                </p>

                {/* What is a CLI agent / GOD agent — item 3 */}
                <div style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)'
                }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="sparkle" /></span>
                  <span>
                    {plain ? (
                      <>A <strong>CLI agent</strong> is an AI coding assistant that runs on your
                      computer — popular ones are Claude Code (Anthropic), Codex (OpenAI) and
                      Antigravity (Google Gemini). The <strong>GOD agent</strong> is the always-on
                      manager that runs your whole office. We recommend Claude Code on Opus 4.8 (1M).
                      You can add or switch the others later.</>
                    ) : (
                      <>Each option is a <strong>CLI engine</strong> you have installed (Claude Code,
                      Codex, Antigravity/Gemini, or a local proxy like Qwen). The
                      <strong> GOD agent</strong> (Michael) is the orchestrator engine for the whole
                      hive. Recommended: Claude Code · Opus 4.8 · 1M — other providers can be wired
                      per agent later.</>
                    )}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => {
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
                            // Reset the model to the new provider's recommended pick so the
                            // dropdown below always shows a valid model for the chosen engine.
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
                          {PROVIDER_BLURB[p.id] && (
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                              {PROVIDER_BLURB[p.id]}
                            </span>
                          )}
                        </span>
                        {p.id === 'claude' && (
                          <span style={{
                            fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                            background: 'var(--cth-lemon)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                            fontFamily: 'var(--cth-font-display)', flexShrink: 0
                          }}>RECOMMENDED</span>
                        )}
                      </label>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>Model</div>
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
                    This only sets Michael's engine. You can run other providers per agent later.
                  </div>
                </div>
              </>
            )}

            {step === 'repos' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  {plain ? (
                    <>Add your <strong>projects</strong>. A project is simply a folder — it can hold
                    code, documents, notes, or any files you want your agents to work with. You can
                    create a brand-new folder or pick an existing one, and add more anytime.</>
                  ) : (
                    <>Add the repos you want your agents to work in. Each folder becomes a
                    <strong> project</strong> (a room on the floor) — multiple agents can share one.
                    You can add more later.</>
                  )}
                </p>
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  maxHeight: 200, overflowY: 'auto'
                }}>
                  {repos.length === 0 && (
                    <div style={{
                      padding: 12,
                      fontSize: 14,
                      color: 'var(--cth-ink-500)',
                      background: 'var(--cth-paper-200)',
                      textAlign: 'center'
                    }}>
                      {plain
                        ? 'No projects added yet. Optional — you can add one later.'
                        : 'No repos added yet. Optional, but recommended.'}
                    </div>
                  )}
                  {repos.map((r) => (
                    <div key={r} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                    }}>
                      <Icon name="folder" />
                      <span style={{
                        flex: 1,
                        fontFamily: 'var(--cth-font-mono)', fontSize: 14,
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
                    <Icon name="plus" /> {plain ? 'add a project' : 'add a repo'}
                  </span>
                </PixelButton>
              </>
            )}

            {step === 'permissions' && (
              <>
                {/* AUTONOMY — merged from the old "auto mode" step (item 5). One choice
                    that maps to each engine's flag (item 6): autoMode → claude
                    bypassPermissions / codex --dangerously-bypass-approvals-and-sandbox,
                    etc.; off → each engine's ask-first default. */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  HOW MUCH CAN AGENTS DO ON THEIR OWN?
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
                      {plain ? 'LET AGENTS WORK ON THEIR OWN' : 'WORK AUTONOMOUSLY (AUTO MODE)'}
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--cth-ink-700)' }}>
                      {plain
                        ? (autoMode
                            ? 'On. Agents carry out tasks without stopping to ask — the smoothest experience.'
                            : 'Off. Agents pause and ask you before changing files or running commands.')
                        : (autoMode
                            ? 'On. Agents never pause — Claude runs bypassPermissions, Codex bypasses approvals + sandbox, etc.'
                            : 'Off. Each agent asks before edits / shell commands (Claude default, codex -a untrusted, …).')}
                    </div>
                  </div>
                </label>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  {plain
                    ? 'Best when agents work in their own projects. You can change this later, including for individual agents.'
                    : 'The right default for the "control room" experience; a foot-gun on production repos. Override per agent in the Add Agent dialog.'}
                </div>

                <div style={{ height: 1, background: 'var(--cth-ink-300)', margin: '2px 0' }} />

                {/* RELIABILITY — keeping work firing while you're away. */}
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
                  KEEP THINGS RUNNING WHILE YOU'RE AWAY
                </div>
                <p style={{ margin: 0, lineHeight: '20px', fontSize: 13, color: 'var(--cth-ink-700)' }}>
                  {plain
                    ? 'Your agents keep working on a schedule and in live terminals, even when you step away. These settings keep you in the loop and keep things running.'
                    : 'Your agents keep working on a schedule and in live terminals. If your Mac fully sleeps those timers pause and catch up the moment you\'re back — nothing is lost, it may just run late.'}
                </p>

                <ToggleRow
                  icon="clock"
                  label="KEEP WORKING WHILE AWAY"
                  desc="Strong keep-alive: stops your Mac from sleeping while an agent is live, so schedules and terminals fire on time even when you step away. Uses more battery — best on power. Off by default."
                  on={strongKeepalive}
                  tint="var(--cth-mint-light)"
                  edge="var(--cth-mint)"
                  onChange={toggleStrongKeepalive}
                />

                <ToggleRow
                  icon="bell"
                  label="DESKTOP NOTIFICATIONS"
                  desc="Get pinged when an agent needs you or a terminal needs reviving — even while you're away. macOS asks permission the first time one fires."
                  on={notifications}
                  tint="var(--cth-peach-light)"
                  edge="var(--cth-peach)"
                  onChange={toggleNotifications}
                />

                <ToggleRow
                  icon="play"
                  label="OPEN AT LOGIN"
                  desc="Relaunch the harness after a reboot so scheduled missions resume on their own. No prompt — applies immediately."
                  on={openAtLogin}
                  tint="var(--cth-sky-light)"
                  edge="var(--cth-sky)"
                  onChange={toggleOpenAtLogin}
                />

                {/* LEVER 4 — instruction-only: macOS won't let the app flip Energy, so we deep-link the pane. */}
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10,
                  background: 'var(--cth-lemon-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>
                  <span style={{
                    width: 28, height: 28, flexShrink: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
                  }}>
                    <Icon name="gear" />
                  </span>
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', marginBottom: 3 }}>
                        STAY AWAKE ON POWER (MANUAL)
                      </div>
                      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
                        macOS only lets you set this one yourself. In Battery → Options,
                        turn on “Prevent automatic sleeping when the display is off” (on
                        power adapter) so timers keep firing with the display asleep.
                        Without a sleep-preventing setting the Mac still truly sleeps —
                        work survives and catches up on wake.
                      </div>
                    </div>
                    <PixelButton variant="secondary" size="sm"
                      onClick={() => openSettings('x-apple.systempreferences:com.apple.preference.battery')}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="arrow-right" /> open Battery settings
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
                fontSize: 14,
                color: 'var(--cth-ink-900)'
              }}>{error}</div>
            )}

            {/* Footer / nav */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <Dots step={step} />
              <div style={{ display: 'flex', gap: 8 }}>
                {step !== 'persona' && step !== 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep(prevStep(step))} disabled={busy}>
                    back
                  </PixelButton>
                )}
                {step === 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep('persona')} disabled={busy}>
                    back
                  </PixelButton>
                )}
                {step !== 'permissions' && (
                  <PixelButton
                    variant="primary"
                    size="md"
                    onClick={() => setStep(nextStep(step))}
                    disabled={step === 'persona' && !audience}
                  >
                    {step === 'welcome' ? 'set it up' : 'next'}
                  </PixelButton>
                )}
                {step === 'permissions' && (
                  <PixelButton variant="primary" size="md" onClick={finish} disabled={busy}>
                    {busy ? 'saving...' : 'finish'}
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
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
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
  tint: string; // background token when on
  edge: string; // border token when on
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
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
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
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
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
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 14,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
