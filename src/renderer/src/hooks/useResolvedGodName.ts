import { useEffect, useState } from 'react';
import { resolveGodName, DEFAULT_GOD_NAME } from '@shared/godIdentity';

const GOD_ID = 'god';

/**
 * god 的持久化显示名，用于 store 尚未拥有 god 活动 agent 对象的启动画面
 * （也就是任何地方都还读不到 `agent.name` 之前）。直接读取注册表，与
 * useHive.ts 的 spawn effect 方式相同，而不是假定默认名——否则被改名后的
 * god 自己的“打卡上班”画面每次启动都会闪错名字。
 */
export function useResolvedGodName(): string {
  const [godName, setGodName] = useState(DEFAULT_GOD_NAME);
  useEffect(() => {
    let cancelled = false;
    void window.cth.hiveRegistry().then((reg) => {
      if (!cancelled) setGodName(resolveGodName(reg?.agents?.[GOD_ID]?.name));
    }).catch(() => { /* 未知时保留默认名 */ });
    return () => { cancelled = true; };
  }, []);
  return godName;
}
