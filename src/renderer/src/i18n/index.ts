/**
 * i18n 引导——基于内联 JSON 资源的 react-i18next。
 *
 * 英文是默认语言（也是任何缺失键的兜底）。用户的选择持久化在
 * localStorage（`cth.language`）。没有任何保存值时，App 回退到操作系统语言：
 * 中文系统以简体中文启动，其他系统以英文启动。每个人仍可在设置中
 * 显式选择语言，且该选择从此永久生效。
 *
 * 新增语言：放入一个键树与 `en.json` 完全一致的 `locales/<code>.json`，
 * 在 `resources` 和 `supportedLngs` 里注册，并在 `LANGUAGES` 中加一条
 * （设置 → 通用从该列表暴露选择器）。若为从右到左的文字，则给出
 * `dir: 'rtl'`。其余代码无需改动。
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_GOD_NAME } from '@shared/godIdentity';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import ar from './locales/ar.json';

/**
 * 设置选择器提供的语言，按显示顺序排列。
 *
 * `dir` 是该语言的书写方向，是 App 决定从右到左布局时唯一依赖的东西。
 * 不是 OS 语言、不是文档内容、不是系统字体——而是用户在此选择的语言，
 * 仅此而已。正因如此，对每个未选择 RTL 语言的用户而言 RTL 都不起作用：
 * 对他们每个 `dir` 都是 'ltr'，于是 renderer 中每个 `isRtl` 分支走的路径
 * 与阿拉伯语出现之前完全一致。
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'zh-CN', label: '简体中文', dir: 'ltr' },
  { code: 'ar', label: 'العربية', dir: 'rtl' }
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

/** 从右到左阅读的语言代码，直接从 LANGUAGES 推导而来，这样新语言环境
 *  无法注册一个方向后在这里被遗忘。 */
const RTL_CODES: ReadonlySet<string> = new Set(
  LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code)
);

/**
 * 这个语言代码是从右到左阅读的吗？
 *
 * 刻意对已注册代码做「精确匹配」，而非前缀匹配或按文字猜测。
 * 未知代码视为从左到右，这正是此功能发布前所有用户的方向——
 * 一个无法识别的值绝不能去镜像某人的界面。
 */
export function isRtlLanguage(lng: string | undefined | null): boolean {
  return !!lng && RTL_CODES.has(lng);
}

/** 返回某个语言代码对应的 `'rtl'` 或 `'ltr'`，用于 `dir` 属性。 */
export function directionFor(lng: string | undefined | null): 'rtl' | 'ltr' {
  return isRtlLanguage(lng) ? 'rtl' : 'ltr';
}

const STORAGE_KEY = 'cth.language';

const SUPPORTED: readonly string[] = LANGUAGES.map((l) => l.code);

/**
 * 编排者（god）的显示名，供所有提及它的字符串使用。
 *
 * 用户可以重命名 god，而大约四十条字符串都提到它。把 "Michael" 硬编码进
 * 语言文件会在所有地方同时静默撤销那次重命名——这是本代码库在 spawn 路径上
 * 已经修过三次的 bug。因此语言文件写 `{{godName}}`，实际名字在此以
 * i18next 默认变量提供，调用点无需传它。需要变体（比如大写的标题）的调用点
 * 仍可显式传入 `godName` 覆盖。
 */
export function setGodName(name: string | undefined | null): void {
  const next = name?.trim() || DEFAULT_GOD_NAME;
  const interpolation = i18n.options.interpolation ?? (i18n.options.interpolation = {});
  const vars = interpolation.defaultVariables ?? (interpolation.defaultVariables = {});
  if (vars.godName === next) return;
  vars.godName = next;
  // react-i18next 会在此事件上重新渲染。没有它，一次重命名只会
  // 触及那些碰巧因其他原因重新渲染的字符串。
  i18n.emit('languageChanged', i18n.language);
}

/** 已保存的选择，或操作系统语言（优先中文，否则英文）。 */
function detectLanguage(): string {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved as LanguageCode)) return saved;
  } catch { /* localStorage unavailable — English it is */ }
  // 简体中文是当前唯一打包的 CJK 语言，因此任何 zh-* 代码
  // （zh、zh-CN、zh-TW、zh-Hans …）都会解析到打包的 zh-CN 资源。
  // 在 zh-TW 系统上的用户仍会看到 zh-CN 文本而非英文；
  // 如果他们愿意，可以在设置里切到英文。
  try {
    const nav = window.navigator.language?.toLowerCase() ?? '';
    if (nav.startsWith('zh')) return 'zh-CN';
  } catch { /* navigator unavailable — English it is */ }
  return 'en';
}

/** 立即切换语言，并在下次启动时保留该选择。 */
export function setLanguage(lng: string): void {
  void i18n.changeLanguage(lng);
  try { window.localStorage.setItem(STORAGE_KEY, lng); } catch { /* best-effort */ }
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
      ar: { translation: ar }
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh-CN', 'ar'],
    // 资源是内联打包的，因此永远不会挂起——字符串在初始化时就存在。
    // 保持为 false 让每个组件都能直接调用 useTranslation()，
    // 而无需用 <Suspense> 包裹整棵树。
    react: { useSuspense: false },
    // 正是 `defaultVariables` 让每个 {{godName}} 字符串无需调用点
    // 知道 god 的名字即可解析。setGodName() 使其保持最新。
    interpolation: { escapeValue: false, defaultVariables: { godName: DEFAULT_GOD_NAME } },
    returnNull: false
  });

export default i18n;
