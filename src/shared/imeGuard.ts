/**
 * “这次 keydown 只是 IME 在发声吗？”
 *
 * 中日韩用户把拉丁字母输入到输入法编辑器里，
 * 编辑器显示候选列表，用户按 ENTER 来*选择*候选。
 * 这个 Enter 是给 IME 的，不是给我们的。
 * 应用里每一个 `if (e.key === 'Enter')` 处理器过去都把它当作“发送”，
 * 于是选候选触发了消息发送、执行了搜索、
 * 或用敲了一半的文本提交了重命名。
 * 用户随后不得不在应用已经胡乱发送过的语言里重新输入。
 *
 * 用两个信号，因为两者单独都不够：
 *
 *  1. `isComposing` — DOM 自己的答案，对组合会话进行期间派发的 keydown
 *     为 true。这是首要检查。React 的合成键盘事件不会重新暴露它，
 *     因此我们先通过 `nativeEvent` 读取，
 *     只在必要时才回退到对象本身（针对直接携带它的原始
 *     `KeyboardEvent` 监听器）。
 *
 *  2. `keyCode === 229` — Chromium 仍会报告的“IME 正在处理这个键”的
 *     传统哨兵值。它覆盖组合会话末尾的竞态：
 *     compositionend 和确认的 keydown 到达顺序可能使我们要吞掉的那个
 *     Enter 到达时 `isComposing` 已经是 false。
 *     229 从来不是真正的 Enter（那是 13），
 *     因此这不会吞掉一次真实的按键。
 *
 * 刻意保持纯净且无框架依赖，以便能从 `node --test` 测试。

/** 我们需要的结构形态，无论是来自 React 合成事件还是原始 DOM
 *  `KeyboardEvent`。刻意全部可选：手工构造的测试替身或部分填充的
 *  事件必须降级为“不在组合中”，绝不抛错。 */
export interface ComposingKeyEvent {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** 当这次 keydown 属于进行中的 IME 组合、处理器必须不做任何动作直接返回时
 *  为 true。组合结束后的下一次 Enter 会以 `isComposing` 为 false、
 *  `keyCode` 为 13 到达，并被正常处理。
 *  */
export function isComposingKey(e: ComposingKeyEvent | null | undefined): boolean {
  if (!e) return false;
  // 优先使用原生事件：React 的 SyntheticKeyboardEvent 会丢掉 `isComposing`。
  const src = e.nativeEvent ?? e;
  return src.isComposing === true || src.keyCode === 229;
}
