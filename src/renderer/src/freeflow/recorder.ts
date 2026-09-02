/**
 * Free Flow 录音器 —— 整个渲染器共享的单个推按说话捕获引擎。
 * 两个入口都使用它，因此同一时间只能有一条录音：
 *   (A) MessageQueueComposer 中的 "Free Flow" 按钮（点击开始/停止），和
 *   (B) 按住 Option 说话（参见 freeflow/holdOption.ts）—— 就绪时开始，松开 Option 停止。
 *
 * 流程：getUserMedia(audio) → MediaRecorder (webm/opus) → 停止后，blob 的
 * 字节通过 IPC（`freeflowTranscribe`）传到 main，main 调用 Groq Whisper 并
 * 返回转写文本。转写文本被追加到目标 agent 的
 * composer 草稿（store.drafts）—— 不会自动发送 —— 忠实于 freeflow：
 * 用户 review 后才按下 Send/Enter。
 *
 * 按住说话让开始/停止的竞态成为现实：用户可能在
 * getUserMedia 解析前松开 Option。`wantActive` 跟踪用户意图，因此
 * 在打开途中到达的 stop 会丢弃即将开始的录音，而不是卡住它。
 *
 * 以模块单例 + `useFreeflow()` hook（useSyncExternalStore）形式暴露。
 */
import { useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';

export type FreeflowStatus = 'idle' | 'recording' | 'transcribing';

export interface FreeflowState {
  status: FreeflowStatus;
  /** 完成转写后落到的 agent 草稿目标。 */
  targetAgentId: string | null;
  /** 最近错误（麦克风被拒、Groq 失败…）。新录制开始时清除。 */
  error: string | null;
}

let state: FreeflowState = { status: 'idle', targetAgentId: null, error: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<FreeflowState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): FreeflowState {
  return state;
}

// ─── Recording internals ─────────────────────────────────────────────────────
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
/** start() 与下一次 stop() 之间为 true：用户想要录音。在
 *  getUserMedia 仍在打开时到达的 stop 会翻转此值，让打开路径
 *  直接丢弃而非录音。 */
let wantActive = false;
/** getUserMedia 进行中时为 true，用于忽略重入的 start() 调用。 */
let opening = false;

/** 优先 webm/opus（Groq 支持、Chromium 默认）；否则回退到平台能提供的。返回 '' 让 MediaRecorder 选其默认。 */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const supported = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
  if (supported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
  }
  return '';
}

/** 释放麦克风流，让系统录音指示器清除。 */
function teardownStream(): void {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
  stream = null;
}

/** 将 `text` 追加到目标 agent 的 composer 草稿（带分隔空格）。 */
function deliverTranscript(agentId: string, text: string): void {
  const st = useStore.getState();
  const cur = st.drafts[agentId] ?? '';
  const sep = cur && !/\s$/.test(cur) ? ' ' : '';
  st.setDraft(agentId, cur + sep + text);
}

/** 为 `agentId` 开始捕获。仅在 idle 状态下安全调用；麦克风无法打开时显示友好错误。 */
async function start(agentId: string): Promise<void> {
  if (state.status !== 'idle' || opening) return;
  if (!agentId) { setState({ error: '未选择 agent' }); return; }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    setState({ error: '麦克风不可用' });
    return;
  }
  wantActive = true;
  opening = true;
  setState({ error: null });
  let opened: MediaStream;
  try {
    opened = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    opening = false;
    wantActive = false;
    const name = e instanceof DOMException ? e.name : '';
    setState({
      status: 'idle',
      error: name === 'NotAllowedError' ? '麦克风权限被拒绝' : '无法打开麦克风'
    });
    return;
  }
  opening = false;
  // 麦克风尚未完全打开就被释放（快速点按）——干净地丢弃。
  if (!wantActive) {
    try { opened.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    return;
  }
  stream = opened;
  chunks = [];
  const mimeType = pickMimeType();
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    teardownStream();
    wantActive = false;
    setState({ status: 'idle', error: '不支持录音' });
    return;
  }
  recorder.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
  recorder.onstop = () => { void finish(agentId); };
  recorder.start();
  setState({ status: 'recording', targetAgentId: agentId, error: null });
}

/** 停止当前录音（通过 `onstop` 触发转写）。如果 start 仍在打开麦克风，则取消它（打开路径会丢弃）。 */
function stop(): void {
  wantActive = false;
  if (opening) return; // the in-flight start() will see !wantActive and discard
  if (state.status !== 'recording' || !recorder) return;
  try { recorder.stop(); } catch { /* already stopped */ }
}

/** MediaRecorder 结束时调用：组装片段、转写、送达。 */
async function finish(agentId: string): Promise<void> {
  const type = recorder?.mimeType || 'audio/webm';
  teardownStream();
  recorder = null;
  const blob = new Blob(chunks, { type });
  chunks = [];
  if (blob.size === 0) {
    setState({ status: 'idle', error: '未录制任何内容' });
    return;
  }
  setState({ status: 'transcribing', error: null });
  try {
    const buf = await blob.arrayBuffer();
    const ext = type.includes('ogg') ? 'ogg' : 'webm';
    const res = await window.cth.freeflowTranscribe({
      audio: buf,
      mimeType: type.split(';')[0],
      filename: `dictation.${ext}`
    });
    if (res.ok && res.text) {
      deliverTranscript(agentId, res.text);
      setState({ status: 'idle', error: null });
    } else {
      setState({ status: 'idle', error: res.error || '转写失败' });
    }
  } catch (e) {
    setState({ status: 'idle', error: e instanceof Error ? e.message : '转写失败' });
  }
}

/** 切换 `agentId` 的捕获（由 composer 按钮使用）：idle 时开始，recording 时停止。转写期间是空操作（上传进行中）。 */
function toggle(agentId: string): void {
  if (state.status === 'recording') stop();
  else if (state.status === 'idle') void start(agentId);
}

/** 片段录制或上传期间为 true —— 按住手势用它来避免启动第二个捕获。 */
function isBusy(): boolean {
  return state.status !== 'idle' || opening;
}

export const freeflowRecorder = { start, stop, toggle, isBusy, subscribe, getSnapshot };

/** React hook：订阅共享的录音器状态。 */
export function useFreeflow(): FreeflowState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
