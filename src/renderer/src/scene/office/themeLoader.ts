// 主题加载器——把 ThemeConfig 解析成可直接渲染的地图。
//
// Phase 0 保持轻薄：解析主题的 Tiled JSON，并把追加的 tileset 图集补上它们
// 的行内元数据（与办公场景在 resolveMap() 里内联做的补丁相同）。异步的
// `loadTheme` 签名是为后续阶段刻意留的余量——届时节目包在交给场景前可能会
// 被拉取并校验；任何失败都回退到办公主题，让坏/缺失的包永远不弄坏楼层
// （报告 §E）。

import type { TiledMap } from './TiledMapRenderer';
import {
  getTheme,
  OFFICE_THEME,
  type ThemeConfig,
  type ThemeId,
} from './themeRegistry';

/** 解析主题的原始 Tiled JSON 并修补其 tileset 数组。
 *  `embedded` 图集保留地图自身的行内元数据；其余被主题的行内元数据
 *  （firstgid + 图片尺寸）替换。结果的 tileset 顺序与纹理加载顺序一致
 *  （texture[i] ↔ tilesets[i]）。 */
export function resolveThemeMap(theme: ThemeConfig): TiledMap {
  const m = JSON.parse(theme.mapRaw) as TiledMap;
  return {
    ...m,
    tilesets: theme.tilesets.map((t, i) => {
      if (t.embedded) return m.tilesets[i];
      // 剥掉仅渲染器使用的字段（url/embedded）；其余是 Tiled 元数据。
      const { url: _url, embedded: _embedded, ...meta } = t;
      return meta as TiledMap['tilesets'][number];
    }),
  };
}

/** 要作为纹理加载的有序 tileset 图片 URL，与地图的 tileset 顺序一致
 *  （这样 texture[i] 与 tilesets[i] 对齐）。 */
export function themeTilesetUrls(theme: ThemeConfig): string[] {
  return theme.tilesets.map((t) => t.url);
}

/** 轻量校验：主题的地图必须能解析并携带合理的尺寸。 */
function isThemeRenderable(theme: ThemeConfig): boolean {
  try {
    const m = JSON.parse(theme.mapRaw) as TiledMap;
    return (
      typeof m.width === 'number' && m.width > 0 &&
      typeof m.height === 'number' && m.height > 0 &&
      Array.isArray(m.layers) && Array.isArray(m.tilesets)
    );
  } catch {
    return false;
  }
}

/** 把主题 id 解析成可渲染的 ThemeConfig。刻意设计为异步（后续阶段可能在这里
 *  拉取节目包）；请求的主题缺失或其地图无法解析时回退到办公主题。 */
export async function loadTheme(id: ThemeId): Promise<ThemeConfig> {
  const theme = getTheme(id);
  if (!isThemeRenderable(theme)) {
    console.warn(`[themeLoader] theme '${id}' is not renderable — falling back to 'office'`);
    return OFFICE_THEME;
  }
  return theme;
}
