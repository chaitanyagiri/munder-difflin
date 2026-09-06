/**
 * 进程级活动 xterm 终端池，每个 ptyId 对应一个。
 *
 * 原因：node-pty 不保留滚动缓冲。如果每次用户切换 agent（或切换全屏）都
 * 新建/销毁一个 xterm，新终端会是空的，并且要一直空白到 TUI 碰巧重绘为止——
 * 这正是“终端消失，直到我拖动分隔条”的 bug。
 *
 * 相反，每个 pty 在应用生命周期内只用一个 Terminal。它被打开进一个分离的
 * host <div>，并且只订阅一次 pty 流，因此它的缓冲始终有内容。视图（侧边栏
 * 标签页或全屏覆盖层）在挂载时只需把那个 host 元素重新挂到自身之下，卸载时
 * 再分离——渲染出的内容随之移动，所以终端总是立刻可见，无需重绘。
 */
import { useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { arabicJoinRanges } from '@/terminal/arabicJoiner';
import { attachArabicSpacingFix } from '@/terminal/arabicSpacingFix';
import { isArabicTerminalEnabled } from '@/terminal/arabicSetting';
import {
  classifyPathToken, isPathToken, pathTokenMatcher, stripPathToken, type PathAction
} from '@shared/terminalPaths';
import {
  createTerminalRecoveryState,
  normalizePtyChunk,
  requestInitialPtyRedraw,
  scheduleWebglRecovery,
  type TerminalRecoveryState
} from './terminalRecovery';
import {
  canAutomateTerminal,
  opensInteractiveTerminalUi,
  shouldFollowTerminalOutput,
  terminalAutomationBlock,
  type TerminalAutomationBlock
} from './terminalAutomation';
import { sanitizeTerminalSelection } from './terminalSelection';
import '@xterm/xterm/css/xterm.css';

export interface TerminalEntry {
  /** 该终端镜像的 pty——重排时需要用来触发 `resizePty`。 */
  ptyId: string;
  term: Terminal;
  fit: FitAddon;
  /** xterm 渲染进去的元素；视图把它挂入/移出 DOM。 */
  host: HTMLDivElement;
  /** xterm 只有在其 host 首次挂载到文档后才会被 `open()`。 */
  opened: boolean;
  exited: boolean;
  /** 要在销毁时拆除的流订阅。 */
  unsub: Array<() => void>;
  /** 当前的消费者回调——由当前挂载的视图设置。 */
  onData?: (chunk: string) => void;
  onPrompt?: (text: string) => void;
  recovery: TerminalRecoveryState;
  needsRendererRepaint: boolean;
  /** 用户打开的斜杠命令选择器（例如 Codex `/model`）拥有输入行。
   * 队列自动化会一直等到选择器关闭。 */
  automationBlocked: boolean;
  /** 运行中的程序是否已启用 DEC 私有模式 2031（终端主题变更通知）？
   *  自己绘制颜色的 TUI 看不到应用主题切换：xterm 会重绘自己的单元格，
   *  但程序显式着色的单元格会一直保持那些颜色，直到程序重绘它们。2031
   *  正是程序请求被通知的方式，而我们只通知那些提出请求的。 */
  themeNotify: boolean;
  /** 选择器锁存被设置的时间——该阻塞会过期，参见 PICKER_BLOCK_MS。 */
  automationBlockedAt: number;
  /** 用户是否在实时 TUI 提示符里留有未提交的文本。 */
  inputDirty: boolean;
  inputDirtyAt: number; // 草稿最后一次被键入的时间；用于驱动过期判定
  automationSettleUntil: number;
  /** 我们对实时提示行上文本的模型。放在条目（ENTRY）上而非闭包变量里：
   * `inputDirty` 由它推导，所以任何清除提示符的路径（Ctrl-U、重启重置）都得
   * 两者一起清，否则下一次按键会把已删除的文本复活成一个幽灵草稿。 */
  lineBuf: string;
  /** 每次该 pty 在相同 id 下被重启都会自增。旧进程的迟到事件带着它们注册时的
   * 代数，因此可以被识别并丢弃，而不是污染替代进程。 */
  generation: number;
  webgl?: WebglAddon;
  /** 实时的阿拉伯文/RTL 渲染句柄，仅在开启时存在。持有它们是为了可以在不
   *  销毁终端的情况下再次关掉该模式。 */
  arabic?: { joiner: number; detachSpacing: () => void };
}

const pool = new Map<string, TerminalEntry>();

import { parseHexColor, oscColorBody, isDarkBackground } from './termColor';

type ThemeMap = Record<string, string>;


/** 告诉正在运行的程序终端主题已改变。
 *
 *  DEC 模式 2031 的回复半部分：暗色为 `CSI ? 997 ; 1 n`，亮色为 `; 2 n`。
 *  只发送给启用了 2031 的程序，因为一个没有请求的程序收到这些字节会被当作
 *  未请求的输入。
 *
 *  没有它，应用主题和 TUI 就会在 agent 重启前一直不一致：xterm 自己的单元格
 *  会翻转，而程序显式绘制的那些不会。 */
export function notifyThemeChangeAll(theme: 'light' | 'dark'): void {
  const all = [...pool.keys()];
  const told = all.filter((id) => pool.get(id)?.themeNotify);
  console.log(`[theme] -> ${theme}: notified ${told.length}/${all.length} terminal(s)`
    + (told.length ? ` (${told.join(', ')})` : ' — none opted into DEC 2031'));
  for (const ptyId of all) notifyThemeChange(ptyId, theme);
}

function notifyThemeChange(ptyId: string, theme: 'light' | 'dark'): void {
  const entry = pool.get(ptyId);
  if (!entry || entry.exited || !entry.themeNotify) return;
  window.cth.writePty(ptyId, `\x1b[?997;${theme === 'dark' ? 1 : 2}n`);
}

/** 获取（或惰性创建）某个 pty 的持久化终端。Theme/font 只在创建时使用；
 *  挂载的视图之后会重新应用自己的设置。 */
export function acquireTerminal(ptyId: string, theme?: ThemeMap, fontSize = 14): TerminalEntry {
  const existing = pool.get(ptyId);
  if (existing) return existing;

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';

  const term = new Terminal({
    theme,
    // v0.3.4: JetBrains Mono 取代 VT323——窄的 CRT 字形在处理数据密度时很吃力。
    // lineHeight 保持 1.0，这样 TUI 的方框线行能保持连在一起。
    fontFamily: '"JetBrains Mono", "Sarasa Mono SC", ui-monospace, "SF Mono", Menlo, "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", monospace',
    fontSize,
    lineHeight: 1.0,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 100000,
    // 无论运行中的程序设置什么颜色，都保证文字可读。
    // 当程序绘制彩色单元格背景（例如 git-diff 的绿色加行背景，或黄色高亮行）
    // 而保留默认前景色时，主题的深色墨迹会渲染成深底深字，在亮色/奶油色主题
    // 下不可读。xterm 会按单元格自动调整前景色，以至少保持这个对比度
    // （WCAG AA = 4.5）相对实际背景——所以它也能拯救奶油纸上低对比度的彩色
    // *文本*。对已经高对比度的单元格（暗色主题）则保持不变。
    minimumContrastRatio: 4.5,
    allowProposedApi: true
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Unicode 11 宽度表：xterm 的默认（Unicode 6）把多数 emoji 计为 1 个单元格宽，
  // 但 Claude Code 用现代宽度（emoji = 2 个单元格）来排布文本——于是字形会溢出
  // 单个单元格并和后面的文字粘在一起（例如 "✅FIX-…"）。这里与应用对字符宽度的
  // 认知保持一致。
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  registerMarkdownLinkProvider(term, ptyId);
  // NOTE: 先不要 open()——xterm 需要它的 host 连接上文档才能正确测量。
  // 我们在首次 attach 时再 open（参见 attachTerminal）。

  const entry: TerminalEntry = {
    ptyId,
    term,
    fit,
    host,
    opened: false,
    exited: false,
    unsub: [],
    recovery: createTerminalRecoveryState(),
    needsRendererRepaint: false,
    automationBlocked: false,
    themeNotify: false,
    automationBlockedAt: 0,
    inputDirty: false,
    inputDirtyAt: 0,
    automationSettleUntil: 0,
    lineBuf: '',
    generation: 0
  };

  // 在终端的整个生命周期里只订阅一次 pty 流，这样即使这个终端没有挂载在
  // 任何视图里，缓冲也会持续填充。
  // 写节流：首 chunk 立即 flush，后续 chunk 合并进 100ms 窗口。
  // 把 qwen TUI 60fps 全屏重绘降到 ~10fps，根治持续闪烁。
  entry.unsub.push(window.cth.onPtyData(ptyId, (rawChunk) => {
    const chunk = normalizePtyChunk(rawChunk);
    if (!chunk) return;
    enqueueWrite(ptyId, chunk);
    entry.onData?.(chunk);
  }));
  // 重启流程是先 killPty() 再在同一个 pty id 下 spawnPty()，所以被杀死进程的
  // 过期 exit 事件原则上可能把 `exited` 锁在它的替代进程上（这会静默丢弃每次
  // 按键）。它做不到：kill() 会同步地从 map 移除会话（main/pty.ts kill），
  // 而进程自身的 onExit 在发出事件前会检查它是否仍拥有该 id——所以过期事件
  // 在主进程就被抑制了，永远不会到达这里。
  entry.unsub.push(window.cth.onPtyExit(ptyId, ({ exitCode, signal }) => {
    entry.exited = true;
    term.writeln(`\r\n\x1b[2m─ process exited (code ${exitCode}${signal ? `, signal ${signal}` : ''}) ─\x1b[0m`);
  }));
  // 首次引擎 CLI 安装刚完成，agent 正在自动重启并继续进到同一个 pty（主进程
  // 重新跑了 spawn）。就地重新武装终端——清除锁存的 exit（让按键重新流通），擦掉
  // 安装横幅和“process exited”行——这样重新启动的 CLI 的 TUI 会画到一个干净、
  // 可输入的网格上。行为类似 resetTerminal，但作用在这个闭包上。
  entry.unsub.push(window.cth.onPtyRelaunch(ptyId, () => {
    entry.exited = false;
    try { term.reset(); } catch { /* 尚未打开 */ }
  }));

  // ── 复制 / 粘贴 ──────────────────────────────────────────────────────────
  // 使用加速渲染器时没有 DOM 文本，浏览器的原生复制看不到终端——选区存在
  // xterm 里面。接线常规的终端约定：
  //   Ctrl/Cmd+C 且有选区 → 复制（没有选区则保持 SIGINT）
  //   Ctrl/Cmd+Shift+C     → 复制；Ctrl/Cmd+Shift+V → 粘贴
  //   右键                 → 复制选区，否则粘贴（控制台风格）
  const copySelection = (): boolean => {
    if (!term.hasSelection()) return false;
    // 选区来自字符 GRID，所以 CLI 画在那里的任何沟槽（Claude Code 把 blockquote
    // 渲染成 `▎ text`）都是被复制单元格的一部分。把它剥掉——参见 terminalSelection.ts。
    const text = sanitizeTerminalSelection(term.getSelection());
    // 当只有沟槽的选区被清理成空后仍为 `true`：该手势是一次复制，就必须保持
    // 为复制，否则右键会落到粘贴上。
    if (text) void window.cth.copyToClipboard(text);
    return true;
  };
  /** 把剪贴板粘贴进终端。
   *
   *  读取是刻意同步的。听写工具（muesli.works、Wispr Flow 等）“打字”的方式是
   *  暂存剪贴板、写入转录文本、发送粘贴键、然后立刻恢复旧剪贴板。过去用的异步
   *  读取会晚一两个 tick 才回来——已经在恢复之后——于是终端粘贴的是在此之前
   *  剪贴板上的文本，而用户刚说出的词被丢弃了。在 keydown 处理器内部读取正好
   *  关死了这个窗口期。
   *
   *  如果同步桥不可用（更老的 preload），就回退到异步读取，所以它会降级为
   *  之前的行为，而不是退化为什么都不做。 */
  const pasteClipboard = (): void => {
    if (entry.exited) return;
    try {
      const text = window.cth.readClipboardSync?.();
      if (typeof text === 'string') { if (text) term.paste(text); return; }
    } catch { /* 落到异步路径 */ }
    void window.cth.readClipboard().then((t) => { if (t) term.paste(t); });
  };
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (!(ev.ctrlKey || ev.metaKey)) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c' && (ev.shiftKey || term.hasSelection())) {
      // 仅在存在选区时在 Ctrl+C 上复制；复制后清除选区，这样第二次 Ctrl+C
      // 仍可照常中断 agent。
      if (copySelection() && !ev.shiftKey) term.clearSelection();
      ev.preventDefault();
      return false;
    }
    if (key === 'v' && ev.shiftKey) {
      pasteClipboard();
      ev.preventDefault();
      return false;
    }
    return true;
  });
  host.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (copySelection()) { term.clearSelection(); return; }
    pasteClipboard();
  });

  // 回答终端颜色查询（OSC 10 前景色、OSC 11 背景色）。
  //
  // 想匹配终端的 TUI 会用 `ESC ] 11 ; ? BEL` 查询颜色，并据回复给自己上样式。
  // 我们之前一个 OSC 处理器都没注册，于是查询无人应答，应用回退到自己的默认值，
  // 对 OpenCode 来说就是亮色（LIGHT）。这就是为什么 OpenCode 在深色窗口里画
  // 出近白色的面板，即使它的主题设成了 `system`，也是为什么它跨 agent 出现
  // 而不是只在一个引擎上：任何会查询的 TUI 得到的都是同样的沉默。
  //
  // COLORFGBG（生成时设置）是更老、更粗的信道，只携带“亮或暗”。而这里携带
  // 实际的颜色，所以 TUI 可以匹配窗口而不是猜一边。
  const oscColorReply = (index: 10 | 11) => (data: string): boolean => {
    if (data !== '?') return false;          // 只处理 QUERY 形式；SET 不是我们该处理的
    if (entry.exited) return true;           // 吞掉它，而不是写给一个已死的 pty
    const map = (term.options.theme ?? theme) as ThemeMap | undefined;
    const hex = index === 11 ? map?.background : map?.foreground;
    const rgb = hex && parseHexColor(hex);
    if (!rgb) return false;                  // 未知颜色：保持沉默而不是撒谎
    window.cth.writePty(ptyId, `\x1b]${index};${oscColorBody(rgb)}\x1b\\`);
    return true;
  };
  term.parser.registerOscHandler(10, oscColorReply(10));
  term.parser.registerOscHandler(11, oscColorReply(11));

  // DEC 私有模式 2031：程序在请求终端主题变化时被通知。只回答 OSC 11 只能
  // 覆盖启动时刻；程序凭那次回答画出的面板会一直保持旧色，直到有什么东西告诉
  // 它重绘——这就是切换应用主题后 OpenCode 的框还留在旧颜色的原因。
  // 返回 false 让 xterm 仍自行应用该模式；我们只是监听。
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.includes(2031)) {
      entry.themeNotify = true;
      // 协议期望程序一选择加入就立刻收到当前主题，而不只是在下次变化时。
      // 没有这句，设为跟随终端的 CLI 启动时没有依据，会回退到自己的默认值，
      // 这就是浅色窗口最终出现黑色消息高亮的原因。
      const bg = (term.options.theme as ThemeMap | undefined)?.background;
      notifyThemeChange(ptyId, bg && !isDarkBackground(bg) ? 'light' : 'dark');
      // 刻意打日志。TUI 是否选择加入，是“主题修复生效”和“我们在跟一个不听的
      // 东西说话”之间的区别，而这从外部观察不到。
      console.log(`[theme] ${ptyId} enabled theme-change notifications (DEC 2031)`);
    }
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(2031)) entry.themeNotify = false;
    return false;
  });

  // 按键 → pty。一个小行缓冲会记录最后一次提交的提示。
  // 它放在条目上（见 TerminalEntry.lineBuf），这样所有清提示的路径也会重置它。
  term.onData((data) => {
    if (entry.exited) return;
    window.cth.writePty(ptyId, data);
    // 单独的 Escape 或 Ctrl-C 会关闭交互式选择器。用户在选择器内导航时，
    // 方向键转义序列绝不能清除阻塞。
    if (data === '\x1b' || data === '\x03') {
      releasePickerBlock(entry);
      entry.lineBuf = '';
    }
    // 用户自己的 Ctrl-U（杀行）会像我们的一样清除提示符。
    if (data === '\x15') entry.lineBuf = '';
    // 括号粘贴仍是用户拥有的草稿文本；只剥掉它的包装，这样粘贴的内容会把提示
    // 标记为脏的，而不是看起来对自动化安全。
    const input = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
    // PASTE 永远不会成为提交：TUI 把换行放进输入框，然后等一个真正的 Enter。
    // xterm 会把粘贴的换行改写成 "\r"，所以没有这条，五行粘贴会被当成五条提交
    // 的消息——而真正发送它的那个 Enter 则会变成第六条。（TELEMETRY.md
    // → message_sent；粘贴自己的 Enter 按键会作为自己的 chunk 到达并在那里计数。）
    const pasted = data.includes('\x1b[200~');
    let submitted = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '\r' || ch === '\n') {
        const t = entry.lineBuf.trim();
        entry.lineBuf = '';
        if (entry.automationBlocked) {
          // Enter 会选中一项并关闭当前选择器。
          releasePickerBlock(entry);
        }
        // 不是 `else`：这个 Enter 就是那个提交命令的 Enter，所以它既要关闭任何
        // 已经打开的选择器，也要为刚提交的命令锁存一个新的。如果写成 `else if`，
        // 类似 `/model sonnet` 的行会锁存阻塞，之后又没有 Enter 能清除它——发往
        // 该 agent 的每条排队消息都被永久跳过。
        if (opensInteractiveTerminalUi(t)) {
          entry.automationBlocked = true;
          entry.automationBlockedAt = Date.now();
        }
        if (t.length >= 2) {
          entry.onPrompt?.(t);
          submitted = true;
        }
      } else if (ch === '\x7f' || ch === '\b') {
        entry.lineBuf = entry.lineBuf.slice(0, -1);
      } else if (ch === '\x1b') {
        break; // 跳过转义序列（方向键等）
      } else if (ch >= ' ') {
        entry.lineBuf += ch;
      }
    }
    // 每个输入 chunk 只在 SUBMIT 边界上报一条消息——不是每次按键（那是
    // `pty:write` 看到的，在那里计数会按打字计量），也不是粘贴内的每一行。
    // 这是渲染器唯一能触发分析事件的地方；它只发送一个表面名，其它什么都不发。
    if (submitted && !pasted) void window.cth.trackMessageSent('terminal');
    entry.inputDirty = entry.lineBuf.length > 0;
    // 每次按键都重新盖章，所以过期时钟度量的是用户最后一次触碰草稿以来的时间
    // ——而不是他们开始写以来的时间。
    if (entry.inputDirty) entry.inputDirtyAt = Date.now();
  });

  pool.set(ptyId, entry);
  return entry;
}

/** 排队的自动化是否还能安全地拥有该终端的输入行。没有池化终端的 PTY
 * 不可能有用户打开的本地选择器。 */
export function isTerminalAutomationSafe(ptyId: string, now = Date.now()): boolean {
  const entry = pool.get(ptyId);
  if (!entry) return true;
  return canAutomateTerminal(automationStateOf(entry, now), now);
}

/** TUI 画在输入行周围的、不属于用户文本的字符：提示符所在的框和提示符标记本身。 */
const PROMPT_CHROME = /[─-╿\s>❯$#|]/g;

/** 按键之后多久，渲染出的屏幕还算不上任何证据。
 *
 *  `inputDirty` 在按键的瞬间就被设置，但字符要等 PTY 把它回显回来才进入 xterm
 *  的缓冲——这是经过子进程的一次往返。在这个间隙里，缓冲仍然显示旧行，所以读取
 *  一个刚开头的草稿会返回“空”，并会在用户打到一半时把提示符交给自动化。屏幕
 *  只有在有机会追上来之后，才被允许推翻按键计数。 */
const ECHO_GRACE_MS = 1000;

/** 终端渲染出的提示行现在真的有文本吗？
 *
 *  `inputDirty` 是通过数按键推断的，而这个模型会 DRIFT：把按键吞进自己 UI
 *  （菜单、确认框）的 TUI 会在可见提示符为空时仍让计数高于零。没有任何东西
 *  纠正过它，于是队列被一个并不存在的草稿卡住——这就是“消息永远不送达”的
 *  bug。xterm 已经持有渲染出的屏幕，所以直接读它，而不是相信计数。
 *
 *  当屏幕算不上任何证据时返回 null：终端还没打开、行缺失、或最后一次按键太近、
 *  回显还没落地。刻意只用于清除幽灵，绝不用于凭空捏造草稿：“空”会去掉阻塞，
 *  而“有文本”或“不知道”则回退到按键模型并保留它。这种不对称很重要，因为
 *  两种错误的代价不一样——错误的“空”会把提示符交给自动化，把一条消息拼接到
 *  用户正在写的内容上；而错误的“有文本”只是把排队消息停放一会儿，直到草稿
 *  过期。 */
function promptLineHasText(entry: TerminalEntry, now = Date.now()): boolean | null {
  if (!entry.opened || entry.exited) return null;
  // 离最后一次按键太近，回显还没落地——缓冲展示的是过去，所以它清除不了任何东西。
  if (entry.inputDirtyAt && now - entry.inputDirtyAt < ECHO_GRACE_MS) return null;
  try {
    const buf = entry.term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    if (!line) return null;
    // `true` 会修剪尾部空白单元格，TUI 用它们来给框内补白。
    return line.translateToString(true).replace(PROMPT_CHROME, '').length > 0;
  } catch {
    return null; // 绝不让一次缓冲读取破坏投递
  }
}

/** 用户是否在该终端的提示符上留有未提交的文本。
 *  与自动化 gate 共享同样的草稿检测，所以“typing”徽章上报的草稿与 gate
 *  正为其扣住投递的是同一个。它不应用 gate 的那种过期判定：过了 STALE_INPUT_MS
 *  之后 gate 开始投递，而这个仍会上报草稿——这是诚实的读法，因为文本确实
 *  还在提示符上。 */
export function hasTerminalDraft(ptyId: string | undefined, now = Date.now()): boolean {
  if (!ptyId) return false;
  const entry = pool.get(ptyId);
  if (!entry) return false;
  return entry.inputDirty && promptLineHasText(entry, now) !== false;
}

/** `hasTerminalDraft` 的 React 状态版本。该标记存在于一个没有任何组件订阅的
 *  可变池条目上，所以轮询它——廉价（读一行缓冲）而且徽章上的一秒延迟不可见。 */
export function useHasTerminalDraft(ptyId: string | undefined): boolean {
  const [dirty, setDirty] = useState(() => hasTerminalDraft(ptyId));
  useEffect(() => {
    // 没有 pty 的 agent 就没有能容纳任何东西的提示符——不要为它每个卡片跑一个
    // 定时器（地板为每个 agent 渲染一张卡片）。
    if (!ptyId) { setDirty(false); return; }
    const read = () => setDirty(hasTerminalDraft(ptyId));
    read();
    const iv = setInterval(read, 1000);
    return () => clearInterval(iv);
  }, [ptyId]);
  return dirty;
}

function automationStateOf(entry: TerminalEntry, now = Date.now()) {
  // 屏幕胜过按键计数，但只在它说“空”的时候。
  const inputDirty = entry.inputDirty && promptLineHasText(entry, now) !== false;
  return {
    exited: entry.exited,
    pickerOpen: entry.automationBlocked,
    pickerOpenedAt: entry.automationBlocked ? entry.automationBlockedAt : undefined,
    inputDirty,
    inputDirtyAt: inputDirty ? entry.inputDirtyAt : undefined,
    settleUntil: entry.automationSettleUntil
  };
}

/** 放下选择器锁存，给 TUI 一点时间重绘被释放的行。 */
function releasePickerBlock(entry: TerminalEntry): void {
  entry.automationBlocked = false;
  entry.automationBlockedAt = 0;
  entry.automationSettleUntil = Date.now() + 500;
}

/** 队列投递目前因为这个 pty 被扣住的原因，没有则为 null。
 * 编辑器会显示这个，而不是声称它正在发送。 */
export function terminalAutomationBlockFor(
  ptyId: string | undefined,
  now = Date.now()
): TerminalAutomationBlock {
  if (!ptyId) return null;
  const entry = pool.get(ptyId);
  if (!entry) return null;
  return terminalAutomationBlock(automationStateOf(entry, now), now);
}

/** 清掉 TUI 提示符当前行并重新武装自动化。Ctrl-U 是每一款受支持的
 * CLI 的输入都遵守的 readline 杀到行首绑定。 */
export function clearTerminalDraft(ptyId: string): string {
  const entry = pool.get(ptyId);
  if (!entry) return '';
  // 把文本交还给调用方，让它能停在一个用户将来找得到的地方。Ctrl-U 在 TUI
  // 里不可撤销，所以静默丢弃它是数据丢失——每次一个看似被弃的草稿其实是真草稿
  // 时都会发生。
  const discarded = entry.lineBuf;
  void window.cth.writePty(ptyId, '\x15');
  entry.inputDirty = false;
  entry.inputDirtyAt = 0;
  // 同时重置我们对该行的模型。留着不重置，会让紧接着的下一次按键根据我们刚
  // 删除的文本重新计算 `inputDirty`，于是草稿阻塞立刻回来，而且被删的文本还会
  // 污染下一条被解析的命令。
  entry.lineBuf = '';
  // 不重置：`automationBlocked`。Ctrl-U 杀的是输入行；它不会关闭打开的
  // 选择器。在这里清除锁存会告诉自动化提示符空闲，而其实选择器仍拥有它，
  // 于是排队消息被打进选择器，并记为已投递——消息丢失，选择器收到垃圾。
  // 锁存由真正的 Enter/Esc/Ctrl-C 释放，或自行过期。
  // 让 TUI 重绘被清掉的行之后，自动化再往里输入。
  entry.automationSettleUntil = Date.now() + 300;
  return discarded;
}

/** 通过发送 Escape——真正能关闭选择器的键——来关闭打开的选择器。
 *
 *  只会被编辑器自己的按钮调用——也就是因为用户要求了。自动化绝不能自行
 *  做这件事：菜单属于用户，而我们看不到 Escape 是否真的关掉了它，所以为了
 *  给一条排队消息腾地方而关掉它，既不礼貌也无法验证。 */
export function dismissTerminalPicker(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry || entry.exited) return;
  void window.cth.writePty(ptyId, '\x1b');
  releasePickerBlock(entry);
}

/** 只要终端在屏幕上，就给它一个 WebGL 渲染器。
 *
 *  DOM 渲染器假定一个完全等宽的字体，但 VT323 缺少字形（↔、箭头、部分
 *  方框线）也没有真正的粗体——浏览器用推进宽度不同的回退字形替代，于是方框线
 *  表格散架、光标漂移。WebGL 把每个字形画进自己固定的单元格，保持网格对齐。
 *  不是那个被废弃的 canvas addon（它的脏区域跟踪会把滚动缓冲弄乱）。
 *
 *  这是一份 LEASE（租约），attach 时取得、detach 时释放（见 detachTerminal），
 *  因为浏览器只允许有限数量的活动 WebGL context——Chromium 里大约 16 个——
 *  并且新 context 超出上限时会静默丢弃最老的。终端过去在 detach 之后也一直
 *  持有 context 到会话结束，于是恢复一个团队（会快速连续地为每个 agent 打开
 *  一个终端）时突破上限，浏览器杀掉了后台终端的 context。它的 pty、缓冲和
 *  订阅都保持健康——只有渲染器死了——这正是上报的“终端黑屏、打字无效”：
 *  按键已投递、回复已到达，却没有活着的东西把它们画出来。
 *
 *  尽力而为：初始化失败或上下文丢失时，回退到 DOM 渲染器，而不是留一个
 *  黑终端。 */
function leaseWebglRenderer(entry: TerminalEntry): void {
  if (entry.webgl) return;
  // 阿拉伯文模式刻意要 DOM 渲染器：行变成真正的文本节点，浏览器自己的引擎
  // 做 shaping，配合（design/global.css 里的 CSS）做 bidi——这是 WebGL 单元格
  // 画家在结构上做不到的（xterm.js 没有 bidi：xtermjs/xterm.js#701）。跳过
  // 租约就是该功能本身，而不是一个回退。
  if (isArabicTerminalEnabled()) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      if (entry.webgl !== webgl) return;
      console.warn('[terminal] webgl context lost — falling back to DOM renderer');
      entry.webgl = undefined;
      entry.needsRendererRepaint = true;
      try { webgl.dispose(); } catch { /* noop */ }
      // 笔记本休眠 == GPU 休眠 == WebGL context 丢失：这很可能是唤醒后
      // “无法滚动到更早的位置”bug 的主要触发点。渲染器切换让 xterm 缓存的
      // 单元格高度（以及由它推导出的视口滚动区）过期，所以完好缓冲只有一部分
      // 可滚动，直到有什么东西强制重新测量。在这里、下一帧（等醒来的布局稳定）
      // 修复它。带守卫且幂等，所以能安全地与视图里的 visibilitychange/focus
      // 路径组合。
      scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () =>
        repaintTerminalAfterRendererLoss(entry));
    });
    // 在 loadAddon 之前设置：一个立刻丢失的 context 可能在初始化期间调用
    // 该处理器，它必须被识别为活动渲染器。
    entry.webgl = webgl;
    entry.term.loadAddon(webgl);
  } catch (e) {
    try { entry.webgl?.dispose(); } catch { /* noop */ }
    entry.webgl = undefined;
    console.warn('[terminal] webgl renderer unavailable, using DOM renderer:', e);
  }
}

/** 找到 addon 渲染器正在绘制进去的活动 WebGL2 context，以便拆解时可以显式
 * 释放它。@xterm/addon-webgl 的 dispose() 会拆掉它的渲染器并移除它的画布，
 * 但从不调用 loseContext()，所以底层的 context 会残留到拥有它的 addon 之后
 * （xterm/xterm.js#6068）。在地板上反复切换 agent 时，每次切换会 dispose 一个
 * 渲染器、租借另一个，于是这些孤儿 context 越积越多，直到 Chromium 撞上它的
 * 活动 context 上限（~16）并逐出一个较老的——经常是办公室地板自己的 context——
 * 让某个终端或场景黑屏。自己主动丢失 context 能立刻释放它，而不是等 GC。
 *
 *  限定在这个终端的元素内，并且要匹配一个活动 webgl2 context，所以绝不能碰到
 *  另一个终端或场景的 context。当没有活动的 webgl2 画布时返回 null（DOM 渲染器
 *  在用，或者它已经没了）。 */
function webglContextOf(term: Terminal): WebGL2RenderingContext | null {
  const el = term.element;
  if (!el) return null;
  for (const canvas of Array.from(el.querySelectorAll('canvas'))) {
    let gl: WebGL2RenderingContext | null = null;
    try { gl = canvas.getContext('webgl2'); } catch { gl = null; }
    if (gl && !gl.isContextLost()) return gl;
  }
  return null;
}

/** 释放 WebGL 租约，让离屏终端不占用屏幕上的终端需要的 GPU context。xterm
 * 回退到 DOM 渲染器，对没人在看的终端来说没问题；下次 attach 会拿一份新租约。
 * 缓冲和 pty 订阅都不动。 */
function releaseWebglRenderer(entry: TerminalEntry): void {
  const webgl = entry.webgl;
  if (!webgl) return;
  entry.webgl = undefined;
  // 在 dispose 之前抓取 context（dispose 可能分离画布），然后显式释放它——
  // 仅 dispose() 会泄漏它（见 webglContextOf）。
  const gl = webglContextOf(entry.term);
  try { webgl.dispose(); } catch { /* noop */ }
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
  // 接管的 DOM 渲染器会继承 xterm 缓存的单元格度量，等到这个终端再次显示时
  // 可能已经过期。
  entry.needsRendererRepaint = true;
}

/** 为某个打开的终端打开阿拉伯文/RTL 渲染。
 *
 *  完整方案记录在 terminal/arabicJoiner.ts：把每段阿拉伯文短语连接成一个
 *  渲染范围，并去掉 xterm 对阿拉伯文跨度的逐 span 字间距。必须在 `open()`
 *  之后运行——在未打开的终端上注册 joiner 会抛错。
 *
 *  `cth-bidi` 类就是用来把 design/global.css 里的 bidi CSS 限定到这个终端的。
 *  PR #213 把这些规则应用到页面上每个 .xterm；它们是 `!important` 并改变 span
 *  布局，所以一个回退到 DOM 渲染器（丢失 WebGL 租约）的英文用户，会看到一个
 *  他们从未启用的功能把 TUI 方框线挤歪。 */
function enableArabicRendering(entry: TerminalEntry): void {
  if (entry.arabic) return;
  entry.host.classList.add('cth-bidi');
  const joiner = entry.term.registerCharacterJoiner(arabicJoinRanges);
  const detachSpacing = attachArabicSpacingFix(entry.host);
  entry.arabic = { joiner, detachSpacing };
  // 终端在启动时打开，常常早于 webfonts 加载完成，所以 xterm 用回退度量测量
  // 阿拉伯字形并一直保留。当真实字体到达时，拨一下 fontFamily（自我赋值）强制
  // 重新测量并完整重绘。
  void document.fonts?.ready.then(() => {
    if (entry.exited) return;
    const fam = entry.term.options.fontFamily;
    entry.term.options.fontFamily = fam;
  });
}

/** 精确撤销上面的事。每一步都可逆，这正是这个开关能实时存在的原因——
 * 这里没有任何东西销毁终端。 */
function disableArabicRendering(entry: TerminalEntry): void {
  const on = entry.arabic;
  if (!on) return;
  entry.arabic = undefined;
  entry.host.classList.remove('cth-bidi');
  try { entry.term.deregisterCharacterJoiner(on.joiner); } catch { /* already gone */ }
  try { on.detachSpacing(); } catch { /* noop */ }
}

/** 让每个打开的终端都跟上当前设置。
 *
 *  在应用语言改变和 Settings 开关被使用时调用。没有它，设置只会影响到之后
 *  才打开的终端，而一个切到阿拉伯文的用户会看到他们已有的终端仍按未塑形、
 *  从左到右的方式渲染——这读起来像功能没生效，而不是一个作用域规则。
 *
 *  它就地升级，而不是重建。办公室场景在语言切换时（a8292697）可以重建，
 *  因为它来自我们仍持有的状态；终端不能，因为它的滚动缓冲只存在于 xterm
 *  自己的缓冲里，pty 也不会重发它——重建一个会静默吞掉用户的历史。放下 WebGL
 *  租约就够了：`releaseWebglRenderer` 把绘制交给 DOM 渲染器，而缓冲、pty 订阅
 *  和滚动缓冲全都原封不动，那个 DOM 渲染器正是阿拉伯文模式需要的。反过来时，
 *  下次 attach 会重新拿 WebGL 租约。
 *
 *  从未打开过的终端会跳过：它在文档里没有 host、没有可注册的 joiner，而且
 *  `attachTerminal` 会在它真正打开时重新读取设置。 */
export function notifyArabicTerminalChangeAll(): void {
  const want = isArabicTerminalEnabled();
  const open = [...pool.values()].filter((e) => e.opened && !e.exited);
  const changed = open.filter((e) => !!e.arabic !== want);
  for (const entry of changed) {
    if (want) {
      // GPU 单元格画家忽略 CSS、做不了 bidi，所以阿拉伯文模式需要 DOM 渲染器。
      // 释放租约能保住缓冲。
      releaseWebglRenderer(entry);
      enableArabicRendering(entry);
    } else {
      disableArabicRendering(entry);
      // 刻意不在这里重新拿 WebGL 租约：租约是在 attach 时拿的，现在为一个
      // 离屏终端拿一份正是 releaseWebglRenderer 存在要避免的 GPU context 耗尽。
      entry.needsRendererRepaint = true;
    }
    repaintTerminalAfterRendererLoss(entry);
  }
  console.log(`[terminal] arabic -> ${want ? 'on' : 'off'}: `
    + `${changed.length}/${open.length} open terminal(s) switched`);
}

/** 把 pty 的终端重新挂进 `container`，首次 attach 时打开 xterm。 */
export function attachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  container.appendChild(entry.host);
  if (!entry.opened) {
    // open() 必须先来——WebGL addon 只能加载到已打开的终端上，而且 xterm 需要
    // host 在文档里才能测量单元格。
    entry.term.open(entry.host);
    entry.opened = true;
    // 阿拉伯文/RTL 终端支持（完整方案记录在 terminal/arabicJoiner.ts）：把每段
    // 阿拉伯文短语连接成一个渲染范围，并去掉 xterm 对阿拉伯文跨度的逐 span
    // 字间距。必须在 open() 之后：在未打开的终端上注册 joiner 会抛错。
    //
    // `cth-bidi` 类就是用来把 design/global.css 里的 bidi CSS 限定到这个终端的。
    // 那个 PR 把这些规则应用到页面上每个 .xterm；它们是 `!important` 并改变 span
    // 布局，所以一个回退到 DOM 渲染器（丢失 WebGL 租约）的英文用户，会看到一个
    // 他们从未启用的功能把 TUI 方框线挤歪。
    if (isArabicTerminalEnabled()) enableArabicRendering(entry);
  }
  leaseWebglRenderer(entry);
  // PTY 启动输出可能在池化终端订阅之前到达。
  // 在 open/订阅之后请求一次同尺寸重绘，即使 fit() 稍后看到尺寸没变、因而不发出
  // 自己的 resize 也一样。
  requestInitialPtyRedraw(entry.recovery, () => window.cth.redrawPty(entry.ptyId));
  if (entry.needsRendererRepaint) {
    scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () =>
      repaintTerminalAfterRendererLoss(entry));
  }
}

/** 把终端移出屏幕：放下 WebGL 租约并取消 host 的挂接。
 *  让终端成为终端的一切——缓冲、滚动缓冲、pty 订阅——都留在池里，所以重新
 *  attach 会显示它完整渲染。 */
export function detachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  // 守卫：另一个视图可能已经取走了 host（React 可能在旧 owner 的清理运行之前
  // 就挂载新 owner）。那时释放渲染器会让刚合法认领它的终端黑屏。
  if (entry.host.parentElement !== container) return;
  releaseWebglRenderer(entry);
  container.removeChild(entry.host);
}

function repaintTerminalAfterRendererLoss(entry: TerminalEntry): void {
  if (!entry.opened || !entry.host.isConnected
      || !entry.host.clientWidth || !entry.host.clientHeight) {
    entry.needsRendererRepaint = true;
    return;
  }
  reflowTerminal(entry.ptyId);
  try {
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
    // 只有到这时重绘才算确认。在 refresh 之前清除标记，意味着这里抛错时
    // （渲染器仍在稳定中）会丢弃“该终端需要重绘”的最后一条记录——于是它一直
    // 黑屏，直到有什么无关的事碰巧调整了尺寸，这就是为什么 Cmd +/- 只有部分
    // 时候能修好它。
    entry.needsRendererRepaint = false;
  } catch {
    entry.needsRendererRepaint = true;
  }
}

/**
 * 重新测量单元格度量，并为池化终端重建视口滚动区。在显示器唤醒 / GPU（WebGL）
 * context 丢失 / DPR 变化之后使用：xterm 会缓存 open() 时测得的单元格高度，
 * 只在字体变化或 resize 时重新计算。当那个缓存的度量过期（休眠/唤醒）时，
 * .xterm-viewport 滚动区高度（rows × cellHeight）是错的，所以完好的缓冲只有
 * PART 一部分可滚动——用户只能靠缩放来强制 fit() 并露出其余部分。
 *
 * 镜像 PtyTerminalView 里的 document.fonts.ready 重测：重新应用 SAME 字体使
 * xterm 缓存的单元格度量失效，clearTextureAtlas 以正确尺寸重新栅格化 WebGL
 * 字形图集，然后 fit() 重新计算 cols/rows 并重建视口。保留滚动位置（不
 * scrollToBottom），所以读历史的人不会被拽到底。在终端已打开且 host 有真实
 * 尺寸之前是 no-op，所以多个触发器同时触发（onContextLoss +
 * visibilitychange + focus）也能安全组合——便宜的两次 reflow 无害；守卫让
 * 过早/重复调用变成 no-op。
 */
// ── resizePty 防抖（启动横幅叠帧根治）─────────────────────────────────
// qwen/Claude Code 的 TUI 每次收到 SIGWINCH 都整屏重绘，并把上一帧推进
// scrollback。挂载级联（rAF×2、60ms、240ms、字体加载、ResizeObserver、
// 唤醒 reflow）会在几百毫秒内发出多次 resizePty——每次都被 TUI 渲染成一帧
// 新横幅，造成启动横幅垂直堆叠（qwen 实测约 9 份 D:\MunderDiffLin）。
// 把发往同一 pty（不同 pty 互不干扰）的 resize 合并进一个 140ms 窗口：
// 窗口内只发最后一次（最终网格），既保留对窗口拖动的最终响应，又掐掉瞬发
// 重复的 SIGWINCH。这是对所有引擎（qwen/Claude/Codex）通用的最小修复。
// DOM lib 下 setTimeout 返回 number，Node 下返回 Timeout —— 命名的句柄类型
// 让两套环境共用同一声明。
type TimerHandle = ReturnType<typeof setTimeout>;
const pendingResizes = new Map<string, { cols: number; rows: number }>();
let resizePtyFlushTimer: TimerHandle | undefined;

export function debouncedResizePty(ptyId: string, cols: number, rows: number): void {
  pendingResizes.set(ptyId, { cols, rows });
  if (resizePtyFlushTimer !== undefined) return; // 已有合并窗口在跑
  resizePtyFlushTimer = setTimeout(() => {
    resizePtyFlushTimer = undefined;
    for (const [id, size] of pendingResizes) {
      try {
        window.cth.resizePty(id, size.cols, size.rows);
      } catch { /* 宿主可能已销毁 */ }
    }
    pendingResizes.clear();
  }, 140);
}
// ── term.write 节流（持续闪烁根治）─────────────────────────────────────
// qwen TUI 内部 SCROLL_FRAME_MS=16（~60fps 全屏重绘），在 ConPTY 下每帧
// 调用 term.write 都会触发 xterm 渲染——叠加出视觉上的持续闪烁（用户报告
// "一直闪"）。写节流：把发往同一 pty 的 write 合并进 100ms 窗口，把 60fps
// 降到 ~10fps。前沿 flush（距上次 >=100ms）立即写，追沿合并+单次定时器。
// 这是 xterm 层节流，不影响字节保真——flush 后的 write 仍是正确的 OSC/CSI
// 序列，只是批量发送而非逐帧。
const writeBufs = new Map<string, string[]>();
const writeFlushTimers = new Map<string, TimerHandle>();
const writeLastFlushAt = new Map<string, number>();
const WRITE_FLUSH_MS = 100;

function enqueueWrite(ptyId: string, chunk: string): void {
  let buf = writeBufs.get(ptyId);
  if (!buf) { buf = []; writeBufs.set(ptyId, buf); }
  buf.push(chunk);
  const last = writeLastFlushAt.get(ptyId) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed >= WRITE_FLUSH_MS) {
    // 前沿 flush：距上次 flush 已够久，立即写（保按键响应性）
    flushWrite(ptyId);
  } else {
    // 追沿 schedule：距边界还有 (WRITE_FLUSH_MS - elapsed) ms，调度一次
    const remaining = WRITE_FLUSH_MS - elapsed;
    const timer = writeFlushTimers.get(ptyId);
    if (timer !== undefined) clearTimeout(timer);
    const t = setTimeout(() => {
      writeFlushTimers.delete(ptyId);
      flushWrite(ptyId);
    }, remaining);
    writeFlushTimers.set(ptyId, t);
  }
}

function flushWrite(ptyId: string): void {
  const buf = writeBufs.get(ptyId);
  if (!buf || buf.length === 0) { writeBufs.delete(ptyId); return; }
  const entry = pool.get(ptyId);
  if (!entry) { writeBufs.delete(ptyId); return; }
  const active = entry.term.buffer.active;
  const follow = shouldFollowTerminalOutput(active.viewportY, active.baseY);
  entry.term.write(buf.join(''), () => {
    if (follow) {
      try { entry.term.scrollToBottom(); } catch { /* 终端可能正在分离 */ }
    }
  });
  writeBufs.delete(ptyId);
  writeLastFlushAt.set(ptyId, Date.now());
}

export function flushPendingWrites(): void {
  for (const ptyId of writeBufs.keys()) {
    const timer = writeFlushTimers.get(ptyId);
    if (timer !== undefined) clearTimeout(timer);
    writeFlushTimers.delete(ptyId);
    flushWrite(ptyId);
  }
}

export function reflowTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry || !entry.opened) return;
  const host = entry.host;
  // 分离或无尺寸时跳过——对 0×0 的 host 做 fit 会让 xterm 提出一个极小的
  // 网格，并把 pty 调整到它（裁剪/过大的横幅）。
  if (!host.isConnected || !host.clientWidth || !host.clientHeight) return;
  try {
    // 重新应用 SAME 字体选项，强制 xterm 的 CharSizeService 针对现在正确的
    // （唤醒后的）布局重新测量单元格，然后丢弃字形图集，让它以修正后的度量
    // 重新栅格化。
    entry.term.options.fontFamily = entry.term.options.fontFamily;
    entry.term.options.fontSize = entry.term.options.fontSize;
    entry.term.clearTextureAtlas?.();
    const before = { cols: entry.term.cols, rows: entry.term.rows };
    entry.fit.fit();
    // 只在网格真的变化时触发 pty（每次 resize 都会重绘 TUI 并向滚动缓冲推入
    // 一帧）。经防抖合并：唤醒级联（visibilitychange + focus + onContextLoss）
    // 会连续重测，只把最终网格发给 pty。
    if (entry.term.cols !== before.cols || entry.term.rows !== before.rows) {
      debouncedResizePty(ptyId, entry.term.cols, entry.term.rows);
    }
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
  } catch { /* 宿主可能尚未确定尺寸 */ }
}

/**
 * 对池化终端做“就地”软重置，用于 pty 原地重生（同一个 ptyId 被复用——例如
 * 模型切换或 agent 重启）。清屏 + 清滚动缓冲并重新武装输入，同时保留同一个
 * Terminal、它的实时数据订阅和 DOM 挂接，这样已挂载的视图能在重启期间保持
 * 可见和可输入。
 *
 * 为什么这里不 disposeTerminal：视图（PtyTerminalView）把它的 attach effect
 * 绑定在 ptyId 上，而 ptyId 在重启时不变——所以它永远不会重新 attach 一个
 * 替代终端。dispose 因此会留下一个死的、分离的、吞掉每次按键的面板。就地重置
 * 完全避免了这一点。
 */
export function resetTerminal(
  ptyId: string,
  opts: { preserveScrollback?: boolean } = {}
): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  // 重新武装输入——先前的退出（或重生前的 kill）可能已锁存 `exited`，
  // 否则会让 onData 静默丢弃按键。
  entry.exited = false;
  entry.inputDirty = false;
  entry.inputDirtyAt = 0;
  // 旧进程的提示符随它而去——丢掉我们对那行以及它可能打开的任何选择器的模型，
  // 否则替代进程会继承一个幽灵草稿和一个无法清除的阻塞。
  entry.lineBuf = '';
  entry.automationBlocked = false;
  entry.automationBlockedAt = 0;
  try {
    if (opts.preserveScrollback) {
      entry.term.writeln('\r\n\x1b[2m─ resuming existing session ─\x1b[0m');
    } else {
      // 新会话需要干净的网格；resume 则保留现有滚动缓冲。
      entry.term.reset();
    }
  } catch { /* 尚未打开 */ }
}

/** 拆掉某个 pty 的终端（agent/pty 永久消失时调用）。 */
export function disposeTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  entry.unsub.forEach((u) => { try { u(); } catch { /* noop */ } });
  // 释放 webgl addon 留下的 GPU context；仅 dispose() 会泄漏它（见
  // webglContextOf）。在 dispose 之前抓取，以防它分离画布。
  const gl = webglContextOf(entry.term);
  try { entry.webgl?.dispose(); } catch { /* noop */ }
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
  try { entry.term.dispose(); } catch { /* noop */ }
  entry.host.remove();
  pool.delete(ptyId);
}

// ─── v0.3.4: ⌘-点击终端输出里的路径 ────────────────────────────────────────
// 一个自定义 ILinkProvider（不是只匹配 URL 的 WebLinksAddon）：检测可见缓冲行
// 里的路径 token，把相对路径按所属 agent 的 cwd 解析，在 Cmd/Ctrl+点击时通过
// 只读元数据的 fs:statAbs IPC 验证存在性后再动作。
// 普通点击仍交给 TUI（与 VS Code 的终端约定一致）。
// 路径字符串是 agent 输出——按敌意对待：它只流入一次只读 stat、现有的读取管线、
// 或一次 REVEAL（绝不做“用默认应用打开”，那会把一个打印出来的路径变成一次
// 执行），而且只在显式的修饰键点击时发生。
//
// v0.4.5 把范围从仅 markdown 扩展到每个路径 token。每种类型做什么记录在
// @shared/terminalPaths，不在这里——本文件只知道怎么在行上找 token，以及怎么
// 运行三种判定。
const mdStatCache = new Map<string, { isFile: boolean; path: string }>();

function resolvePathCandidate(ptyId: string, raw: string): string | null {
  const p = stripPathToken(raw);
  if (!isPathToken(p)) return null;
  if (p.startsWith('~/') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return p;
  // 相对 → 按所属 agent 的 cwd 解析。异步 store import 让本模块能在 node 测试
  // 环境里使用（加载时不依赖 zustand/react）。
  const cwd = storeApi?.getState().agents.find((a) => a.ptyId === ptyId)?.cwd ?? null;
  if (!cwd) return null;
  return `${cwd}/${p.replace(/^\.\//, '')}`;
}

// store 通过动态 import 惰性加载（只解析一次、有缓存）：静态 import 会把
// zustand/react 拖进共享本文件导入图的纯自动化 helper 的 node --test 转译。
interface MdStoreShape {
  getState: () => {
    agents: Array<{ ptyId?: string; cwd: string }>;
    openFileInIde: (absPath: string) => void;
  };
}
let storeApi: MdStoreShape | null = null;
void import('@/store/store')
  .then((m) => { storeApi = (m as unknown as { useStore: MdStoreShape }).useStore; })
  .catch(() => { /* 存储不可用（测试中）—— 链接提供方保持惰性 */ });

/** 对已验证的路径执行动作。`reveal` 也接受任何到达这里的目录：
 *  IDE 需要一个文件。未命中时按设计保持静默——token 是 agent 输出，可能
 *  就是不存在。
 *
 *  两个非 reveal 的判定都落在 IDE。IDE 已经按类型路由（源码走 Monaco、markdown
 *  走预览、图片走查看器），所以这里不需要把判定传下去——它只需要知道这个文件
 *  到底是不是我们能打开的。 */
async function activatePath(abs: string, action: PathAction): Promise<void> {
  let hit = mdStatCache.get(abs);
  if (!hit) {
    const res = await window.cth.statAbs(abs).catch(() => null);
    if (!res || !res.exists) return;
    hit = { isFile: res.isFile, path: res.path };
    if (mdStatCache.size > 500) mdStatCache.clear();
    mdStatCache.set(abs, hit);
  }
  if (action === 'reveal' || !hit.isFile) {
    void window.cth.revealPath(hit.path).catch(() => { /* 文件浏览器被拒绝 */ });
    return;
  }
  storeApi?.getState().openFileInIde(hit.path);
}

function registerMarkdownLinkProvider(term: Terminal, ptyId: string): void {
  try {
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        const text = line ? line.translateToString(true) : '';
        if (!text || !text.includes('.')) { callback(undefined); return; }
        const links: Parameters<typeof callback>[0] = [];
        const re = pathTokenMatcher();
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const raw = m[0];
          const abs = resolvePathCandidate(ptyId, raw);
          if (!abs) continue;
          const action = classifyPathToken(stripPathToken(raw));
          links!.push({
            range: {
              start: { x: m.index + 1, y: bufferLineNumber },
              end: { x: m.index + raw.length, y: bufferLineNumber }
            },
            text: raw,
            decorations: { underline: true, pointerCursor: true },
            activate: (event: MouseEvent | undefined) => {
              // 只接受 ⌘/Ctrl+点击——普通点击必须继续交给 TUI。
              if (event && !(event.metaKey || event.ctrlKey)) return;
              void activatePath(abs, action);
            }
          });
        }
        callback(links && links.length ? links : undefined);
      }
    });
  } catch { /* 提案中的 API 不可用 —— 该功能静默关闭 */ }
}
