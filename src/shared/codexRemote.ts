import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const CODEX_REMOTE_SOCKET_RELATIVE =
  'app-server-control/app-server-control.sock';

/** macOS 把 Unix socket 路径限制在 104 字节（`sun_path`），而 Codex 把它的
 *  控制 socket 构造成 `$CODEX_HOME/app-server-control/app-server-control.sock`——
 *  后缀 42 字节。所以别名 home 本身必须容纳在约 61 字节内。
 *
 *  `$TMPDIR` 无法承载它：macOS 把它写成
 *  `/var/folders/xx/<30-char-hash>/T/`（49 字节），而别名算出来是 121——
 *  比它被引入所要缩短的那个 118 字节真实 home 还要长，所以每次
 *  daemon 启动都以 `path must be shorter than SUN_LEN` 失败。把别名
 *  扎根在一个固定的短前缀上，并把摘要控制在 8 个十六进制字符：
 *  整个 socket 路径于是落在 60 字节，还有余量。 */
export const CODEX_REMOTE_ALIAS_ROOT = '/tmp/mdc';

/** 平台接受的最长 socket 路径，减去一点安全余量。 */
export const CODEX_REMOTE_SOCKET_MAX = 104;

/** 把 CODEX_HOME 的拼写保持得足够短，以适配 macOS 的 Unix-socket 限制。
 *  `tempRoot` 默认为那个短固定根；调用方可以覆盖它（测试用）。 */
export function codexRemoteAliasPath(
  realHome: string,
  agentId: string,
  tempRoot: string = CODEX_REMOTE_ALIAS_ROOT
): string {
  const digest = createHash('sha256')
    .update(`${realHome}\0${agentId}`)
    .digest('hex')
    .slice(0, 8);
  return join(tempRoot, digest);
}

/** 候选 home 是否会产生平台能绑定的控制 socket。 */
export function codexRemoteSocketFits(shortHome: string): boolean {
  return join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE).length < CODEX_REMOTE_SOCKET_MAX;
}

export function codexRemoteEndpoint(shortHome: string): string {
  return `unix://${join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE)}`;
}

/** 全局选项必须位于 `resume` 之前，所以要在所有情况下都前置端点。 */
export function withCodexRemoteArgs(args: string[], endpoint: string): string[] {
  if (args.includes('--remote')) return args;
  return ['--remote', endpoint, ...args];
}
