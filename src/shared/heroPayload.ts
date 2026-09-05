/**
 * 设置页 hero 卡片的远程负载。
 *
 * 以 JSON 形式存放在本仓库中、运行时获取，因此方案文案和赞助商
 * 无需发布新构建即可变更。它是 DATA，绝不是 markup——这一区分
 * 正是整套安全论述的核心：
 *
 *   - 每个字段都由 React 作为文本节点渲染，因此会被转义；此路径上
 *     没有任何 `dangerouslySetInnerHTML`，新增一个就会把配置文件
 *     变成脚本注入面；
 *   - URL 会被校验为 https，并通过既有的 `openExternal` 桥打开，
 *     该桥会独立拒绝任何非 https 的地址；
 *   - 字符串有长度上限，因为无界远程文本的失败模式不是安全漏洞，
 *     而是毁掉用户无法再使用的对话框布局；
 *   - 未知字段会被忽略，格式错误的负载会回退到内置默认值，因此
 *     糟糕的编辑只会退化为"看起来和以前一样"，而不是空卡片或坏卡片。
 *
 * 解析是刻意全量的：`parseHeroPayload` 从不抛异常，总是返回
 * 可渲染的结果。
 */

export interface HeroPlan {
  label: string;
  blurb: string;
  /** 仅当存在且为 https 时才渲染为按钮。 */
  upgrade?: { label: string; url: string };
}

export interface HeroSponsor {
  name: string;
  blurb: string;
  url: string;
}

export interface HeroPayload {
  plan: HeroPlan;
  /** null 不渲染任何内容——绝不出现"把你的 logo 放这里"占位符。 */
  sponsor: HeroSponsor | null;
  /** 可选的一行公告（事故、迁移提醒等）。 */
  notice: string | null;
}

/** 随二进制发布的内容。也是任何一次获取或解析失败时的回退，
 *  因此卡片永不空白、永不等待网络才渲染。 */
export const DEFAULT_HERO: HeroPayload = {
  plan: {
    label: 'Local',
    blurb: 'Every agent runs on your machine, in your folders, under your own keys. No seat limit, nothing metered.'
  },
  sponsor: null,
  notice: null
};

const MAX = { label: 24, blurb: 240, name: 48, notice: 160, url: 300 };

function str(v: unknown, cap: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** 仅 https。`openExternal` 会在桥层再次强制；在这里也做一遍，
 *  意味着坏 URL 甚至永远不会渲染为可点击的控件。 */
function httpsUrl(v: unknown): string | null {
  const s = str(v, MAX.url);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

/**
 * 把任何从网络取回的内容转换为可渲染的负载。任何未通过校验的字段
 * 都会回退到其默认值，而不是让整张卡片失败——损坏的赞助商条目
 * 不应让用户失去方案那一行。
 */
export function parseHeroPayload(raw: unknown): HeroPayload {
  if (!raw || typeof raw !== 'object') return DEFAULT_HERO;
  const o = raw as Record<string, unknown>;

  const planIn = (o.plan && typeof o.plan === 'object' ? o.plan : {}) as Record<string, unknown>;
  const plan: HeroPlan = {
    label: str(planIn.label, MAX.label) ?? DEFAULT_HERO.plan.label,
    blurb: str(planIn.blurb, MAX.blurb) ?? DEFAULT_HERO.plan.blurb
  };
  const upIn = (planIn.upgrade && typeof planIn.upgrade === 'object' ? planIn.upgrade : null) as Record<string, unknown> | null;
  if (upIn) {
    const label = str(upIn.label, MAX.label);
    const url = httpsUrl(upIn.url);
    // 两者都需或都无：没有目标的按钮比没有按钮更糟。
    if (label && url) plan.upgrade = { label, url };
  }

  let sponsor: HeroSponsor | null = null;
  const spIn = (o.sponsor && typeof o.sponsor === 'object' ? o.sponsor : null) as Record<string, unknown> | null;
  if (spIn) {
    const name = str(spIn.name, MAX.name);
    const url = httpsUrl(spIn.url);
    if (name && url) {
      sponsor = { name, blurb: str(spIn.blurb, MAX.blurb) ?? '', url };
    }
  }

  return { plan, sponsor, notice: str(o.notice, MAX.notice) };
}
