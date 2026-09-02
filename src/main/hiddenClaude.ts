import * as pty from 'node-pty';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveCommand, userShellPath } from './shellEnv';
import { expandTilde } from './fs';
import { projectDir } from './transcript';
import { ensureKilled } from './procKill';

/**
 * 共享辅助函数：运行一个“隐藏式”交互 claude 会话（临时 PTY），返回
 * 助手最终的文本回复。
 *
 * “隐藏”意味着：不加入 PtyManager、不向渲染进程发出、不出现在 agent
 * 列表或 OfficeFloor 场景中。每次调用都派生自己的会话，捕获后立即杀掉——
 * 无需 /clear，上下文不会串味。
 *
 * 使用交互式 PTY（而不是 `claude -p`），这样调用消耗的是用户常规的
 * 交互式 plan 配额，而不是从 2026-06-15 起转移到独立“需领取”池的
 * Agent SDK 额度。
 *
 * 会话生命周期：
 *   spawn → 检测启动完成（输出安静）→ 括号粘贴提示 + \r → 空闲稳定 →
 *   从 transcript JSONL 提取（最后一个助手文本块）→ kill
 */

/** PTY 安静多少毫秒表示 TUI 已准备好接收输入（启动完成）。 */
const BOOT_QUIET_MS = 1500;

export interface HiddenClaudeOptions {
  /** 要使用的模型（例如 'claude-haiku-4-5'）。 */
  model: string;
  /** claude 会话的工作目录。 */
  cwd: string;
  /** 基础 claude 命令/二进制。默认为 'claude'。 */
  command?: string;
  /** 会话禁止使用的工具。默认为 ['Edit','Write','NotebookEdit']。 */
  disallowedTools?: string[];
  /** 通过 --add-dir 加入的目录（用于收集上下文）。 */
  addDirs?: string[];
  /** 无论启动活动如何，强制发送提示词前的硬性毫秒上限。默认 7000。 */
  bootCapMs?: number;
  /** 提示之后、表示回复完成的 PTY 安静毫秒数。默认 3500。 */
  idleMs?: number;
  /** 总超时毫秒数。默认 180000。 */
  timeoutMs?: number;
  /** 在解析出的 shell 环境之上合并的额外 env（例如共享的 MemPalace）。 */
  env?: Record<string, string>;
}

export interface HiddenClaudeResult {
  ok: boolean;
  /** 助手最终的文本回复（已去除任何 TUI 外壳）。 */
  text?: string;
  error?: string;
}

/**
 * 从 `spawnedAt` 或其之后写入的 transcript JSONL 中提取最后一个助手
 * 文本块。复用 transcript.ts 的 projectDir()。
 */
function extractLastAssistantText(cwd: string, spawnedAt: number): string | null {
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return null;

    const candidates: { f: string; mtime: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const mtime = statSync(path.join(dir, f)).mtimeMs;
        // 5 秒余量：把 spawn 时已存在、但被本会话更新过的文件
        // 也算进来。按 mtime 排序并取最新的。
        if (mtime >= spawnedAt - 5000) candidates.push({ f, mtime });
      } catch { /* 文件在 readdir 与 stat 之间被移除——跳过 */ }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);

    const lines = readFileSync(path.join(dir, candidates[0].f), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let rec: { type?: unknown; message?: { content?: unknown[] } };
      try { rec = JSON.parse(trimmed); } catch { continue; }
      if (rec.type !== 'assistant') continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j] as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return block.text.trim();
        }
      }
    }
    return null;
  } catch { return null; }
}

export function runHiddenClaude(prompt: string, opts: HiddenClaudeOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    // 纵深防御：`~` 是 shell 语法，不是 Node 认识的路径。
    const cwd = opts.cwd ? expandTilde(opts.cwd) : opts.cwd;
    if (!cwd || !existsSync(cwd)) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }
    opts = { ...opts, cwd };

    const binary = (opts.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    const disallowed = opts.disallowedTools ?? ['Edit', 'Write', 'NotebookEdit'];
    const addDirs = (opts.addDirs ?? []).filter((d) => d && existsSync(d));

    const args: string[] = [
      '--model', opts.model,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', ...disallowed,
    ];
    for (const d of addDirs) { args.push('--add-dir', d); }

    const bootCapMs = opts.bootCapMs ?? 7000;
    const idleMs = opts.idleMs ?? 3500;
    const timeoutMs = opts.timeoutMs ?? 180_000;

    const spawnedAt = Date.now();
    // Windows：node-pty 的 CreateProcess 无法直接执行 npm 的 `.cmd`/无扩展名
    // `claude` shim（ERROR_BAD_EXE_FORMAT，错误 193）——把非 .exe
    // 目标经由 cmd.exe 路由。真正的 claude.exe（WinGet）可直接启动。（#22）
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(exe);
    const spawnFile = winWrap ? (process.env.ComSpec || 'cmd.exe') : exe;
    const spawnArgs = winWrap ? ['/c', exe, ...args] : args;
    let ptyProc: pty.IPty;
    try {
      ptyProc = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd: opts.cwd,
        env: {
          ...process.env,
          PATH: userShellPath(),
          ...(opts.env ?? {}),
        } as Record<string, string>,
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let settled = false;
    let promptSent = false;
    let bootTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let bootMaxTimer: NodeJS.Timeout;
    let globalTimer: NodeJS.Timeout;

    // 隐藏会话是临时性的“检查”——它们派生的任何东西（MCP 服务器、
    // 辅助进程）都不得比它们活得更久。礼貌地杀掉，然后清扫进程组，
    // 即使 `claude` 对 SIGHUP 不理不睬，每个检查也会释放自己的 PID。
    const kill = () => {
      const pid = ptyProc.pid;
      try { ptyProc.kill(); } catch { /* 空操作 */ }
      ensureKilled(pid);
    };

    const finish = (r: HiddenClaudeResult) => {
      if (settled) return;
      settled = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      clearTimeout(bootMaxTimer);
      clearTimeout(globalTimer);
      kill();
      resolve(r);
    };

    const captureAndFinish = () => {
      const text = extractLastAssistantText(opts.cwd, spawnedAt);
      finish(text
        ? { ok: true, text }
        : { ok: false, error: 'no assistant response found in transcript' });
    };

    const sendPrompt = () => {
      if (settled || promptSent) return;
      promptSent = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      // 括号粘贴 + 回车——与 useHive.ts 中 submitToPty 相同的机制。
      ptyProc.write(`\x1b[200~${prompt}\x1b[201~`);
      setTimeout(() => { if (!settled) ptyProc.write('\r'); }, 140);
    };

    bootMaxTimer = setTimeout(sendPrompt, bootCapMs);
    globalTimer = setTimeout(
      () => finish({ ok: false, error: 'hidden session timed out' }),
      timeoutMs,
    );

    ptyProc.onData(() => {
      if (!promptSent) {
        // 启动阶段：重置安静计时器；输出一安静就发送提示词。
        if (bootTimer) clearTimeout(bootTimer);
        bootTimer = setTimeout(sendPrompt, BOOT_QUIET_MS);
      } else {
        // 回复阶段：重置空闲计时器；输出稳定时捕获。
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(captureAndFinish, idleMs);
      }
    });

    // 会话在空闲前就干净退出——无论如何都尝试捕获 transcript。
    ptyProc.onExit(() => { if (!settled) captureAndFinish(); });
  });
}
