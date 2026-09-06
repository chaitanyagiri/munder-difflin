/** 启动时名单从哪里加载——hive 旁的文件，还是这个 origin 的 localStorage。
 *
 *  从 store.ts 拆出来，因为它是每次启动都必须正确、且出错时无法从 UI
 *  观察的少数决策之一：名单就那么出现了，没人说它来自哪里。
 *
 *  localStorage 按 ORIGIN 分区，而不是按 hive。本应用打开过的每个 hive
 *  共享它们当中的一个，所以它只能保存最近写它的那个 hive 的名单。把它
 *  采用进一个不同的 hive，就是一个工作区的团队出现在另一个里的方式——
 *  可恢复条目、一切照旧，每一条都还带着它在被雇佣的那个工作区的 `cwd`。 */

export interface RosterCounts {
  agents: unknown[];
  archived: unknown[];
  restorable: unknown[];
}

export interface RosterSourceInput {
  /** 启动时读到的 `<harnessHome>/roster.json`，没有则为 `null`。 */
  fileRoster: RosterCounts | null;
  /** 本窗口正在打开的 hive。onboarding 选定前为 `null`。 */
  currentHome: string | null;
  /** localStorage 最后一次写入所对应的 hive；当它早于时间戳（一个升级进
   *  此行为的安装）时为 `null`。 */
  storedHome: string | null;
}

export interface RosterSource {
  /** 从文件加载这些切片。 */
  useFileRoster: boolean;
  /** 从 localStorage 加载这些切片——并且，在首次运行时，用它们为文件
   *  播种。为 false 表示两个 store 都被忽略，楼层从空开始。 */
  useLocalFallback: boolean;
}

/** 空文件绝不能赢过有内容的 localStorage：这正是镜像要防止的
 *  “开过一次打包构建然后我的楼层空白了”失败（两个 origin 不共享
 *  localStorage，文件才是桥接它们的东西）。真正的全删会清空两者，
 *  所以什么都不会复活。 */
function fileHasRoster(file: RosterCounts | null): boolean {
  return !!file
    && file.agents.length + file.archived.length + file.restorable.length > 0;
}

export function chooseRosterSource({
  fileRoster,
  currentHome,
  storedHome
}: RosterSourceInput): RosterSource {
  if (fileHasRoster(fileRoster)) return { useFileRoster: true, useLocalFallback: false };

  // 没有文件名单，剩下的唯一候选是 localStorage——而只有当它是为 THIS hive
  // 写入时才值得读取。`null` 是盖章前的情况：localStorage 早于盖章的安装
  // 会被采用一次，因为拒绝它会抹掉每个升级用户的楼层。
  const belongsHere = storedHome === null || currentHome === null || storedHome === currentHome;
  return { useFileRoster: false, useLocalFallback: belongsHere };
}
