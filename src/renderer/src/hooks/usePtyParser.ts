import { useCallback } from 'react';

/**
 * @deprecated The pty-stream → avatar-status parsing moved to
 * `ptyStatusWatcher.ts`, which subscribes to EVERY live agent pty app-wide
 * (mounted-panel-only parsing left background agents' statuses frozen —
 * issue #3). This hook is kept as a no-op so existing views keep compiling;
 * feeding the returned callback is harmless.
 */
export function usePtyParser(_agentId: string) {
  return useCallback((_chunk: string) => { /* parsing handled globally */ }, []);
}
