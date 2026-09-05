/**
 * 从抓取的终端输出中剥离 ANSI 转义序列。
 *
 * pty 解析器过去只移除 SGR 颜色代码（`ESC[…m`），因此其它各种转义都会
 * 泄漏到气泡思考和桌面卡片显示的文本里（issue #141）：CLI 用光标前移
 * （`ESC[1C`）代替它知道已在屏幕上的空格串来重绘实时状态行，还有光标定位
 * （`ESC[14;6H`）和擦除操作——抓取后渲染成了 "all␛[1Cthree␛[1Cland…"。
 *
 * 光标前移被“翻译”成它所代表的空格（丢弃它会粘合相邻单词）；其余都是控制
 * 而非内容，一律移除：OSC 字符串（窗口标题、超链接）、任何剩余的 CSI（SGR、
 * 光标、擦除、模式）、字符集选择，以及残留的任何两字节转义。
 */
const CUF_RE = /\x1b\[(\d*)C/g; // 光标前移：TUI 用来代替空格的写法
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g; // OSC … BEL/ST（标题、链接）
const CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g; // 任意 CSI：SGR、光标、擦除、模式
const CHARSET_RE = /\x1b[()][0-9A-B]/g; // 字符集选择（ESC ( B …）
const ESC2_RE = /\x1b./g; // 游离的两字节转义（ESC 7、ESC = …）

export function stripAnsi(chunk: string): string {
  return chunk
    .replace(CUF_RE, (_, n: string) => ' '.repeat(Math.min(parseInt(n || '1', 10) || 1, 80)))
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(CHARSET_RE, '')
    .replace(ESC2_RE, '');
}

/**
 * pty 的写入可能把一个转义序列拆到两个 chunk 里（一个 chunk 里是 `ESC[3`，
 * 下一个才是 `2m`）。`stripAnsi` 是无状态的，所以序列的开头会被当成游离的
 * 两字节转义丢弃，结尾则渲染成字面文本（"2m"）。流式剥离器会保留一个 chunk
 * 未完成的尾部，并把它接到下一个 chunk 前面。
 *
 * 这个暂存是有界的：一个永远无法完成的孤立 ESC（或永不终止的 OSC 字符串）
 * 不能无限缓冲，所以一旦暂存内容超过 MAX_CARRY，就原样交给无状态剥离器冲刷。
 */
export const MAX_CARRY = 256;

// 一个序列尚未到达其最终字节的 ESC：单独的 ESC、带参数/中间字节但无最终的 CSI、
// 无 BEL/ST 的 OSC，或裸的字符集选择前缀。
const PARTIAL_TAIL_RE = /^\x1b(?:\[[0-9;:?]*[ -/]*|\][^\x07\x1b]*|[()])?$/;

export function createAnsiStripper(): (chunk: string) => string {
  let carry = '';
  return (chunk: string): string => {
    let input = carry + chunk;
    carry = '';
    const esc = input.lastIndexOf('\x1b');
    if (esc !== -1) {
      const tail = input.slice(esc);
      if (PARTIAL_TAIL_RE.test(tail) && tail.length <= MAX_CARRY) {
        carry = tail;
        input = input.slice(0, esc);
      }
    }
    return stripAnsi(input);
  };
}
