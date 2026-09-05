/**
 * 渲染后的 markdown 视图（v0.3.4）—— IDE 的
 *  分屏/预览模式、全屏文件覆盖层，以及（通过它们）终端 ⌘-click 流程
 *  共用的预览。`card` 变体在另一个表面内渲染 agent 编写的
 *  markdown：ASK ME 问题和任务详情的 Q&A 跟踪。
 *
 * 安全：agent 生成的 markdown 不可信。react-markdown 不带
 *  rehype-raw 只渲染为 React 元素 —— 不存在 HTML sink，源中的
 *  原始 HTML 显示为文本，默认 urlTransform 已丢弃
 *  javascript: URI。保持这样：此处绝不调用 rehype-raw。
 *
 * 链接从不导航窗口：http(s)/mailto 走 main-process 打开器；
 * 相对 *.md 链接通过 onOpenMarkdownLink 浮出，由宿主
 * （IDE 标签页 / 覆盖层）在上下文中打开它们；其余保持惰性。
 */
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkspaceImage } from '@/hooks/useWorkspaceImage';
import { isExternal, isRelativeMd, resolveLocalImageRel, resolveRel } from './mdLinks';
import { remarkSoftBreaks } from './remarkSoftBreaks';
import { rehypeAutoDir } from './rehypeAutoDir';
import { useRtl } from '@/i18n/useDirection';

/** 渲染后的 markdown 如何嵌入其宿主。
 *  - `document`（默认）：页面 —— 拥有自己的类型比例、72ch 度量、页面内边距。
 *  - `card`：markdown 在另一个表面内部（ASK ME 问题、Q&A 条目）。
 *    继承宿主字体和大小，去除页面 chrome，并保留单个
 *    换行作为换行，与它替换的纯文本块行为一致。 */
export type MarkdownVariant = 'document' | 'card';

// 提升：每次渲染都新建数组会让 react-markdown 即使
// 源未变化也重跑整条管线。
const DOC_PLUGINS = [remarkGfm];
const CARD_PLUGINS = [remarkGfm, remarkSoftBreaks];

/** 每块 `dir="auto"`，仅对 RTL 应用语言 —— 见下方
 *  `useRtl()` 调用点的说明。冻结的模块常量，使 prop 身份稳定，
 *  react-markdown 不会在每次渲染时重跑管线。 */
const AUTO_DIR_PLUGINS = [rehypeAutoDir];
const NO_PLUGINS: never[] = [];

export interface MarkdownPreviewProps {
  source: string;
  /** 正在预览的文件的工作区相对路径（用于解析相对链接）。 */
  baseRel?: string;
  /** 绝对工作区根目录。提供它可将本地图片从占位符
   *  芯片渲染为真实图片（通过限制到根目录的 fs IPC 读取）；
   *  不提供时每张图片保持为芯片，因为没有可解析的基准。 */
  root?: string;
  /** 在宿主上下文中打开兄弟 markdown 文件（工作区相对路径）。 */
  onOpenMarkdownLink?: (rel: string) => void;
  /** 页面 vs 卡片内渲染。默认为 `document`。 */
  variant?: MarkdownVariant;
}

export const MarkdownPreview = memo(function MarkdownPreview({
  source, baseRel, root, onOpenMarkdownLink, variant = 'document'
}: MarkdownPreviewProps) {
  const card = variant === 'card';
  // 每块方向，以 APP 语言为门控，而非以文本本身。
  //
  // 该插件对每块打上 `dir="auto"`，从其第一个强字符解析 ——
  // 若不加门控，在英文用户看到 agent 引用阿拉伯语行的瞬间就会触发，
  // 并将他们的 UI 镜像覆盖到他们从未开启的内容上。
  // 绑定到所选语言意味着英文用户的 markdown 渲染与
  // 此功能存在之前完全一致的管线，不论 agent 在其中写入什么。
  const rtl = useRtl();
  return (
    <div className={card ? 'cth-md-preview cth-md-card' : 'cth-md-preview'}>
      <ReactMarkdown
        remarkPlugins={card ? CARD_PLUGINS : DOC_PLUGINS}
        rehypePlugins={rtl ? AUTO_DIR_PLUGINS : NO_PLUGINS}
        components={{
          a: ({ href, children }) => {
            const h = href ?? '';
            const onClick = (e: React.MouseEvent) => {
              e.preventDefault();
              if (isExternal(h)) { void window.cth.openExternal?.(h); return; }
              if (isRelativeMd(h) && onOpenMarkdownLink) {
                onOpenMarkdownLink(resolveRel(baseRel, h.replace(/#.*$/, '')));
              }
              // 其余（file:、自身锚点、未知协议）：惰性
            };
            const clickable = isExternal(h) || (isRelativeMd(h) && !!onOpenMarkdownLink);
            return (
              <a
                href={h || undefined}
                onClick={onClick}
                title={h}
                style={clickable ? undefined : { cursor: 'default', textDecoration: 'underline dotted' }}
              >
                {children}
              </a>
            );
          },
          // 图片。本地图片真实渲染（字节通过限制到根目录的 fs
          // IPC → blob URL）；远程图片保持为占位符芯片。
          // 此前每张图片都是芯片，这意味着 agent 报告说 "见下方截图" 时
          // 显示的是写着 "🖼 screenshot" 的药丸，证据在应用中
          // 任何地方都不可见。
          img: ({ alt, src }) => {
            const s = typeof src === 'string' ? src : undefined;
            const rel = root ? resolveLocalImageRel(baseRel, s) : null;
            if (!root || !rel) return <ImageChip alt={alt} src={s} />;
            return <MdImage root={root} rel={rel} alt={alt} src={s} />;
          }
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

/** 我们无法（或不能）加载的 fallback：远程 URL、非图片、
 *  以及被发现缺失或无法解码的本地文件。 */
function ImageChip({ alt, src, note }: { alt?: string; src?: string; note?: string }) {
  return (
    <span className="cth-md-img" title={src}>
      🖼 {alt || 'image'}{note ? ` — ${note}` : ''}
    </span>
  );
}

/** 渲染 markdown 中的本地图片。任何失败时 fallback 到芯片，
 *  使报告中的过期路径退化为旧行为而非破碎图片图标。
 *  Blob 生命周期（创建 AND 撤销）属于该 hook。 */
function MdImage({ root, rel, alt, src }: { root: string; rel: string; alt?: string; src?: string }) {
  const img = useWorkspaceImage(root, rel);
  const [decodeFailed, setDecodeFailed] = useState(false);
  if (img.status === 'loading') return <ImageChip alt={alt} src={src} note="loading" />;
  if (img.status === 'error') return <ImageChip alt={alt} src={src} note={img.error} />;
  if (decodeFailed) return <ImageChip alt={alt} src={src} note="无法解码" />;
  return (
    <img
      className="cth-md-image"
      src={img.url}
      alt={alt || rel}
      title={src}
      onError={() => setDecodeFailed(true)}
    />
  );
}
