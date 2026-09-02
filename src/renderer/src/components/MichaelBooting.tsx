import { PixelPanel } from '@/components/PixelPanel';
import { useTranslation } from 'react-i18next';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';

/**
 * 空办公室上、god agent 启动打卡时显示的 loader。它取代"add agent"
 * 提示，让回访用户不会在 god 启动完成前看到空办公室的呼唤行动。
 *
 * 在 `agentCount === 0` 期间渲染——此时 store 还没有 god 的活 agent
 * 对象（所以 `agent.name` 也还不存在于任何可读之处）——因此这里直接读
 * 持久化的名字，与 useHive.ts 的 spawn effect 相同的方式，而不是
 * 假定默认值。
 */
export function MichaelBooting() {
  const godName = useResolvedGodName();
  const { t } = useTranslation();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none'
    }}>
      <div style={{ pointerEvents: 'auto', width: 360 }}>
        <PixelPanel variant="dialog" title={t('michaelBooting.clockingIn')} noPadding>
          <div style={{
            padding: 20,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14
          }}>
            {/* 阶梯式像素块——错开闪烁、无缓动（契合美学） */}
            <div style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 14, height: 14,
                    background: '#6E1423',
                    boxShadow: 'var(--cth-shadow-hard)',
                    animation: 'cth-blink 1s steps(1, end) infinite',
                    animationDelay: `${i * 0.2}s`
                  }}
                />
              ))}
            </div>
            <p style={{
              margin: 0, fontSize: 13, lineHeight: '20px', textAlign: 'center',
              color: 'var(--cth-ink-700)'
            }}>
              {godName} is settling into the corner office and getting the floor
              ready. Hang tight…
            </p>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
