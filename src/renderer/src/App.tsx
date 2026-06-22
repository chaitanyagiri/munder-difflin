import { useEffect, useState } from 'react';
import { useStore, selectedAgent } from '@/store/store';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { useHive } from '@/hooks/useHive';
import { MemoryPanel } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { AddAgentModal } from '@/components/AddAgentModal';
import { MichaelBooting } from '@/components/MichaelBooting';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { HivePicker } from '@/components/HivePicker';
import { QuitWarningModal, type ClosingTimeState } from '@/components/QuitWarningModal';
import { SettingsModal } from '@/components/SettingsModal';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { acquireTerminal } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { TaskDetailOverlay } from '@/components/TaskDetailOverlay';
import { FullscreenFileEditor } from '@/components/FullscreenFileEditor';
import { useHoldOptionToTalk } from '@/freeflow/holdOption';
import brandLogo from '@brand/logo.png?url';

// Injected at build time from package.json (see electron.vite.config.ts).
declare const __APP_VERSION__: string;

export function App() {
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const fullscreenFilePath = useStore(s => s.fullscreenFilePath);
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const setSidebarWidth = useStore(s => s.setSidebarWidth);

  const [config, setConfig] = useState<HarnessConfig | null>(null);
  // Whether the user has passed the launch-time hive picker this session. Starts
  // true (skip the picker) right after a hive SWITCH — changeHome relaunches and
  // leaves a one-shot localStorage flag so we don't bounce back onto the picker for
  // the hive we just chose. Also set true on onboarding completion (below).
  const [hiveOpened, setHiveOpened] = useState<boolean>(() => {
    try {
      if (window.localStorage.getItem('cth.skipHivePickerOnce')) {
        window.localStorage.removeItem('cth.skipHivePickerOnce');
        return true;
      }
    } catch { /* localStorage unavailable — show the picker */ }
    return false;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [closing, setClosing] = useState<ClosingTimeState | null>(null);
  const [vpWidth, setVpWidth] = useState<number>(window.innerWidth);

  // Initial config load
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      setConfig(c);
      // Mirror the Free Flow flag into the store so the composer mic button shows
      // only when enabled (Settings keeps this in sync on save).
      useStore.getState().setFreeflowEnabled(!!c.freeflowEnabled);
      // Mirror boolean key-presence ONLY (never the key value) so the composer can
      // show the voice button disabled-with-tooltip when Free Flow is on but no
      // Groq key is set (Settings keeps this in sync on save).
      useStore.getState().setHasGroqKey(!!c.groqApiKey);
      // Mirror the active office theme so OfficeFloor renders it (gated on the
      // tvShowOffices flag; off = always the office). Settings keeps this synced.
      useStore.getState().setOfficeTheme(c.tvShowOffices ? (c.officeTheme ?? 'office') : 'office');
    });
    // Mirror BYOK OpenAI key presence (boolean only; the key never leaves main) so the
    // Realtime Michael voice toggle can gate on it. Lives in the secret broker, not
    // config — so fetch it rather than derive from c.
    window.cth.realtimeHasOpenAiKey().then(has => {
      if (!cancelled) useStore.getState().setHasOpenAiKey(has);
    });
    return () => { cancelled = true; };
  }, []);

  // Free Flow entry point B — hold-Option (⌥) to talk. In-renderer push-to-talk
  // for whichever agent the user is viewing; gated on the flag, terminal-safe
  // (solo-hold threshold, aborts on any other key). See freeflow/holdOption.ts.
  useHoldOptionToTalk();

  // Quit warning subscription
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // Shareable hires: a validated manifest arriving via the munderdifflin://
  // deep link (or file import) pre-fills the Add-Agent modal. Never spawns by itself.
  const setPendingHire = useStore(s => s.setPendingHire);
  useEffect(() => {
    const unsub = window.cth.onHireImport?.((m) => {
      setPendingHire(m);
      setAddAgentOpen(true);
    });
    // Pull anything that arrived before this subscription existed (cold-start
    // deep links; packaged renderers load too fast for push-on-load).
    void window.cth.drainPendingHires?.().then((queued) => {
      if (queued && queued.length > 0) {
        setPendingHire(queued[queued.length - 1]);
        setAddAgentOpen(true);
      }
    });
    return unsub;
  }, [setPendingHire, setAddAgentOpen]);
  useEffect(() => window.cth.onHireError?.((info) => {
    console.error('[hire] import failed:', info.error);
  }), []);

  // Closing-time progress: drives the quit dialog's "wrapping up" view. The
  // dialog stays up through the whole protocol; on 'complete' the main process
  // tears down and quits by itself moments later.
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

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking. Held
  // off until the user opens a hive in the launch picker (passing null no-ops the
  // hook) so Michael doesn't boot against the current home while the user may be
  // about to switch to a different one.
  useHive(hiveOpened ? config : null);

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents then re-attaches an already-rendered
  // terminal instantly (with full history) instead of building a blank one.
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // Synthetic demo loop — CAGED (#5B). It must never animate alongside a live
  // hive (it would fire fake envelope handoffs and step seeded agents). Run it
  // only as an explicit showcase (VITE_CTH_DEMO=1 in dev) or on a genuinely
  // empty floor, and stop it the instant the first real PTY agent appears
  // (Michael always spawns, so in normal operation it effectively never runs).
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

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // Track viewport width for splitter clamping
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.onboardingComplete) {
    // Just-onboarded users go straight into the hive they set up — skip the picker.
    return <OnboardingWizard onComplete={(next) => { setConfig(next); setHiveOpened(true); }} />;
  }

  // Launch-time hive picker: on reopen, let the user open their current hive,
  // switch to a recent one, or open/create another. Skipped right after onboarding
  // and right after a switch-relaunch (see hiveOpened init).
  if (!hiveOpened) {
    return <HivePicker config={config} onOpenCurrent={() => setHiveOpened(true)} />;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* Title bar */}
      <div
        className="cth-titlebar-drag"
        style={{
          height: 36, minHeight: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '2px solid var(--cth-ink-900)',
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
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 14,
          color: 'var(--cth-ink-500)'
        }}>
          v{__APP_VERSION__} · {config.autoMode ? 'auto mode on' : 'auto mode off'}
        </span>
        <button
          className="cth-titlebar-nodrag cth-settings-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-900)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          <Icon name="gear" size={1} style={{ width: 18, height: 18 }} />
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
                <PixelPanel variant="dialog" title="EMPTY FLOOR" noPadding>
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ margin: 0, fontSize: 14, lineHeight: '20px' }}>
                      No agents on the floor yet. Spawn one to see real claude output stream in here.
                    </p>
                    <PixelButton variant="primary" size="md" onClick={() => setAddAgentOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> add agent
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
              }}>WAKING THE FLOOR</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Michael is clocking in.<br />
                The terminal will land here once he's seated.
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
              }}>NO AGENT SELECTED</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Spawn an agent from the strip below.<br />
                The terminal and command bar will land here.
              </p>
              <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> add agent
                </span>
              </PixelButton>
            </PixelPanel>
          )}
        </div>
      </div>

      <AgentStrip config={config} />

      {addAgentOpen && (
        <AddAgentModal
          onClose={() => setAddAgentOpen(false)}
          config={config}
          onConfigChange={setConfig}
        />
      )}

      {settingsOpen && (
        <SettingsModal config={config} onClose={() => setSettingsOpen(false)} />
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

      {fullscreenAgentId && <FullscreenTerminal />}
      {fullscreenFilePath && <FullscreenFileEditor />}
      <TaskDetailOverlay />
    </div>
  );
}
