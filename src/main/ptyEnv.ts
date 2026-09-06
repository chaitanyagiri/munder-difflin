/**
 * 为代理 PTY 构建环境变量，作为纯函数实现，使得分层逻辑可以在进程外测试
 * （与 `buildMissingCliScript` 用其 `platform` 参数所用的技巧相同）。
 *
 * 分层规则，自下而上：
 *   1. 继承的环境，减去父级 Claude 会话的身份
 *   2. 应用自身的默认值（PATH、终端身份、locale）
 *   3. 按代理设置的值（`opts.env`）——始终优先，甚至高于下面的剥离
 */

/**
 * 应用常常是从 Claude Code 会话内部启动的（在 claude 终端里输入
 * `npm run dev`），因此该会话的身份标记会经由 `process.env` 传入，
 * 并流入每个代理 CLI。CLAUDE_CODE_CHILD_SESSION 会让代理以为自己是一个
 * 子会话，并静默地 DISABLE 掉转录保存（"Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker"），从而破坏该次运行每个代理的
 * --resume：它们的会话永远到不了磁盘（2026-08-16/17 现场翻车——任何
 * 工作线程转录都不存在）。会话 id、pid、消息 socket+token、
 * effort、execpath 和 entrypoint 同样都描述的是 PARENT 会话，
 * 绝不是一个全新的代理。
 *
 * 按 PREFIX 而非按名称剥离：CLI 新增标记的速度比硬编码列表跟上的速度还快
 * （评审发现时，一个五名称的列表面对实时会话的转储已少了七个）。无论应用
 * 如何启动，代理都是顶级会话，因此它们不继承父级 Claude 的任何身份。
 */
const CLAUDE_MARKER_RE = /^CLAUDE(CODE|_)/;

/**
 * 配置而非身份：这些变量共用同一前缀，但属于 OPERATOR 自己的选择——CLI
 * 把配置放在哪里、如何认证、由哪个后端提供服务。导出它们的操作者希望代理
 * 能看到这些变量，而剥离它们会以与上面剥离完全相同的静默方式破坏代理。
 * 所有会话级作用域的内容都排除在此列表之外。
 */
const CLAUDE_CONFIG_KEEP = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
]);

export function buildPtyEnv(
  parentEnv: NodeJS.ProcessEnv,
  userPath: string,
  agentEnv?: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  // 第 1 层——继承，减去父级会话的 Claude 身份。只有这一层会被剥离：
  // 下面通过 `agentEnv` 刻意设置的标记得以保留，因此按代理的环境覆盖
  // （以及未来的按代理环境特性）不会被剥离静默清除。
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (CLAUDE_MARKER_RE.test(k) && !CLAUDE_CONFIG_KEEP.has(k)) continue;
    inherited[k] = v;
  }
  return {
    ...inherited,
    PATH: userPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // 帮助那些寻找真实交互式 shell 的应用
    FORCE_COLOR: '1',
    // 通过 Finder/Dock 启动的 Electron 应用从 launchd 继承不到任何 locale
    // （`launchctl getenv LANG` 为空），因此没有这里，每个子进程都会在
    // C/POSIX locale 下运行——此时 macOS 的 CoreFoundation 默认文本编码是
    // Mac OS Roman（__CF_USER_TEXT_ENCODING=<uid>:0:0）。代理运行的任何
    // 依赖 locale 的工具随后会把 UTF-8 解码成 MacRoman，并在网格里画出乱码
    // （"—" → "‚Äî"），复制时也会忠实保留。本终端是 UTF-8
    // （xterm.js + Unicode11），所以直接声明这一点。
    //
    // 刻意只用 LC_CTYPE：它才是字符编码这一类别。使用 LC_ALL 也会覆盖所有
    // 从未导出过 locale 用户的排序与日期格式。用户真正导出的 locale 优先。
    ...(platform === 'win32'
      ? {}
      : {
          LANG: parentEnv.LANG ?? 'en_US.UTF-8',
          LC_CTYPE:
            parentEnv.LC_ALL ?? parentEnv.LC_CTYPE ?? parentEnv.LANG ?? 'en_US.UTF-8'
        }),
    // 按代理的 hive 身份（AGENT_ID、HIVE_ROOT……），当提供时。
    ...(agentEnv ?? {})
  };
}
