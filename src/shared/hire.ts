/**
 * 可共享的 "hires"——可移植的 agent 角色模板（manifest 规范 v1）。
 *
 * hire manifest 是一份小型 JSON 文档，描述一个按角色配置的 agent
 * （name、provider、model、flags、goal、budget），因此它可以作为文件共享，
 * 或托管在社区画廊中，并通过 `munderdifflin://hire?src=<https-url>` 深链
 * 或应用内文件选择器一键导入。
 *
 * 安全模型——manifest 是不可信输入：
 *   - 它绝不能自动生成 agent。导入只会预填 Add-Agent 弹窗；
 *     由人来审查最终命令并点击 spawn。
 *   - 它不能携带原始可执行文件/命令。spawn 二进制始终来自本地配置的
 *     provider 预设；manifest 只能追加 flag 形状的参数（下方校验），
 *     弹窗会完整展示这些参数。
 *   - 所有字段都在这里——这个零依赖、由 main（深链/文件导入）和 renderer
 *     （预填）共享的模块中——做了长度/形状上限。
 *   - `skills` 和 `mcpServers` 只能引用 BUNDLED 允许列表中的条目——
 *     绝不是原始规范。这与 `commandFlags` 是同一威胁模型：manifest
 *     永远不能注入任意可执行路径、环境变量或 MCP 规范。
 *     写/密钥类 MCP 服务器在导入时呈现给人类做同意，绝不会自动启用
 *     （与"导入只预填；人类点击 spawn"保持一致）。
 */

import { mcpCatalogEntry } from './mcpCatalog';
import { MAX_AGENT_TOKEN_CAP } from './tokenCaps';

export const HIRE_SPEC_V1 = 'munder-difflin/hire@1';

/** 打包在应用资源中的 skill id（hire manifest 在 `skills` 字段中唯一可请求的值）。
 *  manifest 永远不能指名任意的 skill 路径——
 *  只有这些精选的、只读的、无密钥的 skill id 被列入允许列表。 */
export const BUNDLED_SKILL_IDS: ReadonlySet<string> = new Set([
  'md-hive-sync',
  'md-fetch-summarize',
  'md-audit'
]);

/** manifest 可以请求的 provider。
 *  'custom' 刻意不允许——那会让 manifest 挑选任意的本地二进制。 */
export type HireProvider = 'claude' | 'codex' | 'kimi' | 'qwen';

export interface HireManifest {
  /** 规范标签；本版本恰为 `munder-difflin/hire@1`。 */
  spec: typeof HIRE_SPEC_V1;
  /** Agent 显示名称（也作为 hive id 的种子）。必填。 */
  name: string;
  /** 一行式角色描述，例如 "Documentation writer"——进入 identity.md 和卡片。 */
  description?: string;
  /** 预填进 goal 字段的常驻目标/任务文本。 */
  goal?: string;
  /** Office 角色 sprite id（例如 'pam'）；未知值回退到默认。 */
  character?: string;
  /** 强调色名称（例如 'mint'）；未知值回退到默认。 */
  accent?: string;
  /** 该角色面向哪个 CLI。默认：用户的默认 provider。 */
  provider?: HireProvider;
  /** 该 provider 的模型 id/标签（例如 'claude-sonnet-4-6'）。 */
  model?: string;
  /** 追加到本地构建的 spawn 命令上的额外 flag 形状参数。每个 flag 都必须
   *  在安全 flag 允许列表（见 SAFE_FLAG_NAMES）中且不含 shell 元字符；
   *  其他任何内容都会拒绝该 manifest（命令在导入后仍可编辑）。 */
  commandFlags?: string[];
  /** 供 hive 注册表用的能力标签（路由提示）。 */
  capabilities?: string[];
  /** 在隔离的 git worktree 中 spawn。 */
  isolate?: boolean;
  /** 每个 agent 的 token 总额上限，spawn 后应用于 agentTokenCaps。 */
  tokenCap?: number;
  /** 导入预览中显示的署名。 */
  author?: string;
  /** manifest 主页（画廊页面）。仅 https。 */
  homepage?: string;
  /** 要在 agent 工作区中激活的打包 skill id。只能引用
   *  BUNDLED_SKILL_IDS 中的条目——绝不是原始文件路径或任意 skill 名称。 */
  skills?: string[];
  /** 要为该 agent 启用的默认 MCP catalog id。只能引用 MCP_CATALOG
   *  允许列表中的条目——绝不是原始规范。安全只读 id 会预填；
   *  写/密钥 id 在导入时呈现给人类做同意，且绝不自动启用。 */
  mcpServers?: string[];
}

export interface HireValidation {
  ok: boolean;
  manifest?: HireManifest;
  errors: string[];
  /** manifest 的 `mcpServers` 中出现的 MCP catalog id，它们不是安全只读
   *  （写或密钥级别）。在启用前必须呈现给人类做明确同意——它们绝不自动启用。 */
  consentRequired?: string[];
}

const PROVIDERS: readonly string[] = ['claude', 'codex', 'kimi', 'qwen'];
const MAX_BYTES = 64 * 1024;

/** 一个 flag（"-x"、"--flag"、"--flag=value"）或可跟在 flag 后的裸值 token。
 *  字母/数字加保守的标点集合；不允许引号、反引号、分号、管道、与号、
 *  重定向、百分号（cmd.exe 的 %VAR% 环境变量展开）或空白。参数以 argv
 *  （无 shell）传给 node-pty，因此这是纵深防御。 */
const FLAG_RE = /^[A-Za-z0-9._\/=:,@+-]{1,100}$/;

/** 模型 id/标签中允许的字符。模型值会流入 spawn 命令行（`--model <value>`），
 *  因此这必须拒绝 shell 元字符——在 Windows 上，`.cmd`/`.bat` provider 垫片
 *  会把命令经由 cmd.exe 路由，在那里未加引号的 `&`/`|`/`^`/`<`/`>`/`(`/`)`
 *  会串联出第二条命令。真实的模型 id/标签只需要字母、数字、空格和少量
 *  标点：`claude-sonnet-4-6[1m]`、`Gemini 3.1 Pro (High)`。不允许引号、
 *  反引号、`$`、`;`、`&`、`|`、`^`、`<`、`>`、`%`、`!`。（命令字段
 *  保持可编辑，因此合法但稀有的值仍可手工键入。） */
const MODEL_RE = /^[A-Za-z0-9 ._()[\]\/:@+-]{1,80}$/;

/** manifest 被允许追加的 flag——一个默认拒绝的 ALLOWLIST（允许列表）。
 *
 *  为何用允许列表：manifest 的 `provider` 由攻击者选择，且每个 CLI 都在不断
 *  增加 flag，因此"危险"flag 的拒绝列表会漂移并漏掉（三轮复审每次都发现
 *  又一种漏网的拼写——codex `-a`/`-s`，然后是 `-c model_providers.*.base_url=…`
 *  后端重定向式凭据外泄，再然后是 `--provider`）。默认拒绝关闭的是"类别"：
 *  只有那些被证明不能提权、重定向后端/外泄凭据、读写任意文件、注入
 *  prompt/config/MCP 或运行命令的 flag 才能通过；其他任何 flag 形状的
 *  token 都直接拒绝该 manifest。
 *
 *  这些名字是精选的 SAFE 集合，取自 provider 命令参考
 *  （claudeCommands.ts / codexCommands.ts）和预设（agentProvider.ts）。
 *  这份列表刻意很小——强烈偏向排除，因为 spawn 命令在导入后仍可编辑，
 *  所以需要特殊 flag 的用户可以手工添加。每个都是行为/输出/安全上限类，
 *  且只有一个（或没有）不升级的值：
 *    --model          select the model id           (claude/codex/agy modelFlag)
 *    --max-turns      cap agentic turns (runaway guard, strictly safety-↑)
 *    --output-format  headless output shape: text / json / stream-json
 *    --verbose        logging verbosity only
 *  对 flag 名称（任何 `=` 之前的部分）做大小写不敏感匹配，因此 `--flag value`
 *  和 `--flag=value` 都被覆盖。任何与权限 / sandbox / 审批 / 目录 / 配置
 *  （含 codex `-c`）/ mcp / provider / base-url / 系统提示 / 设置相关的东西
 *  都永不被列入允许列表。 */
const SAFE_FLAG_NAMES: ReadonlySet<string> = new Set([
  '--model',
  '--max-turns',
  '--output-format',
  '--verbose'
]);

/** 判断 commandFlags token 是否是允许的 flag。处理 `--x` 和 `--x=value`
 *  （匹配 `=` 前的 NAME，大小写不敏感）；短 `-x` 形式不在允许列表中，
 *  因此默认被拒绝。 */
function isSafeFlag(token: string): boolean {
  if (!token.startsWith('-')) return false;
  const name = token.split('=', 1)[0].toLowerCase();
  return SAFE_FLAG_NAMES.has(name);
}

function str(v: unknown): v is string { return typeof v === 'string'; }

function capped(v: unknown, max: number, field: string, errors: string[], required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) errors.push(`"${field}" 为必填`);
    return undefined;
  }
  if (!str(v)) { errors.push(`"${field}" 必须是字符串`); return undefined; }
  const t = v.trim();
  if (required && !t) { errors.push(`"${field}" 不能为空`); return undefined; }
  if (t.length > max) { errors.push(`"${field}" 超过 ${max} 个字符`); return undefined; }
  return t || undefined;
}

/** 把不可信的已解析 JSON 值校验为 HireManifest。纯函数；无 I/O。 */
export function validateHireManifest(raw: unknown): HireValidation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const o = raw as Record<string, unknown>;

  if (o.spec !== HIRE_SPEC_V1) {
    return { ok: false, errors: [`unsupported spec "${String(o.spec)}" (expected "${HIRE_SPEC_V1}")`] };
  }

  const name = capped(o.name, 40, 'name', errors, true);
  const description = capped(o.description, 200, 'description', errors);
  const goal = capped(o.goal, 4000, 'goal', errors);
  const character = capped(o.character, 24, 'character', errors)?.toLowerCase();
  const accent = capped(o.accent, 24, 'accent', errors)?.toLowerCase();
  const model = capped(o.model, 80, 'model', errors);
  if (model !== undefined && !MODEL_RE.test(model)) {
    errors.push('"model" 包含不允许的字符（它会进入 spawn 命令行；只允许字母、数字、空格以及 . _ - ( ) [ ] / : @ +）');
  }
  const author = capped(o.author, 80, 'author', errors);
  const homepage = capped(o.homepage, 300, 'homepage', errors);

  let provider: HireProvider | undefined;
  if (o.provider !== undefined) {
    const p = str(o.provider) ? o.provider : o.provider;
    if (str(p) && PROVIDERS.includes(p)) provider = p as HireProvider;
    else errors.push(`"provider" 必须是 ${PROVIDERS.join(', ')} 之一`);
  }

  let commandFlags: string[] | undefined;
  if (o.commandFlags !== undefined) {
    if (!Array.isArray(o.commandFlags) || o.commandFlags.length > 16) {
      errors.push('"commandFlags" 必须是至多 16 项的数组');
    } else {
      commandFlags = [];
      // DEFAULT-DENY：每个 flag 形状的 token 都必须指名一个允许列表内的安全
      // flag；裸 token 只有在紧跟一个被允许的 `--flag` 之后才被允许
      // （这样值永远不会夹带出第二个未知 flag）。
      let valueAllowed = false; // 前一个 token 是被允许的 `--flag`（无内联 =）
      for (let i = 0; i < o.commandFlags.length; i++) {
        const f = o.commandFlags[i];
        if (!str(f) || !FLAG_RE.test(f)) {
          errors.push(`commandFlags 条目 ${JSON.stringify(f)} 不是安全的 flag token`);
          valueAllowed = false;
          continue;
        }
        // 第一个条目必须是 flag 形状（纵深防御；保持显式）。
        if (i === 0 && !f.startsWith('-')) {
          errors.push('"commandFlags" 必须以一个 flag 开头（例如 "--model"）');
          valueAllowed = false;
          continue;
        }
        if (f.startsWith('-')) {
          if (!isSafeFlag(f)) {
            errors.push(`commandFlags 条目 ${JSON.stringify(f)} 不在共享 hire 的安全 flag 列表中——出于安全，共享 hire 只能嵌入已知无害的 flag（${[...SAFE_FLAG_NAMES].join(', ')}）。如果需要该 flag，请在导入后在 command 字段里手动添加。`);
            valueAllowed = false;
            continue;
          }
          commandFlags.push(f);
          valueAllowed = !f.includes('='); // `--flag value` 形式下一个可带一个值
        } else {
          if (!valueAllowed) {
            errors.push(`commandFlags 条目 ${JSON.stringify(f)} 在此处不允许（值只能跟在允许的 flag 之后，例如 "--model"）`);
            continue;
          }
          commandFlags.push(f);
          valueAllowed = false; // 消费该值；不允许串联出第二个值
        }
      }
      if (commandFlags.length === 0) commandFlags = undefined;
    }
  }

  let capabilities: string[] | undefined;
  if (o.capabilities !== undefined) {
    if (!Array.isArray(o.capabilities) || o.capabilities.length > 12) {
      errors.push('"capabilities" 必须是至多 12 项的数组');
    } else {
      capabilities = o.capabilities.filter(str).map(c => c.trim().slice(0, 40)).filter(Boolean);
      if (capabilities.length === 0) capabilities = undefined;
    }
  }

  let isolate: boolean | undefined;
  if (o.isolate !== undefined) {
    if (typeof o.isolate === 'boolean') isolate = o.isolate;
    else errors.push('"isolate" 必须是布尔值');
  }

  let tokenCap: number | undefined;
  if (o.tokenCap !== undefined) {
    if (typeof o.tokenCap === 'number' && Number.isInteger(o.tokenCap) && o.tokenCap > 0 && o.tokenCap <= MAX_AGENT_TOKEN_CAP) tokenCap = o.tokenCap;
    else errors.push('"tokenCap" 必须是正整数（最大 1e10）');
  }

  // skills —— 允许列表：只引用 BUNDLED_SKILL_IDS 中的条目；最多 8 个
  let skills: string[] | undefined;
  if (o.skills !== undefined) {
    if (!Array.isArray(o.skills) || o.skills.length > 8) {
      errors.push('"skills" 必须是至多 8 项的数组');
    } else {
      skills = [];
      for (const s of o.skills) {
        if (!str(s) || !s.trim()) { errors.push('"skills" 条目必须是非空字符串'); continue; }
        const id = s.trim();
        if (!BUNDLED_SKILL_IDS.has(id)) {
          errors.push(`"skills" 条目 ${JSON.stringify(id)} 不是内置 skill id——hire 只能引用内置的安全 skills（${[...BUNDLED_SKILL_IDS].join(', ')}）`);
        } else {
          skills.push(id);
        }
      }
      if (skills.length === 0) skills = undefined;
    }
  }

  // mcpServers —— 允许列表：只引用 MCP_CATALOG 中的条目；最多 8 个；写/密钥类呈现给人类同意
  let mcpServers: string[] | undefined;
  const consentRequired: string[] = [];
  if (o.mcpServers !== undefined) {
    if (!Array.isArray(o.mcpServers) || o.mcpServers.length > 8) {
      errors.push('"mcpServers" 必须是至多 8 项的数组');
    } else {
      mcpServers = [];
      for (const s of o.mcpServers) {
        if (!str(s) || !s.trim()) { errors.push('"mcpServers" 条目必须是非空字符串'); continue; }
        const id = s.trim();
        const entry = mcpCatalogEntry(id);
        if (!entry) {
          errors.push(`"mcpServers" 条目 ${JSON.stringify(id)} 不是已知目录 id——hire 只能引用内置的 MCP servers`);
        } else {
          mcpServers.push(id);
          if (entry.tier !== 'safe-readonly') consentRequired.push(id);
        }
      }
      if (mcpServers.length === 0) mcpServers = undefined;
    }
  }

  if (homepage && !homepage.startsWith('https://')) errors.push('"homepage" 必须是 https');

  if (errors.length > 0 || !name) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    consentRequired: consentRequired.length > 0 ? consentRequired : undefined,
    manifest: { spec: HIRE_SPEC_V1, name, description, goal, character, accent, provider, model, commandFlags, capabilities, isolate, tokenCap, author, homepage, skills, mcpServers }
  };
}

/** 解析 `munderdifflin://hire?src=<https-url>` 深链。返回 https
 *  manifest URL，若链接不是格式良好的 hire 链接则返回 null。 */
export function parseHireDeepLink(link: string): string | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'munderdifflin:') return null;
  // 两种形式都接受：munderdifflin://hire?src=（host）和 munderdifflin:hire?src=（path）。
  const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'hire') return null;
  const src = u.searchParams.get('src');
  if (!src) return null;
  let s: URL;
  try { s = new URL(src); } catch { return null; }
  if (!isAllowedManifestUrl(s)) return null;
  return s.toString();
}

/** 一律 https；纯 http 只对回环地址（本地画廊开发）允许——远程页面永远
 *  不能把应用指向一个 http manifest。 */
export function isAllowedManifestUrl(u: URL): boolean {
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

/** 深链抓取器与文件导入器共享的字节上限。 */
export const HIRE_MAX_BYTES = MAX_BYTES;
