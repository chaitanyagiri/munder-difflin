import { useEffect, useState } from 'react';
import { resolveGodName, DEFAULT_GOD_NAME } from '@shared/godIdentity';

const GOD_ID = 'god';

/**
 * God's persisted display name, for the boot screens shown BEFORE the store
 * has god's live agent object (so before `agent.name` exists anywhere to
 * read). Reads the registry directly, the same way useHive.ts's spawn effect
 * does, rather than assuming the default — otherwise a renamed god's own
 * "clocking in" screen would flash the wrong name every launch.
 */
export function useResolvedGodName(): string {
  const [godName, setGodName] = useState(DEFAULT_GOD_NAME);
  useEffect(() => {
    let cancelled = false;
    void window.cth.hiveRegistry().then((reg) => {
      if (!cancelled) setGodName(resolveGodName(reg?.agents?.[GOD_ID]?.name));
    }).catch(() => { /* keep the default while unknown */ });
    return () => { cancelled = true; };
  }, []);
  return godName;
}
