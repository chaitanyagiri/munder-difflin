import { useEffect, useState, type CSSProperties } from 'react';
import { authTypeNeedsSecret as needsSecret } from '@shared/integrations';
import { PixelButton } from './PixelButton';
import {
  integrationsClient,
  slugify,
  type IntegrationAuthType,
  type IntegrationKind,
  type IntegrationRecord,
  type IntegrationRecordView,
  type IntegrationTemplate,
  type TestResult
} from '@/integrations/registryClient';

// Integrations configuration UI — Settings → Integrations. Conformed to Jim's
// spec v1 (hive/docs/integrations-spec.md) and styled to Pam's mockup
// (hive/docs/integrations-ui-mockup.html). Three views: the configured list, a
// pick-a-template gallery, and a configure-&-test step.
//
// All data flows through integrationsClient — never IPC directly.
//
// v1 worker model (Jim §4): the broker grants EVERY enabled integration to ALL
// workers; there is no per-integration worker scoping yet. So "which workers can
// use it" is surfaced as the usability gate — usable === enabled && hasSecret —
// rather than an editable per-integration picker. Per-worker scoping is a future
// extension; this reflection updates when Jim confirms that model.

type View = 'list' | 'gallery' | 'configure';

interface Draft {
  isNew: boolean;
  id: string;
  label: string;
  kind: IntegrationKind;
  baseUrl: string;
  authType: IntegrationAuthType;
  authHeader: string;
  enabled: boolean;
  hasSecret: boolean; // an existing stored secret (edit)
  createdAt: number;
  secret: string;     // write-only input buffer
}

const AUTH_LABEL: Record<IntegrationAuthType, string> = {
  none: 'None (public API)',
  bearer: 'Bearer token',
  header: 'Custom header',
  github: 'GitHub'
};
// Auth types a user may pick for a custom-REST integration.
const CUSTOM_AUTH: IntegrationAuthType[] = ['none', 'bearer', 'header'];

// UI-only brand glyphs (Jim's templates carry no glyph). Falls back to label initials.
const GLYPH: Record<string, { mono: string; bg: string }> = {
  github: { mono: 'Gh', bg: '#1A1320' },
  'custom-rest': { mono: '{}', bg: '#2E9E5B' }
};
function glyphFor(kind: string, label: string): { mono: string; bg: string } {
  return GLYPH[kind] ?? { mono: (label.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '··'), bg: '#6B5878' };
}

const dispLabel: CSSProperties = { fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-500)', textTransform: 'uppercase' };
const fieldLabel: CSSProperties = { ...dispLabel, color: 'var(--cth-ink-700)' };
const subText: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' };
const hint: CSSProperties = { fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' };
const inputStyle: CSSProperties = { width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)' };
const linkBtn: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start', fontSize: 12, color: 'var(--cth-ink-500)' };

function Glyph({ mono, bg, lg }: { mono: string; bg: string; lg?: boolean }) {
  const size = lg ? 48 : 40;
  return (
    <div style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg, color: '#fff', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)', fontFamily: 'var(--cth-font-display)', fontSize: lg ? 13 : 11 }}>{mono}</div>
  );
}

/** Is an integration actually usable by workers? (Jim §6 gate.) */
function usable(r: { enabled: boolean; authType: IntegrationAuthType; hasSecret: boolean }): boolean {
  return r.enabled && (!needsSecret(r.authType) || r.hasSecret);
}

function draftFromTemplate(t: IntegrationTemplate, now: number): Draft {
  return {
    isNew: true, id: slugify(t.idSuggestion || t.label), label: t.label, kind: t.kind,
    baseUrl: t.baseUrl, authType: t.authType, authHeader: t.authHeader ?? '',
    enabled: true, hasSecret: false, createdAt: now, secret: ''
  };
}
function draftFromRecord(r: IntegrationRecordView): Draft {
  return {
    isNew: false, id: r.id, label: r.label, kind: r.kind, baseUrl: r.baseUrl,
    authType: r.authType, authHeader: r.authHeader ?? '', enabled: r.enabled,
    hasSecret: r.hasSecret, createdAt: r.createdAt, secret: ''
  };
}

export function IntegrationsRegistry() {
  const [templates, setTemplates] = useState<IntegrationTemplate[]>([]);
  const [records, setRecords] = useState<IntegrationRecordView[]>([]);

  const [view, setView] = useState<View>('list');
  const [picked, setPicked] = useState<string>(''); // selected template idSuggestion in gallery
  const [draft, setDraft] = useState<Draft | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [cfgTest, setCfgTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [rowTest, setRowTest] = useState<Record<string, TestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 2400); };
  const refresh = async () => setRecords(await integrationsClient.list());

  useEffect(() => {
    let alive = true;
    (async () => {
      const [tpls, recs] = await Promise.all([integrationsClient.listTemplates(), integrationsClient.list()]);
      if (!alive) return;
      setTemplates(tpls); setRecords(recs);
    })();
    return () => { alive = false; };
  }, []);

  const goList = () => { setView('list'); setDraft(null); setPicked(''); setReplacing(false); setShowSecret(false); setCfgTest(null); setErr(''); };
  const startAdd = () => { setPicked(''); setErr(''); setView('gallery'); };
  const continueFromGallery = () => {
    const t = templates.find((x) => x.idSuggestion === picked);
    if (!t) return;
    setDraft(draftFromTemplate(t, Date.now())); setReplacing(false); setShowSecret(false); setCfgTest(null); setErr(''); setView('configure');
  };
  const startEdit = (r: IntegrationRecordView) => { setDraft(draftFromRecord(r)); setReplacing(false); setShowSecret(false); setCfgTest(null); setErr(''); setView('configure'); };

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const validate = (d: Draft): string | null => {
    if (!d.label.trim()) return 'Give it a label.';
    if (!slugify(d.id || d.label)) return 'Could not derive a valid id from the label.';
    if (d.kind === 'custom-rest') {
      const u = d.baseUrl.trim();
      if (!u) return 'Base URL is required.';
      if (!/^https:\/\//.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)) return 'Base URL must be https:// (or http://127.0.0.1 / localhost for a local target).';
    }
    if (d.authType === 'header' && !/^[A-Za-z0-9-]{1,64}$/.test(d.authHeader.trim())) return 'Header name must be 1–64 chars of A–Z, 0–9, or "-".';
    return null;
  };

  const recordFromDraft = (d: Draft, now: number): IntegrationRecord => {
    const id = slugify(d.id || d.label);
    return {
      id,
      label: d.label.trim(),
      kind: d.kind,
      baseUrl: d.baseUrl.trim(),
      authType: d.authType,
      authHeader: d.authType === 'header' ? d.authHeader.trim() : undefined,
      secretRef: needsSecret(d.authType) ? `int:${id}` : undefined,
      enabled: d.enabled,
      createdAt: d.isNew ? now : d.createdAt,
      updatedAt: now
    };
  };

  const onSave = async () => {
    if (!draft) return;
    const v = validate(draft);
    if (v) { setErr(v); return; }
    setBusy(true); setErr('');
    try {
      const secret = draft.secret.trim().length > 0 ? draft.secret : undefined;
      const res = await integrationsClient.save(recordFromDraft(draft, Date.now()), secret);
      if (!res.ok) { setErr(res.error || 'Could not save.'); return; }
      await refresh();
      flash(draft.isNew ? 'Integration added.' : 'Integration updated.');
      goList();
    } catch { setErr('Could not save.'); }
    finally { setBusy(false); }
  };

  const onRemove = async (r: IntegrationRecordView) => {
    setBusy(true);
    try { await integrationsClient.remove(r.id); setRowTest((m) => { const n = { ...m }; delete n[r.id]; return n; }); await refresh(); flash(`Removed “${r.label}”.`); }
    catch { flash('Could not remove.'); }
    finally { setBusy(false); }
  };

  const fmtTest = (t: TestResult) => t.ok ? `✓ Connected${t.status ? ` (${t.status})` : ''}` : `✕ ${t.error || 'Failed'}${t.status ? ` (${t.status})` : ''}`;

  const onTestRow = async (r: IntegrationRecordView) => {
    setTestingId(r.id);
    try { const res = await integrationsClient.test(r.id); setRowTest((m) => ({ ...m, [r.id]: res })); }
    catch { setRowTest((m) => ({ ...m, [r.id]: { ok: false, error: 'Test failed to run.' } })); }
    finally { setTestingId(null); }
  };
  const onTestCfg = async () => {
    if (!draft || draft.isNew) return;
    setTesting(true); setCfgTest(null);
    try { setCfgTest(await integrationsClient.test(draft.id)); }
    catch { setCfgTest({ ok: false, error: 'Test failed to run.' }); }
    finally { setTesting(false); }
  };

  // ───────────────────────── GALLERY ─────────────────────────
  if (view === 'gallery') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button type="button" onClick={goList} style={linkBtn}>← Integrations</button>
        <div>
          <div style={{ ...dispLabel, marginBottom: 4 }}>Pick a template</div>
          <span style={subText}>Choose what you’re connecting. The template sets the defaults. Pick <b>Custom REST</b> for anything not listed.</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {templates.map((t) => {
            const on = picked === t.idSuggestion;
            const g = glyphFor(t.kind, t.label);
            return (
              <button key={t.idSuggestion} type="button" onClick={() => setPicked(t.idSuggestion)} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: 10, textAlign: 'left', cursor: 'pointer', border: 'none',
                background: on ? 'var(--cth-lemon-light, #FFEC99)' : 'var(--cth-paper-100)',
                boxShadow: `inset 0 0 0 ${on ? 2 : 1}px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`
              }}>
                <Glyph mono={g.mono} bg={g.bg} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, lineHeight: '17px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>{t.label}</span>
                  <span style={hint}>{t.secretHelp || (t.kind === 'custom-rest' ? 'Any HTTP API' : '')}</span>
                </div>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <PixelButton variant="secondary" size="sm" onClick={goList}>cancel</PixelButton>
          <PixelButton variant="primary" size="sm" onClick={continueFromGallery} disabled={!picked}>continue →</PixelButton>
        </div>
      </div>
    );
  }

  // ───────────────────────── CONFIGURE ─────────────────────────
  if (view === 'configure' && draft) {
    const g = glyphFor(draft.kind, draft.label);
    const tpl = templates.find((t) => t.kind === draft.kind);
    const secretLabel = tpl?.secretLabel || 'Secret';
    const showSavedPill = !draft.isNew && draft.hasSecret && !replacing;
    const isUsable = usable(draft);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <button type="button" onClick={draft.isNew ? startAdd : goList} style={linkBtn}>{draft.isNew ? '← Templates' : '← Integrations'}</button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <Glyph mono={g.mono} bg={g.bg} lg />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, lineHeight: '18px', fontWeight: 600, color: 'var(--cth-ink-900)' }}>{tpl?.label ?? draft.kind}</span>
            <span style={hint}>{needsSecret(draft.authType) ? `Needs a ${secretLabel.toLowerCase()}` : 'Public API — no secret needed'}</span>
          </div>
        </div>

        {/* Label */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>Label</span>
          <input value={draft.label} onChange={(e) => patch({ label: e.target.value, ...(draft.isNew ? { id: slugify(e.target.value) } : {}) })} placeholder={`e.g. ${tpl?.label ?? 'My API'} (prod)`} style={inputStyle} />
          <span style={hint}>Shown in your list. Id: <code style={{ fontFamily: 'var(--cth-font-mono)' }}>{slugify(draft.id || draft.label) || '—'}</code>{draft.isNew ? '' : ' (fixed)'}</span>
        </label>

        {/* Base URL — editable for custom-rest, fixed for presets */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>Base URL</span>
          <input value={draft.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="https://api.example.com" readOnly={draft.kind !== 'custom-rest'} style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', opacity: draft.kind !== 'custom-rest' ? 0.7 : 1 }} />
          {draft.kind !== 'custom-rest' && <span style={hint}>Set by the {tpl?.label ?? 'preset'} template.</span>}
        </label>

        {/* Auth type — selectable only for custom-rest */}
        {draft.kind === 'custom-rest' ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 260 }}>
            <span style={fieldLabel}>Authentication</span>
            <select value={draft.authType} onChange={(e) => patch({ authType: e.target.value as IntegrationAuthType })} style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}>
              {CUSTOM_AUTH.map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
            </select>
          </label>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={fieldLabel}>Authentication</span>
            <span style={hint}>{AUTH_LABEL[draft.authType]} (set by template)</span>
          </div>
        )}

        {/* Custom header name (header auth only) */}
        {draft.authType === 'header' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 320 }}>
            <span style={fieldLabel}>Header name</span>
            <input value={draft.authHeader} onChange={(e) => patch({ authHeader: e.target.value })} placeholder="X-Api-Key" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
            <span style={hint}>The secret is sent as <code style={{ fontFamily: 'var(--cth-font-mono)' }}>{(draft.authHeader.trim() || 'X-Header')}: &lt;secret&gt;</code>.</span>
          </label>
        )}

        {/* Secret — WRITE-ONLY (separate setSecret IPC) */}
        {needsSecret(draft.authType) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={fieldLabel}>{secretLabel}</span>
            {showSavedPill ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: 'var(--cth-ink-500)', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: '6px 10px', letterSpacing: 2 }}>•••••••• saved</span>
                <PixelButton variant="secondary" size="sm" onClick={() => { setReplacing(true); setShowSecret(false); patch({ secret: '' }); }}>Replace key</PixelButton>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type={showSecret ? 'text' : 'password'} value={draft.secret} onChange={(e) => patch({ secret: e.target.value })} placeholder={`Paste your ${secretLabel.toLowerCase()}`} autoComplete="off" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
                  <PixelButton variant="secondary" size="sm" onClick={() => setShowSecret((s) => !s)} disabled={!draft.secret}>{showSecret ? 'hide' : 'show'}</PixelButton>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '7px 9px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100, var(--cth-ink-300))', ...hint }}>
                  🔒&nbsp;<span><b style={{ color: 'var(--cth-ink-700)' }}>Write-only.</b> Encrypted in the main process and never shown again. To change it, paste a new key — the old one can’t be read back.{!draft.isNew && draft.hasSecret ? ' Leave blank to keep the saved key.' : ''}</span>
                </div>
                {tpl?.secretHelp && <span style={hint}>{tpl.secretHelp}</span>}
              </>
            )}
          </div>
        )}

        {/* Enabled gate + worker availability */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={fieldLabel}>Availability</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PixelButton variant={draft.enabled ? 'primary' : 'secondary'} size="sm" onClick={() => patch({ enabled: !draft.enabled })}>{draft.enabled ? 'enabled' : 'disabled'}</PixelButton>
            <span style={hint}>{isUsable ? 'Available to all workers.' : needsSecret(draft.authType) && !(draft.hasSecret || draft.secret.trim()) ? 'Add a secret and enable to make it available.' : draft.enabled ? 'Ready once saved.' : 'Disabled — no worker can use it.'}</span>
          </div>
          <span style={hint}>v1 grants every enabled integration to all workers. Per-worker scoping is coming.</span>
        </div>

        {/* Test connection (saved integrations only — broker probes by id) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>Test connection</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <PixelButton variant="secondary" size="sm" onClick={() => { void onTestCfg(); }} disabled={draft.isNew || testing}>{testing ? 'testing…' : 'Test connection'}</PixelButton>
            {cfgTest && <span style={{ fontSize: 13, color: cfgTest.ok ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-danger, #6E1423)' }}>{fmtTest(cfgTest)}</span>}
          </div>
          <span style={hint}>{draft.isNew ? 'Save the integration first, then test the live connection.' : 'Runs a live read-only probe against the base URL with the stored secret.'}</span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {(err || note) && <span style={{ marginRight: 'auto', fontSize: 12, color: err ? 'var(--cth-danger, #6E1423)' : 'var(--cth-ink-500)' }}>{err || note}</span>}
          <PixelButton variant="secondary" size="sm" onClick={goList} disabled={busy}>cancel</PixelButton>
          <PixelButton variant="primary" size="sm" onClick={() => { void onSave(); }} disabled={busy}>{busy ? '…' : draft.isNew ? 'Save integration' : 'Save changes'}</PixelButton>
        </div>
      </div>
    );
  }

  // ───────────────────────── LIST (default) ─────────────────────────
  const usableCount = records.filter(usable).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={dispLabel}>Integrations</div>
          <span style={{ ...subText, maxWidth: 440 }}>Connect outside tools so your agents can read and act on them. Secrets are stored encrypted in the main process and never shown again.</span>
        </div>
        {records.length > 0 && <PixelButton variant="primary" size="sm" onClick={startAdd} disabled={busy || templates.length === 0}>+ add integration</PixelButton>}
      </div>

      {records.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-500)' }}>No integrations yet. Connect GitHub or a custom REST API so your agents can use it.</p>
          <PixelButton variant="primary" size="sm" onClick={startAdd} disabled={templates.length === 0}>+ add your first integration</PixelButton>
        </div>
      ) : (
        <>
          <span style={hint}>{records.length} integration{records.length === 1 ? '' : 's'} · {usableCount} available to workers</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {records.map((r) => {
              const g = glyphFor(r.kind, r.label);
              const tpl = templates.find((t) => t.kind === r.kind);
              const st = !r.enabled
                ? { dot: '○', color: 'var(--cth-ink-500)', text: 'Disabled' }
                : needsSecret(r.authType) && !r.hasSecret
                  ? { dot: '▲', color: 'var(--cth-danger, #6E1423)', text: 'Needs secret' }
                  : { dot: '●', color: 'var(--cth-mint-700, #1f7a4d)', text: 'Enabled' };
              const rt = rowTest[r.id];
              return (
                <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Glyph mono={g.mono} bg={g.bg} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>{r.label}</span>
                      <span style={hint}>{tpl?.label ?? r.kind} · <code style={{ fontFamily: 'var(--cth-font-mono)' }}>{r.baseUrl || '—'}</code></span>
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: st.color, whiteSpace: 'nowrap' }}><span style={{ fontSize: 10 }}>{st.dot}</span> {st.text}</span>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <PixelButton variant="secondary" size="sm" onClick={() => { void onTestRow(r); }} disabled={busy || testingId === r.id}>{testingId === r.id ? '…' : 'test'}</PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => startEdit(r)} disabled={busy}>edit</PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => { void onRemove(r); }} disabled={busy}>✕</PixelButton>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ ...hint, color: usable(r) ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-ink-500)' }}>
                      {usable(r) ? '✓ Available to all workers' : 'Not available to workers yet'}
                    </span>
                    {rt && <span style={{ fontSize: 12, color: rt.ok ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-danger, #6E1423)' }}>· {fmtTest(rt)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {note && <span style={subText}>{note}</span>}
    </div>
  );
}
