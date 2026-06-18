import { useState, useEffect, type CSSProperties } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { OfficeThemePicker } from './OfficeThemePicker';
import { McpDefaultsSettings } from './McpDefaultsSettings';

export interface SettingsModalProps {
  config: HarnessConfig;
  onClose: () => void;
}

/** Slack fields live on the main-process config; the renderer mirror type doesn't
 *  declare them yet (same as `notifications`), so read them off a widened view. */
type SlackConfig = HarnessConfig & {
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackPort?: number;
  webhookEnabled?: boolean;
  webhookSecret?: string;
  webhookPort?: number;
};

/** Pixel-aesthetic text input, mirroring AddAgentModal's inputStyle. */
const slackInputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 14,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

const slackLabelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};

/** The exact connect walkthrough shown behind the i icon. Steps 6 & 7 spell out
 *  the both-lists requirement: subscribe to message.channels / message.groups in
 *  BOTH "Subscribe to bot events" AND "Subscribe to events on behalf of users". */
const SLACK_CONNECT_STEPS = `Connect Munder Difflin to Slack

1. api.slack.com/apps -> Create New App -> From scratch. Name it
   "Munder Difflin" and pick your workspace.
2. Basic Information -> Signing Secret -> copy it into the
   "Signing secret" field here.
3. OAuth & Permissions -> Bot Token Scopes: add
     chat:write          (office replies in-thread)
     channels:history    (read public-channel messages)
     groups:history      (read private-channel messages)
   Install to workspace, then copy the Bot User OAuth Token
   (xoxb-...) into the "Bot token" field here.
4. Press Start (below) to launch the webhook and get your
   Request URL.
5. Event Subscriptions -> Enable Events -> Request URL: paste the
   Request URL from here and wait for Slack's green check (Verified).
6. Event Subscriptions -> "Subscribe to bot events": add
     message.channels
     message.groups
7. Event Subscriptions -> "Subscribe to events on behalf of users"
   (add the matching User Token Scope channels:history / groups:history
   first if Slack asks): add
     message.channels
     message.groups
8. Save Changes, reinstall if Slack prompts, then invite the bot
   to your channel:  /invite @MunderDifflin`;

/** The request/response contract shown behind the webhook i icon. `<endpoint>` is the
 *  public URL printed once the server starts; the secret/token go in headers so
 *  they stay out of URLs and access logs. */
const WEBHOOK_API_DOC = `Generic webhook API

Trigger work (POST <endpoint>):
  header  x-md-webhook-secret: <your secret>
  body    {"message": "do X for me", "title": "optional short title"}
  -> 200  {"ok": true, "token": "<capability token>", "taskId": "<card id>"}

Check status (GET <endpoint>):
  header  x-md-webhook-token: <token>     (or  ?token=<token>)
  -> 200  {"ok": true, "status": "todo|doing|blocked|done",
           "title": "...", "result": "<summary or null>"}

The secret authorizes new work; the returned token is a read-only handle to
that one task's status (it reveals nothing else). Keep both private. The
endpoint URL rotates every time you press Start.`;

/** Clear every renderer-side persisted key so a relaunch starts truly empty. */
function clearLocalState(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('cth.')) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch { /* noop */ }
}

type Section = 'General' | 'MCP' | 'Integrations' | 'Danger Zone';
const NAV_SECTIONS: Section[] = ['General', 'MCP', 'Integrations', 'Danger Zone'];

export function SettingsModal({ config, onClose }: SettingsModalProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>('General');

  // Change-home flow: null until the user picks a new folder, then the sub-modal
  // confirms move-vs-fresh. Pre-selects 'move' (recommended - keeps the data).
  const [changeHome, setChangeHome] = useState<string | null>(null);
  const [changeMode, setChangeMode] = useState<'move' | 'fresh'>('move');
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeErr, setChangeErr] = useState('');

  // `notifications` is an optional field on the main-process config; the renderer
  // mirror type may not declare it yet, so read it defensively.
  const [notifications, setNotifications] = useState<boolean>(
    (config as HarnessConfig & { notifications?: boolean }).notifications === true
  );

  const toggleNotifications = async () => {
    const next = !notifications;
    setNotifications(next); // optimistic
    try { await window.cth.setNotifications(next); }
    catch { setNotifications(!next); /* revert on failure */ }
  };

  // --- circuit-breaker config (Lane A #6 canonical fields, widened view) ---
  // Drives Jim's real breaker: floor-wide TOKEN budget (costCapTokens) + output-
  // token velocity ceiling (circuitBreaker.tokenVelocityPerMin). The token cap
  // replaced the old dollar cap as the user-facing budget.
  type BreakerCfgView = HarnessConfig & {
    costCapTokens?: number;
    circuitBreaker?: { tokenVelocityPerMin?: number; enabled?: boolean; hardStop?: boolean; repeatedToolLimit?: number; errorStormLimit?: number };
  };
  const breakerCfg = config as BreakerCfgView;
  const [agentBudget, setAgentBudget] = useState(breakerCfg.costCapTokens != null ? String(breakerCfg.costCapTokens) : '');
  const [velocityCeiling, setVelocityCeiling] = useState(breakerCfg.circuitBreaker?.tokenVelocityPerMin != null ? String(breakerCfg.circuitBreaker.tokenVelocityPerMin) : '');
  const [budgetNote, setBudgetNote] = useState('');
  const saveBudget = async () => {
    const tokens = agentBudget.trim() === '' ? undefined : Number(agentBudget);
    const vel = velocityCeiling.trim() === '' ? undefined : Number(velocityCeiling);
    await window.cth.updateConfig({
      costCapTokens: Number.isFinite(tokens as number) ? (tokens as number) : undefined,
      circuitBreaker: {
        ...(breakerCfg.circuitBreaker ?? {}),
        tokenVelocityPerMin: Number.isFinite(vel as number) ? (vel as number) : undefined
      }
    } as Partial<HarnessConfig>);
    setBudgetNote('saved');
    setTimeout(() => setBudgetNote(''), 1500);
  };
  const fmtBudgetTokens = (raw: string): string => {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return '';
    if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return String(n);
  };

  // --- Slack integration ---
  const slackCfg = config as SlackConfig;
  const [slackEnabled, setSlackEnabled] = useState(slackCfg.slackEnabled ?? false);
  const [slackSecret, setSlackSecret] = useState(slackCfg.slackSigningSecret ?? '');
  const [slackBotToken, setSlackBotToken] = useState(slackCfg.slackBotToken ?? '');
  const [slackChannel, setSlackChannel] = useState(slackCfg.slackChannelId ?? '');
  const [slackPort, setSlackPort] = useState(String(slackCfg.slackPort ?? 3847));
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackNote, setSlackNote] = useState('');
  // Whether the webhook server is currently live. Hydrated from main on open so
  // reopening Settings shows the true connection state + the persisted Request URL.
  const [running, setRunning] = useState(false);
  // Whether the connect-steps help panel is expanded.
  const [showSlackHelp, setShowSlackHelp] = useState(false);

  // --- Generic webhook + status API ---
  const [webhookEnabled, setWebhookEnabled] = useState(slackCfg.webhookEnabled ?? false);
  const [webhookSecret, setWebhookSecret] = useState(slackCfg.webhookSecret ?? '');
  const [webhookPort, setWebhookPort] = useState(String(slackCfg.webhookPort ?? 3849));
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookRunning, setWebhookRunning] = useState(false);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookNote, setWebhookNote] = useState('');
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [showWebhookHelp, setShowWebhookHelp] = useState(false);

  // ─── Knowledge Graph (enterprise multimodal context for agents) ───────────
  const [kgEnabled, setKgEnabled] = useState<boolean>(
    (config as HarnessConfig & { knowledgeGraph?: { enabled?: boolean } }).knowledgeGraph?.enabled === true
  );
  const [kgDocCount, setKgDocCount] = useState(0);
  const [kgBusy, setKgBusy] = useState(false);
  const [kgNote, setKgNote] = useState('');

  const refreshKgStatus = async () => {
    try { const s = await window.cth.kgStatus(); setKgDocCount(s.docCount); }
    catch { /* status unavailable */ }
  };

  const toggleKg = async () => {
    const next = !kgEnabled;
    setKgEnabled(next);
    try {
      await window.cth.updateConfig({ knowledgeGraph: { enabled: next } });
      if (next) await refreshKgStatus();
    } catch { setKgEnabled(!next); }
  };

  const addKgFiles = async () => {
    setKgBusy(true); setKgNote('');
    try {
      const res = await window.cth.kgAddFiles();
      if (!res.ok) { setKgNote(res.error === 'cancelled' ? '' : (res.error ?? 'failed')); return; }
      const added = res.results.filter((r) => r.ok).length;
      const failed = res.results.length - added;
      setKgNote(`added ${added} document${added === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
      await refreshKgStatus();
    } catch (e) { setKgNote(e instanceof Error ? e.message : String(e)); }
    finally { setKgBusy(false); }
  };

  // --- Free Flow (voice dictation → message queue) ---
  const setFreeflowEnabledStore = useStore((s) => s.setFreeflowEnabled);
  const setHasGroqKeyStore = useStore((s) => s.setHasGroqKey);
  const [freeflowEnabled, setFreeflowEnabled] = useState(slackCfg.freeflowEnabled ?? false);
  const [groqKey, setGroqKey] = useState(slackCfg.groqApiKey ?? '');
  const [freeflowModel, setFreeflowModel] = useState(slackCfg.freeflowModel ?? 'whisper-large-v3-turbo');
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [freeflowBusy, setFreeflowBusy] = useState(false);
  const [freeflowNote, setFreeflowNote] = useState('');

  // Re-seed every editable field from the on-disk config when the modal opens.
  // App's `config` prop is loaded once and never refreshed after a save, so
  // without this the saved budget / velocity / slack values show blank on reopen.
  useEffect(() => {
    let alive = true;
    window.cth.getConfig().then((c) => {
      if (!alive) return;
      const cc = c as BreakerCfgView & SlackConfig & { notifications?: boolean };
      setNotifications(cc.notifications === true);
      setAgentBudget(cc.costCapTokens != null ? String(cc.costCapTokens) : '');
      setVelocityCeiling(cc.circuitBreaker?.tokenVelocityPerMin != null ? String(cc.circuitBreaker.tokenVelocityPerMin) : '');
      setSlackEnabled(cc.slackEnabled ?? false);
      setSlackSecret(cc.slackSigningSecret ?? '');
      setSlackBotToken(cc.slackBotToken ?? '');
      setSlackChannel(cc.slackChannelId ?? '');
      setSlackPort(String(cc.slackPort ?? 3847));
      setWebhookEnabled(cc.webhookEnabled ?? false);
      setWebhookSecret(cc.webhookSecret ?? '');
      setWebhookPort(String(cc.webhookPort ?? 3849));
      const kgOn = (cc as { knowledgeGraph?: { enabled?: boolean } }).knowledgeGraph?.enabled === true;
      setKgEnabled(kgOn);
      setFreeflowEnabled(cc.freeflowEnabled ?? false);
      setGroqKey(cc.groqApiKey ?? '');
      setFreeflowModel(cc.freeflowModel ?? 'whisper-large-v3-turbo');
    }).catch(() => { /* keep prop-seeded values */ });
    window.cth.kgStatus().then((s) => { if (alive) setKgDocCount(s.docCount); })
      .catch(() => { /* status unavailable */ });
    // Hydrate live connection state + the persisted Request URL: the
    // tunnel URL lives in main, so reopening Settings while connected re-shows it.
    window.cth.slackStatus().then((s) => {
      if (!alive) return;
      setRunning(s.running);
      if (s.url) setTunnelUrl(s.url);
    }).catch(() => { /* status unavailable - assume not running */ });
    window.cth.webhookStatus().then((s) => {
      if (!alive) return;
      setWebhookRunning(s.running);
      if (s.url) setWebhookUrl(s.url);
    }).catch(() => { /* status unavailable - assume not running */ });
    return () => { alive = false; };
  }, []);

  /** Persist the current Slack inputs. Returns the resolved config patch. */
  const slackPatch = (enabled: boolean) => ({
    signingSecret: slackSecret,
    botToken: slackBotToken,
    channelId: slackChannel,
    port: Number(slackPort) || 3847,
    enabled
  });

  const saveSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      await window.cth.slackSetConfig(slackPatch(slackEnabled));
      setSlackNote('saved');
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const startSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      // Persist first so the server starts with the latest secret/port/channel.
      await window.cth.slackSetConfig(slackPatch(true));
      setSlackEnabled(true);
      const res = await window.cth.slackStart();
      if (res.ok) {
        setRunning(true);
        // Keep the last URL if this start returned none (tunnel hiccup) - don't blank it.
        if (res.url) setTunnelUrl(res.url);
        setSlackNote(res.url ? 'listening' : (res.error ?? 'started, but tunnel unavailable'));
      } else {
        setSlackNote(res.error ?? 'failed to start');
      }
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const stopSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    // Keep the last Request URL visible (greyed) after Stop.
    try { await window.cth.slackStop(); setRunning(false); setSlackNote('stopped'); }
    catch (e) { setSlackNote(e instanceof Error ? e.message : String(e)); }
    finally { setSlackBusy(false); }
  };

  // --- Generic webhook handlers ---
  const webhookPatch = (enabled: boolean) => ({
    secret: webhookSecret,
    port: Number(webhookPort) || 3849,
    enabled
  });

  const saveWebhook = async () => {
    setWebhookBusy(true); setWebhookNote('');
    try {
      await window.cth.webhookSetConfig(webhookPatch(webhookEnabled));
      setWebhookNote('saved');
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
  };

  /** Mint a fresh secret in main (256-bit) and show it for copying. */
  const generateWebhookSecret = async () => {
    setWebhookBusy(true); setWebhookNote('');
    try {
      const res = await window.cth.webhookGenerateSecret();
      if (res.ok && res.secret) { setWebhookSecret(res.secret); setShowWebhookSecret(true); setWebhookNote('new secret - copy it now'); }
      else setWebhookNote('could not generate secret');
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
  };

  const startWebhook = async () => {
    setWebhookBusy(true); setWebhookNote('');
    try {
      await window.cth.webhookSetConfig(webhookPatch(true));
      setWebhookEnabled(true);
      const res = await window.cth.webhookStart();
      if (res.ok) {
        setWebhookRunning(true);
        if (res.url) setWebhookUrl(res.url);
        setWebhookNote(res.url ? 'listening' : (res.error ?? 'started, but tunnel unavailable'));
      } else {
        setWebhookNote(res.error ?? 'failed to start');
      }
    } catch (e) {
      setWebhookNote(e instanceof Error ? e.message : String(e));
    } finally { setWebhookBusy(false); }
  };

  const stopWebhook = async () => {
    setWebhookBusy(true); setWebhookNote('');
    try { await window.cth.webhookStop(); setWebhookRunning(false); setWebhookNote('stopped'); }
    catch (e) { setWebhookNote(e instanceof Error ? e.message : String(e)); }
    finally { setWebhookBusy(false); }
  };

  const copyWebhookUrl = () => { void window.cth.copyToClipboard(webhookUrl); };
  const copyWebhookSecret = () => { void window.cth.copyToClipboard(webhookSecret); };
  const copyTunnel = () => { void window.cth.copyToClipboard(tunnelUrl); };

  // --- Free Flow handlers ---
  /** Persist Free Flow settings; main re-arms the global hotkey. Also mirror the
   *  flag into the store so the composer mic button appears/disappears live. */
  const saveFreeflow = async (enabledOverride?: boolean) => {
    const enabled = enabledOverride ?? freeflowEnabled;
    setFreeflowBusy(true); setFreeflowNote('');
    try {
      await window.cth.freeflowSetConfig({
        enabled,
        apiKey: groqKey,
        model: freeflowModel.trim() || 'whisper-large-v3-turbo'
      });
      setFreeflowEnabledStore(enabled);
      // Mirror boolean key-presence so the voice button enables/disables live
      // without an app restart (presence only — never the key value).
      setHasGroqKeyStore(!!groqKey.trim());
      setFreeflowNote('saved');
    } catch (e) {
      setFreeflowNote(e instanceof Error ? e.message : String(e));
    } finally { setFreeflowBusy(false); }
  };

  /** Toggle on/off and persist immediately so the change takes effect (and the
   *  global hotkey arms/disarms) without a separate Save click. */
  const toggleFreeflow = () => {
    const next = !freeflowEnabled;
    setFreeflowEnabled(next);
    void saveFreeflow(next);
  };

  const reset = async () => {
    setBusy(true);
    clearLocalState();
    // Wipes hive + palace, resets config, and relaunches into onboarding.
    // The app exits, so this never resolves - no need to clear `busy`.
    await window.cth.resetAll();
  };

  // --- Change home folder ---
  /** Pick a new folder, then open the move-vs-fresh sub-modal. */
  const pickNewHome = async () => {
    setChangeErr('');
    const res = await window.cth.chooseFolder();
    if (!res.ok) return; // cancelled - no-op
    setChangeMode('move'); // recommended default
    setChangeHome(res.path);
  };

  /** Apply the home-folder change. On success the app relaunches (never resolves);
   *  on failure we surface the error and the existing home keeps running. */
  const applyChangeHome = async () => {
    if (!changeHome) return;
    setChangeBusy(true); setChangeErr('');
    // Moving copies the hive (incl. its .git) + palace, so the new home owns the
    // same renderer-side roster - keep localStorage. A 'fresh' home starts empty,
    // so clear the renderer cache to match.
    if (changeMode === 'fresh') clearLocalState();
    try {
      const res = await window.cth.changeHome(changeHome, changeMode);
      if (!res.ok) { setChangeErr(res.error ?? 'Could not change the home folder.'); setChangeBusy(false); }
      // ok === true never returns (the process relaunches).
    } catch (e) {
      setChangeErr(e instanceof Error ? e.message : String(e));
      setChangeBusy(false);
    }
  };

  const rows: Array<[string, string]> = [
    ['Auto mode', config.autoMode ? 'on' : 'off'],
    ['Semantic memory', config.semanticMemory ? 'on' : 'off'],
    ['Command', config.defaultCommand]
  ];

  const modalTitle = changeHome
    ? 'CHANGE HOME FOLDER'
    : confirming
      ? 'RESET EVERYTHING?'
      : 'SETTINGS';

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 840, maxWidth: '92vw', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          filter: 'drop-shadow(4px 4px 0 rgba(26, 19, 32, 0.25))'
        }}
      >
        <PixelPanel
          variant="dialog"
          title={modalTitle}
          noPadding
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', maxHeight: '88vh' }}
        >
          {/* === Change home sub-modal === */}
          {changeHome ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>New home folder</span>
                <code style={{
                  fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 13,
                  color: 'var(--cth-ink-900)', wordBreak: 'break-all'
                }}>{changeHome}</code>
              </div>

              {/* Move vs. fresh - two selectable option rows; move is preselected. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  ['move', 'Move existing data (recommended)', "Copy this harness's hive (every agent, memory, task) and the semantic-memory palace into the new folder. The old folder is left untouched as a backup you can delete later."],
                  ['fresh', 'Start fresh', 'Point the harness at the new (empty) folder. Your existing data stays in the old folder, simply unused.']
                ] as const).map(([value, title, desc]) => {
                  const selected = changeMode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setChangeMode(value)}
                      disabled={changeBusy}
                      style={{
                        textAlign: 'left', cursor: changeBusy ? 'default' : 'pointer',
                        padding: '10px 12px', background: 'var(--cth-paper-100)', border: 'none',
                        boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${selected ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                        display: 'flex', flexDirection: 'column', gap: 3
                      }}
                    >
                      <span style={{
                        fontSize: 14, lineHeight: '20px',
                        color: 'var(--cth-ink-900)', fontWeight: selected ? 700 : 400
                      }}>
                        {selected ? '◉ ' : '○ '}{title}
                      </span>
                      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{desc}</span>
                    </button>
                  );
                })}
              </div>

              {changeErr && (
                <div style={{ fontSize: 13, lineHeight: '18px', color: '#6E1423' }}>{changeErr}</div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={() => { setChangeHome(null); setChangeErr(''); }} disabled={changeBusy}>
                  cancel
                </PixelButton>
                <PixelButton variant="primary" size="md" onClick={applyChangeHome} disabled={changeBusy}>
                  {changeBusy ? 'applying...' : (changeMode === 'move' ? 'move & restart' : 'switch & restart')}
                </PixelButton>
              </div>
            </div>

          /* === Reset confirmation screen === */
          ) : confirming ? (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{
                  width: 32, height: 32,
                  background: 'var(--cth-coral-light)',
                  boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0
                }}>
                  <Icon name="bell" />
                </div>
                <div style={{ flex: 1, fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                  This permanently erases all of Michael's memories and the entire hive,
                  and cannot be undone. Any running sessions will be terminated and the app
                  will relaunch into onboarding. Are you sure?
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
                  cancel
                </PixelButton>
                <PixelButton variant="destructive" size="md" onClick={reset} disabled={busy}>
                  {busy ? 'resetting...' : 'erase everything & restart'}
                </PixelButton>
              </div>
            </div>

          /* === Main two-pane settings layout === */
          ) : (
            <>
              <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

                {/* Left nav */}
                <div style={{
                  width: 160, flexShrink: 0,
                  display: 'flex', flexDirection: 'column',
                  borderRight: '2px solid var(--cth-ink-300)',
                  paddingTop: 8, paddingBottom: 8,
                  background: 'var(--cth-cream-200)'
                }}>
                  {NAV_SECTIONS.map((section) => {
                    const active = activeSection === section;
                    const isDanger = section === 'Danger Zone';
                    return (
                      <button
                        key={section}
                        type="button"
                        onClick={() => setActiveSection(section)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '10px 16px 8px',
                          border: 'none',
                          borderLeft: active ? '3px solid var(--cth-lemon)' : '3px solid transparent',
                          background: active ? 'var(--cth-ink-900)' : 'transparent',
                          color: active
                            ? 'var(--cth-cream-50)'
                            : isDanger
                              ? '#6E1423'
                              : 'var(--cth-ink-700)',
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 8,
                          lineHeight: '12px',
                          cursor: 'pointer',
                          letterSpacing: 0
                        }}
                      >
                        {section}
                      </button>
                    );
                  })}
                </div>

                {/* Right scrollable content pane */}
                <div style={{
                  flex: 1, overflowY: 'auto',
                  padding: '20px 24px',
                  display: 'flex', flexDirection: 'column', gap: 20
                }}>

                  {/* GENERAL */}
                  {activeSection === 'General' && (
                    <>
                      {/* Home folder */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          Home folder
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px', alignItems: 'center' }}>
                          <span style={{
                            flex: 1, color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                            fontFamily: 'var(--cth-font-mono, monospace)'
                          }}>{config.harnessHome ?? '—'}</span>
                          <PixelButton variant="secondary" size="sm" onClick={pickNewHome}>change...</PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Config rows */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          Configuration
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {rows.map(([label, value]) => (
                            <div key={label} style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px' }}>
                              <span style={{ width: 160, flexShrink: 0, color: 'var(--cth-ink-500)' }}>{label}</span>
                              <span style={{
                                color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                                fontFamily: label === 'Command' ? 'var(--cth-font-mono, monospace)' : undefined
                              }}>{value}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Desktop notifications toggle */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          Notifications
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Desktop notifications
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              Native toasts when an agent finishes or needs your input.
                            </span>
                          </div>
                          <PixelButton
                            variant={notifications ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleNotifications}
                          >
                            {notifications ? 'on' : 'off'}
                          </PixelButton>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Circuit breaker */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          Circuit breaker
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                            Guard against runaway spend. Blank = off. The breaker steers, then constrains, then stops an agent that crosses these.
                          </span>
                          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              floor token budget
                              <input
                                type="number" min="0" step="100000" value={agentBudget}
                                onChange={(e) => setAgentBudget(e.target.value)}
                                placeholder="e.g. 1000000"
                                style={{ ...slackInputStyle, width: 180 }}
                              />
                              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                                {fmtBudgetTokens(agentBudget) ? `= ${fmtBudgetTokens(agentBudget)} tokens` : 'total tokens across the floor'}
                              </span>
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...slackLabelStyle }}>
                              token velocity (tok/min)
                              <input
                                type="number" min="0" step="1000" value={velocityCeiling}
                                onChange={(e) => setVelocityCeiling(e.target.value)}
                                placeholder="e.g. 200000"
                                style={{ ...slackInputStyle, width: 180 }}
                              />
                            </label>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <PixelButton variant="secondary" size="sm" onClick={saveBudget}>save</PixelButton>
                            {budgetNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{budgetNote}</span>}
                          </div>
                        </div>
                      </div>

                      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

                      {/* Knowledge Graph — enterprise multimodal context for agents */}
                      <div>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
                        }}>
                          Knowledge Graph
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Enterprise knowledge base
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              Add your docs, images &amp; PDFs; agents query them on demand via the <code>kg</code> tool.
                            </span>
                          </div>
                          <PixelButton
                            variant={kgEnabled ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleKg}
                          >
                            {kgEnabled ? 'on' : 'off'}
                          </PixelButton>
                        </div>
                        {kgEnabled && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                            <PixelButton variant="secondary" size="sm" onClick={addKgFiles} disabled={kgBusy}>
                              {kgBusy ? 'adding…' : 'add files…'}
                            </PixelButton>
                            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                              {kgDocCount} document{kgDocCount === 1 ? '' : 's'} indexed
                            </span>
                            {kgNote && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{kgNote}</span>}
                          </div>
                        )}
                      </div>

                      {/* Office Theme — TV-show office maps (experimental; flag tvShowOffices, default off) */}
                      <OfficeThemePicker config={config} />
                    </>
                  )}

                  {/* MCP DEFAULTS */}
                  {activeSection === 'MCP' && (
                    <McpDefaultsSettings config={config} />
                  )}

                  {/* INTEGRATIONS */}
                  {activeSection === 'Integrations' && (
                    <>
                      {/* Slack integration */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          Slack
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Slack integration
                              {/* i - toggles the step-by-step connect guide. */}
                              <button
                                type="button"
                                aria-label="Show Slack connect steps"
                                aria-expanded={showSlackHelp}
                                onClick={() => setShowSlackHelp((v) => !v)}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                  width: 16, height: 16, padding: 0, cursor: 'pointer',
                                  border: 'none', borderRadius: '50%',
                                  background: showSlackHelp ? 'var(--cth-ink-700)' : 'var(--cth-ink-300)',
                                  color: showSlackHelp ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
                                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px'
                                }}
                              >i</button>
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              Pipe a Slack channel's messages straight into Michael's queue.
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {/* Connection status: clear, always-visible. */}
                            <span style={{
                              fontSize: 12, lineHeight: '16px',
                              color: running ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-ink-500)'
                            }}>
                              {running ? '● Connected' : '○ Not connected'}
                            </span>
                            <PixelButton
                              variant={slackEnabled ? 'primary' : 'secondary'}
                              size="sm"
                              onClick={() => setSlackEnabled((v) => !v)}
                            >
                              {slackEnabled ? 'on' : 'off'}
                            </PixelButton>
                          </div>
                        </div>

                        {/* Step-by-step connect guide. Includes the both-lists
                            bot-event subscription requirement (steps 6 & 7). */}
                        {showSlackHelp && (
                          <pre style={{
                            margin: 0, padding: 10, whiteSpace: 'pre-wrap',
                            background: 'var(--cth-paper-100)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '16px',
                            color: 'var(--cth-ink-700)'
                          }}>{SLACK_CONNECT_STEPS}</pre>
                        )}

                        {slackEnabled && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Signing secret + bot token side-by-side in the wider layout */}
                            <div style={{ display: 'flex', gap: 16 }}>
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                                <span style={slackLabelStyle}>Signing secret</span>
                                <input
                                  type="password"
                                  value={slackSecret}
                                  onChange={(e) => setSlackSecret(e.target.value)}
                                  placeholder="Slack app -> Basic Information -> Signing Secret"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                              {/* Bot token: stays in main; never leaves the main process. */}
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                                <span style={slackLabelStyle}>Bot token</span>
                                <input
                                  type="password"
                                  value={slackBotToken}
                                  onChange={(e) => setSlackBotToken(e.target.value)}
                                  placeholder="xoxb-..."
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                            </div>

                            <div style={{ display: 'flex', gap: 16 }}>
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                                <span style={slackLabelStyle}>Channel id (optional)</span>
                                <input
                                  value={slackChannel}
                                  onChange={(e) => setSlackChannel(e.target.value)}
                                  placeholder="C0123... or blank for any"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 100 }}>
                                <span style={slackLabelStyle}>Port</span>
                                <input
                                  type="number"
                                  value={slackPort}
                                  onChange={(e) => setSlackPort(e.target.value)}
                                  placeholder="3847"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                              </label>
                            </div>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              {/* Start disabled once connected; Stop only when running. */}
                              <PixelButton variant="primary" size="sm" onClick={startSlack} disabled={slackBusy || !slackSecret.trim() || running}>
                                {slackBusy ? '...' : running ? 'connected' : 'start'}
                              </PixelButton>
                              <PixelButton variant="secondary" size="sm" onClick={stopSlack} disabled={slackBusy || !running}>
                                stop
                              </PixelButton>
                              <PixelButton variant="ghost" size="sm" onClick={saveSlack} disabled={slackBusy}>
                                save
                              </PixelButton>
                              {slackNote && (
                                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{slackNote}</span>
                              )}
                            </div>

                            {/* Keep the Request URL visible while connected even after a
                                modal reopen; when stopped, show the last URL greyed
                                since Slack reuses it until the next Start. */}
                            {(running || tunnelUrl) && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: running ? 1 : 0.55 }}>
                                <span style={slackLabelStyle}>
                                  {running
                                    ? 'Request URL - paste into Slack Event Subscriptions'
                                    : 'last Request URL - Slack reuses it until you Stop'}
                                </span>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <input
                                    readOnly
                                    value={tunnelUrl}
                                    onFocus={(e) => e.currentTarget.select()}
                                    style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}
                                  />
                                  <PixelButton variant="secondary" size="sm" onClick={copyTunnel} disabled={!tunnelUrl}>copy</PixelButton>
                                </div>
                              </div>
                            )}

                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              In your Slack app: enable Event Subscriptions, add the{' '}
                              <code>message.channels</code> / <code>message.groups</code> bot event, set the
                              Request URL above, and reinstall to your workspace. The tunnel URL changes on every
                              restart, so re-paste it after pressing Start again.
                            </span>
                          </div>
                        )}
                      </div>

                      <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

                      {/* Generic webhook + status API */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          Webhook API
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Webhook API
                              <button
                                type="button"
                                aria-label="Show webhook API format"
                                aria-expanded={showWebhookHelp}
                                onClick={() => setShowWebhookHelp((v) => !v)}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                  width: 16, height: 16, padding: 0, cursor: 'pointer',
                                  border: 'none', borderRadius: '50%',
                                  background: showWebhookHelp ? 'var(--cth-ink-700)' : 'var(--cth-ink-300)',
                                  color: showWebhookHelp ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
                                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px'
                                }}
                              >i</button>
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              A secret-gated HTTP endpoint: POST to start work and get a token, GET the token for status.
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{
                              fontSize: 12, lineHeight: '16px',
                              color: webhookRunning ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-ink-500)'
                            }}>
                              {webhookRunning ? '● Connected' : '○ Not connected'}
                            </span>
                            <PixelButton
                              variant={webhookEnabled ? 'primary' : 'secondary'}
                              size="sm"
                              onClick={() => setWebhookEnabled((v) => !v)}
                            >
                              {webhookEnabled ? 'on' : 'off'}
                            </PixelButton>
                          </div>
                        </div>

                        {showWebhookHelp && (
                          <pre style={{
                            margin: 0, padding: 10, whiteSpace: 'pre-wrap',
                            background: 'var(--cth-paper-100)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '16px',
                            color: 'var(--cth-ink-700)'
                          }}>{WEBHOOK_API_DOC}</pre>
                        )}

                        {webhookEnabled && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Public surface warning. Loud, not buried. */}
                            <span style={{ fontSize: 12, lineHeight: '16px', color: '#6E1423' }}>
                              This opens a PUBLIC endpoint anyone with the secret can post to. It stays off until you press Start.
                            </span>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={slackLabelStyle}>Secret key</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                  type={showWebhookSecret ? 'text' : 'password'}
                                  value={webhookSecret}
                                  onChange={(e) => setWebhookSecret(e.target.value)}
                                  placeholder="press Generate, or paste your own"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                                <PixelButton variant="secondary" size="sm" onClick={() => setShowWebhookSecret((v) => !v)} disabled={!webhookSecret}>
                                  {showWebhookSecret ? 'hide' : 'show'}
                                </PixelButton>
                                <PixelButton variant="secondary" size="sm" onClick={copyWebhookSecret} disabled={!webhookSecret}>copy</PixelButton>
                                <PixelButton variant="ghost" size="sm" onClick={generateWebhookSecret} disabled={webhookBusy}>generate</PixelButton>
                              </div>
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 100 }}>
                              <span style={slackLabelStyle}>Port</span>
                              <input
                                type="number"
                                value={webhookPort}
                                onChange={(e) => setWebhookPort(e.target.value)}
                                placeholder="3849"
                                style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                              />
                            </label>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <PixelButton variant="primary" size="sm" onClick={startWebhook} disabled={webhookBusy || !webhookSecret.trim() || webhookRunning}>
                                {webhookBusy ? '...' : webhookRunning ? 'connected' : 'start'}
                              </PixelButton>
                              <PixelButton variant="secondary" size="sm" onClick={stopWebhook} disabled={webhookBusy || !webhookRunning}>
                                stop
                              </PixelButton>
                              <PixelButton variant="ghost" size="sm" onClick={saveWebhook} disabled={webhookBusy}>
                                save
                              </PixelButton>
                              {webhookNote && (
                                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{webhookNote}</span>
                              )}
                            </div>

                            {(webhookRunning || webhookUrl) && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: webhookRunning ? 1 : 0.55 }}>
                                <span style={slackLabelStyle}>
                                  {webhookRunning ? 'Endpoint URL - POST work / GET status here' : 'last endpoint URL - rotates on next Start'}
                                </span>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <input
                                    readOnly
                                    value={webhookUrl}
                                    onFocus={(e) => e.currentTarget.select()}
                                    style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}
                                  />
                                  <PixelButton variant="secondary" size="sm" onClick={copyWebhookUrl} disabled={!webhookUrl}>copy</PixelButton>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

                      {/* Free Flow (voice dictation) */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
                        }}>
                          Free Flow
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
                              Free Flow (voice dictation)
                            </span>
                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              Push-to-talk dictation: speak, and Groq Whisper drops the text into the queue composer.
                            </span>
                          </div>
                          <PixelButton
                            variant={freeflowEnabled ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={toggleFreeflow}
                            disabled={freeflowBusy}
                          >
                            {freeflowEnabled ? 'on' : 'off'}
                          </PixelButton>
                        </div>

                        {freeflowEnabled && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Groq API key — stored in main config, used only there. */}
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span style={slackLabelStyle}>Groq API key</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                  type={showGroqKey ? 'text' : 'password'}
                                  value={groqKey}
                                  onChange={(e) => setGroqKey(e.target.value)}
                                  placeholder="gsk_... (get a free key at console.groq.com)"
                                  style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                                />
                                <PixelButton variant="secondary" size="sm" onClick={() => setShowGroqKey((v) => !v)} disabled={!groqKey}>
                                  {showGroqKey ? 'hide' : 'show'}
                                </PixelButton>
                              </div>
                            </label>

                            {/* Model picker */}
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 280 }}>
                              <span style={slackLabelStyle}>Model</span>
                              <select
                                value={freeflowModel}
                                onChange={(e) => setFreeflowModel(e.target.value)}
                                style={{ ...slackInputStyle, fontFamily: 'var(--cth-font-mono)' }}
                              >
                                <option value="whisper-large-v3-turbo">whisper-large-v3-turbo (fast)</option>
                                <option value="whisper-large-v3">whisper-large-v3 (accurate)</option>
                              </select>
                            </label>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <PixelButton variant="ghost" size="sm" onClick={() => saveFreeflow()} disabled={freeflowBusy}>
                                save
                              </PixelButton>
                              {freeflowNote && (
                                <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{freeflowNote}</span>
                              )}
                            </div>

                            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                              Two ways to dictate: click the mic button above Send in the queue composer (click to record,
                              click again to transcribe), or — while viewing any agent's terminal — <strong>hold Option
                              (⌥)</strong> to talk and release to transcribe. Either way the text lands in the composer
                              draft for you to review before sending. macOS will ask for microphone permission the first
                              time you record.
                            </span>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {/* DANGER ZONE */}
                  {activeSection === 'Danger Zone' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                        color: '#6E1423'
                      }}>DANGER ZONE</div>
                      <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
                        Reset wipes Michael's memories, the entire hive (every agent, message,
                        task, and the board), the semantic-memory palace, and all settings -
                        then takes you back to onboarding.
                      </p>
                      <div>
                        <PixelButton variant="destructive" size="md" onClick={() => setConfirming(true)}>
                          reset &amp; start over
                        </PixelButton>
                      </div>
                    </div>
                  )}

                </div>
              </div>

              {/* Footer */}
              <div style={{
                borderTop: '2px solid var(--cth-ink-300)',
                padding: '10px 16px',
                display: 'flex', justifyContent: 'flex-end',
                background: 'var(--cth-cream-50)'
              }}>
                <PixelButton variant="secondary" size="md" onClick={onClose}>close</PixelButton>
              </div>
            </>
          )}
        </PixelPanel>
      </div>
    </div>
  );
}
