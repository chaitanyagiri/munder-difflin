import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// 这些辅助函数镜像 pty.ts 中的解析逻辑。它们单独存在，是为了让
// 无头子进程能用用户交互 shell 看到的同一个 PATH 启动 `claude`——
// macOS 上的 Electron 启动时没有登录 shell 的 PATH，
// 否则裸的 `claude` 会在打包构建里以 ENOENT 失败。

let cachedPath: string | null = null;

/** script → 捕获的输出，进程生命周期内记忆化。每次捕获都拉起一个完整的
 *  交互式登录 shell（含 rc 文件等一切）——在主进程上阻塞 spawnSync
 *  数百毫秒——而且 shell 的 PATH / 二进制位置在会话中途不会变。
 *  只有成功的捕获才被缓存，所以 null（shell 失败 / 围栏缺失）保持可重试。 */
const shellCapture = new Map<string, string>();

/** 在用户的交互式登录 shell 中运行 `script`，只返回脚本自己打印的东西。
 *
 *  需要交互式 shell 才能拾取 nvm/asdf/brew 的 PATH 修改，但它也会运行
 *  用户的 rc 文件，那些文件可以随意打印。某些 zsh 配置会在脚本自身输出
 *  之前，从会话保存插件发出 `Restored session: <date>`，静静地毒化读到
 *  的每个值：对 `echo "$PATH"` 做普通 `.trim()` 会得到
 *  `"Restored session: …\n/opt/homebrew/bin:…"`，那一整串会被当作 PATH
 *  发给每个 agent。用两个标记把输出围起来，让 rc 文件的闲聊（之前、
 *  之后、或前后都有）不可能被误当成结果。shell 失败或围栏从未出现时
 *  返回 null。 */
export function captureFromLoginShell(script: string): string | null {
  const cached = shellCapture.get(script);
  if (cached !== undefined) return cached;
  const value = captureFromLoginShellUncached(script);
  if (value !== null) shellCapture.set(script, value);
  return value;
}

function captureFromLoginShellUncached(script: string): string | null {
  const mark = '__MD_SHELL_FENCE__';
  try {
    const res = spawnSync(
      process.env.SHELL ?? '/bin/zsh',
      ['-ilc', `printf %s ${mark}; ${script}; printf %s ${mark}`],
      { encoding: 'utf8', timeout: 3000 }
    );
    const out = res.stdout ?? '';
    const start = out.indexOf(mark);
    const end = out.lastIndexOf(mark);
    if (start < 0 || end <= start) return null;
    return out.slice(start + mark.length, end);
  } catch {
    return null;
  }
}

/** 用户的交互式 shell PATH，查询一次并在会话期间缓存。 */
export function userShellPath(): string {
  if (cachedPath !== null) return cachedPath;
  // Windows 没有交互式登录 shell 的 PATH 问题——直接用进程 PATH。
  if (process.platform === 'win32') {
    cachedPath = process.env.PATH || '';
    return cachedPath;
  }
  const shellPath = captureFromLoginShell('printf %s "$PATH"')?.trim();
  // PATH 是一条用冒号连接的单一长行。任何多行内容都是溜过围栏的
  // rc 文件噪音——回退，而不是把一条损坏的 PATH 交给 agent，
  // 让它带进自己派生的每个子进程。
  cachedPath = shellPath && !shellPath.includes('\n') ? shellPath : process.env.PATH || '';
  return cachedPath;
}

/** 按用户的 PATH + 常见安装位置解析裸命令（例如 'claude'）。
 *  若输入看起来已是个路径则原样返回。 */
/** 普通的可执行文件名——我们按用户 PATH 解析的唯一形状。
 *  解析器可能把这个 token 插进 shell（`$SHELL -ilc "… which <it> …"`），
 *  所以它被限制为明确属于二进制名的字符（`[A-Za-z0-9._+-]`）；
 *  其他任何东西都不是命令名，会被拒绝而不是解析。调用方在此之前
 *  对真实路径（含 `/` 或 `\`）提前返回，所以到达解析器的唯一输入
 *  按设计就是裸二进制名。 */
export function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(command);
}

export function resolveCommand(command: string): string {
  // 已经是绝对/相对路径（Unix `/` 或 Windows `\`）——直接放行。
  if (command.includes('/') || command.includes('\\')) return command;
  // 不是普通命令名 → 无需解析。原样返回，让调用方的 spawn 以 ENOENT
  // 处理，且绝不让任何 shell 看到它。
  if (!isSafeCommandName(command)) return command;
  if (process.platform === 'win32') {
    // `where` 是 Windows 版的 `which`。不用 `shell:true`：上面的检查已经证明
    // 命令不含元字符，直接运行 `where`（libuv 经 PATHEXT 解析到 where.exe）
    // 让 cmd.exe 不进入回路。
    try {
      const res = spawnSync('where', [command], { encoding: 'utf8', timeout: 3000 });
      const path = (res.stdout ?? '').trim().split(/\r?\n/)[0];
      if (path && existsSync(path)) return path;
    } catch { /* 继续往下 */ }
    const appData = process.env.APPDATA ?? '';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const winCandidates = [
      `${appData}\\npm\\${command}.cmd`,
      `${appData}\\npm\\${command}`,
      `${localAppData}\\Programs\\claude\\${command}.exe`,
      `${home}\\.claude\\local\\${command}.cmd`,
      `${home}\\.claude\\local\\${command}`
    ];
    for (const c of winCandidates) if (existsSync(c)) return c;
    return command;
  }
  const which = captureFromLoginShell(`which ${command}`);
  if (which) {
    const path = which.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (path && existsSync(path)) return path;
  }
  const candidates = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    `${process.env.HOME ?? ''}/.local/bin/${command}`,
    `${process.env.HOME ?? ''}/.claude/local/${command}`,
    `${process.env.HOME ?? ''}/.volta/bin/${command}`
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return command;
}
