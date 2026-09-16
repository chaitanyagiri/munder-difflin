// Synthetic event loop — driven by the main-process MockHookServer via IPC.
//
// Previously this module wrote the zustand store directly (bypassing the
// HookServer → IPC → useHive pipeline). It now delegates to preload-exposed
// IPC methods, so all avatar state flows through the same path as real events.

import type { ToolKind, StationKind } from './store';

/**
 * Start the mock loop. The main process MockHookServer will emit
 * hive:hookEvent + hive:mockFeed messages that useHive.ts consumes.
 */
export function startMockLoop(agentIds: string[]): void {
  window.cth?.startMockLoop?.(agentIds);
}

/**
 * Stop the mock loop.
 */
export function stopMockLoop(): void {
  window.cth?.stopMockLoop?.();
}
