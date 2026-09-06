/** 会打开交互式选择器/面板而不是开始一次普通 agent 回合的斜杠命令。
 * 自动化队列投递必须等到该 UI 关闭为止。 */
const INTERACTIVE_COMMANDS = new Set([
  '/model',
  '/reasoning',
  '/permissions',
  '/permission',
  '/provider',
  '/settings',
  '/config',
  '/experimental',
  '/experiments',
  '/hooks',
  '/mcp',
  '/apps',
  '/plugins',
  '/resume',
  '/sessions'
]);

export function opensInteractiveTerminalUi(input: string): boolean {
  // 只有裸命令才会打开选择器。`/model` 会提示你选择；
  // `/model sonnet` 应用参数并回到提示符，没有任何 UI 需要关闭。
  // 只按第一个 token 匹配会把第二种形式也锁死，而没有任何东西能清除它——
  // 于是该 agent 的消息队列在本会话余下的时间里静默停止投递。
  const trimmed = input.trim().toLowerCase();
  if (/\s/.test(trimmed)) return false;
  return INTERACTIVE_COMMANDS.has(trimmed);
}

/** 只有当用户已经位于底部（或离底部一行以内）时才跟随输出。
 * 这样既能保持实时 TUI 可见，又不会把正在读滚动缓冲的人拽走。 */
export function shouldFollowTerminalOutput(viewportY: number, baseY: number): boolean {
  return baseY - viewportY <= 1;
}

/** 提示符上一个未被触碰的草稿会阻塞队列投递多久。
 *
 * 这个阻塞存在，是为了让自动化不会把自己的文本拼接到半截写了一半的行上。
 * 它仍必须过期，因为该标记是由按键设置的，而一个把按键吞进自己 UI（如菜单、
 * 确认框）的 TUI 可能在提示符明显为空时仍让标记置位——一个幽灵草稿，把队列
 * 卡住直到本会话结束。
 *
 * 半小时，而不是一分钟。旧的 60 秒窗口会在用户只是停下来思考时触发，把真实
 * 草稿当成废弃是代价高昂的错误；把排队消息多停一会儿是廉价的选择。当真触发时，
 * 投递只是在现有文本后面继续输入（二者拼成同一个提示）——自动化从不删除用户写
 * 的内容。 */
export const STALE_INPUT_MS = 1_800_000;

/** 未被触碰的选择器会阻塞队列投递多久。
 * 选择器锁存是在用户提交裸 `/model` 风格命令时设置的，并由在该终端输入的
 * Enter、Escape 或 Ctrl-C 清除——因此以其它任何方式关闭的选择器会留下锁存，
 * 且没有回来的路径。同样半小时、同理：这是用户的菜单，所以要等很久，然后才
 * 投递。我们从不自己发送 Escape；关闭某人打开的菜单来给一条排队消息腾地方，
 * 不是我们该做的事。 */
export const STALE_PICKER_MS = 1_800_000;

export interface TerminalAutomationState {
  exited: boolean;
  pickerOpen: boolean;
  inputDirty: boolean;
  settleUntil: number;
  inputDirtyAt?: number; // 留下草稿的最后一次按键；缺省 ⇒ 永不过期
  pickerOpenedAt?: number; // 选择器锁存的时刻；缺省 ⇒ 永不过期
}

/** 一个超过 STALE_PICKER_MS 无人交互的选择器视为已消失。 */
export function isStaleTerminalPicker(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return state.pickerOpen
    && state.pickerOpenedAt !== undefined
    && now - state.pickerOpenedAt >= STALE_PICKER_MS;
}

/** 为什么自动化此刻可能不能拥有提示符，或者当它可以时为 null。 */
export type TerminalAutomationBlock = 'exited' | 'picker' | 'draft' | 'settling' | null;

/** 一个超过 STALE_INPUT_MS 无人触碰的草稿视为已废弃。 */
export function isStaleTerminalDraft(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return state.inputDirty
    && state.inputDirtyAt !== undefined
    && now - state.inputDirtyAt >= STALE_INPUT_MS;
}

export function terminalAutomationBlock(
  state: TerminalAutomationState,
  now = Date.now()
): TerminalAutomationBlock {
  if (state.exited) return 'exited';
  if (state.pickerOpen && !isStaleTerminalPicker(state, now)) return 'picker';
  if (state.inputDirty && !isStaleTerminalDraft(state, now)) return 'draft';
  if (now < state.settleUntil) return 'settling';
  return null;
}

/** 只有没有用户草稿或选择器占用时，自动写入才能拥有提示符。 */
export function canAutomateTerminal(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return terminalAutomationBlock(state, now) === null;
}
