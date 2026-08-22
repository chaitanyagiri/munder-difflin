import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { useStore } from '@/store/store';
import { TRIGGER_MODES, type TriggerMode, type WebhookTrigger } from '@shared/triggers';
import {
  deleteWebhook, generateWebhookSecret, listWebhooks, newWebhook, saveWebhooks,
  webhooksStatus, type WebhooksStatus
} from './api';
import { JsonEditor } from './JsonEditor';
import {
  Callout, Field, Hint, MiniButton, ModePicker, Muted, SecretField, SubCard, SubHeader,
  Toggle, inputStyle
} from './ui';

/**
 * WEBHOOKS — one inbound HTTP endpoint per caller. Several share one port and
 * one tunnel and are told apart by the id in the path, so the URL you hand out
 * is per endpoint, never the tunnel root.
 *
 * The list lives in the store, not here. Settings → Connections edits the same
 * endpoints off the same mirror, so a save on either surface repaints the other
 * with no refetch — two local copies would drift the moment either one wrote.
 *
 * MIRROR-THEN-PERSIST: keystroke edits (a name) update the mirror only, so the
 * other surface stays live while you type without a disk write per character;
 * everything discrete (toggle, mode, schema, add, delete) persists on the spot.
 */

const STATUS_POLL_MS = 5000;

export function WebhooksSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const { t } = useTranslation();
  const hooks = useStore((s) => s.webhookTriggers);
  const setHooks = useStore((s) => s.setWebhookTriggers);
  const [status, setStatus] = useState<WebhooksStatus>({ running: false, endpoints: [] });
  const [minting, setMinting] = useState(false);

  useEffect(() => {
    let alive = true;
    // App seeds the mirror from getConfig() at boot, and both editing surfaces
    // keep it current — so this read only covers the case where it was never
    // seeded. Adopting unconditionally could clobber an edit being typed in
    // Settings right now.
    if (useStore.getState().webhookTriggers.length === 0) {
      void listWebhooks().then((l) => {
        if (alive && l && useStore.getState().webhookTriggers.length === 0) setHooks(l);
      });
    }
    const poll = () => { void webhooksStatus().then((s) => { if (alive) setStatus(s); }); };
    poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [setHooks]);

  useEffect(() => {
    onSummary?.(hooks.length === 0 ? t('webhooksSection.summaryNone') : t('webhooksSection.summary', { count: hooks.length, state: status.running ? t('webhooksSection.live') : t('webhooksSection.offline') }));
  }, [hooks, status.running, onSummary, t]);

  /** Update the shared mirror; optionally write it through. Main sanitises what
   *  it stores (it will not enable a secretless endpoint), so we adopt its
   *  answer when it comes back rather than assuming ours was accepted. */
  const apply = (next: WebhookTrigger[], persist = true) => {
    setHooks(next);
    if (!persist) return;
    void saveWebhooks(next).then((canonical) => { if (canonical) setHooks(canonical); });
  };
  const patch = (id: string, fields: Partial<WebhookTrigger>, persist = true) =>
    apply(hooks.map((w) => (w.id === id ? { ...w, ...fields } : w)), persist);

  const remove = (id: string) => {
    setHooks(hooks.filter((w) => w.id !== id));
    void deleteWebhook(id).then((canonical) => { if (canonical) setHooks(canonical); });
  };

  const add = async () => {
    setMinting(true);
    try {
      const secret = await generateWebhookSecret();
      apply([...hooks, newWebhook(secret, hooks.length)]);
    } finally {
      setMinting(false);
    }
  };

  const urlFor = (id: string) => status.endpoints.find((e) => e.id === id)?.url ?? '';

  return (
    <>
      <Muted>
        {t('webhooksSection.intro')}
      </Muted>
      <div style={{ height: 8 }} />

      {hooks.length === 0 && <Muted>{t('webhooksSection.noEndpoints')}</Muted>}
      {hooks.map((w) => (
        <WebhookRow
          key={w.id}
          hook={w}
          url={urlFor(w.id)}
          serverRunning={status.running}
          onPatch={(fields, persist) => patch(w.id, fields, persist)}
          onDelete={() => remove(w.id)}
        />
      ))}

      <div style={{ marginTop: 8 }}>
        <PixelButton variant="secondary" size="sm" onClick={() => { void add(); }} disabled={minting}>
          {minting ? t('webhooksSection.minting') : t('webhooksSection.addWebhook')}
        </PixelButton>
        <Hint>{t('webhooksSection.newEndpointHint')}</Hint>
      </div>
    </>
  );
}

/* ─────────────────────────────── one endpoint ────────────────────────────── */

function WebhookRow({ hook, url, serverRunning, onPatch, onDelete }: {
  hook: WebhookTrigger;
  url: string;
  serverRunning: boolean;
  onPatch: (fields: Partial<WebhookTrigger>, persist?: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [schemaText, setSchemaText] = useState(hook.schema);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaSaved, setSchemaSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A closed row must not keep a revealed secret on screen, and re-opening the
  // schema editor should start from what is actually stored.
  useEffect(() => {
    if (open) return;
    setRevealed(false);
    setSchemaOpen(false);
    setConfirmDelete(false);
  }, [open]);

  useEffect(() => {
    if (!schemaOpen) return;
    setSchemaText(hook.schema);
    setSchemaError(null);
    setSchemaSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaOpen]);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const copy = (what: 'url' | 'secret', text: string) => {
    void window.cth.copyToClipboard(text).catch(() => { /* noop */ });
    setCopied(what);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1300);
  };

  const saveSchema = () => {
    try {
      JSON.parse(schemaText);
    } catch (e) {
      // Never persist a schema that cannot be parsed — a broken one would lock
      // the caller out of their own endpoint with nothing on screen to say why.
      setSchemaError(e instanceof Error ? e.message : String(e));
      return;
    }
    setSchemaError(null);
    onPatch({ schema: schemaText });
    setSchemaSaved(true);
    setTimeout(() => setSchemaSaved(false), 1300);
  };

  const modeLabel = TRIGGER_MODES.find((m) => m.value === hook.mode)?.label ?? hook.mode;

  return (
    <SubCard>
      <SubHeader
        open={open}
        onToggle={() => setOpen((o) => !o)}
        title={hook.name || t('webhooksSection.unnamed')}
        sub={<>{modeLabel} · {url ? t('webhooksSection.reachable') : serverRunning ? t('webhooksSection.noUrlYet') : t('webhooksSection.serverOffline')}</>}
        right={<Toggle on={hook.enabled} onClick={() => onPatch({ enabled: !hook.enabled })} />}
      />

      {open && (
        <div style={{ marginTop: 4 }}>
          <Field label={t('webhooksSection.name')}>
            {/* Mirror while typing, write through on blur. */}
            <input
              value={hook.name}
              onChange={(e) => onPatch({ name: e.target.value }, false)}
              onBlur={() => onPatch({ name: hook.name })}
              placeholder={t('webhooksSection.namePlaceholder')}
              style={inputStyle}
            />
          </Field>

          <Field label={t('webhooksSection.postTo')}>
            {url ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  flex: 1, minWidth: 0, padding: '4px 6px',
                  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '15px',
                  color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>{url}</span>
                <MiniButton onClick={() => copy('url', url)} tone={copied === 'url' ? 'good' : 'plain'}>
                  {copied === 'url' ? `${t('common.copy')} ✓` : t('common.copy')}
                </MiniButton>
              </div>
            ) : (
              <Hint>
                {serverRunning
                  ? t('webhooksSection.noAddressYet')
                  : t('webhooksSection.serverNotListening')}
              </Hint>
            )}
          </Field>

          <Field label={t('webhooksSection.secret')}>
            <SecretField
              value={hook.secret}
              revealed={revealed}
              onReveal={() => setRevealed((r) => !r)}
              onCopy={() => copy('secret', hook.secret)}
              copied={copied === 'secret'}
            />
            <Hint>{t('webhooksSection.secretHint')}</Hint>
          </Field>

          <Field label={t('webhooksSection.trust')}>
            <ModePicker value={hook.mode} onChange={(mode: TriggerMode) => onPatch({ mode })} />
          </Field>

          <Field label={t('webhooksSection.bodySchema')}>
            {!schemaOpen && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <MiniButton onClick={() => setSchemaOpen(true)}>{t('webhooksSection.editSchema')}</MiniButton>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                  {t('webhooksSection.schemaDesc')}
                </span>
              </div>
            )}
            {schemaOpen && (
              <>
                <JsonEditor value={schemaText} onChange={(v) => { setSchemaText(v); setSchemaError(null); }} />
                {schemaError && <Callout>{t('webhooksSection.notValidJson', { error: schemaError })}</Callout>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                  <PixelButton variant="primary" size="sm" onClick={saveSchema}>
                    {schemaSaved ? t('webhooksSection.saved') : t('webhooksSection.saveSchema')}
                  </PixelButton>
                  <PixelButton variant="ghost" size="sm" onClick={() => setSchemaOpen(false)}>{t('common.close')}</PixelButton>
                </div>
              </>
            )}
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <span style={{ flex: 1 }} />
            {!confirmDelete && <MiniButton tone="danger" onClick={() => setConfirmDelete(true)}>{t('common.delete')}</MiniButton>}
            {confirmDelete && (
              <>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('webhooksSection.sure')}</span>
                <MiniButton tone="danger" onClick={onDelete}>{t('webhooksSection.deleteIt')}</MiniButton>
                <MiniButton onClick={() => setConfirmDelete(false)}>{t('webhooksSection.keep')}</MiniButton>
              </>
            )}
          </div>
        </div>
      )}
    </SubCard>
  );
}
