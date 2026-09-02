/**
 * SKILLS——这里的编码 agent 已经会什么，以及它们还能会的 1,200 多个。
 *
 * 一个开关后面有两种模式，而不是两个标签页：“installed”回答“我的 agent 刚才
 * 为什么那样做？”，"browse" 回答“外面还有什么？”，它们共享同一个搜索框，因为
 * 用户的问题通常只是一个词。
 *
 * 这里不安装任何东西。一个 skill 是在持有用户工具和密钥的 agent 内部运行的
 * 指令，所以添加一个是一次决定，不是一次点击——目录链接出去，由用户选择。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import type { LocalSkill, CatalogSkill } from '../../../preload';

type Mode = 'installed' | 'browse';

const PROVIDER_LABEL: Record<LocalSkill['provider'], string> = {
  claude: 'Claude Code',
  codex: 'Codex'
};

function Chip({ text, tone = 'quiet' }: { text: string; tone?: 'quiet' | 'accent' }) {
  return (
    <span style={{
      fontSize: 10, fontFamily: 'var(--cth-font-display)', letterSpacing: 0.4,
      padding: '2px 6px', flexShrink: 0, textTransform: 'uppercase',
      color: 'var(--cth-ink-900)',
      background: tone === 'accent' ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
      boxShadow: `inset 0 0 0 1px ${tone === 'accent' ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`
    }}>{text}</span>
  );
}

export function SkillsTab({ agentCwd }: { agentCwd?: string }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('installed');
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<LocalSkill[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null);
  const [catalogMeta, setCatalogMeta] = useState<{ stale: boolean; error?: string; fetchedAt: number } | null>(null);
  const [owner, setOwner] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [busy, setBusy] = useState(false);
  /** 逐行动作状态，以目录 url / 本地路径为键。避免把某一行的 spinner 或错误
   *  误当成整个标签页失败。 */
  const [action, setAction] = useState<Record<string, { busy?: boolean; error?: string; done?: string }>>({});
  /** 卸载是破坏性的，所以要两次点击：第一次武装这个，第二次才执行。不用弹窗——
   *  行本身成为确认。 */
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadLocal = useCallback(async () => {
    try { setLocal(await window.cth.skillsLocal(agentCwd)); } catch { setLocal([]); }
  }, [agentCwd]);

  const loadCatalog = useCallback(async (force = false) => {
    setBusy(true);
    try {
      const res = await window.cth.skillsCatalog(force);
      setCatalog(res.skills);
      setCatalogMeta({ stale: res.stale, error: res.error, fetchedAt: res.fetchedAt });
    } catch {
      setCatalog([]);
      setCatalogMeta({ stale: true, error: t('skillsTab.catalogUnreachable'), fetchedAt: 0 });
    } finally { setBusy(false); }
  }, [t]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);
  // 只有用户真正打开 Browse 时才获取目录——只想看已装了什么的人不做网络调用。
  useEffect(() => { if (mode === 'browse' && catalog === null) void loadCatalog(); }, [mode, catalog, loadCatalog]);

  const q = query.trim().toLowerCase();

  const shownLocal = useMemo(() => {
    const list = local ?? [];
    if (!q) return list;
    return list.filter((s) =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [local, q]);

  const owners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of catalog ?? []) counts.set(s.owner, (counts.get(s.owner) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalog]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of catalog ?? []) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalog]);

  const shownCatalog = useMemo(() => {
    let list = catalog ?? [];
    if (owner !== 'all') list = list.filter((s) => s.owner === owner);
    if (category !== 'all') list = list.filter((s) => s.category === category);
    if (q) {
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    }
    // 限制渲染：DOM 列表里放 1,200 行会让面板卡顿，而且没人会滚过几百行。
    // 下面的数字始终说明真实总数。
    return list.slice(0, 300);
  }, [catalog, owner, category, q]);

  const totalMatching = useMemo(() => {
    let list = catalog ?? [];
    if (owner !== 'all') list = list.filter((s) => s.owner === owner);
    if (category !== 'all') list = list.filter((s) => s.category === category);
    if (!q) return list.length;
    return list.filter((s) =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)).length;
  }, [catalog, owner, category, q]);

  const install = async (c: CatalogSkill) => {
    setAction((a) => ({ ...a, [c.url]: { busy: true } }));
    try {
      const res = await window.cth.skillsInstall(c.url, c.name);
      if (res.ok) {
        setAction((a) => ({ ...a, [c.url]: { done: t('skillsTab.installed') } }));
        void loadLocal(); // 已安装面板必须立刻反映它
      } else {
        setAction((a) => ({ ...a, [c.url]: { error: res.error } }));
      }
    } catch (e) {
      setAction((a) => ({ ...a, [c.url]: { error: e instanceof Error ? e.message : t('skillsTab.installFailed') } }));
    }
  };

  const uninstall = async (sk: LocalSkill) => {
    setConfirming(null);
    setAction((a) => ({ ...a, [sk.path]: { busy: true } }));
    try {
      const res = await window.cth.skillsUninstall(sk.path);
      if (res.ok) { setAction((a) => { const n = { ...a }; delete n[sk.path]; return n; }); void loadLocal(); }
      else setAction((a) => ({ ...a, [sk.path]: { error: res.error ?? t('skillsTab.removeFailed') } }));
    } catch (e) {
      setAction((a) => ({ ...a, [sk.path]: { error: e instanceof Error ? e.message : t('skillsTab.uninstallFailed') } }));
    }
  };

  const actionBtn = (kind: 'primary' | 'quiet' | 'danger'): React.CSSProperties => ({
    padding: '3px 9px 2px', border: 'none', cursor: 'pointer', flexShrink: 0,
    fontFamily: 'var(--cth-font-ui)', fontSize: 11,
    color: 'var(--cth-ink-900)',
    background:
      kind === 'primary' ? 'var(--cth-mint-light)'
      : kind === 'danger' ? 'var(--cth-coral-light)'
      : 'var(--cth-cream-200)',
    boxShadow: `inset 0 0 0 1px ${
      kind === 'primary' ? 'var(--cth-mint)' : kind === 'danger' ? 'var(--cth-coral)' : 'var(--cth-ink-300)'
    }`
  });

  const tabBtn = (m: Mode, label: string): React.CSSProperties => ({
    padding: '4px 10px 3px', border: 'none', cursor: 'pointer',
    fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    background: mode === m ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
    boxShadow: `inset 0 0 0 1px ${mode === m ? 'var(--cth-lemon)' : 'var(--cth-ink-300)'}`,
    color: 'var(--cth-ink-900)'
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* 控件 */}
      <div style={{
        flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: 10, borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <button onClick={() => setMode('installed')} style={tabBtn('installed', t('skillsTab.installed'))}>
          {t('skillsTab.installed')}{local ? ` (${local.length})` : ''}
        </button>
        <button onClick={() => setMode('browse')} style={tabBtn('browse', t('skillsTab.browse'))}>
          {t('skillsTab.browse')}{catalog ? ` (${catalog.length})` : ''}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === 'installed' ? t('skillsTab.searchInstalled') : t('skillsTab.searchCatalog')}
          style={{
            flex: 1, minWidth: 140, padding: '4px 8px',
            background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
            border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12
          }}
        />
        {mode === 'browse' && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            title={t('skillsTab.categoryTitle')}
            style={{
              padding: '4px 6px', maxWidth: 210,
              background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
              border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12
            }}
          >
            <option value="all">{t('skillsTab.allCategories')}</option>
            {categories.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
          </select>
        )}
        {mode === 'browse' && (
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            style={{
              padding: '4px 6px', maxWidth: 190,
              background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
              border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12
            }}
          >
            <option value="all">{t('skillsTab.allPublishers')}</option>
            {owners.map(([o, n]) => <option key={o} value={o}>{o} ({n})</option>)}
          </select>
        )}
        <PixelButton
          variant="ghost"
          size="sm"
          onClick={() => (mode === 'installed' ? void loadLocal() : void loadCatalog(true))}
          disabled={busy}
        >{busy ? t('skillsTab.loading') : t('skillsTab.refresh')}</PixelButton>
      </div>

      {/* 主体 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {mode === 'installed' ? (
          local === null ? <Muted>{t('skillsTab.scanning')}</Muted>
          : shownLocal.length === 0 ? (
            <Muted>
              {local.length === 0
                ? t('skillsTab.noSkillsInstalled')
                : t('skillsTab.nothingMatches')}
            </Muted>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shownLocal.map((s) => (
                <div key={s.id + s.path} style={rowStyle}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, flex: 1, minWidth: 0 }}>
                      {s.name.toUpperCase()}
                    </span>
                    <Chip text={PROVIDER_LABEL[s.provider]} />
                    <Chip text={s.scope} tone={s.scope === 'project' ? 'accent' : 'quiet'} />
                  </div>
                  {s.description && (
                    <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.45 }}>
                      {s.description.length > 220 ? `${s.description.slice(0, 220)}…` : s.description}
                    </div>
                  )}
                  <div style={{
                    fontFamily: 'var(--cth-font-mono)', fontSize: 10.5,
                    color: 'var(--cth-ink-500)', wordBreak: 'break-all'
                  }}>{s.path}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button onClick={() => void window.cth.skillsReveal(s.path)} style={actionBtn('quiet')}>
                      {t('skillsTab.openFolder')}
                    </button>
                    {s.scope === 'bundled' ? (
                      // Bundled skills 随应用一起分发，每次 spawn 都会被重新复制到
                      // 每个 agent，所以“移除”一个会在稍后悄悄复活。说明这一点，
                      // 而不是提供一个撒谎的按钮。
                      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                        {t('skillsTab.shipsWithApp')}
                      </span>
                    ) : confirming === s.path ? (
                      <>
                        <button onClick={() => void uninstall(s)} style={actionBtn('danger')}>
                          {t('skillsTab.deleteConfirm', { name: s.name })}
                        </button>
                        <button onClick={() => setConfirming(null)} style={actionBtn('quiet')}>{t('common.cancel')}</button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirming(s.path)}
                        disabled={action[s.path]?.busy}
                        style={actionBtn('quiet')}
                      >{action[s.path]?.busy ? t('skillsTab.removing') : t('skillsTab.uninstall')}</button>
                    )}
                    {action[s.path]?.error && (
                      <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{action[s.path]?.error}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : catalog === null ? <Muted>{t('skillsTab.loadingCatalog')}</Muted>
        : (
          <>
            {catalogMeta?.error && (
              <div style={{
                marginBottom: 8, padding: 8, fontSize: 12, color: 'var(--cth-ink-900)',
                background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)'
              }}>
                {t('skillsTab.cachedCopy', { error: catalogMeta.error })}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginBottom: 8 }}>
              {totalMatching > shownCatalog.length
                ? t('skillsTab.matchingFirst', { count: totalMatching, shown: shownCatalog.length })
                : t('skillsTab.matching', { count: totalMatching })}
              {' · '}{t('skillsTab.curatedBy')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shownCatalog.map((s) => (
                <div key={s.url + s.name} style={rowStyle}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, flex: 1, minWidth: 0 }}>
                      {s.name.toUpperCase()}
                    </span>
                    <Chip text={s.category} />
                    <Chip text={s.owner} />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.45 }}>
                    {s.description}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => void install(s)}
                      disabled={!!action[s.url]?.busy || !!action[s.url]?.done}
                      style={actionBtn(action[s.url]?.done ? 'quiet' : 'primary')}
                    >
                      {action[s.url]?.busy ? t('skillsTab.installing') : action[s.url]?.done ?? t('skillsTab.install')}
                    </button>
                    <button
                      onClick={() => void window.cth.openExternal(s.url)}
                      style={actionBtn('quiet')}
                    >{t('skillsTab.learnMore')}</button>
                    {action[s.url]?.error && (
                      <span style={{ fontSize: 11, color: 'var(--cth-coral)', flex: 1, minWidth: 0 }}>
                        {action[s.url]?.error}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 5, padding: 10,
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  color: 'var(--cth-ink-900)'
};

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', padding: 6 }}>{children}</div>;
}
