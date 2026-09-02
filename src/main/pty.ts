import * as pty from 'node-pty';
import type { WebContents } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureKilled, hardKillTree } from './procKill';
import { expandTilde } from './fs';
import { buildPtyEnv } from './ptyEnv';
import { captureFromLoginShell, isSafeCommandName, userShellPath } from './shellEnv';

/** 把 hive 自带的 node 目录（`<HIVE_ROOT>/bin/runtime`，其中放着一个字面名为 `node`
 *  的垫片）APPEND 到子进程的 PATH 末尾。
 *
 *  第 1 层让 WE 生成的命令走 `hive-node`。这里覆盖的是我们不生成的命令：一个声明为
 *  `node ./server.js` 的 MCP 服务器、一个向外调用 node 的 provider CLI、一个 agent
 *  自己写的辅助脚本。没有系统级 node 时，它们都会以 127 退出——同一类 bug，只是又低了一层。
 *
 *  只 APPEND、绝不 PREPEND：用户自己装了 node 就保留它，我们只是兜底。若 PREPEND，
 *  会在用户自己的项目里悄悄把 node 版本换成 Electron 自带的，这是另一个（而且是错误的）
 *  产品决策。没有 hive 根目录或该目录从未写入时，本函数为 no-op。 */
export function withHiveRuntimeFallback(path: string, hiveRoot?: string): string {
  if (!hiveRoot) return path;
  const dir = join(hiveRoot, 'bin', 'runtime');
  if (!existsSync(dir)) return path;
  const entries = path.split(delimiter).filter(Boolean);
  if (entries.includes(dir)) return path; // 正在重新生成活的 agent
  return [...entries, dir].join(delimiter);
}

interface PtySession {
  id: string;
  proc: pty.IPty;
  cwd: string;
  command: string;
  /** 生成该 PTY 并应接收其输出的窗口（webContents）。多窗口场景下：每个楼层拥有自己的
   *  终端，因此 `pty:data:<id>` / `pty:exit:<id>` 只路由到这里——绝不广播——这样
   *  一个楼层的输出流不会泄漏到另一个楼层。为 null 时回退到默认的附加输出目标（主窗口），
   *  保持单窗口行为不变。 */
  owner: WebContents | null;
  /** 本 PTY 最近一次输出字节的 epoch 毫秒数（在 onData 中更新）。心跳（Lane A #1）
   *  读取它用于两件事：楼层静默检测（agent 打印/思考即使还没写 hive 文件也算活跃）和
   *  空闲握手——用来门控 god 的 PTY 轻推（绝不要向最近几秒内仍有输出的 PTY 键入内容 =
   *  正处于输出流中间）。 */
  lastOutputAt: number;
  /** 子进程至少输出过一帧后为 true。自动化在键入前会等待它，这样启动提示不会跑在
   *  TUI 订阅之前。 */
  hasOutput: boolean;
}

export interface SpawnOptions {
  id: string;
  cwd: string;
  command: string;       // 例如 'claude'
  args?: string[];
  cols?: number;
  rows?: number;
  /** 子进程的额外环境变量（覆盖到已解析的 shell 环境之上）。 */
  env?: Record<string, string>;
  /** 设置后，把该字符串当作一个可见的 shell 脚本来运行，而不是解析/生成 `command`。
   *  用于缺少 CLI 的自动安装路径：该脚本（一条横幅 + 一条安装命令）会流式输出到同一个
   *  Terminal 标签页。unix 下经 `$SHELL -lc` 运行，Windows 下经 `cmd.exe /d /s /c`
   *  运行。脚本绝不能包含内嵌双引号（在 Windows 上会原样包裹）。`command` 仍会被记录
   *  用于展示，但不会被执行。 */
  shellScript?: string;
}

/**
 * (#55) 构建单条预转义命令行 STRING，用于把非 .exe 的 Windows 目标经 cmd.exe 路由。
 * 只返回 args 部分（`cmd.exe` 之后的一切），采用 Node 规范的 `child_process` 形式：
 *
 *   /d /s /c "<target> <arg> <arg> ..."
 *
 * 每个 token（解析出的目标 + 每个用户参数）仅在包含空格/制表符/引号时加双引号，然后用
 * 一对额外的外层引号包住整个内部命令。cmd.exe 的 `/s` 恰好剥掉那对外层引号并按字面执行
 * 其余部分，所以 `C:\Program Files\...` 这样的目标能扛过它路径中的空格。
 *
 * 该字符串以 STRING 形式交给 `pty.spawn(file, args, ...)`，node-pty 会把它当作一条
 * 预转义的 CommandLine 并 VERBATIM 透传（不再逐参数重新转义），所以这里的引号绝不会被
 * 二次包裹。
 *
 * ⚠️ 最后手段路径——绝不要把 agent 提示词塞进去。cmd.exe 解析器有两个硬限制，这里无论
 * 怎样转义都无法绕过：
 *
 *  1. **cmd.exe 没有反斜杠转义。** 本注释的早期版本曾声称 `\"` 是 "cmd 的引号转义"。
 *     其实不是：对 cmd 而言 `\` 只是普通字符，每个 `"` 都会 TOGGLE 引号状态。所以 `\"`
 *     并不会嵌入一个引号——它只会关闭（或打开）带引号的一段，并把其后的一切重新丢回裸的、
 *     按元字符解释的上下文。下面生成的 `\"` 之所以能存活，只是因为 *最终* 程序的 CRT
 *     会反转义它；中间的 cmd.exe 仍会在它上面错误跟踪引号状态。
 *  2. **换行永远无法存活。** cmd.exe 在考虑引号之前就把 CR/LF 当作语句分隔符，所以
 *     多行参数会在第一个换行处被 TRUNCATED，剩余部分被当作命令执行。这正是 Windows 上
 *     hive 协议提示词（多行、满是 cmd 视为块定界符的 `(`/`)`）被毁掉的方式：agent 启动
 *     后看起来健康，却从未收到 HIVE PROTOCOL 块，于是永远不知道收件箱/发件箱存在，
 *     没有任何 agent 能互发消息。
 *
 * 还有 cmd.exe 约 8191 字符的命令行上限，而注入的 hive 提示词（约 6.1k 字符）就紧贴着
 * 这个上限。
 *
 * 因此携带提示词的 spawn 改走 `parseNpmCmdShim`（用 ARRAY 参数生成垫片的真实解释器，
 * 这样 node-pty 自带的 CRT 正确的 `argsToCommandLine` 得以运行，全程不涉及 shell 解析器）。
 * 本函数仍是所有我们无法解码目标的兜底——严格说不比从前更差。
 */
export function buildCmdCommandLine(resolved: string, args: string[]): string {
  const quoteToken = (s: string): string => {
    // 转义任何内嵌的双引号，然后在需要时给 token 加引号。
    // 在空白/引号以及 cmd.exe 元字符（& | ^ < > ( ) % !）上加引号：
    // 未加引号的 `&`/`|`/等一旦被 cmd.exe 执行，会让一个 token 串联出第二条命令。
    // 加引号可以中和它们——cmd 不会解释双引号段内的元字符。
    const escaped = s.replace(/"/g, '\\"');
    return /[ \t"&|^<>()%!]/.test(s) ? `"${escaped}"` : escaped;
  };
  const inner = [resolved, ...args].map(quoteToken).join(' ');
  return `/d /s /c "${inner}"`;
}

/** 一个 npm 风格的 Windows `.cmd` 垫片实际运行的内容，从其文本中解码而来。 */
export interface NpmShimTarget {
  /** BARE 解释器名——`node`、`bun` 或 `deno`——由调用方沿 PATH 解析（刻意保持裸名：
   *  见 parseNpmCmdShim）；当垫片直接运行原生可执行文件、根本没有解释器时为 NULL。 */
  interpreter: string | null;
  /** 该解释器应运行的脚本的绝对、规范化 win32 路径——当 `interpreter` 为 null 时，
   *  则指向可执行文件本身。 */
  scriptPath: string;
}

/** 我们愿意直接生成的解释器。刻意保持极小的白名单：任何其他东西（手写的批处理文件、
 *  python/ruby 垫片、我们没见过形状的东西）都解析为 null 并回退到 cmd.exe 路径——绝不
 *  比现在的行为更差。 */
const SHIM_INTERPRETERS = new Set(['node', 'bun', 'deno']);
/** 垫片的目标必须看起来像 JS 入口点。指向其他东西的垫片不是我们能理解的形状 → null。 */
const SHIM_SCRIPT_EXT = /\.(?:c|m)?js$/i;

/**
 * 把一个 npm 生成的 Windows `.cmd` 垫片解码成它本会运行的解释器 + 脚本。PURE（不碰
 * 文件系统、不碰 `process.platform`）：它接收垫片的路径及其 CONTENT，因此可以在
 * macOS/Linux 上做单元测试，而所有 Windows 构建都在那里产出。
 *
 * 为什么存在。Windows 上 `.cmd`/`.bat` 不能直接交给 CreateProcess，所以 spawn 路径过去
 * 把它经 `cmd.exe /d /s /c "<line>"` 路由。那会把 argv 变成由 cmd.exe 解析的单条字符串
 * ——cmd.exe 无法承载换行（语句分隔符）、把 `(`/`)` 当作块定界符、没有反斜杠转义、上限
 * 接近 8191 字符。hive 协议提示词是一个约 6.1k 字符、11 行、62 个括号的参数，所以在
 * Windows 上它会在第一个换行处被截断：每个 npm 安装的 CLI（OpenCode 一直如此；只要没有
 * 原生 `claude.exe`，`claude.cmd` 也如此）启动后看起来完全健康，却从未收到 HIVE PROTOCOL
 * 块，从未得知 `inbox/`/`outbox/` 存在，于是没有任何 agent 能听到别的 agent 的声音。
 * Claude 看起来正常，只是因为它的原生 `claude.exe` 完全绕过了 cmd.exe。
 *
 * 用 ARRAY 形式的参数直接生成垫片自己的解释器，就把 cmd.exe 从整条链路中移除了：
 * node-pty 的 `argsToCommandLine` 会应用 MSDN/CRT 转义（引号前反斜杠加倍、遇空白时整参
 * 加引号），并把结果直接交给 CreateProcess，由它把原始命令行传给子进程。带引号的 CRT
 * 参数里的换行在那里只是一个字符，上限也变成 CreateProcess 的 32767，而不是 cmd 的 8191。
 *
 * SHAPES HANDLED（npm 的 cmd-shim，覆盖其历史各版本；pnpm/yarn 产出同一族形状）：
 *
 *   modern (cmd-shim ≥4 / npm ≥7) — dp0 被捕获进变量，程序选入 %_prog%，末尾单条 exec 行：
 *       SET dp0=%~dp0
 *       IF EXIST "%dp0%\node.exe" ( SET "_prog=%dp0%\node.exe" ) ELSE ( SET "_prog=node" … )
 *       endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
 *
 *   classic (cmd-shim 2/3, npm 5/6) — IF/ELSE，exec 在两个分支中都内联：
 *       @IF EXIST "%~dp0\node.exe" (
 *         "%~dp0\node.exe"  "%~dp0\node_modules\pkg\bin\cli.js" %*
 *       ) ELSE ( … node  "%~dp0\node_modules\pkg\bin\cli.js" %* )
 *
 *   ancient 单行:
 *       @"%~dp0\node.exe"  "%~dp0\node_modules\pkg\bin\cli.js" %*
 *
 * 解释器刻意以 BARE（`node`）形式返回，而不是垫片的 `%dp0%\node.exe` 候选：那个候选只
 * 在 npm 安装自带同目录 node 时存在，而该目录按构造本来就在 PATH 上——所以解析裸名能
 * 找到同一个二进制，同时仍会走调用方现有的 PATH/候选目录解析与缓存。
 *
 * 对任何未完全理解的形状返回 null——含义是"回退到 cmd.exe 路径"：未知解释器、目标里
 * 残留未展开的 `%VAR%`、相对目标、我们本会静默丢弃的多余解释器标志、非 JS 目标、大到
 * 不可能是垫片的文件，或者纯垃圾内容。
 */
export function parseNpmCmdShim(shimPath: string, content: string): NpmShimTarget | null {
  if (typeof shimPath !== 'string' || typeof content !== 'string') return null;
  if (!shimPath || !content) return null;
  // 一个 cmd-shim 约 1KB。更大的东西是某人的真实批处理脚本（或某个被命名为 `.cmd` 的
  // 二进制），不该由我们重新解释。
  if (content.length > 8192 || content.includes('\0')) return null;

  // 明确使用 win32.* ——无论我们在什么宿主机上运行（或测试），这些路径都是 Windows 路径。
  const dir = win32.dirname(shimPath);
  if (!dir || dir === '.') return null;

  /** 把一个垫片 token 的 `%~dp0` / `%dp0%`（垫片自己的目录，cmd 展开时会带一个尾部
   *  反斜杠）展开成绝对、规范化的路径。任何其他存留的 `%` 都意味着有一个我们没有建模的
   *  变量 → 拒绝。 */
  const expand = (raw: string): string | null => {
    let s = raw.replace(/%~dp0%?|%dp0%/gi, `${dir}\\`);
    if (s.includes('%')) return null;
    if (!s.trim()) return null;
    // `<dir>\` + `\node_modules\…` 会产生一个 Windows 能容忍的双写分隔符；把它折叠掉，
    // 这样交给 existsSync 的路径是干净的。开头的 UNC `\\server\share` 前缀必须在这种
    // 折叠后仍然保留。
    const unc = /^[\\/]{2}/.test(s);
    s = s.replace(/[\\/]+/g, '\\');
    if (unc) s = `\\${s}`;
    if (!win32.isAbsolute(s)) return null;
    return win32.normalize(s);
  };

  // 垫片执行的每个 `SET "_prog=…"`（IF-EXISTS 分支和 PATH 分支）。
  const progValues: string[] = [];
  for (const m of content.matchAll(/^\s*@?SET\s+"?_prog=([^"\r\n]*)"?/gim)) progValues.push(m[1]);

  // exec 行是携带 `%*`（cmd 的"转发全部参数"）的最后一行：在 modern 垫片里就是那条
  // 单独的 `endLocal & … & "%_prog%" "<script>" %*` 行；在 classic IF/ELSE 垫片里则是
  // ELSE 分支，它运行同一个脚本。
  const lines = content.split(/\r?\n/);
  let execLine: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('%*')) { execLine = lines[i]; break; }
  }
  if (!execLine) return null;

  const head = execLine.slice(0, execLine.lastIndexOf('%*'));
  const quoted = [...head.matchAll(/"([^"]*)"/g)].map((m) => ({
    text: m[1],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length
  }));
  if (quoted.length === 0) return null;

  const scriptTok = quoted[quoted.length - 1];
  // 定位程序 token，并 PROVE 它和脚本之间没有任何东西。写死在 shebang（`#!/usr/bin/env
  // node --flag`）里的解释器标志会落在这里；悄悄丢弃它们会改变 CLI 的运行方式，所以我们
  // 改而退出到 cmd.exe 兜底。
  let progRaw: string;
  if (quoted.length >= 2) {
    const progTok = quoted[quoted.length - 2];
    if (head.slice(progTok.end, scriptTok.start).trim() !== '') return null;
    progRaw = progTok.text;
  } else {
    // 两种单 token 形状共用这个分支，靠引号前面是什么来区分。
    const before = head.slice(0, scriptTok.start).trim().replace(/^@/, '').trim();
    if (before === '') {
      // DIRECT-EXECUTABLE 垫片：带引号的目标前面什么都没有，因此没有解释器——垫片直接
      // 运行一个原生二进制。npm 在包的 bin 没有 shebang 时会写出这种形式，而这正是编译型
      // CLI 的常态：
      //
      //   "%dp0%\..\opencode-ai\bin\opencode.exe"   %*
      //
      // opencode-ai 正是如此（其 bin 是 ./bin/opencode.exe，一个真正的二进制），所以
      // 每个 Windows OpenCode 安装都会命中这种形状、落回 null，然后走 cmd.exe 兜底，而
      // cmd.exe 会在第一个换行处截断 hive 协议。agent 随后启动，看起来健康，却完全不知道
      // 自己有收件箱。用 argv 数组把二进制直接交给 CreateProcess，严格优于经 cmd.exe
      // 路由——同一个程序，中间没有 shell 解析器。
      const exe = expand(scriptTok.text);
      if (!exe) return null;
      // 只接受真正的可执行文件。这里的其他任何东西都是我们没有建模过的形状。
      if (!/\.(exe|com)$/i.test(exe)) return null;
      return { interpreter: null, scriptPath: exe };
    }
    // Classic ELSE 分支：`node  "<script>" %*` —— 程序是一个未加引号的单词。
    const word = before.split(/\s+/).filter(Boolean).pop();
    if (!word || word !== before) return null; // 它前面还有别的 → 未知形状
    progRaw = word;
  }

  // `"%_prog%"` → 垫片 SET 的那个值。优先取裸名分支（PATH 兜底）；`%dp0%\node.exe`
  // 这种值下面仍会归约到同一个 basename。
  if (/^%_prog%$/i.test(progRaw)) {
    if (progValues.length === 0) return null;
    progRaw = progValues.find((v) => !/[%\\/]/.test(v)) ?? progValues[progValues.length - 1];
  }
  const interpreter = (progRaw.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  if (!SHIM_INTERPRETERS.has(interpreter)) return null;

  const scriptPath = expand(scriptTok.text);
  if (!scriptPath || !SHIM_SCRIPT_EXT.test(scriptPath)) return null;
  return { interpreter, scriptPath };
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private webContents: WebContents | null = null;
  /** 当 PTY 自行退出（子进程结束/崩溃/被外部杀死）时触发，这样主进程可以运行与显式
   *  kill() 路径相同的生命周期清理（归档、worktree 移除、map 清理）。尽力而为——由主进程
   *  设置一次。 */
  private exitHandler: ((id: string, exitCode?: number) => void) | null = null;

  /** 默认/兜底的输出目标——设为主窗口。只用于没有记录 owner 的会话；有 owner 的会话
   *  路由到各自的 owner。 */
  attachWebContents(wc: WebContents) {
    this.webContents = wc;
  }

  /** 统计某个窗口拥有的存活 PTY 数量——用于把楼层的关闭确认限定在它自己的终端上，
   *  而不是整个应用的终端。 */
  countByOwner(wc: WebContents): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.owner === wc) n++;
    return n;
  }

  /** 杀死一个窗口拥有的每个 PTY（其 onExit 会运行常规清理：归档 + worktree 清理）。
   *  在楼层窗口关闭时调用，这样它的终端不会作为孤儿进程残留、继续向已死的 webContents
   *  写入。 */
  killByOwner(wc: WebContents): void {
    for (const [id, s] of [...this.sessions.entries()]) {
      if (s.owner === wc) {
        try {
          const pid = s.proc.pid;
          s.proc.kill();
          ensureKilled(pid);
        } catch { /* 已经不在了 */ }
        void id;
      }
    }
  }

  /** 注册自然退出清理回调。在会话清理完成后，从 node-pty 的 onExit 内部调用。退出码会被
   *  转发，这样处理器能区分干净退出（例如首次 CLI 安装成功 → 自动重启并继续）与崩溃。 */
  setExitHandler(handler: (id: string, exitCode?: number) => void): void {
    this.exitHandler = handler;
  }

  /** 仅当渲染进程还活着时才发送给它。应用退出期间，杀死 PTY 会异步触发 onExit——到那时
   *  app.quit() 可能已经销毁了窗口，对已销毁的 webContents 调用 `.send()` 会抛出 "Object
   *  has been destroyed"，表现为主进程崩溃对话框。要加防护。 */
  private safeSend(channel: string, payload: unknown, target?: WebContents | null): void {
    // 已知时路由到会话的 owner 窗口（多窗口：让每个楼层的输出流保持私有）；否则回退到
    // 默认附加的输出目标。
    const wc = target ?? this.webContents;
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch { /* 发送途中窗口被销毁 */ }
  }

  /** 引擎 CLI 是否真的安装/可定位在这台机器上。由缺少 CLI 的自动安装路径在 PRE-SPAWN
   *  时使用：一个 resolveCommand 定位不到的裸 `claude`/`codex` 若被强行生成，会以
   *  "process exited (code 1)" 死掉。复用与 spawn() 完全相同的 `which`/`where` +
   *  候选目录逻辑，这样检测与生成永远不会不一致。 */
  isCommandAvailable(command: string): boolean {
    return this.resolveCommand(command).found;
  }

  /** 裸命令为 THIS 用户解析出的绝对路径；未安装时为 null。与 spawn() 相同的解析 + 缓存，
   *  因此探测某个二进制的调用方（例如 `node --version`，用来判断它是否太旧该弃用）检查的
   *  正是 agent 本会运行的那个可执行文件。 */
  commandPath(command: string): string | null {
    const r = this.resolveCommand(command);
    return r.found ? r.path : null;
  }

  /** 成功命令解析的会话缓存。每次 miss 都要在主进程上同步启动一次完整交互式 shell
   *  （`$SHELL -ilc which …` 会 source 用户整个 zshrc——nvm/asdf 初始化通常约 1s），
   *  而每次 agent 生成过去都要付两次（预检 + 生成）——每次生成造成全窗口数秒冻结，团队
   *  恢复时再 ×N。负结果刻意不缓存：缺少 CLI 的自动安装路径在复检时必须能看到刚装好的
   *  二进制。 */
  private readonly resolvedCommands = new Map<string, { path: string; found: boolean }>();

  /** 沿用户的 PATH + 常见安装位置解析裸命令（例如 'claude'）。之所以需要，是因为
   *  macOS 上 Electron 的 spawn 环境启动时没有用户的交互式 shell PATH。返回最佳路径以及
   *  是否真的定位到了存在的可执行文件（`found`）：什么都没找到时，`path` 回退为裸命令
   *  （spawn 会 ENOENT）且 `found` 为 false——这是缺少 CLI 路径所依赖的信号。 */
  private resolveCommand(command: string): { path: string; found: boolean } {
    const cached = this.resolvedCommands.get(command);
    // 只在二进制仍存在时信任正命中（两次生成之间的卸载/更新必须重新探测，而不是交出
    // 一个已死的路径）。
    if (cached && existsSync(cached.path)) return cached;
    const res = this.resolveCommandUncached(command);
    if (res.found) this.resolvedCommands.set(command, res);
    else this.resolvedCommands.delete(command);
    return res;
  }

  private resolveCommandUncached(command: string): { path: string; found: boolean } {
    // 已经是绝对/相对路径（Unix `/` 或 Windows `\`）——直接透传；`found` 反映该路径是否
    // 真的存在于磁盘上。
    if (command.includes('/') || command.includes('\\')) return { path: command, found: existsSync(command) };
    // 只有纯命令名才会沿 PATH 解析。其他任何东西都在这里被拒绝，这样它永远不会到达
    // `which`/`where`；`found:false` 让调用方把它当作缺失。
    if (!isSafeCommandName(command)) return { path: command, found: false };
    if (process.platform === 'win32') {
      // `where` 是 `which` 的 Windows 等价物。
      // 它可能按 PATH 顺序返回 MULTIPLE 个匹配；第一个往往是 EXTENSIONLESS 垫片（裸
      // `claude`）。跳过无扩展名的命中，取第一个符合 PATHEXT 的（.CMD/.BAT/.EXE/…）。
      // 注意：即使 .CMD/.BAT 文件也不能被 node-pty 的 CreateProcess 直接生成（错误 193）；
      // spawn() 要么把垫片解码成其真实解释器，要么在失败时经 `cmd.exe /c` 路由
      // （见下面的 resolveWindowsShimSpawn）。
      try {
        // 不用 `shell:true`：上面已证明 `command` 不含元字符，直接运行 `where` 能让
        // cmd.exe 不去重新解析该参数。
        const res = spawnSync('where', [command], { encoding: 'utf8', timeout: 3000 });
        const lines = (res.stdout ?? '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const pathExts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';').map((e) => e.trim().toUpperCase()).filter(Boolean);
        const isExecutable = (p: string): boolean => {
          const dot = p.lastIndexOf('.');
          const sep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
          if (dot <= sep) return false; // basename 没有扩展名
          return pathExts.includes(p.slice(dot).toUpperCase());
        };
        const exe = lines.find((p) => isExecutable(p) && existsSync(p));
        if (exe) return { path: exe, found: true };
      } catch { /* 继续向下 */ }
      // 常见 Windows 安装位置（npm 全局 = %APPDATA%\npm\<cmd>.cmd）。
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
      for (const c of winCandidates) if (existsSync(c)) return { path: c, found: true };
      // 最后手段——让 node-pty 试一把；若缺失会以 ENOENT 失败。
      return { path: command, found: false };
    }
    // macOS / Linux —— 对交互式 shell 运行 `which`，从而拿到 nvm/asdf/brew 的路径。
    // 围栏式捕获（shellEnv）：rc 文件的碎语不会污染 which 的输出。
    const which = captureFromLoginShell(`which ${command}`);
    if (which) {
      const path = which.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (path && existsSync(path)) return { path, found: true };
    }
    // 常见显式安装位置
    const candidates = [
      `/opt/homebrew/bin/${command}`,
      `/usr/local/bin/${command}`,
      `${process.env.HOME ?? ''}/.local/bin/${command}`,
      `${process.env.HOME ?? ''}/.claude/local/${command}`,
      `${process.env.HOME ?? ''}/.volta/bin/${command}`
    ];
    for (const c of candidates) if (existsSync(c)) return { path: c, found: true };
    // 最后手段——让 node-pty 试一把；若缺失会以 ENOENT 失败。
    return { path: command, found: false };
  }

  /**
   * 仅 WINDOWS。判断 `resolved` 是不是一个我们可以 DIRECTLY 生成的 npm 风格垫片（其真实
   * 解释器 + 脚本，以 argv ARRAY 形式），而不是经 `cmd.exe /d /s /c "<one big string>"`
   * 路由。
   *
   * cmd.exe 路由会毁掉任何多行参数（见 buildCmdCommandLine），这正是 Windows 上每个
   * npm 安装的 agent CLI 系统提示词里 HIVE PROTOCOL 块被悄悄剥掉的原因——agent 启动正常，
   * 却从不互发消息，因为它们从未得知收件箱/发件箱存在。
   *
   * 对任何未完全理解的东西返回 null，这里的每种失败模式（不是垫片、不可读、未知形状、
   * 磁盘上缺失脚本、解释器未安装或本身不是真正的 .exe）都恰好退化为今天 cmd.exe 的行为。
   * 绝不抛出。
   */
  private resolveWindowsShimSpawn(resolved: string): { file: string; script: string | null } | null {
    if (process.platform !== 'win32') return null;
    try {
      const lower = resolved.toLowerCase();
      // 这个 `.cmd` 就是垫片。无扩展名的 npm 垫片（`%APPDATA%\npm\claude`）是一个
      // cmd.exe 根本无法运行的 POSIX **sh** 脚本；npm 总会写一个指向同一目标的 `.cmd`
      // 兄弟文件，所以改读它——严格优于把 sh 语法交给 cmd.exe。
      const shimPath = lower.endsWith('.cmd') || lower.endsWith('.bat')
        ? resolved
        : (existsSync(`${resolved}.cmd`) ? `${resolved}.cmd` : null);
      if (!shimPath) return null;
      const st = statSync(shimPath);
      if (!st.isFile() || st.size > 8192) return null;

      const target = parseNpmCmdShim(shimPath, readFileSync(shimPath, 'utf8'));
      if (!target) return null;
      // 垫片可能比它指向的包活得更久（一个被半删除的全局安装）。此时回退到 cmd.exe 至少
      // 能复现今天的错误。
      if (!existsSync(target.scriptPath)) return null;

      // 直接执行型垫片：目标本身就是程序。无需解析解释器，也无需前置脚本参数——用 argv
      // 数组生成它，正是 cmd.exe 路由一直挡着不让做的。
      if (target.interpreter === null) {
        return { file: target.scriptPath, script: null };
      }

      const interp = this.resolveCommand(target.interpreter);
      if (!interp.found) return null;
      // 必须是真正的可执行文件：如果 `node` 本身只解析到一个 `.cmd`（例如我们追加到 PATH
      // 的自带 runtime 垫片），直接生成它会撞上我们正绕开的那个 CreateProcess 限制。
      const il = interp.path.toLowerCase();
      if (!il.endsWith('.exe') && !il.endsWith('.com')) return null;

      return { file: interp.path, script: target.scriptPath };
    } catch {
      return null; // 不可读/竞态的垫片——回退，绝不让生成失败
    }
  }

  spawn(opts: SpawnOptions, owner: WebContents | null = null): { ok: boolean; error?: string } {
    if (this.sessions.has(opts.id)) {
      return { ok: false, error: `pty already exists for id ${opts.id}` };
    }
    // 纵深防御：cwd 在摄入时已做过波浪号展开（spawnAgentCore），但任何其他直接触达 PTY
    // 的调用方也得到同样的处理——`existsSync('~/dev/foo')` 恒为 false，只有 shell 会展开
    // `~`。
    opts = { ...opts, cwd: expandTilde(opts.cwd) };
    if (!existsSync(opts.cwd)) {
      return { ok: false, error: `cwd does not exist: ${opts.cwd}` };
    }
    const resolved = this.resolveCommand(opts.command).path;
    try {
      // 构建用户 shell 的 PATH，让子进程能解析子进程依赖。为会话缓存（shellEnv.userShellPath，
      // 用围栏防 rc 文件噪声）——它取代的那次交互式 shell 启动在每次生成时都要花约 1s 的主线程冻结。
      const userPath = withHiveRuntimeFallback(
        process.platform === 'win32' ? (process.env.PATH || '') : userShellPath(),
        opts.env?.HIVE_ROOT
      );

      // Windows 上 .cmd/.bat 文件（以及无扩展名的垫片）不能被 CreateProcess 直接执行——
      // 只有 .exe/.com 可以。两条出路，按优先级排列：(1) 把 npm 垫片解码成它包裹的解释器
      // + 脚本，用 argv 数组生成那个（转义正确、换行得以保留）；或 (2) 传统兜底，把整件事
      // 经 cmd.exe 作为一条预转义字符串路由（丢失换行——见 buildCmdCommandLine）。
      const isWin = process.platform === 'win32';
      const lower = resolved.toLowerCase();
      const directExe = lower.endsWith('.exe') || lower.endsWith('.com');
      const needsCmd = isWin && !directExe;
      // 优先把 npm 垫片解码成它的解释器，而不是走 cmd.exe 路由（见 resolveWindowsShimSpawn）。
      // 仅 win32，且遇到任何意外都返回 null，因此 macOS/Linux 和每个无法解码的 Windows
      // 目标都保持今天的行为。对 shellScript 生成完全跳过——它从不执行 `resolved`。
      const shimSpawn = needsCmd && typeof opts.shellScript !== 'string'
        ? this.resolveWindowsShimSpawn(resolved)
        : null;
      let file: string;
      let spawnArgs: string[] | string;
      if (typeof opts.shellScript === 'string') {
        // 缺少 CLI 的自动安装：经平台 shell 运行横幅 + 安装命令，让它流式输出到这个同一个
        // Terminal 标签页。Windows 上我们给 cmd.exe 一条原样 STRING（`/d /s /c "<script>"`）
        // ——node-pty 不转义地透传字符串，`/s` 精确剥掉外层引号对，因此 `&` 串联的脚本
        // 原样运行（脚本本身不含内嵌 `"`）。unix 上用 `$SHELL -lc <script>`（登录、非交互）：
        // npm 已经在 PATH 上，因为 spawn() 把 env.PATH 设为捕获到的交互式 shell PATH
        // （含 nvm/asdf/brew），而省略 `-i` 可以避免把用户交互式 rc 的会话恢复噪声倾倒进
        // 安装终端。脚本是一个 argv 元素，因此这里无需 shell 引号转义。
        if (isWin) {
          file = process.env.ComSpec || 'cmd.exe';
          spawnArgs = `/d /s /c "${opts.shellScript}"`;
        } else {
          file = process.env.SHELL || '/bin/sh';
          spawnArgs = ['-lc', opts.shellScript];
        }
      } else if (needsCmd && shimSpawn) {
        // WINDOWS、npm 垫片目标：用 ARRAY 形式的参数生成垫片自己的解释器。node-pty 随后
        // 运行其 `argsToCommandLine`（MSDN/CRT 转义：引号前反斜杠加倍、遇空白时整参加引号）
        // 并把结果直接交给 CreateProcess——整个链路中没有任何 shell 解析器。这就是让 hive
        // 协议提示词完好通过的原因：它的换行、括号和内嵌引号在一个带引号的 CRT 参数里只是
        // 普通字符，上限也变成 CreateProcess 的 32767 而不是 cmd.exe 的 8191。把同一个
        // 提示词经 cmd.exe 路由会在第一个换行处截断它，这正是 Windows agent 从未得知自己
        // 有收件箱/发件箱、无法互相通信的原因。
        file = shimSpawn.file;
        // 对直接执行型垫片 `script` 为 null——无需前置任何东西，参数直接给二进制。
        spawnArgs = shimSpawn.script === null
          ? [...(opts.args ?? [])]
          : [shimSpawn.script, ...(opts.args ?? [])];
      } else {
        file = needsCmd ? (process.env.ComSpec || 'cmd.exe') : resolved;
        // #55：经 cmd.exe 路由时，绝不能把 `resolved` 当作裸的、未加引号的数组元素传入。
        // 一个 Program-Files 路径（`C:\Program Files\nodejs\node`）在 cmd.exe 下会按空格
        // 拆开 → "C:\Program is not recognized"，然后每个 Windows agent 终端都会死掉。
        // 构建一条完整加引号的命令行，作为 STRING（而非数组）交给 node-pty：node-pty 的
        // argsToCommandLine() 只会对 ARRAY 参数重新转义；字符串则原样透传（isCommandLine
        // === true → `file + " " + args`），因此我们的引号绝不会被二次包裹。我们镜像 Node
        // 自己的 child_process 形式 `cmd.exe /d /s /c "<command>"`，用一对外层引号包住
        // 整个内部命令——cmd 的 /s 标志精确剥掉那对引号，并按字面运行剩余部分（其中的
        // resolved 路径保留自己的引号）。/d 跳过 AutoRun。
        spawnArgs = needsCmd
          ? buildCmdCommandLine(resolved, opts.args ?? [])
          : (opts.args ?? []);
        // cmd.exe 兜底是有损的，过去还是静默的——这正是 Windows agent 能看起来完全健康、
        // 却从未收到 hive 协议的原因：cmd.exe 在第一个换行处切断多行参数，而整个协议块
        // 就搭载在这样一条参数上。resolveWindowsShimSpawn 对任何它未完全理解的垫片形状
        // 都返回 null，所以这条路径在真实机器上可达，而所有单元测试都照常通过。要大声、
        // 明确地说出来，带上诊断所需的两个事实：哪个目标拒绝解码，以及本次生成是否真的有
        // 多行参数处于风险中。
        if (needsCmd) {
          const multiline = (opts.args ?? []).some((a) => a.includes('\n'));
          console.warn(
            `[pty] Windows: "${resolved}" could not be decoded as an npm shim — falling back to cmd.exe.` +
            (multiline
              ? ' A MULTI-LINE ARGUMENT IS PRESENT AND WILL BE TRUNCATED AT ITS FIRST NEWLINE.' +
                ' The agent will start and look healthy without ever receiving the hive protocol.'
              : ' No multi-line argument in this spawn, so nothing is lost here.')
          );
        }
      }
      const proc = pty.spawn(file, spawnArgs, {
        name: 'xterm-256color',
        cols: opts.cols ?? 160,
        rows: opts.rows ?? 30,
        cwd: opts.cwd,
        // 继承的环境减去父 Claude 会话的身份标记，然后是应用的默认值与 locale，再是
        // 每个 agent 的值——为何要剥离、为何按前缀剥离，见 ptyEnv.ts。
        env: buildPtyEnv(process.env, userPath, opts.env)
      });
      // 捕获 THIS 会话对象，这样 proc 的回调能判断该 id 是否仍属于它们。模型切换/重启
      // 会复用同一个 id 做 kill()+spawn()：旧进程的 kill 是异步的，因此它的 onData/onExit
      // 可能在替换会话已经放进 map 之后触发。没有这个身份守卫，将死进程会 (a) 把它的
      // 最后字节喷洒进新 agent 刚生成的 TUI 帧——文本散乱/重叠——以及 (b) 在退出时删除
      // 替换会话并发出假的 `pty:exit`，杀掉刚启动 agent 的输入。
      const session: PtySession = {
        id: opts.id,
        proc,
        cwd: opts.cwd,
        command: resolved,
        lastOutputAt: Date.now(),
        hasOutput: false,
        owner
      };
      this.sessions.set(opts.id, session);

      proc.onData((data) => {
        // 丢弃来自已被重新生成（或杀死）回收 id 的进程的尾部输出——它会破坏新会话的屏幕。
        if (this.sessions.get(opts.id) !== session) return;
        session.hasOutput = true;
        session.lastOutputAt = Date.now();
        // 路由到会话的 owner 窗口（多窗口 owner 路由）。
        this.safeSend(`pty:data:${opts.id}`, data, session.owner);
      });
      proc.onExit(({ exitCode, signal }) => {
        // 来自 id 已被回收（kill()+respawn）进程的过期退出——绝不要碰存活的会话，也不要
        // 告诉渲染进程新 pty 死了。
        if (this.sessions.get(opts.id) !== session) return;
        this.safeSend(`pty:exit:${opts.id}`, { exitCode, signal }, session.owner);
        this.sessions.delete(opts.id);
        // 自然退出必须运行与显式 kill 相同的生命周期清理。加上防护，这样清理错误永远不会
        // 让 node-pty 的退出回调崩溃。
        try { this.exitHandler?.(opts.id, exitCode); } catch { /* 绝不从 onExit 抛出 */ }
      });

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  write(id: string, data: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.write(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  resize(id: string, cols: number, rows: number): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.resize(cols, rows);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 向前台 TUI 要一个刷新帧但不改变其几何尺寸。启动输出可能早于渲染进程订阅，而同样
   *  大小的第一次 fit 否则不会触发 resize。 */
  redraw(id: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.resize(s.proc.cols, s.proc.rows);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  kill(id: string): { ok: boolean; error?: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      const pid = s.proc.pid;
      s.proc.kill();
      ensureKilled(pid); // 验证并清扫进程组，确保没有 PID 泄漏
      this.sessions.delete(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  list(): Array<{ id: string; cwd: string; command: string; pid: number; lastOutputAt: number; hasOutput: boolean }> {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      cwd: s.cwd,
      command: s.command,
      pid: s.proc.pid,
      lastOutputAt: s.lastOutputAt,
      hasOutput: s.hasOutput
    }));
  }

  /** 该 PTY 最近一次输出的 epoch 毫秒数；没有该 PTY 时为 undefined。 */
  lastOutputAt(id: string): number | undefined {
    return this.sessions.get(id)?.lastOutputAt;
  }

  /** 距该 PTY 上次产生输出已过去的毫秒数（Date.now() - lastOutputAt）；没有该 PTY 时为
   *  undefined。空闲握手：值越大 = 越安全地键入。 */
  idleFor(id: string): number | undefined {
    const s = this.sessions.get(id);
    return s ? Date.now() - s.lastOutputAt : undefined;
  }

  /** 为应用退出/重置批量杀死每个 PTY。这是整体关闭，不是单个 agent 的生命周期管理，因此
   *  会抑制自然退出清理——我们不希望在进程拆除期间归档每个 agent 或触发一阵 `git worktree
   *  remove`。
   *
   *  Windows 上与 kill() 不同，这里的进程树清扫是 SYNCHRONOUSLY 执行的：ensureKilled 的
   *  宽限定时器是 unref 的，而在退出路径上主进程会提前退出（will-quit 把分析日志刷新限制
   *  在约 1.2s），远早于 4s 宽限——所以延迟的 `taskkill /T /F` 从未运行，agent 进程树
   *  随应用存活下来。conpty 自己的 kill 是异步且尽力而为的（我们的 conpty 补丁会把失败的
   *  控制台枚举降级为什么都不杀），因此同步清扫是退出时唯一可靠的收割者。POSIX 保留优雅
   *  路径：关闭 pty 会给前台进程组发 HUP，所以进程树会自然死亡，无需我们在清理中途
   *  SIGKILL。 */
  killAll() {
    this.exitHandler = null;
    const sweepNow = process.platform === 'win32';
    for (const s of this.sessions.values()) {
      const pid = s.proc.pid;
      if (sweepNow) {
        // 在关闭 ConPTY 之前捕获并杀死完好的 Windows 进程树：一旦根进程退出，taskkill
        // 可能就无法再按该 PID 找到后代。让 node-pty 的清理保持独立，这样任一操作的失败
        // 都不会阻碍另一个。
        try { hardKillTree(pid); } catch { /* 无操作 */ }
        try { s.proc.kill(); } catch { /* 无操作 */ }
      } else {
        try { s.proc.kill(); } catch { /* 无操作 */ }
        ensureKilled(pid);
      }
    }
    this.sessions.clear();
  }
}
