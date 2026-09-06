/** 任何人自定义之前 God 的身份——应用自身的默认值，
 *  而不是散落在每个 spawn 调用点的魔法字符串。 */
export const DEFAULT_GOD_NAME = 'Michael';

/**
 * 解析 god 在（重新）spawn 时的显示名称。
 *
 * `renameAgent()`（`store.ts`）会把重命名直接持久化到 `registry.json`
 * （经由 `hive.ts` 的 `renameAgent()`）——但 god-spawn 效果过去会用
 * 硬编码在三处的 `name: DEFAULT_GOD_NAME` 从头重建 god 的 agent 对象，
 * 于是即便 registry 里保存的名称是对的，自定义名称也会在每次应用
 * 重启时还原成 "Michael"。在这里读回持久化的名称（而不是硬编码默认值）
 * 正是让重命名不再还原的关键。仅当尚未持久化任何内容时才回退到默认值
 * ——全新 hive，或本次运行尚未写入 registry 的情况。
 */
export function resolveGodName(persistedName: string | undefined | null): string {
  const trimmed = persistedName?.trim();
  return trimmed ? trimmed : DEFAULT_GOD_NAME;
}
