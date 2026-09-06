/**
 * god 雇佣的工作线程的生成请求如何变成一个可执行文件 + argv，以
 * 纯函数的方式实现：这个精确的转换曾静默地让真实工作线程挂了数天，
 * 却仍然上报成功，正因如此它才赢得了一个单元测试。
 */
import { autoModeFlagForProvider, hasAutoModeStance, inferAgentProvider } from '../shared/agentProvider';
import { tokenizeCommand } from '../shared/commandLine';

export interface WorkerLaunch {
  /** 仅可执行文件名——PTY 层解析并生成的东西。 */
  bin: string;
  /** 其余一切，以 argv 形式表示，适用时包含模型标志。 */
  args: string[];
  /** 完整有效的命令行，用于展示和面板卡片。 */
  command: string;
}

export function buildWorkerLaunch(opts: {
  /** 来自生成请求的 `command` —— god 编写的是完整的命令行。 */
  requestCommand?: unknown;
  requestProvider?: unknown;
  /** 请求中独立的 `model` 字段，如果有的话。 */
  requestModel?: unknown;
  defaultCommand?: string;
  /** 应用的 auto（跳过权限）设置。 */
  autoMode: boolean;
}): WorkerLaunch {
  let command =
    typeof opts.requestCommand === 'string' && opts.requestCommand.trim()
      ? opts.requestCommand.trim()
      : (opts.defaultCommand ?? 'claude');
  // 当请求没有自带立场时，继承应用的 auto（跳过权限）模式：无头工作线程
  // 没有人去点击工具提示，所以没有该标志它会在第一次询问时就卡住，直到
  // 空闲回收器把它杀掉。该标志属于 PROVIDER——codex 工作线程需要
  // `-a never -s danger-full-access`，而 claude 的 --permission-mode
  // 对它毫无意义（早期硬编码 claude 的版本让每个非 claude 工作线程
  // 卡死；评审发现了这一点）。请求中明确的立场仍然优先：标志的前导 token
  // 已作为 TOKEN 存在（而非子串——copilot 的标志以 `-s` 开头）
  // 即表示请求已做出选择。
  const provider = inferAgentProvider(command, opts.requestProvider);
  const autoFlag = opts.autoMode ? autoModeFlagForProvider(provider) : '';
  if (autoFlag && !hasAutoModeStance(tokenizeCommand(command), provider)) {
    command += ` ${autoFlag}`;
  }
  // god 把 `command` 编写为完整的命令行（"claude --model … --permission-mode …"），
  // 但 PTY 层只接受一个可执行文件名（resolveCommand）加 argv——未拆分的
  // 命令行会让 node-pty 去执行一个字面意义上就叫整串命令的二进制文件
  // → ENOENT → 工作线程在生成后约 1 秒内死亡，而它的请求却归档为
  // .done（2026-08-16 两个带标志的 Ryan 生成都因此被杀；
  // 只有裸 `claude` 的那个活了下来）。用渲染进程生成流程所用的同一个
  // 分词器来拆分，并把标志作为 argv 传下去。
  const tokens = tokenizeCommand(command);
  const bin = tokens[0] || command;
  const flags = tokens.slice(1);
  // 独立的 `model` 字段只在命令行本身没有选定模型时才会生效
  // （spawnAgentCore 在 argv 已携带 --model 时同样会跳过默认模型注入）。
  const model =
    typeof opts.requestModel === 'string' && opts.requestModel.trim() ? opts.requestModel.trim() : '';
  const args = [...flags, ...(model && !flags.includes('--model') ? ['--model', model] : [])];
  return { bin, args, command };
}
