/**
 * 发布 drop：一个居中、全幅的"有什么新东西"时刻。
 *
 * 角落 toast 带三条裁剪的要点是 changelog 通知。这是另一回事：一个由发布作者
 * 设计的页面，只显示一次，以作品配得上的尺寸呈现。
 *
 * 它的外观跟随落地页（docs/DESIGN.md），而非应用自己的像素风格、也不是通用的
 * 圆角卡片：暖色纸、方角、粗墨色边框、无模糊的硬偏移阴影，以及一条带三个方点的
 * 深色等宽标题栏。它就是 munderdiffl.in 上的 `.win` 窗口，用户一打开 drop 就
 * 读作他们下载的那个同一款产品。
 *
 * 这里刻意没有浏览器按钮。应用给 drop 装框然后退到一边；发布想提供的每个动作
 * （读说明、star 仓库、加入 Discord）都由作者在 HTML 内部写成普通链接，
 * 由写发布的人控制措辞和位置。
 *
 * 编写的 HTML 运行在带 `default-src 'none'` CSP 和只授予一项能力的 sandbox 的
 * iframe 里：`allow-popups`（为什么其他一切都保持关闭见 shared/releaseDrop.ts）。
 * 这就是让作者写的 `<a target="_blank">` 生效的原因：frame 自己不能导航任何东西，
 * 它只能 ASK 一个窗口，而 main 的 setWindowOpenHandler 会拒绝窗口并只在 URL 是
 * http(s) 时把它交给操作系统浏览器。没有脚本、没有同源、没有表单、没有顶层导航。
 *
 * 有一个后果仍塑造着布局：frame 的高度无法测量（那需要 postMessage 桥，
 * 又需要 allow-scripts）。所以 modal 是一个固定的视口相对盒子，drop 在它内部
 * 分页，而不是让盒子随内容长高。
 *
 * 关闭方式是 Esc、标题栏的关闭按钮，或点击背景。一个没有可见退出的这么大的
 * modal 是陷阱，所以关闭是一个真实控件，即使 drop 本身一个都不带。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildDropSrcDoc } from '../../../shared/releaseDrop';

export interface ReleaseDropProps {
  version: string;
  /** 已从发布正文提取出来的 Authored HTML。 */
  html: string;
  onDismiss: () => void;
}

// 落地页配色（docs/DESIGN.md §2）。在此复述是因为 modal 是应用外壳，够不到
// 站点的样式表；集中放在一处，让 shared/releaseDrop.ts 里 frame 的 token 和这
// 套外壳永不失步。
const PAPER = '#FFFDF7';
const INK = '#1B1B1B';
const INK_FAINT = '#8A867A';
const YELLOW = '#FFCA54';
const SKY = '#72C2DF';
const MAROON = '#B23A4E';
const MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// loader 最长可遮挡 frame 多久，然后无论结果如何都揭开。
//
// 揭开的信号是 iframe ELEMENT 自身的 `onLoad`（它触发在父级，不需要沙箱子级
// 里的脚本权限）——但 `load` 会等子资源，所以带慢速远程图片的 drop 会为整次
// 获取一直撑着 loader。随着 render-blocking 的字体 @import 被移除（shared/releaseDrop.ts），
// 首绘是即时的，onLoad 通常远低于这个上限；该上限只约束病态情况——揭出一张
// 图片仍在陆续到达的纸面页面，好过永无止境的 spinner。2.5s 足够不切断正常的
// onLoad，又足够短到不会读作卡死。
const REVEAL_TIMEOUT_MS = 2500;

export function ReleaseDrop({ version, html, onDismiss }: ReleaseDropProps) {
  const { t } = useTranslation();
  const srcDoc = useMemo(() => buildDropSrcDoc(html), [html]);

  // loader 覆盖 frame 直到它准备好被看到。`revealed` 在两个信号中
  // 先到的一个上锁存为 true——iframe 的 onLoad 或超时上限——
  // 并且从不翻回，所以揭开是单调的、不可能闪烁。
  const [revealed, setReveal] = useState(false);
  const reveal = () => setReveal(true);

  // 超时上限。卸载时清除，让提前关闭的 drop 不再排程任何东西，
  // 并且它与 onLoad 竞争而非取代它：谁先触发谁揭开，另一个对着已锁存的状态
  // 是无害的空操作。
  useEffect(() => {
    const t = setTimeout(reveal, REVEAL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  // Esc 关闭。"稍后"对一次更新来说永远是合理的回答。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      // 背景。点击关闭，与"稍后"同义。应用之上是暖色墨，带站点点状纸网格，
      // 让窗口落在纸上而不是漂浮在灰色虚空里。
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 600,
        background:
          'radial-gradient(rgba(255,253,247,0.16) 1px, transparent 1px) 0 0 / 22px 22px, rgba(27,27,27,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 28,
        // 用子元素上的 auto margin 居中并让遮罩层滚动，这样很高的对话框
        // 不会被从顶部剪掉、滚不回去。
        overflowY: 'auto'
      }}
    >
      <div
        role="dialog"
        aria-label={t('releaseDrop.whatsNew', { version })}
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: 'auto',
          // 一个横版窗口，像站点的 hero 框一样，而不是方卡片。
          // 宽度由高度推导，这样窗口缩放时形状保持不变；`min(…, 92vw)`
          // 是窄窗口的逃生口。
          height: 'min(82vh, 720px)',
          width: 'min(calc(82vh * 1.28), 92vw, 920px)',
          minHeight: 420,
          display: 'flex', flexDirection: 'column',
          background: PAPER,
          // 新粗野主义窗口：方形、3px 墨色边框、无模糊的硬 10px 偏移
          // 阴影。纵深来自偏移，而非抬升。
          border: `3px solid ${INK}`,
          borderRadius: 0,
          boxShadow: `12px 12px 0 ${INK}`,
          overflow: 'hidden',
          fontFamily: MONO
        }}
      >
        {/* 标题栏：站点的 `.win` 头部。深色带、三个方点、
            白色等宽标题，以及外壳唯一拥有的控件：关闭。 */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 14px', background: INK, color: PAPER,
          borderBottom: `3px solid ${INK}`
        }}>
          <span aria-hidden style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <i style={{ width: 10, height: 10, background: YELLOW, display: 'block' }} />
            <i style={{ width: 10, height: 10, background: '#72C2DF', display: 'block' }} />
            <i style={{ width: 10, height: 10, background: '#B23A4E', display: 'block' }} />
          </span>
          <span style={{
            flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, letterSpacing: '.08em',
            textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            Munder Difflin <span style={{ color: YELLOW }}>v{version.replace(/^v/, '')}</span>
            <span style={{ color: INK_FAINT, fontWeight: 500, marginLeft: 10, letterSpacing: '.12em' }}>
              {t('releaseDrop.releaseNotes')}
            </span>
          </span>
          <span aria-hidden style={{
            flexShrink: 0, fontSize: 11, fontWeight: 500, letterSpacing: '.12em',
            color: INK_FAINT, textTransform: 'uppercase'
          }}>
            {t('releaseDrop.esc')}
          </span>
          <button
            onClick={onDismiss}
            aria-label={t('releaseDrop.closeReleaseNotes')}
            title={t('releaseDrop.closeEsc')}
            style={{
              flexShrink: 0, width: 26, height: 26, padding: 0,
              background: PAPER, color: INK, border: `2px solid ${PAPER}`,
              borderRadius: 0, cursor: 'pointer',
              fontFamily: MONO, fontSize: 13, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
          >✕</button>
        </div>

        {/* 框架区域。Relative 让 loader 能正好盖在 drop 上、
            而不盖住标题栏。iframe 始终以全不透明挂载——loader 是一个单独的
            覆盖层，在揭开时被移除，所以揭开失败的模式是短暂多转一圈 spinner，
            绝不是永远藏起的框架。 */}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, background: PAPER }}>
          {/* drop 本身。`allow-popups` 是唯一的授权：它让作者写的
              <a target="_blank"> 能到达操作系统浏览器，且它不带任何脚本、
              同源、表单或导航权限。 */}
          <iframe
            title={`What's new in ${version}`}
            srcDoc={srcDoc}
            sandbox="allow-popups"
            referrerPolicy="no-referrer"
            // onLoad 触发在 PARENT，不需要子级里的脚本权限；
            // 它是诚实的"框架已就绪"信号。上面 effect 里的超时上限
            // 覆盖它被慢速子资源推迟的情况。
            onLoad={reveal}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              border: 'none', background: PAPER
            }}
          />
          {!revealed && <DropLoader />}
        </div>
      </div>
    </div>
  );
}

/** 框架绘制前的窗口。暖色纸（从不是白色闪屏），标题栏的三个方点
 *  按落地页配色行进。纯外壳——它不带任何控件；关闭仍是 Esc / 关闭 / 背景。
 *  框架一揭开它就被移除，所以它只被短暂看到。 */
function DropLoader() {
  const { t } = useTranslation();
  return (
    <div
      // aria-hidden：对话框自身的 label 已经宣告了 drop，一个转瞬即逝的
      // loader 不应被读出来。它位于 frame 之上且不放过任何交互，但下面的
      // frame 在加载完成前本来就是惰性的，所以拦截指针事件在这里不会改变
      // 用户可做的任何事情。
      aria-hidden
      style={{
        position: 'absolute', inset: 0, zIndex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 18, background: PAPER
      }}
    >
      <style>{`
        @keyframes drop-load-pulse {
          0%, 80%, 100% { opacity: .2; transform: translateY(0); }
          40% { opacity: 1; transform: translateY(-4px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .drop-load-dot { animation: none !important; opacity: .55 !important; transform: none !important; }
        }
      `}</style>
      <span aria-hidden style={{ display: 'flex', gap: 8 }}>
        {[YELLOW, SKY, MAROON].map((c, i) => (
          <i
            key={c}
            className="drop-load-dot"
            style={{
              width: 12, height: 12, background: c, display: 'block',
              animation: 'drop-load-pulse 1.1s ease-in-out infinite',
              animationDelay: `${i * 0.16}s`
            }}
          />
        ))}
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 11, fontWeight: 500, letterSpacing: '.18em',
        textTransform: 'uppercase', color: INK_FAINT
      }}>
        {t('releaseDrop.loading')}
      </span>
    </div>
  );
}
