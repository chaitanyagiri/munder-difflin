/**
 * 缺失引擎 CLI 的安装阶梯（install ladder）。
 *
 * 特意从 index.ts 中拆出：它不 import electron 的任何内容，因此“哪种安装器
 * 在这台机器上确实能装成功？”这一决策，以及它生成的脚本，都可以在不启动
 * 应用的情况下测试。
 */
import type { AgentProvider, ProviderInstallInfo } from '../shared/agentProvider';
import { installInfoForProvider } from '../shared/agentProvider';
import type { NodeInstaller } from './nodeInstall';
import { buildNodeInstallScript } from './nodeInstall';

export type InstallRungKind = 'npm' | 'node-then-npm' | 'native' | 'manual';

/** 根据这台机器已具备的条件，选择安装阶梯的哪一级来执行。
 *
 *  每个 provider 的 `installCommand` 都是 `npm install -g …`，这需要 npm，
 *  而 npm 又需要 node。在没有 node 的机器上，启动横幅过去照样会打印这条
 *  命令并执行它——于是用户看着 `npm: command not found` 滚动过去，认定应用
 *  坏了。先做分类：
 *
 *    npm 可用                          → npm install（不变；常见情况）
 *    npm 缺失、找到 Node 安装器        → 先装真正的 Node + npm，再 npm install
 *    npm 缺失、有原生安装器            → 厂商自带的独立安装器
 *    两者都没有                        → 仅手动处理。不要运行注定失败的命令。
 *
 *  创始人决策（2026-08-07）把 `node-then-npm` 排在 `native` 之上，推翻了早先
 *  “绝不自动安装系统级 Node”的规则：只拿到不含 node 的 Claude 安装器的用户，
 *  依然没有可运行 MCP 服务器、hooks 或其他 provider 的运行时——因此默认做法
 *  是修好机器，而不是绕开它。`native` 保留为无法解析出任何安装器时的回退
 *  （离线，或平台 nodejs.org 没有提供对应包）。
 *
 *  `npmAvailable` 表示 npm 存在且其 Node 版本足够新（见
 *  nodeInstall.NODE_FLOOR_MAJOR）——过旧的 Node 会走升级那一级。 */
export function chooseInstallRung(
  info: ProviderInstallInfo,
  npmAvailable: boolean,
  nodeInstaller?: NodeInstaller | null
): { command?: string; kind: InstallRungKind; nodeMissing: boolean } {
  if (info.command && npmAvailable) return { command: info.command, kind: 'npm', nodeMissing: false };
  if (info.command && nodeInstaller) return { command: info.command, kind: 'node-then-npm', nodeMissing: true };
  if (info.nativeCommand) return { command: info.nativeCommand, kind: 'native', nodeMissing: !npmAvailable };
  return { kind: 'manual', nodeMissing: !npmAvailable };
}

/** 生成缺失 CLI 自动安装路径“顶替”缺失引擎 CLI 时运行的 shell 脚本。当上面的
 *  某一级可以执行时，它先打印横幅再显式运行（让用户能看着并完成任何登录）；
 *  否则只打印一条手动操作说明，不运行任何东西。脚本以目标平台的 shell 语法
 *  输出（unix 上是 $SHELL，Windows 上是 cmd.exe）——`platform` 只是参数，
 *  这样 Windows 分支也能在 macOS 上的测试里触达。唯一由用户派生出的值
 *  （缺失的二进制名）会清洗成安全标识符；安装命令是可信常量。 */
export function buildMissingCliScript(
  bin: string,
  provider: AgentProvider,
  npmAvailable: boolean,
  platform: string = process.platform,
  nodeInstaller?: NodeInstaller | null
): string {
  const info: ProviderInstallInfo = installInfoForProvider(provider, platform);
  const safeBin = (bin || provider).replace(/[^A-Za-z0-9._-]/g, '') || provider;
  const rung = chooseInstallRung(info, npmAvailable, nodeInstaller);
  // 只有确实需要的那一级才会拼入 Node 安装步骤。
  const nodeSteps = rung.kind === 'node-then-npm' && nodeInstaller
    ? buildNodeInstallScript(nodeInstaller, platform)
    : null;
  const cmd = rung.command; // 可信常量；若为 undefined → 仅提示手动操作
  const label = info.label;
  const docs = info.docsUrl;
  const rule = '------------------------------------------------------------';

  if (platform === 'win32') {
    // 单条 cmd.exe 命令：`&` 串联各步骤，`^&` 打印字面量 & 字符，并且
    // 脚本不含双引号（它会原样包在 `/d /s /c "..."` 里）。
    // 我们避免 `if errorlevel` 分支（此处无法测试）——一条合并的成功/
    // 失败提示在安装之后给出，稳健且满足手动回退的完成定义（DoD）。
    const parts: string[] = ['echo.', `echo ${rule}`, `echo   找不到引擎 CLI：${safeBin}`, 'echo.'];
    if (nodeSteps && nodeInstaller) {
      parts.push(
        'echo   此机器未安装 Node.js，所以通常的 npm',
        `echo   安装器暂时无法运行。先从 nodejs.org 安装 Node ${nodeInstaller.version} ^(+ npm^)，`,
        'echo   校验和已验证。',
        'echo.',
        ...nodeSteps,
        'echo.'
      );
    } else if (rung.nodeMissing) {
      parts.push('echo   此机器未安装 Node.js，所以通常', 'echo   npm 安装器无法在此运行。', 'echo.');
    }
    if (cmd) {
      if (rung.kind === 'native') parts.push(`echo   改用自包含的 ${label} 安装器 ^(无需 Node^)：`);
      else parts.push(`echo   现在安装 ${label} CLI，你可以观看：`);
      parts.push(
        'echo.',
        `echo     ${cmd}`,
        `echo ${rule}`,
        'echo.',
        cmd,
        'echo.',
        'echo   [完成] 如果成功，agent 会自动启动。',
        'echo   如果失败，请手动运行上面的命令，然后重启 agent。'
      );
    } else {
      if (rung.nodeMissing) {
        parts.push(
          `echo   安装 Node.js ^(nodejs.org^)，然后是 ${label} CLI：`,
          `echo     ${info.command ?? ''}`,
          'echo   …或按其文档推荐的方式安装该 CLI。'
        );
      } else {
        parts.push(
          `echo   没有针对 ${label} provider 的捆绑安装器。`,
          'echo   请手动安装，然后重启 agent 以启动它。'
        );
      }
      if (docs) parts.push(`echo   Docs: ${docs}`);
      parts.push(`echo ${rule}`);
    }
    return parts.join(' & ');
  }

  // unix（$SHELL -lc <script>）：每行一条语句，echo 文本用单引号包裹，这样
  // 就不会有 shell 元字符被展开。我们避开 `!`，免得带历史扩展
  // 的 shell 触发误展开。npm 是通过 spawn() 注入的交互式 PATH 找到的。
  const lines: string[] = [
    `echo ''`,
    `echo '${rule}'`,
    `echo '  找不到引擎 CLI：${safeBin}'`,
    `echo ''`
  ];
  if (nodeSteps && nodeInstaller) {
    // 裸机上的默认路径：先修好运行时，再使用它。每个
    // 步骤失败都会中止整个脚本，因此下面的 npm install 只
    // 会在真实安装成功的 Node 上运行。
    lines.push(
      `echo '  此机器未安装 Node.js，所以通常的 npm'`,
      `echo '  安装器暂时无法运行。先从 nodejs.org 安装 Node ${nodeInstaller.version} (+ npm)，'`,
      `echo '  校验和已验证。'`,
      `echo ''`,
      ...nodeSteps,
      `echo ''`
    );
  } else if (rung.nodeMissing) {
    lines.push(
      `echo '  此机器未安装 Node.js，所以通常的 npm'`,
      `echo '  安装器无法在此运行。'`,
      `echo ''`
    );
  }
  if (cmd) {
    lines.push(
      ...(rung.kind === 'native'
        ? [`echo '  改用自包含的 ${label} 安装器（无需 Node）——'`,
           `echo '  完成它提示的任何登录，然后回到此终端。'`]
        : [`echo '  现在安装 ${label} CLI，你可以观看——完成任何'`,
           `echo '  它提示的登录，然后回到此终端。'`]),
      `echo ''`,
      `echo '    ${cmd}'`,
      `echo '${rule}'`,
      `echo ''`,
      cmd,
      `__clirc=$?`,
      `echo ''`,
      `if [ $__clirc -eq 0 ]; then`,
      `  echo '  [完成] 已安装——正在启动 agent…'`,
      `else`,
      `  echo "  [x] 安装以代码 $__clirc 退出——请手动完成："`,
      `  echo '    ${cmd}'`,
      ...(docs ? [`  echo '    Docs: ${docs}'`] : []),
      `  echo '  然后重启 agent 以启动它。'`,
      `fi`
    );
  } else if (rung.nodeMissing) {
    // 坦诚的死胡同：没有 node，且该厂商没有随附无 node 的安装器。
    // 直接说明到底缺什么，而不是运行一条注定无法成功的命令。
    lines.push(
      `echo '  安装 Node.js (nodejs.org)，然后是 ${label} CLI：'`,
      ...(info.command ? [`echo '    ${info.command}'`] : []),
      `echo '  …或按其文档推荐的方式安装该 CLI。'`,
      ...(docs ? [`echo '  Docs: ${docs}'`] : []),
      `echo '${rule}'`
    );
  } else {
    lines.push(
      `echo '  没有针对 ${label} provider 的捆绑安装器。'`,
      `echo '  请手动安装，然后重启 agent 以启动它。'`,
      ...(docs ? [`echo '  Docs: ${docs}'`] : []),
      `echo '${rule}'`
    );
  }
  return lines.join(String.fromCharCode(10));
}
