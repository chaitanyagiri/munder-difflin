export interface TerminalRecoveryState {
  initialRedrawRequested: boolean;
  webglRecoveryPending: boolean;
}

export function createTerminalRecoveryState(): TerminalRecoveryState {
  return { initialRedrawRequested: false, webglRecoveryPending: false };
}

/** 附着到稳定 PTY id 上的一次性 xterm 实例的 React key。 */
export function terminalInstanceKey(ptyId: string, generation = 0): string {
  return `${ptyId}:${generation}`;
}

/** 同时接受当前字符串协议和短暂的 replay 协议，这样渲染器热重载在应用下次
 * 退出前都保持可用。 */
export function normalizePtyChunk(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'data' in value) {
    const data = (value as { data?: unknown }).data;
    if (typeof data === 'string') return data;
  }
  return '';
}

/** 在渲染器订阅 PTY 输出后，请求正好一次重绘。
 *
 *  这个锁存只在重绘真正 SUCCEED 之后才设置。过去是在前面就设置的——在
 *  fire-and-forget IPC 解析之前——所以一次失败或竞态的重绘会留下一个已经
 *  耗尽它唯一机会的终端，没有输出可以重画它，也没有重试路径。那是一个空白
 *  面板，背后却是一个完全健康的 pty。被拒绝的重绘现在会让锁存保持清空，
 *  于是下一次 attach 会再试一次。 */
export function requestInitialPtyRedraw(
  state: TerminalRecoveryState,
  requestRedraw: () => void | Promise<unknown>
): boolean {
  if (state.initialRedrawRequested) return false;
  // 在 await 之前设置，这样同一 tick 内的两次 attach 不会都触发；下面的失败
  // 会再次清除它。
  state.initialRedrawRequested = true;
  try {
    const result = requestRedraw();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).catch(() => {
        state.initialRedrawRequested = false;
      });
    }
  } catch {
    state.initialRedrawRequested = false;
  }
  return true;
}

/** 在 WebGL 销毁后等待两个绘制帧，让 DOM 渲染器可以重绘。
 *
 *  `recover` 报告它是否真的重绘了。当它做不到时（host 已分离或仍未定尺寸），
 *  pending 标记被清除，同时调用方保留它的 needs-repaint 标记，这样稍后的
 *  attach 可以再安排一次尝试。在确认重绘之前无条件清除标记，正是让空白终端
 *  “有时候”能恢复的原因——稍后一次 resize 是否碰巧重建渲染器全凭运气。 */
export function scheduleWebglRecovery(
  state: TerminalRecoveryState,
  requestFrame: (cb: () => void) => void,
  recover: () => void
): boolean {
  if (state.webglRecoveryPending) return false;
  state.webglRecoveryPending = true;
  requestFrame(() => requestFrame(() => {
    state.webglRecoveryPending = false;
    recover();
  }));
  return true;
}
