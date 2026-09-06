/** 把命令字符串拆分为 argv，尊重双/单引号，使含空格的模型值
 *  （agy 的 `--model "Gemini 3.1 Pro (High)"`）保持为单个 token。
 *  引号会从结果中剥掉。
 *
 *  共享是因为两侧都要拆分命令行：渲染器的 spawn 流程
 *  （AddAgentModal、restore、命令中心）和主进程的 god 雇佣 worker 路径
 *  （processSpawnRequest）。它们过去各持一份逐字节相同的副本，
 *  这等于邀请两侧漂移——而一个命令行拆分方式与渲染器不同的 worker，
 *  正是 spawn-request 修复要防止的那类静默破坏。
 *  */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
