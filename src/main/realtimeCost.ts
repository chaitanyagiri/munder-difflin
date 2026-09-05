/**
 * Realtime Michael —— 主进程成本辅助（卡片 rt-9，成本守卫）。
 *
 * 重新导出共享的 realtime 音频成本辅助函数，让主进程侧的调用方无需直接深入
 * ../shared 即可为 realtime 用量增量计价。这些数据供给成本上限（失控守卫），
 * 它仍然静默触发——金钱已不再展示给用户或由调度器口头播报，因此原本放在这里
 * 的 spawn/hire 的 $ 估算已被移除（去货币化）。LIVE 会话计量 + 消费上限位于
 * 渲染进程——参见 src/renderer/src/realtime/costStore.ts。
 */
export { computeRealtimeUsd, formatUsd, type RealtimeUsage } from '../shared/realtimePricing';
