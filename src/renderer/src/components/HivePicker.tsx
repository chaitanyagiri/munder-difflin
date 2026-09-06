import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { HarnessConfig } from '@/store/config';

export interface HivePickerProps {
  config: HarnessConfig;
  /** 原地打开当前 harness home（不重启）。 */
  onOpenCurrent: () => void;
}

// 在 hive 切换前设置此键，使 App 在 changeHome 触发的重启后
// 只跳过此选择器一次——否则用户会再次落回刚刚选中的 hive 的选择器。
// App.tsx 在挂载时读取并清除它。
const SKIP_KEY = 'cth.skipHivePickerOnce';

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * HivePicker —— 启动时的工作区选择器。"hive" 是一个 harness home
 * 文件夹：拥有自己的 agents、memory、tasks 与 history。重新打开时，
 * 用户可以进入上次所在的 hive（快速、原地），跳转到最近的某一个，
 * 浏览一个已有文件夹，或新建一个。切换到"不同"的 home 会走
 * changeHome('fresh')，它会拆除服务并针对新 home 重启——因此每次切换
 * 都是一次干净的过程重启（在任何工作开始之前，代价很小）。
 */
export function HivePicker({ config, onOpenCurrent }: HivePickerProps) {
  const { t } = useTranslation();
  const current = config.harnessHome;
  const recents = (config.recentHives ?? []).filter((h) => h && h !== current);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // 打开一个 hive。与当前所在文件夹相同 → 直接进入（不重启）。
  // 不同的文件夹 → changeHome('fresh') 重新指向并重启进程。
  const openHive = async (path: string) => {
    if (!path) return;
    if (current && path === current) { onOpenCurrent(); return; }
    setError(undefined);
    setBusy(path);
    try {
      window.localStorage.setItem(SKIP_KEY, '1');
      const res = await window.cth.changeHome(path, 'fresh');
      // 成功从不返回（进程会重启）。有返回即意味着出错。
      if (!res.ok) {
        window.localStorage.removeItem(SKIP_KEY);
        setError(res.error ?? t('hivePicker.couldNotOpen'));
        setBusy(undefined);
      }
    } catch (e) {
      window.localStorage.removeItem(SKIP_KEY);
      setError(e instanceof Error ? e.message : String(e));
      setBusy(undefined);
    }
  };

  const browse = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) void openHive(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-200)',
      backgroundImage:
        `repeating-linear-gradient(45deg, rgba(232, 217, 160, 0.4) 0 1px, transparent 1px 8px)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
      padding: 32
    }}>
      <div style={{ width: 560, maxWidth: '94vw' }}>
        <PixelPanel variant="dialog" title={t('hivePicker.title')} noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--cth-ink-700)' }}>
              <Trans i18nKey="hivePicker.desc" components={{ strong: <strong /> }} />
            </p>

            {/* CURRENT —— 上次使用的 home，一键默认项。 */}
            {current && (
              <div>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>
                  {t('hivePicker.current')}
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 2px var(--cth-mint)'
                }}>
                  <Icon name="folder" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '15px' }}>
                      {folderName(current)}
                    </div>
                    <div style={{
                      fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left'
                    }}>{current}</div>
                  </div>
                  <PixelButton variant="primary" size="md" onClick={onOpenCurrent} disabled={!!busy}>
                    {t('hivePicker.open')}
                  </PixelButton>
                </div>
              </div>
            )}

            {/* RECENTS —— 此安装此前打开过的其他 home。 */}
            {recents.length > 0 && (
              <div>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginBottom: 4 }}>
                  {t('hivePicker.recent')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                  {recents.map((h) => (
                    <button
                      key={h}
                      onClick={() => openHive(h)}
                      disabled={!!busy}
                      title={t('hivePicker.switchTo', { path: h })}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        border: 'none', cursor: busy ? 'default' : 'pointer', textAlign: 'left',
                        opacity: busy && busy !== h ? 0.5 : 1
                      }}
                    >
                      <Icon name="folder" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                          {folderName(h)}
                        </div>
                        <div style={{
                          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left'
                        }}>{h}</div>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
                        {busy === h ? t('hivePicker.openingEllipsis') : t('hivePicker.switchArrow')}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div style={{
                padding: '6px 10px', background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}>{error}</div>
            )}

            {busy && (
              <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                {t('hivePicker.opening', { name: folderName(busy) })}
              </div>
            )}

            {/* OPEN / CREATE —— 两者都会浏览到文件夹；"fresh" 模式会重新指向它
                （引导一个空文件夹，或就地复用已有的 hive 数据）。 */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <PixelButton variant="secondary" size="md" onClick={browse} disabled={!!busy}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="folder" /> {t('hivePicker.openExisting')}
                </span>
              </PixelButton>
              <PixelButton variant="secondary" size="md" onClick={browse} disabled={!!busy}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> {t('hivePicker.createNew')}
                </span>
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
