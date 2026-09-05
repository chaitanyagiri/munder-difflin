/**
 * 获取 + 缓存 Settings 的 hero 负载。
 *
 * 与技能目录形状相同：新鲜时从缓存提供，否则后台刷新，并且绝不致命——
 * 抓取失败先回退到缓存副本，再回退到编译进应用的默认值。卡片必须能
 * 即时且离线渲染，因为它位于人们为更换文件夹而打开的那个对话框顶部。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getText } from './fetchText';
import { parseHeroPayload, DEFAULT_HERO, type HeroPayload } from '../shared/heroPayload';

const HERO_URL =
  'https://raw.githubusercontent.com/chaitanyagiri/munder-difflin/main/docs/hero.json';
/** 套餐文案和赞助商按人类时间尺度变化。 */
const TTL_MS = 6 * 60 * 60 * 1000;

export async function loadHero(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<{ hero: HeroPayload; fetchedAt: number; stale: boolean }> {
  let cached: { hero: HeroPayload; fetchedAt: number } | null = null;
  try {
    if (existsSync(cachePath)) cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch { cached = null; }

  if (cached && !opts.force && Date.now() - cached.fetchedAt < TTL_MS) {
    return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: false };
  }

  try {
    const body = await getText(HERO_URL, { timeoutMs: 8000 });
    // 分别解析 JSON 和“形状”：是合法 JSON 但不是 hero
    // 负载的内容也必须降级为默认值，而不是渲染成 undefined。
    const hero = parseHeroPayload(JSON.parse(body));
    const payload = { hero, fetchedAt: Date.now() };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(payload));
    } catch { /* 缓存是一种优化 */ }
    return { ...payload, stale: false };
  } catch {
    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true };
    return { hero: DEFAULT_HERO, fetchedAt: 0, stale: true };
  }
}
