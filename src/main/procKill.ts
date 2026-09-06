/**
 * 进程树终止辅助（PID 释放加固）。
 *
 * 过去每条显式 kill 路径都是裸的 node-pty `proc.kill()`——只向直接子进程发
 * SIGHUP。随之而来两个泄漏：(1) 忽略/排队 SIGHUP 的子进程永远不会死，它的
 * PID 会一直残留到机器重启；(2) 即使子进程死了，它自己的子进程（MCP 服务器、
 * 会话启动的辅助守护进程）会被孤养到 PID 1 下而永不释放。熔断器/心跳整天在
 * 生成和杀掉会话，PID 因此稳步累积。
 *
 * 修复：pty 子进程是会话首领（forkpty 会 setsid），因此它的进程组覆盖其
 * 全部后代——优雅终止后，先校验再对整个组 SIGKILL（POSIX），或在 Windows 上
 * 用 `taskkill /T /F` 杀整棵树。
 *
 * 刻意的范围：调用方只在“显式”终止时使用（熔断停止、归档、重生、应用退出、
 * 隐藏式检查会话）——绝不在自然退出时使用；自然退出时，agent 有意留着运行的
 * 守护进程（比如通过 Bash 工具启动的 dev server）必须能比其父会话活得更久。
 */
import { spawnSync } from 'node:child_process';

/** 礼貌信号与 SIGKILL 升级之间的宽限期。 */
export const KILL_GRACE_MS = 4_000;

/** 进程是否还活着？信号 0 只探测，不打扰它。 */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 立即强力杀死 pid 及其全部后代。POSIX 上对进程组 SIGKILL（组 id 已消失时
 *  回退到单个 pid）；Windows 上 `taskkill /T /F`。对已死亡首领的组执行杀死
 *  正是回收孤儿的情形：任何幸存的成员仍然持有该组 id。 */
export function hardKillTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000 }); } catch { /* 已消失 */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已消失 */ }
  }
}

/** 优雅终止（node-pty 的 SIGHUP）之后，确保 PID 真正被释放：等待短暂宽限期，
 *  然后清扫进程树。即使首领及时死亡也会运行——清扫正是为了回收礼貌信号
 *  从未触达的孙进程。定时器已 unref，因此它绝不可能在退出时拖住应用。 */
export function ensureKilled(pid: number | undefined, graceMs = KILL_GRACE_MS): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  const t = setTimeout(() => hardKillTree(pid), graceMs);
  t.unref?.();
}
