/**
 * RELEASE DROPS —— 一段整版、精心编排的"新功能"时刻，而不是角落里
 * 只有三条被截断项目的气泡提示。
 *
 * 作者在 GitHub release 正文中一个标记块内编写普通 HTML。
 * 标记之间的内容就是这段 drop；正文其余部分对在 github.com 上阅读 release
 * 的人来说仍是普通 markdown，他们应该还能看到一页合理的页面。没有 drop 块
 * 的 release 会回退到现有的摘要气泡，因此这纯粹是增量式的——没有任何
 * release 必须改动。
 *
 *   <!-- drop -->
 *   <section class="hero"> … any HTML/CSS, <img>, <video> … </section>
 *   <!-- /drop -->
 *
 * ── 为何此文件如此多疑 ──────────────────────────────────────────────
 * 它会在应用内部渲染远程、作者控制的标记。否则它会落入的 renderer 上桥接
 * 着 `window.cth`——spawnPty、writeFileText、updateConfig。在该上下文中执行
 * 脚本不是 bug，而是在用户的机器上以应用的完整权限执行任意代码，任何能
 * 发布 release（或对请求做中间人攻击）的人都能触达。
 *
 * 因此 drop 绝不在应用的 renderer 中运行。它被交给一个 iframe，其 sandbox
 * 只授予一件事——`allow-popups`——并且在其内部还有一条 `default-src 'none'`
 * 的 CSP，独立地封锁脚本。两个互不相关的机制，单独任何一个都足够。
 * `allow-scripts` 绝不能与 `allow-same-origin` 一起加：那一对会让 frame
 * 够到外面并移除自己的 sandbox。
 *
 * 为什么是 `allow-popups` 而不是别的。该弹窗刻意不携带任何自己的按钮，
 * 因此 release 想提供的动作在这里被编写成普通的 `<a target="_blank">` 链接。
 * 弹窗是兑现它的最弱方式：frame 不能导航自己或顶层窗口，它只能请求一个
 * 新窗口，而 main 的 setWindowOpenHandler 会拒绝该窗口，并且只在它是
 * http(s) 时才把 URL 交给操作系统浏览器。两边都不会运行脚本。没有
 * target="_blank" 的同 frame `<a href>` 仍然什么都不做，这是正确的——
 * drop 绝不能能够替换自身。
 *
 * 什么能工作，也就是一个发布页真正需要的全部：图片、视频、音频、web 字体、
 * 渐变、变换、关键帧动画、grid，以及指向外部的 target="_blank" 链接。
 * 什么不能：脚本、表单、同 frame 或顶层导航，以及 http 和 https 之外的
 * 任何 URL scheme。
 */

import { DROP_FONT_WOFF2_BASE64 } from './dropFonts';

const DROP_OPEN = '<!-- drop -->';
const DROP_CLOSE = '<!-- /drop -->';

/**
 * 从 release 正文中取出作者编写的 HTML；没有时返回 null。
 * 刻意保持字面：一对精确的标记，从第一个开始标记到下一个结束标记。
 * 任何不平衡都返回 null，由调用方回退到摘要——
 * 半解析的 drop 会在每个用户面前渲染成损坏的标记。
 */
export function extractDropHtml(body: string | null | undefined): string | null {
  if (typeof body !== 'string') return null;
  const start = body.indexOf(DROP_OPEN);
  if (start === -1) return null;
  const from = start + DROP_OPEN.length;
  const end = body.indexOf(DROP_CLOSE, from);
  if (end === -1) return null;
  const html = body.slice(from, end).trim();
  return html.length > 0 ? html : null;
}

/**
 * 只是纵深防御——sandbox 和 CSP 才是真正的控制。
 *
 * 它的存在是因为 CSP 拼写错误或未来的 `allow-scripts` 否则会成为单点故障，
 * 而不是因为正则能胜任 HTML 清理器：它不能，这里的东西也绝不能被当作清理器
 * 依赖。它移除的是若主控制失效时最具破坏性的那些形态。
 */
function stripActiveContent(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    // on*= 处理器，带引号或裸写。同样被 CSP 封锁（内联处理器属于 script，
    // 而 script-src 回退到 default-src 'none'）。
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // 远程 `@import` 会阻塞渲染：frame 在样式表解析完成前什么都不画，
    // 而在 fonts.googleapis.com 被屏蔽（中国）的网络上那就是一次 TCP 超时——
    // 几十秒的白屏。收紧的 CSP（style-src 'unsafe-inline'，font-src data:）
    // 已经会让这样的请求快速失败而不是让它挂起，但我们也直接把这条规则去掉，
    // 让 frame 根本不去尝试，并且不记录任何 CSP 违规。只有远程的 import 被
    // 去掉——`data:` 的 import 不依赖任何东西，保留下来。设计字体在
    // FRAME_FONT_CSS 中自托管，因此作者的 `var(--font-sans)` / `var(--font-mono)`
    // 无论怎样都零网络地正确渲染。
    //
    // 两种形式，且都消费整条语句：url 可能自带 `;`（字体 url 形如
    // `…wght@400;500;600…`），所以朴素的 `[^;]*` 会在 url 内部停下，
    // 在身后留下一段损坏的 CSS。
    .replace(/@import\s+(?:url\(\s*)?(["'])https?:\/\/(?:(?!\1)[\s\S])*\1\s*\)?\s*[^;]*;?/gi, '')
    .replace(/@import\s+url\(\s*https?:\/\/[^)]*\)\s*[^;]*;?/gi, '');
}

/** 设计字体，以 `data:` URI 自托管，因此 frame 无需网络。
 *  Inter 对应 `--font-sans`（drop 声明的 Geist 替身），JetBrains Mono 精确
 *  对应 `--font-mono`；两者都是可变字体，因此一个字面各覆盖 400–700 字重。
 *  `font-display: swap` 意味着文本先以回退字体绘制，字体就绪后再回流——但字体
 *  是 data: URI，所以"就绪"与初始绘制在同一帧，没有任何需要等待的东西。 */
const FRAME_FONT_CSS = `
  @font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url(data:font/woff2;base64,${DROP_FONT_WOFF2_BASE64.inter}) format('woff2');
  }
  @font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url(data:font/woff2;base64,${DROP_FONT_WOFF2_BASE64.jetbrainsMono}) format('woff2');
  }
`;

/** 镜像进 frame 的设计令牌。drop 无法跨源读取应用的 CSS 变量，
 *  所以把值得有的这些重述在这里——写 `var(--ink)` 的作者免费获得应用的调色板，
 *  而完全自定的 drop 可以完全忽略它们。 */
const FRAME_BASE_CSS = `
  /* 着陆页调色板（docs/DESIGN.md §2）：暖纸底色、近黑色墨色、一枚黄色 CTA、天蓝色高亮短语、酒红色品牌色。方角 + 硬偏移阴影是视觉基调；--radius 故意设为 0。--accent 和 --line 保留为别名，让老 drop 仍可解析。 */
  :root {
    --paper: #FFFDF7;
    --cream: #F5F2E8;
    --cream-2: #F5ECD7;
    --white: #FFFFFF;
    --ink: #1B1B1B;
    --ink-dim: #57544C;
    --ink-faint: #8A867A;
    --ink-soft: #57544C;
    --yellow: #FFCA54;
    --sky: #72C2DF;
    --maroon: #B23A4E;
    --lilac: #E4DEFB; --peach: #FBDDBE; --mint: #D6F3E1;
    --tan: #F1E6CC; --rose: #FBE0DF; --sky-soft: #DCEFF7;
    --accent: #B23A4E;
    --line: rgba(27,27,27,0.16);
    --border: 2px solid var(--ink);
    --border-bold: 3px solid var(--ink);
    --shadow-card: 10px 10px 0 var(--ink);
    --shadow-card-sm: 6px 6px 0 var(--ink);
    --shadow-btn: 4px 4px 0 var(--ink);
    --shadow-chip: 3px 3px 0 var(--ink);
    --radius: 0px;
    --pad: clamp(24px, 4.5vw, 48px);
    --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Geeza Pro", "Noto Naskh Arabic", monospace;
    --font-sans: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", sans-serif;
    --font-ui: var(--font-sans);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--paper); color: var(--ink);
    font-family: var(--font-sans);
    font-size: 15px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    /* frame 独占滚动：外层弹窗 chrome 保持静止，drop 内容在内部滚动——这正是长发布页能在固定高度对话框中可行用的原因。 */
    overflow-x: hidden;
  }

  /* 默认布局。作者只需写语义化 HTML——一个 eyebrow、一个 h1、一段 lede、一个 <ul class="features">——即可获得设计效果，无需写一行 CSS。此处所有样式均可覆盖。 */
  .drop { padding: var(--pad); max-width: 780px; margin: 0 auto; }

  .eyebrow {
    font-family: var(--font-mono);
    font-size: 11px; font-weight: 500; letter-spacing: .28em; text-transform: uppercase;
    color: var(--ink-faint); margin: 0 0 14px;
  }
  h1, h2, h3 { font-family: var(--font-mono); }
  h1 {
    font-size: clamp(1.9rem, 5vw, 2.9rem); line-height: 1.04;
    letter-spacing: -0.04em; font-weight: 600; margin: 0 0 .35em;
    text-wrap: balance;
  }
  h2 {
    font-size: clamp(1.1rem, 2.4vw, 1.4rem); line-height: 1.15;
    letter-spacing: -0.03em; font-weight: 600; margin: 0 0 .3em;
  }
  .lede {
    font-size: clamp(1rem, 1.9vw, 1.15rem); line-height: 1.5;
    color: var(--ink-dim); max-width: 58ch; margin: 0 0 2em;
    text-wrap: pretty;
  }
  p { margin: 0 0 1em; }
  a { color: var(--ink); text-decoration-thickness: 2px; text-underline-offset: 3px; }
  a:hover { color: var(--maroon); }
  hr { border: none; border-top: 2px solid var(--ink); margin: 2.2em 0; }

  /* 特性列表：堆叠行，每行带独立媒体块。 */
  ul.features { list-style: none; padding: 0; margin: 0; display: grid; gap: clamp(28px, 5vw, 48px); }
  ul.features > li { display: grid; gap: 14px; }
  ul.features p { color: var(--ink-dim); margin: 0; max-width: 58ch; }

  /* 媒体元素。图片、视频和占位符共用同一轮廓，这样用占位符搭建的 drop 在真实资源就位后外观完全一致。 */
  img, video, canvas, svg, .placeholder {
    display: block; width: 100%; max-width: 100%; height: auto;
    border-radius: 0; border: var(--border);
  }
  figure { margin: 0; }
  figcaption { font-family: var(--font-mono); font-size: 12px; color: var(--ink-faint); margin-top: 10px; }

  /* 即插即用占位符：<div class="placeholder" data-label="Hero"></div> 纯 CSS 实现，无需任何资源，对用户永远不可能 404。 */
  .placeholder {
    aspect-ratio: 16 / 9;
    display: flex; align-items: center; justify-content: center;
    background:
      repeating-linear-gradient(135deg,
        rgba(27,27,27,0.04) 0 10px, rgba(27,27,27,0.07) 10px 20px);
    color: var(--ink-faint); font-family: var(--font-mono); font-size: 12px; letter-spacing: .08em;
  }
  .placeholder::after { content: attr(data-label); }
  .placeholder.square { aspect-ratio: 1 / 1; }
  .placeholder.wide { aspect-ratio: 21 / 9; }

  /* 故意不做主题适配。drop 是作者创作的作品，是发布页而非应用 chrome，它必须对所有接收者看起来一样。自动的深色反转会悄无声息地重绘作者从未见过的配色方案，毁掉任何针对浅色背景选择的图片。想要深色的 drop 显式声明即可。 */
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
`;


/**
 * v0.4.4 的 release 页面——也是 drop 能做到什么的参照。
 *
 * 六个页面带可用的 Back/Next，不用一行 JavaScript 构建，因为 frame 运行在
 * `sandbox=""` 下，里面永远不会执行任何东西。翻页器是 radio input 加
 * `:checked ~` 兄弟选择器：`<label for>` 是真正的点击目标，勾选 radio 不是
 * 脚本，分页由 CSS 完成。在真实的沙箱 iframe 里验证过，不是想当然。
 *
 * 导航在每页内重复而不是共享，这样每页自己指名相邻页，任何选择器都不必
 * 计算"当前 + 1"。
 *
 * 每页的尺寸都正好放进方形弹窗而不滚动——滚动的页面会在折线处把句子切成
 * 两半，这是一个发布页绝不能做的事。正因为这个约束，结束语才是独立的一页，
 * 而不是列表的尾巴。
 *
 * 保留为 simulate 载荷，这样 `updateSimulate({ drop: true })` 渲染出的
 * 正是 release 正文里发布的内容。
 */
export const DEFAULT_DROP_HTML = `<style>
  html, body { height: 100%; }
  body { overflow: hidden; }
  .stage { height: 100%; }
  .pg { position: absolute; opacity: 0; pointer-events: none; }

  .page { display: none; height: 100%; flex-direction: column;
          padding: clamp(24px, 4vw, 46px); }
  #pg1:checked ~ .stage .p1,
  #pg2:checked ~ .stage .p2,
  #pg3:checked ~ .stage .p3,
  #pg4:checked ~ .stage .p4,
  #pg5:checked ~ .stage .p5,
  #pg6:checked ~ .stage .p6 { display: flex; animation: rise .34s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  .content { flex: 1; min-height: 0; overflow-y: auto; }
  .center { display: flex; flex-direction: column; justify-content: center; }
  .nav { flex-shrink: 0; display: flex; align-items: center; gap: 12px;
         padding-top: 16px; margin-top: 12px; border-top: 1px solid var(--line); }
  .dots { display: flex; gap: 7px; flex: 1; }
  .dot { width: 7px; height: 7px; border-radius: 999px; background: rgba(20,19,26,.16);
         cursor: pointer; transition: background .2s, transform .2s; }
  .dot:hover { background: rgba(20,19,26,.34); }
  .dot.on { background: var(--accent); transform: scale(1.25); }
  .btn { cursor: pointer; border-radius: 999px; font-size: 13.5px; font-weight: 600;
         padding: 9px 18px; border: 1px solid var(--line); color: var(--ink-soft);
         user-select: none; transition: background .16s, color .16s; }
  .btn:hover { background: rgba(20,19,26,.04); }
  .btn.primary { background: var(--ink); border-color: var(--ink); color: #FBFAF8; }
  .btn.primary:hover { background: #2a2733; }

  .kicker { font-size: 11.5px; font-weight: 700; letter-spacing: .14em;
            text-transform: uppercase; color: var(--accent); margin: 0 0 14px; }
  h1 { font-size: clamp(1.8rem, 4.4vw, 2.7rem); }
  .lede { margin-bottom: 1.4em; }
  .big { font-size: clamp(3.2rem, 10vw, 5.4rem); line-height: .92; letter-spacing: -.045em;
         font-weight: 700; margin: 0 0 .1em;
         background: linear-gradient(135deg, #14131A 20%, #1B7F5A 115%);
         -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 24px;
          padding-top: 18px; border-top: 1px solid var(--line); }
  .stat b { display: block; font-size: 1.5rem; letter-spacing: -.03em; font-weight: 680; }
  .stat span { font-size: 12px; color: var(--ink-soft); }

  .tag { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .1em;
         text-transform: uppercase; color: var(--accent);
         background: rgba(27,127,90,.09); padding: 4px 9px; border-radius: 999px; }
  .quote { border-left: 2px solid var(--accent); padding-left: 15px; margin: 18px 0 0;
           color: var(--ink-soft); font-size: 14.5px; }
  .rows { list-style: none; padding: 0; margin: 0; }
  .rows li { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: baseline;
             padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .rows i { font-style: normal; font-size: 10px; font-weight: 700; letter-spacing: .09em;
            text-transform: uppercase; color: var(--ink-soft); }
  .rows b { font-weight: 620; }
  .rows p { margin: 1px 0 0; color: var(--ink-soft); font-size: 12.5px; }
  .card { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
  .card h2 { margin: 10px 0 .2em; font-size: 1.15rem; }
  .card p { margin: 0; color: var(--ink-soft); font-size: 13.5px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  /* 16:10 而非 4:3——更高的比例让第二行越过折叠线，而一个会滚动的 drop 页会在边界处把句子切成两半。 */
  .split .placeholder { aspect-ratio: 16 / 10; }
</style>

<input class="pg" type="radio" name="pg" id="pg1" checked>
<input class="pg" type="radio" name="pg" id="pg2">
<input class="pg" type="radio" name="pg" id="pg3">
<input class="pg" type="radio" name="pg" id="pg4">
<input class="pg" type="radio" name="pg" id="pg5">
<input class="pg" type="radio" name="pg" id="pg6">

<div class="stage">

  <section class="page p1">
    <div class="content center">
      <p class="kicker">Munder Difflin</p>
      <h1 class="big">0.4.4</h1>
      <p class="lede" style="font-size:clamp(1.05rem,2.1vw,1.3rem);margin-top:.5em">
        The release where Windows finally joined the floor — and the first run
        stopped quietly failing.
      </p>
      <div class="stat">
        <div><b>27</b><span>fixes</span></div>
        <div><b>4</b><span>new surfaces</span></div>
        <div><b>1</b><span>platform unbroken</span></div>
      </div>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot on" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn primary" for="pg2">Start &rarr;</label>
    </div>
  </section>

  <section class="page p2">
    <div class="content">
      <p class="kicker">The headline</p>
      <h1>Agents can talk to each other on Windows.</h1>
      <p class="lede">Roughly half of all downloads run on Windows, where
      agent-to-agent messaging had never worked at all.</p>
      <div class="placeholder" data-label="Two agents messaging" style="aspect-ratio:24/9"></div>
      <p class="quote">Every agent booted, rendered, and looked completely healthy.
      None of them had been told they had an inbox.</p>
      <p style="margin-top:16px;color:var(--ink-soft);font-size:14px">Any CLI that is
      not an .exe was launched through cmd.exe, which cuts a multi-line argument at
      its first newline — taking the protocol block with it. Spawns now launch the
      real interpreter with an argument array, so the whole prompt survives.</p>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot on" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg1">&larr; Back</label>
      <label class="btn primary" for="pg3">Next &rarr;</label>
    </div>
  </section>

  <section class="page p3">
    <div class="content">
      <p class="kicker">The first five minutes</p>
      <h1>Setup finishes. The floor wakes up.</h1>
      <p class="lede">Four separate bugs sat on the very first thing a new user does.</p>
      <ul class="rows">
        <li><i>Wizard</i><div><b>The suggested folder works</b>
          <p>Accepting ~/HarnessAgents stored a literal tilde and died on ENOENT.
          It now resolves to a real path — and the field actually suggests it.</p></div></li>
        <li><i>Wizard</i><div><b>It tells you at step one</b>
          <p>An empty folder used to walk you through all four steps before bouncing
          you back. The panel no longer overflows a short screen either.</p></div></li>
        <li><i>Hive</i><div><b>Services start at setup, not next launch</b>
          <p>On a fresh install the message router, hooks and telemetry stayed dead
          until you restarted — so mail never moved and agents never reported.</p></div></li>
        <li><i>Agents</i><div><b>Restart &amp; Continue has something to resume</b>
          <p>The live session id is recorded from a second source, so continuing
          works even when a hook never lands.</p></div></li>
      </ul>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot on" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg2">&larr; Back</label>
      <label class="btn primary" for="pg4">Next &rarr;</label>
    </div>
  </section>

  <section class="page p4">
    <div class="content">
      <p class="kicker">New</p>
      <h1>Four things that were not here before.</h1>
      <div class="split">
        <div class="card">
          <span class="tag">Skills</span>
          <h2>Every skill your agents can use</h2>
          <p>What is installed across Claude Code, OpenCode and Codex — and a
          browsable catalog of 227 more, with search, filters, install and
          uninstall.</p>
        </div>
        <div class="card">
          <span class="tag">Prerequisites</span>
          <h2>Whether you actually have the tools</h2>
          <p>MemPalace, uv, git and every agent engine, with live status and where
          each one sits on disk. One button asks Michael to fill in the gaps.</p>
        </div>
        <div class="card">
          <span class="tag">Release drops</span>
          <h2>This page</h2>
          <p>Update notes used to be three clipped bullets in the corner. A release
          can now carry its own designed page, and you are reading the first one.</p>
        </div>
        <div class="card">
          <span class="tag">Dark mode</span>
          <h2>Rebuilt for reading</h2>
          <p>Every control border measured under 2:1 against its background, so the
          edges defining them were invisible. Re-tuned and measured, not eyeballed.</p>
        </div>
      </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot on" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg3">&larr; Back</label>
      <label class="btn primary" for="pg5">Next &rarr;</label>
    </div>
  </section>

  <section class="page p5">
    <div class="content">
      <p class="kicker">Everything else</p>
      <h1>The rest of the list.</h1>
      <ul class="rows">
        <li><i>Terminal</i><div><b>Copy comes back clean</b>
          <p>The quote rail is stripped and terminals run in UTF-8, so an em dash
          survives the trip to another app.</p></div></li>
        <li><i>Terminal</i><div><b>Dictation pastes what you just said</b></div></li>
        <li><i>IDE</i><div><b>Images open as images</b>
          <p>PNG, SVG and embedded screenshots render. The title names the agent.</p></div></li>
        <li><i>Agents</i><div><b>Restart &amp; Continue revives a dead agent</b></div></li>
        <li><i>Agents</i><div><b>Grok 4.6 in the model picker</b></div></li>
        <li><i>Agents</i><div><b>OpenCode runs the model you actually have</b></div></li>
        <li><i>Board</i><div><b>Task cards stop going missing</b></div></li>
        <li><i>Hive</i><div><b>A wake nudge survives an odd message id</b></div></li>
        <li><i>Hive</i><div><b>Compact fires once, not every hour</b></div></li>
        <li><i>Hive</i><div><b>The cost ledger is out of your git history</b></div></li>
        <li><i>Office</i><div><b>The floor stops rendering when nobody is looking</b></div></li>
        <li><i>Layout</i><div><b>Michael sits first on the dock again</b></div></li>
      </ul>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot on" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg4">&larr; Back</label>
      <label class="btn primary" for="pg6">Next &rarr;</label>
    </div>
  </section>

  <section class="page p6">
    <div class="content center">
      <p class="kicker">One last thing</p>
      <h1 style="font-size:clamp(1.9rem,4.6vw,2.9rem)">Thank you for running this
      on your own machine.</h1>
      <p class="lede" style="margin-top:.4em">Every agent here starts on your
      hardware, in your folders, under your keys. Nothing about that changes.</p>
      <p class="quote">If it has been useful, a star is the entire marketing budget.
      The button is just below this page.</p>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot on" for="pg6"></label>
      </div>
      <label class="btn" for="pg5">&larr; Back</label>
      <label class="btn" for="pg1">Start over</label>
    </div>
  </section>

</div>`;

/**
 * 把作者编写的 HTML 包装成一份完整、自包含的 `srcdoc` 文档。
 *
 * CSP 是承重的那一行。`default-src 'none'` 意味着省略的指令是被拒绝而非
 * 允许，因此 script-src、connect-src、frame-src 和 object-src 无需点名即全部
 * 关闭。只有发布页需要的媒体被重新打开，且只通过 https 或 data:。
 */
export function buildDropSrcDoc(html: string): string {
  const csp = [
    "default-src 'none'",
    'img-src https: data: blob:',
    'media-src https: data: blob:',
    // style-src 去掉 `https:`：作者编写的 `<style>` 是 'unsafe-inline'，但远程
    // 样式表或 `@import url(https://…)` 被拒绝。那就是白屏的修复——远程字体
    // 样式表会阻塞渲染，允许它就意味着 frame 会挂在一个慢速或被屏蔽的
    // fonts.googleapis.com 上（中国：白色的 TCP 超时）。被 CSP 拒绝后，同样的
    // import 会快速失败，frame 立即用回退字体绘制。
    "style-src 'unsafe-inline'",
    // font-src 也去掉 `https:`：字体以 data: URI 自托管（FRAME_FONT_CSS），
    // 因此没有任何合法东西需要网络，远程 @font-face src 也无法再拖住一次绘制。
    'font-src data:'
    // 没有 script-src、connect-src、form-action：default-src 'none' 会拒绝
    // 它们。在这里写明，这样未来的编辑必须删掉一条注释才能放宽它们。
    //
    // CSP 的 `sandbox` 指令刻意不列出：通过 <meta> 交付时它会被忽略（按规范
    // 仅限头部），所以写上它会被读作第三个控制却什么都不做。iframe 自己的
    // sandbox 属性才是真正的那个。
  ].join('; ');
  // 没有指向字体 CDN 的远程 <link>/<preconnect>：设计字体以下方的 data: URI
  // 内联，因此 frame 在加载时完全不为任何东西触网。这是 drop 版的应用自身
  // "字体内嵌"修复——同样是渲染阻塞的 Google Fonts 请求，用同样的方式消灭。
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${FRAME_FONT_CSS}${FRAME_BASE_CSS}</style>
</head>
<body>
${stripActiveContent(html)}
</body>
</html>`;
}
