import { useState, useEffect, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig, AgentProvider } from '@/store/config';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';
import { OSS_BLOG_LINKS } from '@shared/ossModels';
import { useStore } from '@/store/store';

/**
 * AiEnginesSettings —— BYOK CLI 引擎（OpenCode · Crush · pi.dev · Qwen）的
 * v0.3.1 按 provider 的配置界面。按数据类型分成两类存储：
 *  - API 密钥 → 在 secret broker 中只写（`providerKey:*` IPC）。按
 *    BACKEND 模型提供方（anthropic/openai/…）键控。字段只显示已设置/未设置；
 *    明文永远不会回读给 renderer（在 spawn 时仅于 MAIN 侧物化）。
 *  - 本地 base-URL + 默认模型 → HarnessConfig（`providerBaseUrls` /
 *    `providerDefaultModels`），按 CLI provider 键控。非机密；普通配置保存。
 * 参见 hive/shared/cli-agents/settings-ui-schema.md。
 */

/** CLI 从标准环境变量读取其密钥的后端模型提供方。必须
 *  与 src/main/index.ts 中的 BACKEND_KEY_ENV 匹配。 */
const BACKENDS: Array<{ id: string; label: string; envVar: string }> = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { id: 'google', label: 'Google · Gemini', envVar: 'GEMINI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'groq', label: 'Groq', envVar: 'GROQ_API_KEY' }
];

/** 接受按 provider 的本地 base-URL + 默认模型的 CLI 引擎。`hint`
 *  值是技术性的端点描述——保持英文（技术数据）。 */
const CLIS: Array<{ id: AgentProvider; label: string; hint: string }> = [
  { id: 'qwen', label: 'Qwen', hint: 'OpenAI 兼容端点——用作代理上游' }
];

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};
const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};
const linkStyle: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

export function AiEnginesSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  // 让全局"存在 OpenAI 密钥"信号（仅布尔值）保持最新，这样 Talk 按钮的
  // 缺密钥警告会在用户在此保存 OpenAI 密钥的瞬间立即消失——没有它，
  // 该门只在下次应用启动时才刷新。apikey:openai 正是 Realtime mint
  // 读取的同一把密钥；保存/清除它会翻转该门。
  const setHasOpenAiKey = useStore((s) => s.setHasOpenAiKey);
  // 哪些后端已经存了密钥（仅布尔值——绝不含值本身）。
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [draftKey, setDraftKey] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  // Base-URL + 默认模型草稿，从配置中播种。
  const [baseUrls, setBaseUrls] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerBaseUrls ?? {}
  );
  const [models, setModels] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerDefaultModels ?? {}
  );

  // 挂载时重新播种已设置/未设置标志（只写——只取回布尔值）。
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const b of BACKENDS) {
        try { out[b.id] = await window.cth.providerKeyHas(b.id); } catch { out[b.id] = false; }
      }
      if (alive) setHasKey(out);
    })();
    return () => { alive = false; };
  }, []);

  const saveKey = async (backend: string) => {
    const key = (draftKey[backend] ?? '').trim();
    if (!key) return;
    try {
      const r = await window.cth.providerKeySet({ backend, key });
      if (r.ok) {
        setHasKey((s) => ({ ...s, [backend]: true }));
        setDraftKey((s) => ({ ...s, [backend]: '' }));
        setNote((s) => ({ ...s, [backend]: t('aiEngines.saved') }));
        // OpenAI 密钥控制 Talk——镜像存在性到 store，让警告立即清除。
        if (backend === 'openai') setHasOpenAiKey(true);
      } else setNote((s) => ({ ...s, [backend]: r.error ?? t('aiEngines.failed') }));
    } catch (e) { setNote((s) => ({ ...s, [backend]: e instanceof Error ? e.message : String(e) })); }
  };
  const clearKey = async (backend: string) => {
    try {
      await window.cth.providerKeyClear(backend);
      setHasKey((s) => ({ ...s, [backend]: false }));
      setNote((s) => ({ ...s, [backend]: t('aiEngines.cleared') }));
      // OpenAI 密钥控制 Talk——清除它会禁用 Talk；立即反映出来。
      if (backend === 'openai') setHasOpenAiKey(false);
    } catch { /* noop */ }
  };

  const saveBaseUrl = async (id: AgentProvider, value: string) => {
    const next = { ...baseUrls, [id]: value.trim() || undefined };
    setBaseUrls(next);
    try { await window.cth.updateConfig({ providerBaseUrls: next }); } catch { /* noop */ }
  };
  const saveModel = async (id: AgentProvider, value: string) => {
    const next = { ...models, [id]: value.trim() || undefined };
    setModels(next);
    try { await window.cth.updateConfig({ providerDefaultModels: next }); } catch { /* noop */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={headStyle}>{t('aiEngines.providers')}</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
          {t('aiEngines.providersDesc')}
        </div>
      </div>

      {/* 后端 API 密钥（只写） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={headStyle}>{t('aiEngines.apiKeys')}</div>
        {BACKENDS.map((b) => (
          <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>
              {b.label} {hasKey[b.id] ? `· ${t('aiEngines.setCheck')}` : ''} <span style={{ opacity: 0.6 }}>({b.envVar})</span>
            </label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder={hasKey[b.id] ? t('aiEngines.keyStoredPlaceholder') : t('aiEngines.keyPlaceholder', { label: b.label })}
                value={draftKey[b.id] ?? ''}
                onChange={(e) => setDraftKey((s) => ({ ...s, [b.id]: e.target.value }))}
                style={inputStyle}
              />
              <PixelButton variant="secondary" size="sm" onClick={() => saveKey(b.id)}>{t('common.save')}</PixelButton>
              {hasKey[b.id] && (
                <PixelButton variant="secondary" size="sm" onClick={() => clearKey(b.id)}>{t('common.delete')}</PixelButton>
              )}
            </div>
            {note[b.id] && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note[b.id]}</div>}
          </div>
        ))}
      </div>

      {/* 按 CLI 的本地端点 + 默认模型 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={headStyle}>{t('aiEngines.localEndpoint')}</div>
        {CLIS.map((c) => (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ProviderLogo provider={c.id} size={12} /> {c.label}
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder={`base-URL — ${c.hint}`}
                defaultValue={baseUrls[c.id] ?? ''}
                onBlur={(e) => saveBaseUrl(c.id, e.target.value)}
                style={inputStyle}
              />
              <input
                placeholder={t('aiEngines.defaultModelPlaceholder')}
                defaultValue={models[c.id] ?? ''}
                onBlur={(e) => saveModel(c.id, e.target.value)}
                style={{ ...inputStyle, maxWidth: 220 }}
              />
            </div>
          </div>
        ))}
        {/* 本地搭建指南（ondev-c part-3）——链接两篇 how-to 博客。 */}
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
          {t('aiEngines.runningOpenModels')}{' '}
          <a
            href={OSS_BLOG_LINKS.openModels}
            onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.openModels); }}
            style={linkStyle}
          >{t('aiEngines.runOnOpenModels')}</a>
          {' '}·{' '}
          <a
            href={OSS_BLOG_LINKS.macMini}
            onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.macMini); }}
            style={linkStyle}
          >{t('aiEngines.setUpMacMini')}</a>.
        </div>
      </div>

      {/* 自动模式下非沙箱的注意事项（Pam 护栏 #6） */}
      <div style={{
        fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px',
        padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-paper-100)'
      }}>
        {t('aiEngines.autoModeCaveat')}
      </div>
    </div>
  );
}
