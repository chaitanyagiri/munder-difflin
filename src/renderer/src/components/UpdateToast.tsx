/**
 * 自动更新 toast（v0.3.4）——后台更新器的可见半边。
 *
 * main 的更新器（src/main/updater.ts）在后台下载新版本，并通过 `update:status`
 * 推送两种状态之一：
 *   - 'downloaded'        → 更新已就位；提供“重启以更新”。
 *   - 'available-manual'  → 这个安装不能自更新（win-portable、
 *                           更新器错误）；提供到发布页的链接。
 *
 * 镜像 CompletionToast：自包含 + 自订阅，在 App.tsx 里挂载一次，空闲时什么
 * 都不渲染。安装永远是用户发起的——“稍后”只是把 toast 藏到下次应用启动
 * （或 6 小时后的重新检查）为止。
 *
 * ─── v0.4.4: “有什么新内容” ─────────────────────────────────────────────────
 * 两种状态原本都已经携带 `notes`（GitHub 发布正文），toast 却把它丢在地上，
 * 所以这个应用唯一会弹出的通知除了版本号什么都不说。现在它渲染那段正文的摘要
 * ——src/shared/releaseNotes.ts 里的 summarizeReleaseNotes() 负责解析，放在
 * 那里而不是这里，是为了可以在没有渲染器的情况下做单元测试。
 *
 * 这个区块遵守三条规则：
 *   1. 没有 notes 就没有区块。缺失、为空或纯结构的发布正文会得到一个空摘要，
 *      toast 渲染得和之前完全一样——没有孤儿标题，没有移动的按钮。多数正文
 *      都是这样，所以这是常见路径，不是边界情况。
 *   2. 高度有界。摘要上限在 releaseNotes.ts 里，这里再用滚动夹紧，因为一个
 *      随发布说明增长而增长的 toast 是一个盖住应用的对话框。
 *   3. 星标请求至多显示一次，不是每个版本一次。重复请求是那种会让通知被
 *      静音的唠叨，那会夺走更新器唯一的渠道。参见下面的 STAR_ASK_KEY。
 *
 * 没有新的 IPC，也没有新的网络调用：“read more”复用 `updateOpenRelease`
 * （手动状态的按钮一直在用的同一个桥），星标链接走现有的 `openExternal` 打开器。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Icon';
import { summarizeReleaseNotes } from '@shared/releaseNotes';
import { extractDropHtml } from '@shared/releaseDrop';
import { ReleaseDrop } from '@/components/ReleaseDrop';
import type { UpdateStatus } from '@shared/updateState';

/** toast 是“响”的半边——只为用户必须行动的那两种状态打断。其它一切（检查中、
 * 可用、下载进度、错误）都安静地待在徽章里，挨着 logo。 */
type ToastStatus = Extract<UpdateStatus, { state: 'downloaded' | 'available-manual' | 'just-updated' }>;

function toastable(s: UpdateStatus): ToastStatus | null {
  return s.state === 'downloaded' || s.state === 'available-manual' || s.state === 'just-updated' ? s : null;
}

const GITHUB_REPO_URL = 'https://github.com/chaitanyagiri/munder-difflin';
/** 只作为 `href` 使用——点击由 `updateOpenRelease` 处理，它在 main 里把
 * `undefined` 解析为这同一个页面。 */
const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;

/** 星标请求的一次性标记。`cth.` 前缀的 localStorage 是这个应用对纯渲染器
 *  UI 记忆的约定（见 App.tsx 的 skipHivePickerOnce 和 design/theme.ts）——
 *  而 SettingsModal 的“重置并重新开始”会清掉每个 `cth.` 键，这是对的：清空
 *  的安装就是一个还没被问过的新用户。它刻意不是一个 HarnessConfig 键；那个
 *  文件是 agent 运行时的契约，在 main/preload/renderer 间手工镜像，一个
 *  装饰性的提示不属于它。 */
const STAR_ASK_KEY = 'cth.updateStarAsked';

function starAskPending(): boolean {
  try {
    return window.localStorage.getItem(STAR_ASK_KEY) !== '1';
  } catch {
    // 存储不可用意味着我们无法兑现“至多一次，永远”——所以宁可问零次，
    // 也不要冒着在每次更新时都问的风险。
    return false;
  }
}

function markStarAsked(): void {
  try { window.localStorage.setItem(STAR_ASK_KEY, '1'); } catch { /* 无事可做 */ }
}

export function UpdateToast() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ToastStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // 每个窗口只读一次，这样下面持久化标记不会让链接从正看着它的人光标下消失。
  const [starAsk] = useState(starAskPending);
  /** 那次请求花在哪个版本上。存版本而不是布尔，因为一持久化就翻转布尔会把链接
   *  从正看着它的人光标下拽走——用版本可以让它停在正显示它的那个 toast 上，
   *  并从任何后来的 toast 上撤掉。 */
  const [starSpentOn, setStarSpentOn] = useState<string | null>(null);

  useEffect(() => window.cth.onUpdateStatus?.((next) => {
    const t = toastable(next);
    // 一个不可 toast 的状态（比如一次重新检查）绝不能抹掉用户还没回答的 toast
    // ——只有新的可行动状态才替换它。
    if (t) setStatus(t);
  }), []);

  // main 可能在这个窗口存在之前就发出过（上次会话下载的更新，或仅开发用的
  // MD_DROP_PREVIEW 启动钩子），而没人听的推送已经没了。挂载时拉一次最后状态，
  // 这样那个状态不会丢。
  useEffect(() => {
    let alive = true;
    void window.cth.updateCurrent?.().then((cur) => {
      const t = toastable(cur);
      if (alive && t) setStatus((prev) => prev ?? t);
    }).catch(() => { /* 没什么可显示的 */ });
    return () => { alive = false; };
  }, []);

  // 设置的 hero 卡片会请求重新打开发布说明。这个界面持有最后的状态和 drop
  // 渲染器，所以由它来回应，而不是二者重复。“稍后”会清掉本地副本而 main 仍
  // 持有它，所以用 `updateCurrent()` 而不是记住的状态——关闭一次发布绝不能让
  // 它之后变得不可读。当真没什么可显示（开发构建，或已装最新版）时，诚实的
  // 回答是发布页，而不是一个空弹窗。
  useEffect(() => {
    const onShow = async () => {
      try {
        const cur = await window.cth.updateCurrent();
        const t = toastable(cur);
        if (t) { setStatus(t); return; }
      } catch { /* 落到页面 */ }
      void window.cth.updateOpenRelease();
    };
    window.addEventListener('cth:show-release-notes', onShow);
    return () => window.removeEventListener('cth:show-release-notes', onShow);
  }, []);

  const notes = useMemo(() => summarizeReleaseNotes(status?.notes), [status?.notes]);
  /** 发布正文里一段作者撰写的 <!-- drop --> 块，会把这一刻从角落 toast 升级成
   *  居中的发布页。没有它（迄今发布的每个版本都没有），下面的一切行为都和之前
   *  完全一样——摘要路径保持为默认路径，而不是一个没人走的回退。 */
  const dropHtml = useMemo(() => extractDropHtml(status?.notes), [status?.notes]);
  const version = status?.version ?? null;
  // 显示即视为已花费。不是“已点击”——用户读过并忽略的请求也是回答，下个版本
  // 再问正是规则 3 禁止的。
  // `notes.length > 0` 一直代替“这个 toast 有内容可显示”。一个只有 drop 的
  // 发布正文摘要出零个圆点，却同时是我们发布过最丰富的发布页，所以它也必须
  // 算数——否则星标请求恰恰会在最值得加星的那些发布上静默消失。
  // drop 不再算数。星标请求是按钮，drop 没有，把一次一次性请求花在一个没法
  // 显示它的界面上等于白烧——想要星的 drop 发布会把自己链接写进自己的 HTML。
  const showStar = starAsk && notes.length > 0
    && (starSpentOn === null || starSpentOn === version);
  useEffect(() => {
    if (showStar && version && starSpentOn === null) {
      setStarSpentOn(version);
      markStarAsked();
    }
  }, [showStar, version, starSpentOn]);

  if (!status) return null;

  /** 先关闭通知，再让 main 退出并安装。退出路径在 agent 运行时抬起
   *  kill-and-quit 警告，而在它后面留一个“正在重启…”的通知只是让用户同时读
   *  两样东西。（警告凌驾于每个弹窗之上是另一个修复——这个修复是关于不要一次
   *  问两个问题。）如果 main 报告它无法退出，通知会回来让用户重试；用户对警告
   *  点 CANCEL 不是失败，通知保持关闭。 */
  const restart = async () => {
    const prev = status;
    setBusy(true);
    setStatus(null);
    try {
      const res = await window.cth.updateRestartAndInstall();
      if (!res.ok) { setStatus(prev); setBusy(false); }
    } catch { setStatus(prev); setBusy(false); }
  };

  /** 与手动状态的按钮相同的调用：main 把 `undefined` 解析为发布页，并拒绝
   *  这个 repo 之外的任何 URL。 */
  const openRelease = () => {
    void window.cth.updateOpenRelease(
      status.state === 'available-manual' ? (status.downloadUrl ?? status.url) : undefined
    );
  };
  /** 当发布为这台机器携带一个安装器时为真，这样按钮可以承诺一次下载，而不是
   *  一个要人去翻找的页面。 */
  const hasDownload = status.state === 'available-manual' && !!status.downloadUrl;

  // 一段作者撰写的发布：把整个时刻交给居中的 drop，而不是角落 toast。除了
  // 内容什么都不传——drop 不携带应用按钮，它自己的链接走操作系统浏览器出去。
  //
  // 重启以安装并不会随按钮丢失：autoInstallOnAppQuit 是关的，所以更新需要一个
  // 显式重启，而标题栏的 UpdateBadge（以及 设置 → 更新）在被关闭后仍然提供它。
  if (dropHtml && version) {
    return (
      <ReleaseDrop
        version={version}
        html={dropHtml}
        onDismiss={() => setStatus(null)}
      />
    );
  }
  // 刚更新完，且这次发布没有作者撰写的内容：无话可说。
  if (status.state === 'just-updated') return null;

  const buttonStyle: React.CSSProperties = {
    padding: '3px 10px 1px',
    background: 'var(--cth-mint-light, #d0f0e0)',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
    fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
  };

  const linkStyle: React.CSSProperties = {
    fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)',
    textDecoration: 'underline', cursor: 'pointer'
  };

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 400,
      maxWidth: 340,
      background: 'var(--cth-cream-50)',
      boxShadow: '0 0 0 2px var(--cth-ink-900), 4px 5px 0 0 rgba(26,19,32,0.25)',
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 8,
      fontFamily: 'var(--cth-font-ui)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="sparkle" />
        <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontWeight: 600 }}>
          {status.state === 'downloaded'
            ? t('updateToast.downloadedTitle', { version: status.version })
            : t('updateToast.availableTitle', { version: status.version })}
        </span>
      </div>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
        {status.state === 'downloaded'
          ? t('updateToast.downloadedBody')
          : t('updateToast.manualBody')}
      </span>

      {notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
            color: 'var(--cth-ink-500)', textTransform: 'uppercase'
          }}>
            {t('updateToast.whatsNew')}
          </div>
          {/* 摘要已在上限 ~280 字符；这个 clamp 是第二道保险，留给哪天发布正文
              骗过解析器的时候。 */}
          <ul style={{
            listStyle: 'none', margin: 0, padding: '0 0 0 2px',
            maxHeight: 96, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 4
          }}>
            {notes.map((line, i) => (
              <li key={i} style={{
                display: 'flex', gap: 6,
                fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)'
              }}>
                <span aria-hidden style={{ color: 'var(--cth-ink-300)' }}>•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a
              href={status.state === 'available-manual' ? status.url : GITHUB_RELEASES_URL}
              onClick={(e) => { e.preventDefault(); openRelease(); }}
              style={linkStyle}
            >{t('updateToast.readMore')}</a>
            {showStar && (
              <a
                href={GITHUB_REPO_URL}
                onClick={(e) => { e.preventDefault(); void window.cth.openExternal(GITHUB_REPO_URL); }}
                style={linkStyle}
              >{t('updateToast.starOnGitHub')}</a>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => setStatus(null)}
          style={{ ...buttonStyle, background: 'var(--cth-cream-100)' }}
        >
          {t('updateToast.later')}
        </button>
        {status.state === 'downloaded' ? (
          <button onClick={restart} disabled={busy} style={buttonStyle}>
            {busy ? t('updateToast.restarting') : t('updateToast.restartToUpdate')}
          </button>
        ) : (
          <button
            onClick={openRelease}
            style={buttonStyle}
          >
            {hasDownload ? t('updateToast.downloadVersion', { version: status.version }) : t('updateToast.openReleases')}
          </button>
        )}
      </div>
    </div>
  );
}
