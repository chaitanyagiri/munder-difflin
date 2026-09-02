import { useEffect, useSyncExternalStore } from 'react';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';
import { roleForHiveSpawn } from '@shared/agentRole';

/** “恢复团队” —— 从上一次会话重新拉起每个 worker。
 *
 *  放在这里而不是 AgentStrip 内部，是因为楼层条在全屏时会被隐藏，这曾经
 *  意味着你进入全屏后，恢复按钮（以及可恢复 agent 的列表）就凭空消失了。
 *  两个挂载点共享下面的进度状态，因此从一个视图发起的恢复会在另一个视图
 *  中显示为运行中，并且不会被重复启动。 */

let restoring = false;
let note: string | null = null;
/** 仅在“自动启动恢复”真正进行中时为 true，让 UI 显示“这是自动发生的”
 *  而不是看起来像一次你不记得点的点击。 */
let autoRestoring = false;
/** 在自动恢复启动的那一刻锁定。模块级而非组件级：`useRestoreTeam` 同时
 *  挂在楼层条和全屏侧栏上，没有这个锁，两边会各自启动一次。 */
let autoStarted = false;
const listeners = new Set<() => void>();

/** 启动后等待多久再自行恢复。
 *
 *  App.tsx 会把持久化的名单与主进程中实际存活的 PTY 对账，而这是一次异步
 *  往返。在它落地之前触发，读到的可恢复列表里仍包含终端已经在运行的
 *  agent，会尝试把它们重复 spawn 一遍。这个延迟同时也是你不想恢复某个
 *  agent 时点击 ✕ 关闭它的窗口期。 */
export const AUTO_RESTORE_DELAY_MS = 2500;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// useSyncExternalStore 需要稳定的快照标识——每次调用返回新对象会无限循环，
// 因此这两个字段分开读取。
const getRestoring = (): boolean => restoring;
const getNote = (): string | null => note;
const getAutoRestoring = (): boolean => autoRestoring;

export interface RestoreTeamState {
  restoring: boolean;
  /** 当进行中的这次运行是在启动时自动开始、而非点击触发时为 true。
   *  驱动「正在恢复你的团队…」横幅。 */
  autoRestoring: boolean;
  /** 上次运行的结果（"restored 3 · 1 failed — …"），或为 null。 */
  restoreNote: string | null;
  restoreTeam: () => Promise<void>;
}

/**
 * @param config 仅用于为在 `command` 字段出现之前持久化的可恢复 agent
 *        重建 spawn 命令。
 */
export function useRestoreTeam(config?: HarnessConfig | null): RestoreTeamState {
  const isRestoring = useSyncExternalStore(subscribe, getRestoring, getRestoring);
  const restoreNote = useSyncExternalStore(subscribe, getNote, getNote);
  const isAutoRestoring = useSyncExternalStore(subscribe, getAutoRestoring, getAutoRestoring);

  /** 用其原始 agent id、cwd、model 与 command 从上一次会话重新拉起每个
   *  worker —— hive 工作区（memory.md、inbox、注册表条目）会自行重新挂上，
   *  无需移植记忆。 */
  const restoreTeam = async (): Promise<void> => {
    if (restoring) return;
    restoring = true;
    note = null;
    emit();
    const prevSel = useStore.getState().selectedId;
    const restorableAgents = useStore.getState().restorableAgents;
    // 汇总每个 agent 的结果，让运行 ALWAYS 留下可见痕迹——最初的 bug 就是
    // 所有失败路径只写 console，导致一个什么都 spawn 不了的点击看起来像
    // 个死按钮。
    let restored = 0;
    let alreadyLive = 0;
    const failures: string[] = [];
    try {
      // 并发恢复每个 agent。每次 spawn 以各自的 ptyId 为键，不触碰渲染端
      // 任何跨 agent 状态；而在主进程里，整个 `pty:spawn` 处理器（包括 hive
      // 注册表的读-改-写）在每个 await 之间同步执行，所以并发处理器不可能
      // 在更新中途交错。串行执行的成本是每个 agent 的 git 探测+spawn 之和；
      // 一个 6-agent 团队为此白白付出约 6 倍单 agent 的时间。
      // spawn 并发运行，但之后按名单顺序 ADD agent。在每次 spawn 内部调用
      // addAgent 会让完成时序决定名单顺序——而该顺序会被持久化，于是慢的
      // provider 或慢的 git 探测会静默覆盖用户拖拽好的卡片顺序。
      const restoredInOrder = await Promise.all([...restorableAgents].map(async (a): Promise<Agent | null> => {
        // 单 agent 防护：一个 agent 的失败（或一次被拒绝的 IPC 调用）绝不能
        // 中止其他 agent——这里曾经有一个未处理的 rejection，会让整个恢复
        // 在第一个坏 agent 之后变成静默空操作。
        try {
          const provider = inferAgentProvider(a.command, a.provider);
          const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');
          if (!command || !a.cwd) {
            // 没有 spawn 配方（在 `command` 之前持久化的旧条目，又没有可重建
            // 的 config）。保留其可恢复状态并说明原因，而不是静默丢弃——
            // 静默移除看起来像“什么都没发生”。
            failures.push(`${a.name}: no saved command`);
            return null;
          }
          const [exe, ...args] = tokenizeCommand(command);
          const ptyId = a.ptyId ?? `pty-${a.id}`;
          // 隔离 agent 的工作树在应用重启后会残留在磁盘上（它只会在关闭
          // 标签页/会话中途退出时被拆除，退出应用不会）。所以直接以那个工作树
          // 作为 cwd 重新进入，而不是重新隔离——`git worktree add` 会与既有
          // 路径/分支冲突，重新隔离还会丢失工作树的未提交改动。cwd = 工作树
          // 意味着 resume + seedSessionTranscript 会落在正确的 checkout 上。
          // 但用户可能在两次运行之间手动修剪/删除了工作树——gitIsRepo
          // (git rev-parse) 对缺失/无效目录返回 false，因此回退到基础仓库的
          // cwd，而不是 spawn 进一条死路径。
          let cwd = a.cwd;
          let worktreeGone = false;
          if (a.worktreePath) {
            if (await window.cth.gitIsRepo(a.worktreePath)) {
              cwd = a.worktreePath;
            } else {
              worktreeGone = true;
              console.warn(`[restore] worktree gone for ${a.id} (${a.worktreePath}); falling back to base repo ${a.cwd}`);
            }
          }
          const res = await window.cth.spawnPty({
            id: ptyId,
            cwd,
            command: exe,
            provider,
            args,
            cols: 100,
            rows: 30,
            // 工作树（如果有）已在磁盘上——cd 进去，而不是新建一个
            // （重新隔离会与既有路径/分支冲突并丢失未提交的改动）。
            isolate: false,
            // 如果记录了 worker 之前的 CLI 会话就继续它——主进程会选择
            // provider 的 resume 标志（Claude --resume、agy --conversation），
            // 对 Claude 会重新挂接 transcript。agent id 跨重启保持不变，
            // 因此其注册表条目、memory.md 与 inbox 按 id 重新挂上。
            // 没有记录的会话时该标志不生效。
            resume: true,
            hive: { id: a.id, name: a.name, provider, cwd, role: roleForHiveSpawn(a) }
          });
          if (res.ok) {
            restored++;
            return {
                ...a,
                provider,
                ptyId,
                archived: false,
                status: 'idle',
                // 在楼层卡片上体现工作树回退；否则显示正常。
                action: worktreeGone ? '工作树已丢失——使用基础仓库' : '启动中',
                // 工作树已不在磁盘上——去掉它，让该 agent 今后按普通
                // base-cwd agent 处理（以后的恢复不会反复探测死路径）。
                worktreePath: worktreeGone ? undefined : a.worktreePath,
                // Crush 以裸方式 spawn（无位置协议）并把种子在这里交回；
                // useHive 在启动后为其定型。对已恢复的 worker 重新播种是
                // 幂等的（它只是按协议重读自己的 inbox）。(ondev-b)
                seedPrompt: res.seedPrompt,
                carrying: undefined,
                currentStation: 'desk',
                recentTextTs: Date.now()
            };
          } else if ((res.error ?? '').includes('already exists')) {
            // 该 id 的活跃 PTY 已在运行（例如启动时已被拉起，或由其他路径
            // 拉起）——agent 其实并不缺，因此把它从可恢复列表退役，而不是
            // 报告一个幻影失败。
            alreadyLive++;
            useStore.getState().removeRestorableAgent(a.id);
          } else {
            // 保留可恢复状态以允许用户重试——但记录原因，让结果显示在楼层上，
            // 而不是埋在 devtools 控制台里。
            failures.push(`${a.name}: ${res.error ?? '生成失败'}`);
            console.error('[restore] spawn failed for', a.id, res.error);
          }
        } catch (e) {
          failures.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
          console.error('[restore] error for', a.id, e);
        }
        return null;
      }));
      // 按原始名单顺序添加，而不是完成顺序。
      for (const restoredAgent of restoredInOrder) {
        if (restoredAgent) useStore.getState().addAgent(restoredAgent);
      }
    } finally {
      // addAgent 会自动选中每次 spawn；把用户放回原来的位置。
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      restoring = false;
      // ALWAYS 展示结果，让按钮永远不可能看起来呆滞。
      const parts: string[] = [];
      if (restored) parts.push(`已恢复 ${restored}`);
      if (alreadyLive) parts.push(`${alreadyLive} 已在运行`);
      if (failures.length) parts.push(`${failures.length} 个失败 — ${failures.join('; ')}`);
      note = parts.length ? parts.join(' · ') : '无需恢复';
      emit();
    }
  };

  // 打开应用时恢复上一会话的团队，无需等待点击。
  //
  // 刻意用 store SUBSCRIPTION 驱动而不是普通定时器：可恢复列表在首次渲染时
  // 为空，只有等 App.tsx 的 PTY 对账 resolve 之后才会填充，因此在挂载时
  // 启动的定时器会看到一个空列表、断定无事可做、然后不再看第二眼。
  //
  // 只对已经在可恢复列表上的 agent 生效——也就是上次退出应用时终端仍
  // 打开的那些。已归档 agent（关闭的标签页）永远不会被触碰。
  useEffect(() => {
    if (autoStarted || !config?.onboardingComplete) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = (): void => {
      if (autoStarted || restoring || timer) return;
      if (!useStore.getState().restorableAgents.length) return;
      timer = setTimeout(() => {
        timer = null;
        if (autoStarted || restoring) return;
        if (!useStore.getState().restorableAgents.length) return;
        // 在 await 之前锁定，让另一个挂载点的定时器（可能在同一 tick 触发）
        // 也能看到。
        autoStarted = true;
        autoRestoring = true;
        emit();
        void restoreTeam().finally(() => { autoRestoring = false; emit(); });
      }, AUTO_RESTORE_DELAY_MS);
    };

    check();
    const unsub = useStore.subscribe(check);
    return () => { unsub(); if (timer) clearTimeout(timer); };
    // restoreTeam 每次渲染都会重建，但只会在定时器内部被调用，因此调用时
    // 读取到的总是最新，不应列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.onboardingComplete]);

  return { restoring: isRestoring, autoRestoring: isAutoRestoring, restoreNote, restoreTeam };
}
