import { useEffect, useState, type CSSProperties } from 'react';
import { PixelButton } from './PixelButton';
import {
  integrationsClient,
  type IntegrationDraft,
  type IntegrationEntry,
  type IntegrationGlyph,
  type IntegrationStatus,
  type IntegrationTemplate,
  type IntegrationWorker,
  type TestResult
} from '@/integrations/registryClient';

// Integrations configuration UI. Goal (per dispatch): CLEAN + EASY TO
// UNDERSTAND. Built against Pam's reference mockup
// (hive/docs/integrations-ui-mockup.html): a configured-integrations list, a
// two-step Add flow (pick a template -> configure & test), a write-only masked
// secret field, and per-row test-connection. The dispatch also requires showing
// which workers can use an integration, so a worker picker lives in the
// configure step (the mockup omits it; we adapt).
//
// All data flows through integrationsClient — this component never touches IPC
// directly, so it is unaffected when that client is wired to Jim's registry.

type View = 'list' | 'gallery' | 'configure';

const dispLabel: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};
const fieldLabel: CSSProperties = { ...dispLabel, color: 'var(--cth-ink-700)' };
const subText: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' };
const hint: CSSProperties = { fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' };
const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)'
};

const STATUS_META: Record<IntegrationStatus, { dot: string; color: string; text: string }> = {
  ok: { dot: '●', color: 'var(--cth-mint-700, #1f7a4d)', text: 'Connected' },
  error: { dot: '▲', color: 'var(--cth-danger, #6E1423)', text: 'Auth failed' },
  untested: { dot: '○', color: 'var(--cth-ink-500)', text: 'Not tested' }
};

function Glyph({ glyph, lg }: { glyph: IntegrationGlyph; lg?: boolean }) {
  const size = lg ? 48 : 40;
  return (
    <div style={{
      width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: glyph.bg, color: '#fff', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
      fontFamily: 'var(--cth-font-display)', fontSize: lg ? 13 : 11
    }}>{glyph.mono}</div>
  );
}

function blankDraft(templateId: string): IntegrationDraft {
  return { label: '', templateId, fields: {}, secret: '', workers: [] };
}
function draftFromEntry(entry: IntegrationEntry): IntegrationDraft {
  // Write-only: secret starts empty and is never pulled back.
  return { id: entry.id, label: entry.label, templateId: entry.templateId, fields: { ...entry.fields }, secret: '', workers: [...entry.workers] };
}

export function IntegrationsRegistry() {
  const [templates, setTemplates] = useState<IntegrationTemplate[]>([]);
  const [workers, setWorkers] = useState<IntegrationWorker[]>([]);
  const [entries, setEntries] = useState<IntegrationEntry[]>([]);

  const [view, setView] = useState<View>('list');
  const [picked, setPicked] = useState<string>(''); // selected template id in the gallery
  const [draft, setDraft] = useState<IntegrationDraft | null>(null);
  const [replacing, setReplacing] = useState(false); // edit: user chose to swap the saved secret
  const [showSecret, setShowSecret] = useState(false);
  const [draftTest, setDraftTest] = useState<TestResult | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 2400); };
  const refresh = async () => setEntries(await integrationsClient.list());
  const templateOf = (id: string) => templates.find((t) => t.id === id);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [tpls, wkrs, list] = await Promise.all([
        integrationsClient.listTemplates(), integrationsClient.listWorkers(), integrationsClient.list()
      ]);
      if (!alive) return;
      setTemplates(tpls); setWorkers(wkrs); setEntries(list);
    })();
    return () => { alive = false; };
  }, []);

  const editing = draft?.id != null;
  const editEntry = editing ? entries.find((e) => e.id === draft?.id) : undefined;
  const activeTemplate = draft ? templateOf(draft.templateId) : undefined;
  // Show the masked "saved" state only while editing an entry that has a secret
  // and the user hasn't chosen to replace it.
  const showSavedPill = !!(editing && editEntry?.hasSecret && !replacing);

  const goList = () => {
    setView('list'); setDraft(null); setPicked(''); setReplacing(false);
    setShowSecret(false); setDraftTest(null);
  };
  const startAdd = () => { setPicked(''); setView('gallery'); };
  const continueFromGallery = () => {
    if (!picked) return;
    setDraft(blankDraft(picked)); setReplacing(false); setShowSecret(false); setDraftTest(null); setView('configure');
  };
  const startEdit = (entry: IntegrationEntry) => {
    setDraft(draftFromEntry(entry)); setReplacing(false); setShowSecret(false); setDraftTest(null); setView('configure');
  };

  const setField = (key: string, value: string) =>
    setDraft((d) => (d ? { ...d, fields: { ...d.fields, [key]: value } } : d));
  const toggleWorker = (id: string) =>
    setDraft((d) => {
      if (!d) return d;
      const has = d.workers.includes(id);
      return { ...d, workers: has ? d.workers.filter((w) => w !== id) : [...d.workers, id] };
    });

  /** Secret to send: only when the user actually typed one (write-only). */
  const draftPayload = (d: IntegrationDraft): IntegrationDraft => ({
    ...d, label: d.label.trim(),
    secret: d.secret && d.secret.length > 0 ? d.secret : undefined
  });

  const onTestDraft = async () => {
    if (!draft) return;
    setTestingDraft(true); setDraftTest(null);
    try { setDraftTest(await integrationsClient.testDraft(draftPayload(draft))); }
    catch { setDraftTest({ ok: false, message: 'Test failed to run.' }); }
    finally { setTestingDraft(false); }
  };
  const onSave = async () => {
    if (!draft) return;
    if (!draft.label.trim()) { flash('Give it a label first.'); return; }
    setBusy(true);
    try {
      await integrationsClient.save(draftPayload(draft));
      await refresh();
      flash(editing ? 'Integration updated.' : 'Integration added.');
      goList();
    } catch { flash('Could not save.'); }
    finally { setBusy(false); }
  };
  const onRemove = async (entry: IntegrationEntry) => {
    setBusy(true);
    try { await integrationsClient.remove(entry.id); await refresh(); flash(`Removed “${entry.label}”.`); }
    catch { flash('Could not remove.'); }
    finally { setBusy(false); }
  };
  const onTestRow = async (entry: IntegrationEntry) => {
    setTestingId(entry.id);
    try { const r = await integrationsClient.test(entry.id); await refresh(); flash(r.message); }
    catch { flash('Test failed to run.'); }
    finally { setTestingId(null); }
  };

  // ───────────────────────── GALLERY ─────────────────────────
  if (view === 'gallery') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button type="button" onClick={goList} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start', fontSize: 12, color: 'var(--cth-ink-500)' }}>← Integrations</button>
        <div>
          <div style={{ ...dispLabel, marginBottom: 4 }}>Pick a template</div>
          <span style={subText}>Choose what you’re connecting. The template decides which fields and scopes are requested. Pick <b>Custom REST</b> for anything not listed.</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {templates.map((t) => {
            const on = picked === t.id;
            return (
              <button key={t.id} type="button" onClick={() => setPicked(t.id)} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: 10, textAlign: 'left', cursor: 'pointer', border: 'none',
                background: on ? 'var(--cth-lemon-light, #FFEC99)' : 'var(--cth-paper-100)',
                boxShadow: `inset 0 0 0 ${on ? 2 : 1}px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`
              }}>
                <Glyph glyph={t.glyph} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, lineHeight: '17px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>{t.label}</span>
                  <span style={hint}>{t.description}</span>
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
  if (view === 'configure' && draft && activeTemplate) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <button type="button" onClick={editing ? goList : startAdd} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start', fontSize: 12, color: 'var(--cth-ink-500)' }}>
          {editing ? '← Integrations' : '← Templates'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <Glyph glyph={activeTemplate.glyph} lg />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, lineHeight: '18px', fontWeight: 600, color: 'var(--cth-ink-900)' }}>{activeTemplate.label}</span>
            <span style={hint}>{activeTemplate.description} · needs a {activeTemplate.secretLabel.toLowerCase()}</span>
          </div>
        </div>

        {/* Label */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>Label</span>
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder={`e.g. ${activeTemplate.label} (prod)`} style={inputStyle} />
          <span style={hint}>A friendly name shown in your integrations list. You can have more than one {activeTemplate.label} connection.</span>
        </label>

        {/* Non-secret fields */}
        {activeTemplate.fields.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={fieldLabel}>{f.label}{f.optional ? ' (optional)' : ''}</span>
            <input value={draft.fields[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.placeholder} style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
          </label>
        ))}

        {/* Secret — WRITE-ONLY */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>{activeTemplate.secretLabel}</span>
          {showSavedPill ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: 'var(--cth-ink-500)', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: '6px 10px', letterSpacing: 2 }}>•••••••• saved</span>
              <PixelButton variant="secondary" size="sm" onClick={() => { setReplacing(true); setShowSecret(false); setDraft({ ...draft, secret: '' }); }}>Replace key</PixelButton>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={draft.secret ?? ''}
                  onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                  placeholder={`Paste your ${activeTemplate.secretLabel.toLowerCase()}`}
                  autoComplete="off"
                  style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                />
                <PixelButton variant="secondary" size="sm" onClick={() => setShowSecret((v) => !v)} disabled={!draft.secret}>
                  {showSecret ? 'hide' : 'show'}
                </PixelButton>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '7px 9px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100, var(--cth-ink-300))', ...hint }}>
                🔒&nbsp;<span><b style={{ color: 'var(--cth-ink-700)' }}>Write-only.</b> Stored encrypted in the main process and never displayed again after you save. To change it later, paste a new key — there’s no way to read the old one back.{editing && editEntry?.hasSecret ? ' Leave blank to keep the saved key.' : ''}</span>
              </div>
            </>
          )}
        </div>

        {/* Workers (dispatch requirement) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>Workers that can use it</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {workers.length === 0 && <span style={hint}>no workers available</span>}
            {workers.map((w) => {
              const on = draft.workers.includes(w.id);
              return (
                <button key={w.id} type="button" onClick={() => toggleWorker(w.id)} style={{
                  padding: '2px 8px', border: 'none', cursor: 'pointer', fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-900)',
                  background: on ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`
                }}>{on ? '✓ ' : ''}{w.label}</button>
              );
            })}
          </div>
          <span style={hint}>Only the selected workers may use this integration. Leave empty to keep it unused for now.</span>
        </div>

        {/* Test connection */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>Test connection</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <PixelButton variant="secondary" size="sm" onClick={() => { void onTestDraft(); }} disabled={testingDraft}>
              {testingDraft ? 'testing…' : 'Test connection'}
            </PixelButton>
            {draftTest && (
              <span style={{ fontSize: 13, lineHeight: '18px', color: draftTest.ok ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-danger, #6E1423)' }}>
                {draftTest.ok ? '✓ ' : '✕ '}{draftTest.message}
              </span>
            )}
          </div>
          <span style={hint}>Runs a live read-only call with the key above before you save. On failure it shows the API error inline.</span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {note && <span style={{ marginRight: 'auto', ...subText }}>{note}</span>}
          <PixelButton variant="secondary" size="sm" onClick={goList} disabled={busy}>cancel</PixelButton>
          <PixelButton variant="primary" size="sm" onClick={() => { void onSave(); }} disabled={busy}>
            {busy ? '…' : editing ? 'Save changes' : 'Save integration'}
          </PixelButton>
        </div>
      </div>
    );
  }

  // ───────────────────────── LIST (default) ─────────────────────────
  const connected = entries.filter((e) => e.status === 'ok').length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={dispLabel}>Integrations</div>
          <span style={{ ...subText, maxWidth: 440 }}>Connect outside tools so your agents can read and act on them. Secrets are stored in the main process, encrypted, and never shown again.</span>
        </div>
        {entries.length > 0 && (
          <PixelButton variant="primary" size="sm" onClick={startAdd} disabled={busy || templates.length === 0}>+ add integration</PixelButton>
        )}
      </div>

      {entries.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-500)' }}>
            No integrations yet. Connect Linear, Stripe, Notion, GitHub and more — or a custom REST API.
          </p>
          <PixelButton variant="primary" size="sm" onClick={startAdd} disabled={templates.length === 0}>+ add your first integration</PixelButton>
        </div>
      ) : (
        <>
          <span style={hint}>{entries.length} integration{entries.length === 1 ? '' : 's'} · {connected} connected</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {entries.map((entry) => {
              const tpl = templateOf(entry.templateId);
              const st = STATUS_META[entry.status];
              const assigned = workers.filter((w) => entry.workers.includes(w.id));
              return (
                <div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {tpl && <Glyph glyph={tpl.glyph} />}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>{entry.label}</span>
                      <span style={hint}>{tpl ? `${tpl.label} · ${tpl.description}` : entry.templateId}{entry.hasSecret ? '' : ' · no secret'}</span>
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: st.color, whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: 10 }}>{st.dot}</span> {st.text}
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <PixelButton variant="secondary" size="sm" onClick={() => { void onTestRow(entry); }} disabled={busy || testingId === entry.id}>
                        {testingId === entry.id ? '…' : 'test'}
                      </PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => startEdit(entry)} disabled={busy}>edit</PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => { void onRemove(entry); }} disabled={busy}>✕</PixelButton>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={dispLabel}>Workers</span>
                    {assigned.length === 0 ? (
                      <span style={hint}>none assigned</span>
                    ) : assigned.map((w) => (
                      <span key={w.id} style={{ fontSize: 11, lineHeight: '16px', padding: '1px 6px', background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-900)' }}>{w.label}</span>
                    ))}
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
