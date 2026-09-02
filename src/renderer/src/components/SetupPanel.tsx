/**
 * 前置依赖（PREREQUISITES）——本应用需要的外部工具，以及你是否已经拥有它们。
 *
 * 本 harness 的几项最佳功能，其实是对应用包之外工具的薄封装：mempalace 提供语义记忆，
 * uv 负责安装它，git 用于 worktree，每个 agent 引擎各有一个 CLI。它们任何一个缺失时
 * 都会静默降级——这是正确的运行时行为，却也是糟糕的排查体验，因为从 floor 上看，
 * "关闭"和"损坏"长得一模一样。本页是唯一能区分两者的地方，也是唯一说明每个工具
 * 到底能给你带来什么的地方。
 *
 * 主操作是委托而非直接执行：安装软件会动到用户的机器，可能需要密码，所以按钮是把
 * 一条精确、经 Michael 验证过的契约 SEED（预填）进他的 dispatch 框，而不是从 renderer
 * 直接 shell 出去。用户仍然要自己按下 dispatch。这样，任何写入应用之外的操作前面
 * 都保留了一道真实的确认步骤。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { setupPrompt, type ToolStatus, type ToolKind } from '../../../shared/toolCatalog';

const SECTIONS: { kind: ToolKind; titleKey: string; blurbKey: string }[] = [
  { kind: 'prerequisite', titleKey: 'setupPanel.sections.prerequisites.title', blurbKey: 'setupPanel.sections.prerequisites.blurb' },
  { kind: 'memory', titleKey: 'setupPanel.sections.memory.title', blurbKey: 'setupPanel.sections.memory.blurb' },
  { kind: 'engine', titleKey: 'setupPanel.sections.engine.title', blurbKey: 'setupPanel.sections.engine.blurb' }
];

function StatusChip({ tool }: { tool: ToolStatus }) {
  const { t } = useTranslation();
  const ready = tool.found;
  return (
    <span style={{
      fontFamily: 'var(--cth-font-display)', fontSize: 9, letterSpacing: 0.5,
      padding: '2px 6px', flexShrink: 0, whiteSpace: 'nowrap',
      background: ready ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
      boxShadow: `inset 0 0 0 1px ${ready ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
      color: 'var(--cth-ink-900)'
    }}>
      {ready ? t('setupPanel.statusReady') : tool.essential ? t('setupPanel.statusMissing') : t('setupPanel.statusNotSetUp')}
    </span>
  );
}

function ToolRow({ tool }: { tool: ToolStatus }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(tool.installCommand).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1200); },
      () => { /* 剪贴板被拒绝——文本就在屏幕上，可手动选择 */ }
    );
  };
  return (
    <div style={{
      padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, flex: 1, minWidth: 0 }}>
          {tool.label.toUpperCase()}
        </span>
        {tool.essential && !tool.found && (
          <span style={{ fontSize: 10, color: 'var(--cth-ink-500)', flexShrink: 0 }}>{t('setupPanel.recommended')}</span>
        )}
        <StatusChip tool={tool} />
      </div>

      <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.5 }}>{tool.why}</div>

      {/* 已找到：展示位置，让"就绪"的结论可验证而非凭空信任。 */}
      {tool.found && tool.path && (
        <div style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
          wordBreak: 'break-all'
        }}>
          {tool.path}{tool.detail ? ` · ${tool.detail}` : ''}
        </div>
      )}

      {/* 缺失但有脚本化安装：给出确切命令，一键复制。 */}
      {!tool.found && tool.installCommand && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <code style={{
            flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 11,
            padding: '4px 6px', background: 'var(--cth-cream-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            color: 'var(--cth-ink-900)', overflowX: 'auto', whiteSpace: 'pre'
          }}>{tool.installCommand}</code>
          <button
            onClick={copy}
            style={{
              flexShrink: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 11, padding: '0 8px',
              background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              border: 'none', cursor: 'pointer', color: 'var(--cth-ink-900)'
            }}
          >{copied ? t('common.copy') + ' ✓' : t('common.copy')}</button>
        </div>
      )}

      {(tool.note || tool.docsUrl) && (
        <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tool.note && <span>{tool.note}</span>}
          {tool.docsUrl && (
            <a
              href={tool.docsUrl}
              onClick={(e) => { e.preventDefault(); void window.cth.openExternal(tool.docsUrl!); }}
              style={{ color: 'var(--cth-ink-700)' }}
            >{t('setupPanel.docs')}</a>
          )}
        </div>
      )}
    </div>
  );
}

export function SetupPanel({ onDone }: { onDone?: () => void } = {}) {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const requestDispatchSeed = useStore((s) => s.requestDispatchSeed);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);

  const refresh = useCallback(async () => {
    setBusy(true);
    try { setTools(await window.cth.toolsStatus()); }
    catch { setTools([]); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // 只把 ESSENTIALS（必需项）交给 Michael。只因为它们碰巧被列出就把全部八个引擎 CLI
  // 都装上，对一次点击来说越界得离谱。
  const missingEssential = useMemo(
    () => (tools ?? []).filter((t) => !t.found && t.essential),
    [tools]
  );
  const readyCount = (tools ?? []).filter((t) => t.found).length;

  const askMichael = () => {
    if (missingEssential.length === 0) return;
    requestDispatchSeed(setupPrompt(missingEssential));
    requestCommandCenterTab('floor'); // dispatch 输入框在 monitor 标签页上
    // 这个面板现在位于 modal 中——保持打开会遮住我们刚填好的那个输入框。
    onDone?.();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12 }}>{t('setupPanel.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', marginTop: 2 }}>
            {tools === null
              ? t('setupPanel.checking')
              : t('setupPanel.summary', { ready: readyCount, total: tools.length, missing: missingEssential.length })}
          </div>
        </div>
        <PixelButton variant="ghost" size="md" onClick={() => void refresh()} disabled={busy}>
          {busy ? t('setupPanel.checkingBtn') : t('setupPanel.recheck')}
        </PixelButton>
      </div>

      {/* 主操作。没有缺失时以禁用态呈现，让页面两种情况下观感一致，而不是让按钮消失。 */}
      <div style={{
        padding: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        background: missingEssential.length ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.5 }}>
          {missingEssential.length
            ? t('setupPanel.askDesc', { count: missingEssential.length })
            : t('setupPanel.allReady')}
        </div>
        <PixelButton
          variant="primary"
          size="md"
          onClick={askMichael}
          disabled={missingEssential.length === 0}
        >
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <Icon name="sparkle" /> {t('setupPanel.askMichael')}
          </span>
        </PixelButton>
      </div>

      {SECTIONS.map((section) => {
        const rows = (tools ?? []).filter((t) => t.kind === section.kind);
        if (rows.length === 0) return null;
        return (
          <div key={section.kind} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 10, letterSpacing: 0.5,
              color: 'var(--cth-ink-500)', textTransform: 'uppercase'
            }}>{t(section.titleKey)}</div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: -2 }}>{t(section.blurbKey)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((t) => <ToolRow key={t.id} tool={t} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
