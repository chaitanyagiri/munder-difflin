import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { setGodName } from './index';

/**
 * 让 i18n 的 `{{godName}}` 指向编排器的真实名称。
 *
 * 在根附近挂载一次。读取实时 agent（重命名会更新的正是这个）并将其推入
 * i18next 的默认变量，因此所有提到编排器的字符串都会立即跟随重命名，
 * 两种语言下都生效，且这些调用点无需知道该名称。
 */
export function useGodNameSync(): void {
  const name = useStore((s) => s.agents.find((a) => a.isGod)?.name);
  useEffect(() => { setGodName(name); }, [name]);
}
