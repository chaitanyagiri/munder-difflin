/**
 * 每周日程 — 用"每周一和周四的 09:00"来表达，而不是
 * "每 86400000 毫秒"。
 *
 * `ScheduledMission` 一直按固定间隔触发，这无法表达"工作日早晨"：
 * 间隔相对时钟会漂移，而且在 15:00 启动的 24 小时间隔会永远
 * 在 15:00 触发。本模块补充另一种形态。当任务带有有效的
 * `weekly` 时，它 REPLACES 该间隔；记录上的间隔保持原样不动，
 * 这样切回时能恢复。
 *
 * 刻意保持纯净且无导入，测试加载器可以直接引用它，
 * 调度器的运算可以在没有时钟或配置文件的情况下测试。
 *
 * ── 这里的一切时间都是本地时间，刻意如此 ────────────────────────────
 * "周一 09:00" 指的是用户所在时区的 09:00，这是人们唯一
 * 会期望的解读。这就是为什么下一次触发是用
 * `Date(y, m, d, h, min)` 构造器而不是毫秒加法构建的：
 * 跨夏令时边界加 `7 * 86400000` 会偏差一小时，而
 * 从日历字段重建则会落在同一个墙上时钟上。在春季拨快的
 * 一天里，不存在的时间（美国大部分地区的 02:30）会
 * 按平台的方式向前滚动，这是标准行为，也是其他所有
 * 调度器都会产生的行为。
 */

export interface WeeklySchedule {
  /** 0 = 周日 … 6 = 周六。空数组表示"不是每周日程"。 */
  days: number[];
  /** 自本地午夜起的分钟数，0..1439。 */
  minute: number;
}

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 7 按钮选择器的首字母。两个 T 和两个 S——由位置承载含义，
 *  世界上每个日历都是这么做的。 */
export const WEEKDAY_INITIALS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 错过（MISSED）时段后任务仍然触发的最长等待时间。
 *
 * 一台在 09:00 睡眠、10:30 打开的笔记本仍应得到它 09:00 的运行；
 * 一台周五关闭、周一打开的笔记本则不应补跑周五的。六个小时
 * 大约落在人们会划分这两类情况的界限附近。这与间隔调度器
 * 已有的行为一致（它把负的剩余时间钳制为零并在启动时触发），
 * 因此两类日程在睡眠后的行为相同，而不是其中一个
 * 静默跳过。
 */
export const WEEKLY_CATCHUP_MS = 6 * 60 * 60 * 1000;

/** 校验并规范化。对任何不可用的每周日程返回 null——没有天数、
 *  无效的星期数、超出一天的分钟数——这样每个调用方都只需做一次检查。
 *  天数会排序并去重返回，因此两个含义相同的日程比较结果
 *  相等。 */
export function normalizeWeekly(w: unknown): WeeklySchedule | null {
  if (!w || typeof w !== 'object') return null;
  const raw = w as { days?: unknown; minute?: unknown };
  if (!Array.isArray(raw.days)) return null;
  const days = [...new Set(
    raw.days.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
  )].sort((a, b) => a - b);
  if (days.length === 0) return null;
  const minute = raw.minute;
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 1439) return null;
  return { days, minute };
}

/** "09:00"。24 小时制补零，因为操作员回读的日程
 *  不应还需要再看一眼上午/下午。 */
export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 供人阅读的摘要行："weekdays at 09:00"、"Mon, Thu at 14:30"。 */
export function formatWeekly(w: unknown): string {
  const n = normalizeWeekly(w);
  if (!n) return '未选择任何日子';
  const at = formatMinute(n.minute);
  const key = n.days.join(',');
  if (key === '0,1,2,3,4,5,6') return `每天 ${at}`;
  if (key === '1,2,3,4,5') return `工作日 ${at}`;
  if (key === '0,6') return `周末 ${at}`;
  return `${n.days.map((d) => WEEKDAY_LABELS[d]).join('、')} ${at}`;
}

/** 为距 `from` 起 `offset` 天的那一天、在 `minute` 时刻构建本地时刻。
 *  使用日历字段构造，而非毫秒运算——参见 DST 注释。 */
function slotAt(from: Date, offset: number, minute: number): Date {
  return new Date(
    from.getFullYear(), from.getMonth(), from.getDate() + offset,
    Math.floor(minute / 60), minute % 60, 0, 0
  );
}

/** 严格晚于 `nowMs` 的第一个匹配时段，若无可用天数则返回 null。
 *  八个候选总是够用：最坏情况是每周一天、其时段今天已过，
 *  那会落在偏移 7 上。 */
export function nextWeeklyFireMs(w: unknown, nowMs: number): number | null {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const from = new Date(nowMs);
  for (let offset = 0; offset <= 7; offset++) {
    const slot = slotAt(from, offset, n.minute);
    if (!n.days.includes(slot.getDay())) continue;
    const t = slot.getTime();
    if (t > nowMs) return t;
  }
  return null;
}

/** 最接近的、在 `nowMs` 之前（含）的匹配时段，或 null。仅用于
 *  判断应用未运行期间是否有时段被错过（MISSED）。 */
export function previousWeeklyFireMs(w: unknown, nowMs: number): number | null {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const from = new Date(nowMs);
  for (let offset = 0; offset >= -7; offset--) {
    const slot = slotAt(from, offset, n.minute);
    if (!n.days.includes(slot.getDay())) continue;
    const t = slot.getTime();
    if (t <= nowMs) return t;
  }
  return null;
}

/**
 * 调度器在触发此任务前应等待多久，日程不可用时
 * 返回 null。
 *
 * 零表示"立即触发"：我们未监控时有一个时段已过，它足够新、
 * 仍值得运行，而且我们尚未运行过。最后一个条件就是
 * `lastFiredAt` 的作用——没有它，重新武装调度器
 * （对任意任务每次保存都会发生）会重新触发一个
 * 几分钟前已经运行过的任务。
 */
export function weeklyDelayMs(w: unknown, nowMs: number, lastFiredAt = 0): number | null {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const prev = previousWeeklyFireMs(n, nowMs);
  if (prev !== null && prev > lastFiredAt && nowMs - prev <= WEEKLY_CATCHUP_MS) return 0;
  const next = nextWeeklyFireMs(n, nowMs);
  return next === null ? null : Math.max(0, next - nowMs);
}
