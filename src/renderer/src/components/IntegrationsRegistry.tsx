import { useEffect, useState, type CSSProperties } from 'react';
import { PixelButton } from './PixelButton';
import {
  integrationsClient,
  type IntegrationDraft,
  type IntegrationEntry,
  type IntegrationStatus,
  type IntegrationTemplate,
  type IntegrationWorker
} from '@/integrations/registryClient';

// Connected-services registry UI. Goal (per dispatch): CLEAN + EASY TO
// UNDERSTAND. You see your integrations at a glance, add/edit one in a small
// inline form, test the connection, and pick which workers may use it.
//
// All data flows through integrationsClient — this component never touches IPC
// directly, so it is unaffected when that client is wired to Jim's registry.

const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-500)',
  textTransform: 'uppercase'
};

const inputStyle: CSSProperties = {
  padding: '6px 8px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--cth-ink-900)'
};

const STATUS_META: Record<IntegrationStatus, { dot: string; color: string; text: string }> = {
  ok: { dot: '●', color: 'var(--cth-mint-700, #1f7a4d)', text: 'Connected' },
  error: { dot: '●', color: '#6E1423', text: 'Error' },
  untested: { dot: '○', color: 'var(--cth-ink-500)', text: 'Not tested' }
};

/** Blank draft for the Add form, seeded to the first template. */
function blankDraft(templates: IntegrationTemplate[]): IntegrationDraft {
  return {
    label: '',
    templateId: templates[0]?.id ?? '',
    fields: {},
    secret: '',
    workers: []
  };
}

/** Draft for editing an existing entry — note: no secret is ever pulled back. */
function draftFromEntry(entry: IntegrationEntry): IntegrationDraft {
  return {
    id: entry.id,
    label: entry.label,
    templateId: entry.templateId,
    fields: { ...entry.fields },
    secret: '', // write-only: starts empty, blank-on-save keeps the stored secret
    workers: [...entry.workers]
  };
}

export function IntegrationsRegistry() {
  const [templates, setTemplates] = useState<IntegrationTemplate[]>([]);
  const [workers, setWorkers] = useState<IntegrationWorker[]>([]);
  const [entries, setEntries] = useState<IntegrationEntry[]>([]);
  const [draft, setDraft] = useState<IntegrationDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(''), 2200);
  };

  const refresh = async () => {
    setEntries(await integrationsClient.list());
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const [tpls, wkrs, list] = await Promise.all([
        integrationsClient.listTemplates(),
        integrationsClient.listWorkers(),
        integrationsClient.list()
      ]);
      if (!alive) return;
      setTemplates(tpls);
      setWorkers(wkrs);
      setEntries(list);
    })();
    return () => { alive = false; };
  }, []);

  const templateOf = (id: string) => templates.find((t) => t.id === id);
  const editing = draft?.id != null;
  const editEntry = editing ? entries.find((e) => e.id === draft?.id) : undefined;
  const activeTemplate = draft ? templateOf(draft.templateId) : undefined;

  const onSave = async () => {
    if (!draft) return;
    if (!draft.label.trim()) { flash('Give it a label first.'); return; }
    if (!draft.templateId) { flash('Pick a kind first.'); return; }
    setBusy(true);
    try {
      // Write-only secret: only send it when the user actually typed one.
      const payload: IntegrationDraft = {
        ...draft,
        label: draft.label.trim(),
        secret: draft.secret && draft.secret.length > 0 ? draft.secret : undefined
      };
      await integrationsClient.save(payload);
      setDraft(null);
      await refresh();
      flash(editing ? 'Integration updated.' : 'Integration added.');
    } catch {
      flash('Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (entry: IntegrationEntry) => {
    setBusy(true);
    try {
      await integrationsClient.remove(entry.id);
      if (draft?.id === entry.id) setDraft(null);
      await refresh();
      flash(`Removed “${entry.label}”.`);
    } catch {
      flash('Could not remove.');
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (entry: IntegrationEntry) => {
    setTestingId(entry.id);
    try {
      const res = await integrationsClient.test(entry.id);
      await refresh();
      flash(res.message);
    } catch {
      flash('Test failed to run.');
    } finally {
      setTestingId(null);
    }
  };

  const setField = (key: string, value: string) =>
    setDraft((d) => (d ? { ...d, fields: { ...d.fields, [key]: value } } : d));

  const toggleWorker = (id: string) =>
    setDraft((d) => {
      if (!d) return d;
      const has = d.workers.includes(id);
      return { ...d, workers: has ? d.workers.filter((w) => w !== id) : [...d.workers, id] };
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ ...labelStyle, marginBottom: 2 }}>Connected services</div>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            Add a service once, store its secret securely, and choose which workers may use it.
          </span>
        </div>
        {!draft && (
          <PixelButton
            variant="primary"
            size="sm"
            onClick={() => setDraft(blankDraft(templates))}
            disabled={busy || templates.length === 0}
          >
            + add integration
          </PixelButton>
        )}
      </div>

      {/* List of configured integrations */}
      {entries.length === 0 && !draft && (
        <div style={{
          padding: '14px 12px', textAlign: 'center',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)'
        }}>
          No integrations yet. Press “add integration” to connect your first service.
        </div>
      )}

      {entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entries.map((entry) => {
            const tpl = templateOf(entry.templateId);
            const st = STATUS_META[entry.status];
            const assigned = workers.filter((w) => entry.workers.includes(w.id));
            return (
              <div
                key={entry.id}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px',
                  background: 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>
                      {entry.label}
                      <code style={{ marginLeft: 6, fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', fontWeight: 400 }}>
                        {tpl?.label ?? entry.templateId}
                      </code>
                    </span>
                    <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
                      {entry.hasSecret ? 'secret set' : 'no secret'}
                      {' · '}
                      <span style={{ color: st.color }}>{st.dot} {st.text}</span>
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <PixelButton
                      variant="secondary" size="sm"
                      onClick={() => { void onTest(entry); }}
                      disabled={busy || testingId === entry.id}
                    >
                      {testingId === entry.id ? '…' : 'test'}
                    </PixelButton>
                    <PixelButton variant="ghost" size="sm" onClick={() => setDraft(draftFromEntry(entry))} disabled={busy}>
                      edit
                    </PixelButton>
                    <PixelButton variant="ghost" size="sm" onClick={() => { void onRemove(entry); }} disabled={busy}>
                      remove
                    </PixelButton>
                  </div>
                </div>

                {/* Which workers can use it */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ ...labelStyle }}>Workers</span>
                  {assigned.length === 0 ? (
                    <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>none assigned</span>
                  ) : (
                    assigned.map((w) => (
                      <span key={w.id} style={{
                        fontSize: 11, lineHeight: '16px', padding: '1px 6px',
                        background: 'var(--cth-cream-200)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        color: 'var(--cth-ink-900)'
                      }}>{w.label}</span>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / edit form */}
      {draft && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 10, padding: '12px',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 2px var(--cth-ink-700)'
        }}>
          <div style={{ ...labelStyle, color: 'var(--cth-ink-700)' }}>
            {editing ? 'Edit integration' : 'New integration'}
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Label</span>
            <input
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="e.g. Prod GitHub"
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 280 }}>
            <span style={labelStyle}>Kind</span>
            <select
              value={draft.templateId}
              onChange={(e) => setDraft({ ...draft, templateId: e.target.value, fields: {} })}
              disabled={editing /* kind is fixed once created */}
              style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            {activeTemplate?.description && (
              <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
                {activeTemplate.description}
              </span>
            )}
          </label>

          {/* Non-secret fields the chosen kind needs */}
          {activeTemplate?.fields.map((f) => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>{f.label}{f.optional ? ' (optional)' : ''}</span>
              <input
                value={draft.fields[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
              />
            </label>
          ))}

          {/* Secret — WRITE-ONLY. Never pre-filled, never echoed back. */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>{activeTemplate?.secretLabel ?? 'Secret'}</span>
            <input
              type="password"
              value={draft.secret ?? ''}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
              placeholder={
                editing && editEntry?.hasSecret
                  ? '•••••••• stored — leave blank to keep'
                  : `Paste your ${(activeTemplate?.secretLabel ?? 'secret').toLowerCase()}`
              }
              autoComplete="off"
              style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
            />
            <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
              Stored securely and never shown again.
              {editing && editEntry?.hasSecret ? ' Leave blank to keep the current secret.' : ''}
            </span>
          </label>

          {/* Which workers can use it */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Workers that can use it</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {workers.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>no workers available</span>
              )}
              {workers.map((w) => {
                const on = draft.workers.includes(w.id);
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => toggleWorker(w.id)}
                    style={{
                      padding: '2px 8px', border: 'none', cursor: 'pointer',
                      fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-900)',
                      background: on ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
                      boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`
                    }}
                  >
                    {on ? '✓ ' : ''}{w.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <PixelButton variant="primary" size="sm" onClick={() => { void onSave(); }} disabled={busy}>
              {busy ? '…' : editing ? 'save changes' : 'add'}
            </PixelButton>
            <PixelButton variant="secondary" size="sm" onClick={() => setDraft(null)} disabled={busy}>
              cancel
            </PixelButton>
          </div>
        </div>
      )}

      {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>{note}</span>}
    </div>
  );
}
