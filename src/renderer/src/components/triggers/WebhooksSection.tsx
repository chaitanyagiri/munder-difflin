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
 * WEBHOOKS —— 每个调用方一个入站 HTTP 端点。多个调用方共享一个端口和一个
 * 隧道，靠路径中的 id 区分，所以你给出的 URL 是每个端点一个，绝不是隧道根。
 *
 * 列表存在 store 里，不在这里。Settings → Connections 编辑的是同一份镜像上的
 * 相同端点，所以任一处保存后无需重新拉取，另一处也会同步刷新——如果存在两份
 * 本地副本，任何一方写入后它们就会分叉。
 *
 * MIRROR-THEN-PERSIST（先镜像后持久化）：按键级编辑（如名字）只更新镜像，这样
 * 你输入时另一个界面保持实时，而不会每个字符都写一次磁盘；所有离散操作
 * （开关、模式、schema、添加、删除）则当场持久化。
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
    // App 在启动时用 getConfig() 播种镜像，两个编辑界面都让它保持最新——
    // 所以这次读取只覆盖从未播种过的情况。无条件采纳可能会覆盖 Settings 中
    // 正在输入的一次编辑。
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

  /** 更新共享镜像；可选地写入到底层。Main 会净化它存储的内容（不会启用无密钥
   *  的端点），所以当它返回答案时我们采纳它的答案，而不是假设我们的被接受了。 */
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

/* ─────────────────────────────── 单个端点 ────────────────────────────── */

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

  // 折叠的行绝不能把已揭示的密钥留在屏幕上，而且重新打开 schema 编辑器应该
  // 从实际存储的内容开始。
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
      // 绝不能持久化无法解析的 schema——损坏的 schema 会把调用方锁在自己的
      // 端点外，而屏幕上没有任何说明原因的东西。
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
            {/* 输入时镜像，失焦时写穿。 */}
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
