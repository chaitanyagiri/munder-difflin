/**
 * Free Flow 入口 B —— 按住 Option 键说话（用户选定的激活方式）。
 *
 * 单独按住 Option (⌥) 键一个短阈值即可开始录音；松开
 * 则停止并将语音转写为目标 agent 的 composer 草稿（与
 * 麦克风按钮同一路径 —— 发送前可 review）。仅在 Free Flow 启用时有效。
 *
 * 难点在于终端的 Alt/Meta 冲突：在终端中 Option 是 Meta
 * （Alt+键组合、特殊字符），因此朴素的 "Option 按下 → 录音" 会
 * 破坏正常输入。消歧义：
 *   - 单独按住 THRESHOLD（约 320ms）：Option 必须单独按住，不加其他
 *     键，录音才会开始。快速的 Alt+键组合不会触发它。
 *   - 任何其它键在 Option 按下时（且录音未就绪时）立刻 ABORT ——
 *     这是真正的 Alt 组合键；我们从不调用 preventDefault，因此
 *     终端/composer 看到按键原文未改。
 *   - 自动重复的 keydown（e.repeat）会被忽略，已按住的 Option 不会重复开始。
 *   - 监听器挂载在 window 的 CAPTURE 阶段，因此手势在
 *     xterm（或 composer 的 textarea）持有 DOM 焦点时仍然触发。
 *   - 从不调用 preventDefault，因此未录音时 Option 对终端和文本框的行为与
 *     之前完全一致。
 *
 * 作用范围：窗口获得焦点时全应用生效（覆盖任意 agent 的终端
 * 屏幕，满足需求）。目标 = 全屏 agent，否则 = 选中的
 * agent。窗口失焦时重置状态，因此窗口外的松开不会让一次
 * 录音卡住。
 */
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { freeflowRecorder } from './recorder';

/** Option 必须单独按住多久才会开始录音。足够长，使得
 *  正常的 Alt+键组合（会立刻被取消资格）绝不会触发它。 */
const ARM_MS = 320;

function isOptionKey(e: KeyboardEvent): boolean {
  return e.code === 'AltLeft' || e.code === 'AltRight' || e.key === 'Alt' || e.key === 'AltGraph';
}

/** 只要组件挂载就安装按住 Option 说话的手势。实时读取
 *  启用状态和当前焦点 agent。 */
export function useHoldOptionToTalk(): void {
  useEffect(() => {
    let optionDown = false;     // Option 此刻物理按下
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    let recording = false;      // 本次手势开启了录音
    let disqualified = false;   // 其它键加入 → 当作普通 Alt 组合键

    const focusedAgentId = (): string | null => {
      const s = useStore.getState();
      return s.fullscreenAgentId ?? s.selectedId;
    };

    const clearArm = (): void => {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };

    const reset = (): void => {
      clearArm();
      if (recording) freeflowRecorder.stop();
      optionDown = false;
      recording = false;
      disqualified = false;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      // 仅在 Free Flow 开启时有效。
      if (!useStore.getState().freeflowEnabled) return;

      if (isOptionKey(e)) {
        if (e.repeat || optionDown) return; // ignore auto-repeat / already tracking
        optionDown = true;
        disqualified = false;
        // 如果已有录音正在运行/上传，不要启动第二个。
        if (freeflowRecorder.isBusy()) { disqualified = true; return; }
        const target = focusedAgentId();
        if (!target) { disqualified = true; return; }
        clearArm();
        armTimer = setTimeout(() => {
          armTimer = null;
          if (optionDown && !disqualified) {
            recording = true;
            void freeflowRecorder.start(target);
          }
        }, ARM_MS);
        return;
      }

      // Option 按住期间任何非 Option 键、且录音尚未就绪时，是
      // 真正的 Alt 组合键（或普通打字）—— 取消资格并让它原样通过。
      if (optionDown && !recording) {
        disqualified = true;
        clearArm();
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!isOptionKey(e)) return;
      clearArm();
      if (recording) freeflowRecorder.stop(); // release → transcribe
      optionDown = false;
      recording = false;
      disqualified = false;
    };

    // CAPTURE 阶段：确保 xterm/textarea 的焦点不会先吃掉事件。
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', reset);
      reset();
    };
  }, []);
}
