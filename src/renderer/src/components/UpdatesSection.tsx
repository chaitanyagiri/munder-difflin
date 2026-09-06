/**
 * 设置 → 通用 → “更新”。
 *
 * 工具栏已经有一个更新胶囊（UpdateBadge），但一个一切正常时保持空白的胶囊，
 * 不是一个你会去“问”的地方——而“有没有新版本？”正是人们打开设置时要问的问题。
 * 这个区块总是回答它：你现在用的版本、是不是最新的，以及一个按钮，按钮上写着
 * 按下去会做什么。
 *
 * 与徽章相同的状态流、相同的 reducer、相同的状态——只是措辞不同
 * （`describeUpdateSettings` 对比 `describeUpdate`），所以两者永远不可能对
 * “装的是什么”产生分歧。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { summarizeReleaseNotes } from '@shared/releaseNotes';
import { describeUpdateSettings, manualDownloadUrl, manualInstallSteps, pendingVersion, reduceStatus, clampPercent, type UpdateStatus } from '@shared/updateState';
import { PixelButton } from './PixelButton';

declare const __APP_VERSION__: string;

export function UpdatesSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 先订阅再拉取：main 可能在这个弹窗关闭期间就发出过事件，而 `update:current`
    // 会重新派发最后已知的状态。
    const off = window.cth.onUpdateStatus?.((next) => setStatus((prev) => reduceStatus(prev, next)));
    void window.cth.updateCurrent?.().then((cur) => {
      if (cur) setStatus((prev) => reduceStatus(prev, cur));
    }).catch(() => { /* 没有该 handler 的旧 main——推送通道仍可用 */ });
    return off;
  }, []);

  const view = describeUpdateSettings(status, __APP_VERSION__);
  /** 手动路径始终和自动路径并列提供。 */
  const pending = pendingVersion(status, __APP_VERSION__);
  const [manualStarted, setManualStarted] = useState<string | null>(null);
  const steps = manualInstallSteps(window.cth.platform ?? 'darwin');
  const downloadManually = () => {
    if (!status) return;
    const url = manualDownloadUrl(status, window.cth.platform, window.cth.arch);
    if (!url) return;
    void window.cth.updateOpenRelease(url);
    setManualStarted(pending);
  };

  // 共享的 describeUpdateSettings() 渲染英文文案（它也喂给工具栏徽章和 toast，
  // 而它们还没做 i18n）。对于这个区块，我们通过 i18n 从状态重新推导三个文案
  // 字段，把共享函数作为语气/动作/忙碌状态的唯一事实来源。
  const v = __APP_VERSION__;
  const localized: { headline: string; detail: string; button: string | null } = (() => {
    switch (status?.state) {
      case 'checking':
        return { headline: t('updatesSection.onVersion', { v }), detail: t('updatesSection.checkingDetail'), button: null };
      case 'available':
        return {
          headline: t('updatesSection.availableHeadline', { version: status.version }),
          detail: t('updatesSection.availableDetail', { v }),
          button: t('updatesSection.downloadBtn', { version: status.version })
        };
      case 'downloading':
        return {
          headline: t('updatesSection.downloadingHeadline', { version: status.version }),
          detail: t('updatesSection.downloadingDetail', { percent: clampPercent(status.percent) }),
          button: null
        };
      case 'downloaded':
        return {
          headline: t('updatesSection.downloadedHeadline', { version: status.version }),
          detail: t('updatesSection.downloadedDetail', { v }),
          button: t('updatesSection.restartBtn')
        };
      case 'available-manual':
        return {
          headline: t('updatesSection.availableHeadline', { version: status.version }),
          detail: status.reason
            ? t('updatesSection.manualDetailReason', { reason: status.reason })
            : t('updatesSection.manualDetail'),
          button: t('updatesSection.openReleaseBtn')
        };
      case 'error':
        return {
          headline: t('updatesSection.errorHeadline'),
          detail: t('updatesSection.errorDetail', { message: status.message, v }),
          button: t('updatesSection.retryBtn')
        };
      case 'not-available':
        return {
          headline: t('updatesSection.latestHeadline', { v }),
          detail: t('updatesSection.latestDetail'),
          button: t('updatesSection.checkAgainBtn')
        };
      case 'idle':
      default:
        return {
          headline: t('updatesSection.onVersion', { v }),
          detail: t('updatesSection.idleDetail'),
          button: t('updatesSection.checkBtn')
        };
    }
  })();
  const viewText = { ...view, headline: localized.headline, detail: localized.detail, button: localized.button };

  // 与更新 toast 渲染的摘要相同（src/shared/releaseNotes.ts），理由也一样：
  // 发布内容已经在手，“我能得到什么？”是继“有没有新版本？”之后每个人都会问的
  // 第二个问题。只有带 notes 的状态才有它们——其余的不渲染额外内容。
  const notes = useMemo(
    () => summarizeReleaseNotes(status && 'notes' in status ? status.notes : undefined),
    [status]
  );

  const onClick = useCallback(async () => {
    if (view.action === 'none' || busy) return;
    setBusy(true);
    try {
      if (view.action === 'restart') await window.cth.updateRestartAndInstall();
      else if (view.action === 'download') await window.cth.updateDownload();
      else if (view.action === 'check') await window.cth.updateCheckNow();
      else if (view.action === 'open-release') {
        await window.cth.updateOpenRelease(status?.state === 'available-manual' ? status.url : undefined);
      }
    } catch { /* 发出的状态携带着失败——这里无事可做 */ }
    setBusy(false);
  }, [view.action, busy, status]);

  return (
    <div>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        {t('updatesSection.title')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)',
            // 只有可操作的状态才配得上强调；“你已是最新”是信息，
            // 不是行动号召。
            fontWeight: viewText.tone === 'ready' ? 600 : 400
          }}>
            {viewText.headline}
          </span>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            {viewText.detail}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
          {pending && (
            <PixelButton
              variant="secondary"
              size="sm"
              onClick={downloadManually}
              style={{ whiteSpace: 'nowrap' }}
              title={t('updatesSection.downloadManuallyTitle', { version: pending })}
            >
              {t('updatesSection.downloadManually')}
            </PixelButton>
          )}
          {viewText.button && (
            <PixelButton
              variant={viewText.tone === 'ready' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => { void onClick(); }}
              disabled={busy || viewText.busy}
              // 标签是一个短语（“检查更新”、“重启以更新”），而这一行是 flex
              // 行，左列承载两行文案。没有这些属性，按钮会成为弹性项：它被压缩、
              // 标签换行成两行，而且因为按钮高度来自它的尺寸变体，第二行会直接
              // 穿过底边框打印出来。拒绝收缩、拒绝换行——文案列已有 minWidth: 0，
              // 所以是它让步。
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {viewText.button}
            </PixelButton>
          )}
        </div>
      </div>
      {manualStarted && (
        <div style={{
          marginTop: 10, padding: '10px 12px', fontSize: 12, lineHeight: 1.5,
          color: 'var(--cth-ink-900)', background: 'var(--cth-paper-100)',
          border: '2px solid var(--cth-ink-900)'
        }}>
          <Trans i18nKey="updatesSection.manualDownloadingTitle" values={{ version: manualStarted }} components={{ b: <b /> }}>
            v{manualStarted} is downloading in your browser.
          </Trans>{' '}
          <Trans i18nKey="updatesSection.manualDownloadingBody" values={{ os: steps.os }}>
            When it lands, quit this app, install the new version over the current one, open it and
            pick the same project. On {steps.os}:
          </Trans>
          <ol style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--cth-ink-700)' }}>
            {steps.steps.map((t) => <li key={t}>{t}</li>)}
          </ol>
        </div>
      )}
      {notes.length > 0 && (
        <ul style={{
          listStyle: 'none', margin: '8px 0 0', padding: 0,
          display: 'flex', flexDirection: 'column', gap: 4
        }}>
          {notes.map((line, i) => (
            <li key={i} style={{
              display: 'flex', gap: 6,
              fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)'
            }}>
              <span aria-hidden style={{ color: 'var(--cth-ink-300)' }}>•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
