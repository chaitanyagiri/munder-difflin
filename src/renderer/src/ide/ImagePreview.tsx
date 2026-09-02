/**
 * IDE 的图片标签页主体。
 *
 * 取代了这个 App 过去存在的死胡同：在 IDE 中打开 .png 会创建一个标签，
 * 其全部内容只是红字「binary file (not displayable)」，因为唯一可用的
 * 文件读取器拒绝任何含空字节的内容。这使截图——agent 写出的最常见的
 * 非文本产物——在产生它的产品内部反而不可见。
 *
 * 字节经 IPC 到达，并由 useWorkspaceImage 以 `blob:` URL 持有，
 * 后者负责撤销（见那里的说明：blob URL 比引用它的元素活得久，
 * 而 IDE 标签整天开开关关）。
 *
 * 工具条刻意镜像编辑器工具条并去掉保存——这里没有任何可编辑内容——
 * 这样标签条读起来像一个整体而不是两个。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Icon';
import { useWorkspaceImage } from '@/hooks/useWorkspaceImage';
import { formatBytes, isSvgPath } from '@shared/imageTypes';
import { ideBarStyle, ideTextBtn } from './chrome';

export interface ImagePreviewProps {
  /** 路径被限制在其中的绝对工作区根。 */
  root: string;
  /** 图片相对于工作区的路径。 */
  rel: string;
  /** 复制绝对路径（与编辑器栏相同的交互方式）。 */
  onCopyPath: () => void;
  /** 改为在 Monaco 中打开该文件。针对 SVG 提供，其源码常被手改，
   *  只读预览反而是一种退化。 */
  onViewSource?: () => void;
}

export function ImagePreview({ root, rel, onCopyPath, onViewSource }: ImagePreviewProps) {
  const { t } = useTranslation();
  const img = useWorkspaceImage(root, rel);
  // 默认「适应窗口」，因为常见场景是比面板宽得多的全屏截图；
  // 先以 1:1 显示会让每个标签页都滚动到一张看不出全貌的图片左上角。
  const [fit, setFit] = useState(true);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={ideBarStyle}>
        <Icon name="image" />
        <span
          style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--cth-font-mono)' }}
          title={rel}
        >{rel}</span>

        {/* 关于文件的事实，与 diff 栏「HEAD → 工作区」标签同样克制的风格。
            尺寸只在图片真正解码后才存在，因此这里如实反映已知信息。 */}
        <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>
          {dims ? `${dims.w}×${dims.h}` : '—'}
          {img.status === 'ready' ? ` · ${formatBytes(img.size)}` : ''}
        </span>

        <span style={{ display: 'inline-flex', gap: 0 }}>
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              onClick={() => setFit(v)}
              title={v ? t('imagePreview.fitTitle') : t('imagePreview.oneToOneTitle')}
              style={{
                ...ideTextBtn,
                background: fit === v ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
                boxShadow: fit === v ? 'inset 0 0 0 1px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)'
              }}
            >{v ? t('imagePreview.fit') : '1:1'}</button>
          ))}
        </span>

        {onViewSource && (
          <button onClick={onViewSource} title={t('imagePreview.viewSourceTitle')} style={ideTextBtn}>
            {t('imagePreview.viewSource')}
          </button>
        )}
        <button onClick={onCopyPath} title={t('imagePreview.copyAbsolutePath')} style={ideTextBtn}>{t('imagePreview.copyPath')}</button>
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflow: 'auto',
        display: 'flex', alignItems: fit ? 'center' : 'flex-start', justifyContent: fit ? 'center' : 'flex-start',
        padding: 16,
        // 用棋盘格而非纯色填充：透明 PNG 在 agent 输出中随处可见（图标、裁剪的截图），
        // 而在纯色背景上，透明区域与白色或黑色无法区分。
        // 两种色调都是 token，因此棋盘会随主题反色，
        // 而不是在深色模式下泛着刺眼的白。
        backgroundColor: 'var(--cth-paper-100)',
        backgroundImage: `
          linear-gradient(45deg, var(--cth-cream-200) 25%, transparent 25%),
          linear-gradient(-45deg, var(--cth-cream-200) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, var(--cth-cream-200) 75%),
          linear-gradient(-45deg, transparent 75%, var(--cth-cream-200) 75%)`,
        backgroundSize: '16px 16px',
        backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px'
      }}>
        {img.status === 'loading' && <Centered>{t('imagePreview.loading')}</Centered>}
        {img.status === 'error' && <Centered tone="error">{img.error}</Centered>}
        {img.status === 'ready' && decodeFailed && (
          <Centered tone="error">
            {t('imagePreview.decodeFailed')}
          </Centered>
        )}
        {img.status === 'ready' && !decodeFailed && (
          <img
            src={img.url}
            alt={rel}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setDecodeFailed(true)}
            style={fit
              // `maxWidth/maxHeight: 100%` 只会缩小——32px 的 favicon 不会
              // 被放大成模糊的海报，它只是以 32px 静静待在原地。
              ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
              // 1:1 绝不能被允许缩小：它位于 flex 行内，而 flex 默认的
              // `min-width: auto` 会把图片重新压缩回面板——这正是用户刚点走的那个状态。
              : { flexShrink: 0 }}
          />
        )}
      </div>
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div style={{
      margin: 'auto', padding: 16, textAlign: 'center',
      fontFamily: 'var(--cth-font-ui)', fontSize: 13,
      color: tone === 'error' ? 'var(--cth-coral)' : 'var(--cth-ink-500)'
    }}>{children}</div>
  );
}
