/**
 * Realtime Michael —— 麦克风 & 扬声器设备选择器（卡片 rt-8，第一阶段）。
 *
 * 让用户选择语音循环采集哪个麦克风、通过哪个扬声器播放 Michael 的声音。
 * 选择保存在实时会话 store 里，经 `setDeviceId()` / `setOutputDeviceId()`
 * （见 session.ts）：麦克风在下次 connect() 时应用（getUserMedia
 * `{ deviceId: { exact } }`），扬声器立即应用到活跃的 `<audio>` 输出端
 * （经 `setSinkId()`，并在 connect 时重新应用）。存储的 id 过期时两者都
 * 回退到系统默认。
 *
 * `enumerateDevices()` 只在页面至少被授予过一次麦克风访问后才返回设备
 * LABEL（我们的主进程闸在语音会话或 Free Flow 活跃时打开——见
 * src/main/index.ts）。在此之前我们显示通用的「麦克风 N」/「扬声器 N」
 * 名称和一个提示，让选择器冷启动即可用。
 *
 * 分支 feat/realtime-michael。见 board.md “🎙 REALTIME MICHAEL”。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRealtimeMichael } from './session';
import { useStore } from '@/store/store';

interface AudioDevice {
  deviceId: string;
  label: string;
}

/** 此运行时能否把音频输出路由到选定的输出端（Chromium/Electron 暴露
 *  HTMLMediaElement.setSinkId；某些 lib.dom 目标没有）。为 false 时我们隐藏
 *  扬声器选择器，而不是显示一个无效控件。 */
const CAN_PICK_SPEAKER =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/** 枚举某一种类的音频设备；真实标签被隐藏时（本会话还没授予麦克风权限）
 *  提供一个通用回退标签。 */
async function listDevices(kind: 'audioinput' | 'audiooutput'): Promise<AudioDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const fallback = kind === 'audioinput' ? 'Microphone' : 'Speaker';
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === kind)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-500)',
  textTransform: 'uppercase'
};
const selectStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 12,
  padding: '6px 8px',
  border: '2px solid var(--cth-ink-300)',
  background: 'var(--cth-paper-100)',
  color: 'var(--cth-ink-900)'
};

export function RealtimeDevicePicker(): React.ReactElement {
  const { t } = useTranslation();
  const { deviceId, setDeviceId, outputDeviceId, setOutputDeviceId } = useRealtimeMichael();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [mics, setMics] = useState<AudioDevice[]>([]);
  const [speakers, setSpeakers] = useState<AudioDevice[]>([]);
  /** 一旦至少一个设备暴露真实标签即为 true ⇒ 麦克风权限已授予。 */
  const [labelled, setLabelled] = useState(false);

  const refresh = useCallback(async () => {
    const [ins, outs] = await Promise.all([
      listDevices('audioinput'),
      CAN_PICK_SPEAKER ? listDevices('audiooutput') : Promise.resolve<AudioDevice[]>([])
    ]);
    setMics(ins);
    setSpeakers(outs);
    setLabelled(ins.some((m) => m.label && !/^Microphone \d+$/.test(m.label)));
  }, []);

  useEffect(() => {
    void refresh();
    // 热插拔设备，或揭示标签的权限授予 → 重新枚举。
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md) return;
    const onChange = (): void => void refresh();
    md.addEventListener?.('devicechange', onChange);
    return () => md.removeEventListener?.('devicechange', onChange);
  }, [refresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 280 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={labelStyle}>{t('devicePicker.microphone')}</span>
        <select
          value={deviceId ?? ''}
          onChange={(e) => setDeviceId(e.target.value || null)}
          style={selectStyle}
        >
          <option value="">{t('devicePicker.systemDefault')}</option>
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {CAN_PICK_SPEAKER && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>{t('devicePicker.speaker')}</span>
          <select
            value={outputDeviceId ?? ''}
            onChange={(e) => setOutputDeviceId(e.target.value || null)}
            style={selectStyle}
          >
            <option value="">{t('devicePicker.systemDefault')}</option>
            {speakers.map((s) => (
              <option key={s.deviceId} value={s.deviceId}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {!labelled && (
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          {t('devicePicker.namesHint')}
        </span>
      )}
    </div>
  );
}
