/**
 * 工具栏版本 + 更新控件——左上角，紧挨着 logo。
 *
 * 总是显示当前运行的版本。当 main 的更新器报告任何有意思的事时，它会长出一个
 * 本身就是按钮的胶囊：“v0.3.7 可安装”（点击 → 下载）、“正在下载 42%”、
 * “重启以更新到 v0.3.7”（点击 → quitAndInstall）。没有待办时，点击版本号本身
 * 会跑一次手动检查——旧构建只在启动 30 秒后检查一次，然后每 6 小时一次，
 * 所以之前没有问的途径。
 *
 * 所有“这个状态说什么、做什么”的逻辑都放在 src/shared/updateState.ts，
 * 以便在没有 Electron 的情况下做单元测试；这个文件只是接线和像素。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeUpdate, manualDownloadUrl, manualInstallSteps, pendingVersion, reduceStatus, clampPercent as clampPct, type UpdateStatus } from '@shared/updateState';
import { PixelButton } from './PixelButton';

declare const __APP_VERSION__: string;

export function UpdateBadge() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  /** 刚启动下载的那个版本，用于“现在去替换应用”的通知。局部状态：它是一次性
   *  解释，不是一个更新状态。 */
  const [started, setStarted] = useState<string | null>(null);
  /** 手动检查未发现更新后，短暂、正面的“已检查，你是最新的”闪现。没有它，
   *  一次成功的检查会安静地回到灰色“最新”胶囊，与一次点击什么也没发生无法
   *  区分——而这正是徽章看起来坏了的原因。 */
  const [checkedOk, setCheckedOk] = useState(false);

  useEffect(() => {
    // 先订阅再拉取——main 可能在这个窗口加载完（或一次重载之前）就发出过，
    // 而 `update:current` 会重新派发它。
    const off = window.cth.onUpdateStatus?.((next) => setStatus((prev) => reduceStatus(prev, next)));
    void window.cth.updateCurrent?.().then((cur) => {
      if (cur) setStatus((prev) => reduceStatus(prev, cur));
    }).catch(() => { /* 没有该 handler 的旧 main——推送通道仍可用 */ });
    return off;
  }, []);

  // 这个确认是一次闪现，不是一种模式：几秒后清掉，让徽章回到它安静的静止状态。
  useEffect(() => {
    if (!checkedOk) return;
    const t = setTimeout(() => setCheckedOk(false), 3500);
    return () => clearTimeout(t);
  }, [checkedOk]);

  const rawView = describeUpdate(status, __APP_VERSION__);
  const pendingV = pendingVersion(status, __APP_VERSION__);
  // 与 UpdatesSection 同样的模式：保留共享函数的语气/动作/忙碌，把人类可读的
  // 标签/标题经 i18n 重新推导。
  const view = (() => {
    switch (status?.state) {
      case 'downloading':
        return { ...rawView, label: t('updateBadge.downloadingChip', { percent: clampPct(status.percent) }), title: t('updateBadge.downloadingTitle', { version: status.version, percent: clampPct(status.percent) }) };
      case 'downloaded':
        return { ...rawView, label: t('updateBadge.downloadedChip', { version: pendingV }), title: t('updateBadge.downloadedTitle', { version: pendingV }) };
      case 'available':
        return { ...rawView, label: t('updateBadge.availableChip', { version: pendingV }), title: t('updateBadge.availableTitle', { version: pendingV }) };
      case 'available-manual':
        return {
          ...rawView,
          label: t('updateBadge.manualChip', { version: pendingV }),
          title: status.reason
            ? t('updateBadge.manualTitleReason', { version: pendingV, reason: status.reason })
            : t('updateBadge.manualTitle', { version: pendingV })
        };
      case 'checking':
        return { ...rawView, label: t('updateBadge.checking'), title: t('updateBadge.checkingTitle', { v: __APP_VERSION__ }) };
      case 'error':
        return { ...rawView, label: t('updateBadge.checkFailed'), title: t('updateBadge.errorTitle', { message: status.message }) };
      case 'not-available':
      case 'just-updated':
        return { ...rawView, label: t('updateBadge.latest'), title: t('updateBadge.latestTitle', { v: __APP_VERSION__ }) };
      case 'idle':
      default:
        return { ...rawView, label: null, title: t('updateBadge.idleTitle', { v: __APP_VERSION__ }) };
    }
  })();

  const onClick = useCallback(async () => {
    if (view.action === 'none' || busy) return;
    setBusy(true);
    try {
      if (view.action === 'check') {
        const res = await window.cth.updateCheckNow();
        // 一次成功的“已是最新”检查必须大声说出来。runCheck 在这解析时已经
        // 落定了 lastStatus，所以读回来：无更新的结果闪现确认；有可用更新
        // 本身就已经够响（胶囊会变），所以不管它。
        if (res?.ok) {
          const cur = await window.cth.updateCurrent?.();
          const st = cur?.state;
          if (!st || st === 'not-available' || st === 'idle' || st === 'just-updated') setCheckedOk(true);
        }
      }
      else if (view.action === 'download') await window.cth.updateDownload();
      else if (view.action === 'restart') await window.cth.updateRestartAndInstall();
      else if (view.action === 'manual' && status) {
        // 这次点击本身就是下载。自动更新住在设置里。
        const url = manualDownloadUrl(status, window.cth.platform, window.cth.arch);
        if (url) {
          await window.cth.updateOpenRelease(url);
          setStarted(pendingVersion(status, __APP_VERSION__));
        }
      }
    } catch { /* 发出的状态携带着失败——这里无事可做 */ }
    setBusy(false);
  }, [view.action, busy, status]);

  const interactive = view.action !== 'none' && !view.busy;
  // 胶囊只在有所求时才配上颜色：ready = mint（来点我）、warn = amber（出了
  // 问题）、busy/idle 留在标题栏自己的灰色里，这样安静的应用看起来和之前
  // 一模一样。
  const chipBg =
    view.tone === 'ready' ? 'var(--cth-mint-light, #d0f0e0)'
      : view.tone === 'warn' ? 'var(--cth-amber-light, #f6e2b3)'
        : 'transparent';

  const pending = pendingVersion(status, __APP_VERSION__);
  const steps = manualInstallSteps(window.cth.platform ?? 'darwin');
  const INK = 'var(--cth-ink-900)';

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
    <button
      className="cth-titlebar-nodrag"
      onClick={() => { void onClick(); }}
      disabled={!interactive}
      title={view.title}
      aria-label={view.label ? `${view.title}` : t('updateBadge.versionCheckAria', { version: __APP_VERSION__ })}
      aria-busy={view.busy || busy}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: view.label && view.tone !== 'idle' ? '2px 8px' : '2px 4px',
        margin: 0,
        background: chipBg,
        border: 'none',
        borderRadius: 2,
        // 'latest' 是版本号后面一个安静的词，不是求点击的胶囊。
        boxShadow: view.label && view.tone !== 'idle' ? 'inset 0 0 0 1px var(--cth-ink-300)' : 'none',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 13,
        lineHeight: '18px',
        color: view.tone === 'idle' ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
        cursor: interactive ? 'pointer' : 'default'
      }}
    >
      <span>v{__APP_VERSION__}</span>
      {view.label && (
        <>
          <span aria-hidden style={{ color: 'var(--cth-ink-500)' }}>·</span>
          <span style={{ fontWeight: view.tone === 'idle' ? 400 : 600 }}>{view.label}</span>
        </>
      )}
    </button>

    {/* 悬浮卡片：点击会做什么、拿到文件后怎么处理，按当前 OS 显示。 */}
    {view.action === 'manual' && hover && !started && (
      <div
        role="tooltip"
        className="cth-titlebar-nodrag"
        style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 400,
          width: 340, padding: '10px 12px',
          background: 'var(--cth-paper-100)', color: INK,
          border: `2px solid ${INK}`, boxShadow: `4px 4px 0 ${INK}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: 1.5, textAlign: 'left'
        }}
      >
        <div style={{ fontFamily: 'var(--cth-font-mono, monospace)', fontWeight: 700, fontSize: 12.5 }}>
          {t('updateBadge.clickToDownload', { pending })}
        </div>
        <div style={{ marginTop: 4, color: 'var(--cth-ink-700)' }}>
          {t('updateBadge.preferSelfUpdate')}
        </div>
        <div style={{
          marginTop: 8, fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 9,
          letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--cth-ink-500)'
        }}>On {steps.os}</div>
        <ol style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--cth-ink-700)' }}>
          {steps.steps.map((t) => <li key={t}>{t}</li>)}
        </ol>
      </div>
    )}

    {/* 点击之后：下载已经在浏览器里，接下来该做什么。 */}
    {started && (
      <div
        role="dialog"
        aria-label={t('updateBadge.installUpdateAria')}
        className="cth-titlebar-nodrag"
        style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 400,
          width: 380, padding: '12px 14px',
          background: 'var(--cth-paper-100)', color: INK,
          border: `2px solid ${INK}`, boxShadow: `4px 4px 0 ${INK}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 12.5, lineHeight: 1.5, textAlign: 'left'
        }}
      >
        <div style={{ fontFamily: 'var(--cth-font-mono, monospace)', fontWeight: 700, fontSize: 13 }}>
          {t('updateBadge.downloading', { version: started })}
        </div>
        <div style={{ marginTop: 6, color: 'var(--cth-ink-700)' }}>
          {t('updateBadge.downloadingBody')}
        </div>
        <ol style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--cth-ink-700)' }}>
          {steps.steps.map((t) => <li key={t}>{t}</li>)}
        </ol>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <PixelButton variant="ghost" size="sm" onClick={() => setStarted(null)}>{t('updateBadge.gotIt')}</PixelButton>
        </div>
      </div>
    )}
    {/* 一次成功的“你已是最新”检查必须可见，否则与一次死点击无法区分。只对
        手动检查的无更新结果显示，并自动关闭。 */}
    {checkedOk && !started && (
      <div
        role="status"
        aria-live="polite"
        className="cth-titlebar-nodrag"
        style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 400,
          width: 300, padding: '10px 12px',
          background: 'var(--cth-paper-100)', color: INK,
          border: `2px solid ${INK}`, boxShadow: `4px 4px 0 ${INK}`,
          fontFamily: 'var(--cth-font-ui)', fontSize: 12.5, lineHeight: 1.5, textAlign: 'left'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--cth-font-mono, monospace)', fontWeight: 700, fontSize: 13 }}>
          <span aria-hidden style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 18, height: 18, borderRadius: 999,
            background: 'var(--cth-mint-light, #d0f0e0)', color: 'var(--cth-ink-900)', fontSize: 12
          }}>&#10003;</span>
          {t('updateBadge.youAreCurrent')}
        </div>
        <div style={{ marginTop: 4, color: 'var(--cth-ink-700)' }}>
          {t('updateBadge.latestChecked', { version: __APP_VERSION__ })}
        </div>
      </div>
    )}
    </span>
  );
}
