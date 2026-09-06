/**
 * 通过 IPC 加载工作区图片，并返回其 `blob:` URL。
 *
 * 为什么用 HOOK 且为什么用 BLOB：渲染进程无法读取磁盘。CSP 是
 * `default-src 'self'`，`img-src 'self' data: blob:`，且应用没有注册
 * 文件协议，所以 `<img src="file:///…">` 会静默失败——“我的截图为什么是
 * 空白”的经典死胡同就是它。因此字节通过 `fs:readBinary` 传过来并在本地包装。
 *
 * `blob:` 而非 `data:`：data URI 会对载荷做 base64 编码，把一张 6 MB 的
 * 截图膨胀成约 8 MB 的 JavaScript STRING，只要该元素存在就驻留在堆里，
 * 而且每次渲染都要重新解码。blob URL 只是浏览器已持有的字节的句柄，
 * 传递起来很便宜。
 *
 * 缺陷——也是每个消费方都必须经由这个 hook 的原因——在于 blob URL 是
 * 文档作用域的注册项，当 <img> 消失时并不会被垃圾回收。IDE 会反复打开和
 * 关闭图片标签页，一份 markdown 报告可能持有十几张截图；没有显式 revoke
 * 的话，每次打开都会让字节滞留到窗口生命周期结束。这里的 effect 清理
 * 是唯一的 revoke 位置，因此“已挂载”与“URL 存活”天然是同一个区间。
 *
 * SVG 说明：通过 <img> 加载的 SVG 运行在浏览器的静态安全模式下——无脚本、
 * 无外部请求——因此 agent 生成的 SVG 即使源码看起来像可执行标记，也可以
 * 安全地这样展示。
 */
import { useEffect, useState } from 'react';

export type WorkspaceImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; mime: string; size: number }
  | { status: 'error'; error: string };

export function useWorkspaceImage(
  root: string | null | undefined,
  rel: string | null | undefined
): WorkspaceImageState {
  const [state, setState] = useState<WorkspaceImageState>({ status: 'loading' });

  useEffect(() => {
    if (!root || !rel) {
      setState({ status: 'error', error: '无文件' });
      return;
    }
    let alive = true;
    let created: string | null = null;
    setState({ status: 'loading' });

    void window.cth.readBinary(root, rel).then((res) => {
      // 在创建 URL 之前先检查：消费方已卸载时就放弃——清理之后创建的
      // URL 永远不会被任何人 revoke。
      if (!alive) return;
      if (!res.ok) { setState({ status: 'error', error: res.error }); return; }
      created = URL.createObjectURL(new Blob([res.bytes], { type: res.mime }));
      setState({ status: 'ready', url: created, mime: res.mime, size: res.size });
    }).catch((e: unknown) => {
      if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    });

    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [root, rel]);

  return state;
}
