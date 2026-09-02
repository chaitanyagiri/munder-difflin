/**
 * ASK ME 看板的排序规则。
 *
 * 这块看板原本根本没有比较器：`tasks.filter(waitsOnHuman)` 按卡片在
 * 440KB 的 tasks.json 中恰好所处的顺序渲染，而这大致等于整个文件里的建卡顺序，
 * 与问题是什么时候提出来的毫无关系。五分钟前的问题可能排到三天前的问题下面，
 * 而且随着无关卡片的加入，顺序还会变动。
 *
 * 本模块只是排序规则，刻意不引入任何 import（没有 React、没有 store），
 * 这样比较器可以独立做单元测试——queueDelivery.ts 保持其 gate 结构化也是同理。
 *
 * 重要——这个界面有两种排序，这里只对其中“外层”的一种排序：卡片的列表（本文件）。
 * 卡片内部的 `humanQA` 数组是对话历史，通过“查看前 N 条更早的回答”折叠
 * 按旧到新渲染，必须保持时间顺序。切勿反转它。
 */

/** 排序只需要卡片打开的那个 ask 的这几项。做成结构化类型，这样
 *  测试不必构造完整的 HiveTask。 */
export interface AskLike {
  askedAt?: string;
}

/** `askedAt` 转成 epoch 毫秒，缺失或无法解析时为 null。
 *  永不抛错——手工编辑的账本不能把看板搞崩。 */
export function askedAtMs(open: AskLike | undefined): number | null {
  const raw = open?.askedAt;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 最新的 ask 排最前，最旧的排最后。
 *
 * 调用方传入每张卡片的 OPEN 问题（来自 `openQuestion()`），所以“open”
 * 是从 `waitsOnHuman` 已经在用的同一个谓词推导出来的，而不是在这里再定义一遍。
 *
 * 打开 ask 没有可解析 `askedAt` 的卡片排到最后，这样坏时间戳只会让那一张卡
 * 丢位置，而不会抛错。
 */
export function compareByNewestAsk(a: AskLike | undefined, b: AskLike | undefined): number {
  const ax = askedAtMs(a);
  const bx = askedAtMs(b);
  if (ax === null && bx === null) return 0;
  if (ax === null) return 1;  // a 没有时间 -> 排在 b 之后
  if (bx === null) return -1; // b 没有时间 -> 排在 a 之后
  return bx - ax;             // 降序
}
