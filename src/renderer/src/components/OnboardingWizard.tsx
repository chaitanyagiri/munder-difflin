import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon, type IconName } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import { AGENT_PROVIDER_PRESETS, modelsForProvider, type AgentProvider, type HarnessConfig } from '@/store/config';
import { canReceiveInbox, providerPreset } from '@shared/agentProvider';

export interface OnboardingWizardProps {
  onComplete: (config: HarnessConfig) => void;
}

type Step = 'welcome' | 'home' | 'orchestrator' | 'repos' | 'auto' | 'permissions' | 'done';

// First-run showcase — the 4-6 highest-value features a brand-new user should
// understand before any setup. Kept to one scannable grid (not a manual).
interface Feature {
  icon: IconName;
  label: string;
  desc: string;
  tint: string; // tile background token
  edge: string; // tile border token
}
const FEATURES: Feature[] = [
  {
    icon: 'mcp',
    label: 'MULTI-PROVIDER HIVE',
    desc: 'Claude Code, Antigravity & Codex run as live agents in one shared office.',
    tint: 'var(--cth-lilac-light)', edge: 'var(--cth-lilac)'
  },
  {
    icon: 'gear',
    label: 'MICHAEL ORCHESTRATES',
    desc: 'An always-on GOD agent triages requests, routes tasks, and escalates only what needs you.',
    tint: 'var(--cth-sky-light)', edge: 'var(--cth-sky)'
  },
  {
    icon: 'web',
    label: 'LONG-TERM MEMORY',
    desc: 'Each agent keeps notes, mined into a shared, searchable MemPalace.',
    tint: 'var(--cth-mint-light)', edge: 'var(--cth-mint)'
  },
  {
    icon: 'terminal',
    label: 'COMMAND CENTER',
    desc: 'Terminal · Floor · Memory · Activity · Tasks · Schedules in one control surface.',
    tint: 'var(--cth-lemon-light)', edge: 'var(--cth-lemon)'
  },
  {
    icon: 'pause',
    label: 'GUARDRAILS',
    desc: 'Per-agent token budgets, a steer→constrain→stop circuit breaker, and human approvals.',
    tint: 'var(--cth-coral-light)', edge: 'var(--cth-coral)'
  },
  {
    icon: 'sparkle',
    label: 'READY-MADE HIRES',
    desc: 'Grab a pre-configured agent from the Agent Gallery and spawn it in one click.',
    tint: 'var(--cth-peach-light)', edge: 'var(--cth-peach)'
  }
];

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
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
            step === 'welcome' ? 'MEET YOUR OFFICE'
            : step === 'home' ? 'STEP 1 OF 5 · HARNESS HOME'
            : step === 'orchestrator' ? "STEP 2 OF 5 · MICHAEL'S ENGINE"
            : step === 'repos' ? 'STEP 3 OF 5 · YOUR REPOS'
            : step === 'auto' ? 'STEP 4 OF 5 · AUTO MODE'
            : step === 'permissions' ? 'STEP 5 OF 5 · PERMISSIONS & RELIABILITY'
            : 'ALL SET'
          }
          noPadding
        >
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

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
                      You run a hive of AI coding agents — coordinated, persistent, and watchable.
                      Here's what's inside:
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
                          {f.desc}
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
                  Pick a folder where the harness will keep its own files — agent metadata,
                  logs, and any new repos you create from here. Something like{' '}
                  <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                    ~/HarnessAgents
                  </code>{' '}
                  is a fine default. We'll create it if it doesn't exist.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={home}
                    onChange={(e) => setHome(e.target.value)}
                    placeholder="/path/to/HarnessAgents"
                    style={inputStyle}
                  />
                  <PixelButton variant="secondary" size="md" onClick={pickHome}>
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <Icon name="folder" /> pick
                    </span>
                  </PixelButton>
                </div>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  Think of this as the "town hall." The harness pins agent state there so
                  sessions can be picked back up after a restart.
                </div>
              </>
            )}

            {step === 'orchestrator' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  <strong>Michael</strong>, the orchestrator you just met, coordinates the whole floor —
                  he triages your requests, assigns tasks, and manages the team. Give him a
                  longer-context, higher-capability model.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id)).map((p) => (
                    <label key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px',
                      background: godProvider === p.id ? 'var(--cth-mint-light)' : 'var(--cth-paper-100)',
                      boxShadow: `inset 0 0 0 ${godProvider === p.id ? 2 : 1}px ${godProvider === p.id ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
                      cursor: 'pointer'
                    }}>
                      <input
                        type="radio"
                        name="godProvider"
                        value={p.id}
                        checked={godProvider === p.id}
                        onChange={() => {
                          setGodProvider(p.id);
                          setGodModel(p.recommendedOrchestratorModel);
                        }}
                        style={{ width: 16, height: 16, flexShrink: 0 }}
                      />
                      <span style={{ flex: 1, fontFamily: 'var(--cth-font-display)', fontSize: 11 }}>
                        {p.label.toUpperCase()}
                      </span>
                      {p.id === 'claude' && (
                        <span style={{
                          fontSize: 10, padding: '1px 5px', lineHeight: '16px',
                          background: 'var(--cth-lemon)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                          fontFamily: 'var(--cth-font-display)'
                        }}>RECOMMENDED</span>
                      )}
                    </label>
                  ))}
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
                </div>
              </>
            )}

            {step === 'repos' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  Add the existing repos you want claude agents to run on. Each one becomes
                  a room on the floor — multiple agents can live in the same repo. You can
                  add more later.
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
                      No repos added yet. Optional, but recommended.
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
                    <Icon name="plus" /> add a repo
                  </span>
                </PixelButton>
              </>
            )}

            {step === 'auto' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  Agents in the harness run <strong>unattended</strong>. By default, every
                  agent is spawned with{' '}
                  <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                    --permission-mode bypassPermissions
                  </code>{' '}
                  — meaning claude won't pause to ask you before file edits or shell commands.
                  This is the right default for the "control room" experience; it's also a
                  loaded foot-gun on production repos. Keep this on unless you have a reason
                  to babysit a specific agent.
                </p>
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
                    style={{ width: 18, height: 18 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px' }}>
                      AUTO MODE
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--cth-ink-700)' }}>
                      {autoMode ? 'Always on. Agents never pause for permission.' : 'Off. Each agent will prompt before running tools.'}
                    </div>
                  </div>
                </label>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  You can override this per agent in the Add Agent dialog — change the
                  command string to drop the flag.
                </div>
              </>
            )}

            {step === 'permissions' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  Your agents keep working on a schedule and in live terminals. The
                  harness already holds a light power blocker, but if your Mac fully
                  sleeps — lid closed or idle — those timers pause and{' '}
                  <strong>catch up the moment you're back</strong>. Nothing is lost; it
                  may just run late. These keep you in the loop and, optionally, keep
                  missions firing on time while you're away.
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
                {step !== 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep(prevStep(step))} disabled={busy}>
                    back
                  </PixelButton>
                )}
                {step !== 'permissions' && (
                  <PixelButton variant="primary" size="md" onClick={() => setStep(nextStep(step))}>
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
  const order: Step[] = ['welcome', 'home', 'orchestrator', 'repos', 'auto', 'permissions'];
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
  return s === 'welcome' ? 'home' : s === 'home' ? 'orchestrator' : s === 'orchestrator' ? 'repos' : s === 'repos' ? 'auto' : s === 'auto' ? 'permissions' : 'done';
}
function prevStep(s: Step): Step {
  return s === 'permissions' ? 'auto' : s === 'auto' ? 'repos' : s === 'repos' ? 'orchestrator' : s === 'orchestrator' ? 'home' : s === 'home' ? 'welcome' : 'welcome';
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
