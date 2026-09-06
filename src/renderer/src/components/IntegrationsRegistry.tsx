import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
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

// Integrations 配置界面 —— 设置 → Integrations。遵循 Jim 的
// spec v1（hive/docs/integrations-spec.md），并按 Pam 的线框稿
// （hive/docs/integrations-ui-mockup.html）确定样式。包含三种视图：已配置列表、
// 选模板的图库，以及配置并测试的步骤。
//
// 所有数据都通过 integrationsClient 流转 —— 从不直接走 IPC。
//
// v1 worker 模型（Jim §4）：broker 把每个已启用的集成授予 ALL worker；
// 目前还没有按集成划分 worker 的作用域。所以"哪些 worker 能用它"
// 通过可用性门来表示 —— usable === enabled && hasSecret ——
// 而不是提供一个可编辑的按集成选择器。按 worker 划作用域是未来的扩展；
// 一旦 Jim 确认该模型，这里的描述就会更新。

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
  hasSecret: boolean; // 已存在的已存储密钥（编辑时）
  createdAt: number;
  secret: string;     // 只写输入缓冲
}

const AUTH_LABEL: Record<IntegrationAuthType, string> = {
  none: 'None (public API)',
  bearer: 'Bearer token',
  header: 'Custom header',
  github: 'GitHub'
};
// 用户可为自定义 REST 集成选择的认证类型。
const CUSTOM_AUTH: IntegrationAuthType[] = ['none', 'bearer', 'header'];

// 仅用于界面的品牌字形（Jim 的模板不带字形）。回退到标签首字母。
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
const inputStyle: CSSProperties = { width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)' };
const linkBtn: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start', fontSize: 12, color: 'var(--cth-ink-500)' };

function Glyph({ mono, bg, lg }: { mono: string; bg: string; lg?: boolean }) {
  const size = lg ? 48 : 40;
  return (
    <div style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg, color: '#fff', boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)', fontSize: lg ? 13 : 11 }}>{mono}</div>
  );
}

/** 集成对 worker 而言真的可用吗？（Jim §6 门。） */
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
  const { t: tr } = useTranslation();
  const [templates, setTemplates] = useState<IntegrationTemplate[]>([]);
  const [records, setRecords] = useState<IntegrationRecordView[]>([]);

  const [view, setView] = useState<View>('list');
  const [picked, setPicked] = useState<string>(''); // 图库中选中的模板 idSuggestion
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
    if (!d.label.trim()) return tr('integrations.errLabel');
    if (!slugify(d.id || d.label)) return tr('integrations.errId');
    if (d.kind === 'custom-rest') {
      const u = d.baseUrl.trim();
      if (!u) return tr('integrations.errBaseUrl');
      if (!/^https:\/\//.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)) return tr('integrations.errBaseUrlFormat');
    }
    if (d.authType === 'header' && !/^[A-Za-z0-9-]{1,64}$/.test(d.authHeader.trim())) return tr('integrations.errHeader');
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
      if (!res.ok) { setErr(res.error || tr('integrations.couldNotSave')); return; }
      await refresh();
      flash(draft.isNew ? tr('integrations.added') : tr('integrations.updated'));
      goList();
    } catch { setErr(tr('integrations.couldNotSave')); }
    finally { setBusy(false); }
  };

  const onRemove = async (r: IntegrationRecordView) => {
    setBusy(true);
    try { await integrationsClient.remove(r.id); setRowTest((m) => { const n = { ...m }; delete n[r.id]; return n; }); await refresh(); flash(tr('integrations.removed', { label: r.label })); }
    catch { flash(tr('integrations.couldNotRemove')); }
    finally { setBusy(false); }
  };

  const fmtTest = (t: TestResult) => t.ok
    ? (t.status ? tr('integrations.connectedWith', { status: t.status }) : tr('integrations.connected'))
    : (t.status ? `${tr('integrations.failed')} ${t.error || ''} (${t.status})` : `${tr('integrations.failed')} ${t.error || ''}`);

  const onTestRow = async (r: IntegrationRecordView) => {
    setTestingId(r.id);
    try { const res = await integrationsClient.test(r.id); setRowTest((m) => ({ ...m, [r.id]: res })); }
    catch { setRowTest((m) => ({ ...m, [r.id]: { ok: false, error: tr('integrations.testFailed') } })); }
    finally { setTestingId(null); }
  };
  const onTestCfg = async () => {
    if (!draft || draft.isNew) return;
    setTesting(true); setCfgTest(null);
    try { setCfgTest(await integrationsClient.test(draft.id)); }
    catch { setCfgTest({ ok: false, error: tr('integrations.testFailed') }); }
    finally { setTesting(false); }
  };

  // ───────────────────────── 图库 ─────────────────────────
  if (view === 'gallery') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button type="button" onClick={goList} style={linkBtn}>{tr('integrations.backToList')}</button>
        <div>
          <div style={{ ...dispLabel, marginBottom: 4 }}>{tr('integrations.pickTemplate')}</div>
          <span style={subText}>{tr('integrations.galleryDesc')}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, overflowWrap: 'anywhere' }}>
                  <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>{t.label}</span>
                  <span style={hint}>{t.secretHelp || (t.kind === 'custom-rest' ? tr('integrations.anyHttpApi') : '')}</span>
                </div>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <PixelButton variant="secondary" size="sm" onClick={goList}>{tr('common.cancel')}</PixelButton>
          <PixelButton variant="primary" size="sm" onClick={continueFromGallery} disabled={!picked}>{tr('integrations.continue')} →</PixelButton>
        </div>
      </div>
    );
  }

  // ───────────────────────── 配置 ─────────────────────────
  if (view === 'configure' && draft) {
    const g = glyphFor(draft.kind, draft.label);
    const tpl = templates.find((t) => t.kind === draft.kind);
    const secretLabel = tpl?.secretLabel || 'Secret';
    const showSavedPill = !draft.isNew && draft.hasSecret && !replacing;
    const isUsable = usable(draft);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <button type="button" onClick={draft.isNew ? startAdd : goList} style={linkBtn}>{draft.isNew ? tr('integrations.backToTemplates') : tr('integrations.backToList')}</button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <Glyph mono={g.mono} bg={g.bg} lg />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 600, color: 'var(--cth-ink-900)' }}>{tpl?.label ?? draft.kind}</span>
            <span style={hint}>{needsSecret(draft.authType) ? tr('integrations.needsSecret', { label: secretLabel.toLowerCase() }) : tr('integrations.publicApi')}</span>
          </div>
        </div>

        {/* 标签 */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>{tr('integrations.label')}</span>
          <input value={draft.label} onChange={(e) => patch({ label: e.target.value, ...(draft.isNew ? { id: slugify(e.target.value) } : {}) })} placeholder={`e.g. ${tpl?.label ?? 'My API'} (prod)`} style={inputStyle} />
          <span style={hint}>{tr('integrations.labelHint')}: <code style={{ fontFamily: 'var(--cth-font-mono)' }}>{slugify(draft.id || draft.label) || '—'}</code>{draft.isNew ? '' : ` (${tr('integrations.fixed')})`}</span>
        </label>

        {/* Base URL —— 自定义 REST 可编辑，预设模板固定 */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>{tr('integrations.baseUrl')}</span>
          <input value={draft.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="https://api.example.com" readOnly={draft.kind !== 'custom-rest'} style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', opacity: draft.kind !== 'custom-rest' ? 0.7 : 1 }} />
          {draft.kind !== 'custom-rest' && <span style={hint}>{tr('integrations.baseUrlHint', { label: tpl?.label ?? tr('integrations.preset') })}</span>}
        </label>

        {/* 认证类型 —— 仅自定义 REST 可选择 */}
        {draft.kind === 'custom-rest' ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 260 }}>
            <span style={fieldLabel}>{tr('integrations.authentication')}</span>
            <select value={draft.authType} onChange={(e) => patch({ authType: e.target.value as IntegrationAuthType })} style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}>
              {CUSTOM_AUTH.map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
            </select>
          </label>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={fieldLabel}>{tr('integrations.authentication')}</span>
            <span style={hint}>{AUTH_LABEL[draft.authType]} ({tr('integrations.setByTemplate')})</span>
          </div>
        )}

        {/* 自定义 header 名（仅 header 认证） */}
        {draft.authType === 'header' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 320 }}>
            <span style={fieldLabel}>{tr('integrations.headerName')}</span>
            <input value={draft.authHeader} onChange={(e) => patch({ authHeader: e.target.value })} placeholder="X-Api-Key" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
            <span style={hint}>{tr('integrations.headerHint', { header: draft.authHeader.trim() || 'X-Header' })}</span>
          </label>
        )}

        {/* 密钥 —— 只写（独立 setSecret IPC） */}
        {needsSecret(draft.authType) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={fieldLabel}>{secretLabel}</span>
            {showSavedPill ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-500)', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: '6px 10px', letterSpacing: 2 }}>•••••••• {tr('integrations.saved')}</span>
                <PixelButton variant="secondary" size="sm" onClick={() => { setReplacing(true); setShowSecret(false); patch({ secret: '' }); }}>{tr('integrations.replaceKey')}</PixelButton>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type={showSecret ? 'text' : 'password'} value={draft.secret} onChange={(e) => patch({ secret: e.target.value })} placeholder={`${tr('integrations.pasteYour')} ${secretLabel.toLowerCase()}`} autoComplete="off" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
                  <PixelButton variant="secondary" size="sm" onClick={() => setShowSecret((s) => !s)} disabled={!draft.secret}>{showSecret ? tr('common.hide') : tr('common.show')}</PixelButton>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '7px 9px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100, var(--cth-ink-300))', ...hint }}>
                  🔒&nbsp;<span><b style={{ color: 'var(--cth-ink-700)' }}>{tr('integrations.writeOnly')}.</b> {tr('integrations.secretDesc')}{!draft.isNew && draft.hasSecret ? ` ${tr('integrations.blankKeepsKey')}` : ''}</span>
                </div>
                {tpl?.secretHelp && <span style={hint}>{tpl.secretHelp}</span>}
              </>
            )}
          </div>
        )}

        {/* 启用开关 + worker 可用性 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={fieldLabel}>{tr('integrations.availability')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PixelButton variant={draft.enabled ? 'primary' : 'secondary'} size="sm" onClick={() => patch({ enabled: !draft.enabled })}>{draft.enabled ? tr('integrations.enabled') : tr('integrations.disabled')}</PixelButton>
            <span style={hint}>{isUsable ? tr('integrations.availableToAll') : needsSecret(draft.authType) && !(draft.hasSecret || draft.secret.trim()) ? tr('integrations.addSecretToEnable') : draft.enabled ? tr('integrations.readyOnceSaved') : tr('integrations.disabledNoUse')}</span>
          </div>
          <span style={hint}>{tr('integrations.v1Note')}</span>
        </div>

        {/* 测试连接（仅已保存的集成 —— broker 按 id 探测） */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabel}>{tr('integrations.testConnection')}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <PixelButton variant="secondary" size="sm" onClick={() => { void onTestCfg(); }} disabled={draft.isNew || testing}>{testing ? tr('integrations.testing') : tr('integrations.testConnection')}</PixelButton>
            {cfgTest && <span style={{ fontSize: 12, color: cfgTest.ok ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-danger, #6E1423)' }}>{fmtTest(cfgTest)}</span>}
          </div>
          <span style={hint}>{draft.isNew ? tr('integrations.testAfterSave') : tr('integrations.testLiveDesc')}</span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {(err || note) && <span style={{ marginRight: 'auto', fontSize: 12, color: err ? 'var(--cth-danger, #6E1423)' : 'var(--cth-ink-500)' }}>{err || note}</span>}
          <PixelButton variant="secondary" size="sm" onClick={goList} disabled={busy}>{tr('common.cancel')}</PixelButton>
          <PixelButton variant="primary" size="sm" onClick={() => { void onSave(); }} disabled={busy}>{busy ? '…' : draft.isNew ? tr('integrations.saveIntegration') : tr('integrations.saveChanges')}</PixelButton>
        </div>
      </div>
    );
  }

  // ───────────────────────── 列表（默认） ─────────────────────────
  const usableCount = records.filter(usable).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={dispLabel}>{tr('integrations.title')}</div>
          <span style={{ ...subText, maxWidth: 440 }}>{tr('integrations.titleDesc')}</span>
        </div>
        {records.length > 0 && <PixelButton variant="primary" size="sm" onClick={startAdd} disabled={busy || templates.length === 0}>+ {tr('integrations.addIntegration')}</PixelButton>}
      </div>

      {records.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <p style={{ margin: '0 0 12px', fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-500)' }}>{tr('integrations.empty')}</p>
          <PixelButton variant="primary" size="sm" onClick={startAdd} disabled={templates.length === 0}>+ {tr('integrations.addFirst')}</PixelButton>
        </div>
      ) : (
        <>
          <span style={hint}>{tr('integrations.count', { count: records.length, usable: usableCount })}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {records.map((r) => {
              const g = glyphFor(r.kind, r.label);
              const tpl = templates.find((t) => t.kind === r.kind);
              const st = !r.enabled
                ? { dot: '○', color: 'var(--cth-ink-500)', text: tr('integrations.disabled') }
                : needsSecret(r.authType) && !r.hasSecret
                  ? { dot: '▲', color: 'var(--cth-danger, #6E1423)', text: tr('integrations.needsSecretShort') }
                  : { dot: '●', color: 'var(--cth-mint-700, #1f7a4d)', text: tr('integrations.enabled') };
              const rt = rowTest[r.id];
              return (
                <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Glyph mono={g.mono} bg={g.bg} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)', fontWeight: 600 }}>{r.label}</span>
                      <span style={hint}>{tpl?.label ?? r.kind} · <code style={{ fontFamily: 'var(--cth-font-mono)' }}>{r.baseUrl || '—'}</code></span>
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: st.color, whiteSpace: 'nowrap' }}><span style={{ fontSize: 10 }}>{st.dot}</span> {st.text}</span>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <PixelButton variant="secondary" size="sm" onClick={() => { void onTestRow(r); }} disabled={busy || testingId === r.id}>{testingId === r.id ? '…' : tr('integrations.test')}</PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => startEdit(r)} disabled={busy}>{tr('integrations.edit')}</PixelButton>
                      <PixelButton variant="ghost" size="sm" onClick={() => { void onRemove(r); }} disabled={busy}>✕</PixelButton>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ ...hint, color: usable(r) ? 'var(--cth-mint-700, #1f7a4d)' : 'var(--cth-ink-500)' }}>
                      {usable(r) ? tr('integrations.availableToAll') : tr('integrations.notAvailableYet')}
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
