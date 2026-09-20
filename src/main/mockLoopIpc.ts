/**
 * mockLoopIpc — registers IPC handlers that wire the renderer's mock loop
 * requests to the main-process MockHookServer.
 *
 * Add this import to src/main/index.ts:
 *   import { registerMockLoopIpc } from './mockLoopIpc';
 *
 * And call it after constructing the HookServer:
 *   registerMockLoopIpc(hookServer, mockServer, mainWindow);
 */

import { ipcMain } from 'electron';
import { MockHookServer } from './mockHookServer';

export function registerMockLoopIpc(
  mockServer: MockHookServer,
  getWindow: () => Electron.WebContents | null
): void {
  ipcMain.on('mock:start', (_event, agentIds: string[]) => {
    mockServer.start(agentIds);
  });

  ipcMain.on('mock:stop', () => {
    mockServer.stop();
  });
}
