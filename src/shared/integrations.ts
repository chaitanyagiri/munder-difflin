/**
 * Integrations registry——共享 schema（Phase 2 基础）。
 *
 * 一个零依赖、主进程与渲染进程均可导入的模块，声明集成记录/模板类型、
 * 其校验以及 v1 参考模板。与 `src/shared/mcpCatalog.ts` 的姿态一致：
 * 不含 electron/node/UI 导入，因此可被同时拉入主进程、preload 桥和渲染进程。
 *
 * 集成（*integration*）是用户注册的带标签 REST 端点（"给它贴个标签就能用"）。
 * 记录只携带 METADATA——绝不包含密钥值，只有指向加密密钥库的 `secretRef`
 * 句柄（见 src/main/integrations.ts）。回环密钥代理
 * （src/main/integrationBroker.ts）是真实密钥唯一被实体化的地方，且仅在
 * 主进程内的转发时刻。
 *
 * 与 mcpCatalog.ts 的关系：那个目录声明 STDIO MCP 服务器；本注册表声明
 * 经由回环代理访问的 HTTP REST 端点——是互补的传输方式，而非竞争目录。
 * 服务重叠处（github/db/email/search）标签保持一致。
 *
 * 完整契约：hive/docs/integrations-spec.md。
 */

export type IntegrationKind = 'github' | 'custom-rest';

/** 转发到集成 baseUrl 时代理如何注入凭据。这是唯一的认证注入词汇表；
 *  密钥由代理在转发时提供，绝不存储于此。 */
export type IntegrationAuthType =
  | 'none'    // 公共 API——不注入任何内容
  | 'bearer'  // Authorization: Bearer <secret>
  | 'header'  // <authHeader>: <secret>   （authHeader 必填）
  | 'github'; // Authorization: Bearer <secret> + GitHub API 请求头

/** 已注册的集成。仅元数据——不携带任何密钥值，只有一个 `secretRef` 句柄。
 *  可以安全地持久化到 config.json 并通过 IPC 传给渲染进程。 */
export interface IntegrationRecord {
  /** 稳定且唯一的 slug。参见 SLUG_RE。同时是 secretRef（`int:<id>`）的种子。 */
  id: string;
  /** 供 UI 显示的人类可读标签（不超过 60 字符）。 */
  label: string;
  /** 预设族——决定默认请求头和 UI 表现形式。 */
  kind: IntegrationKind;
  /** https 源（+ 可选基础路径）。代理转发 <baseUrl>/<path>。仅当用户显式
   *  注册本地 custom-rest 目标时才允许回环 http 源。 */
  baseUrl: string;
  /** 向上游转发时代理如何注入认证。 */
  authType: IntegrationAuthType;
  /** 仅当 authType === 'header' 时必填——密钥注入时所用的请求头名称。 */
  authHeader?: string;
  /** 指向加密密钥库的句柄；绝不存放密钥本身。仅当 authType !== 'none'
   *  时存在。约定：`int:<id>`。 */
  secretRef?: string;
  /** 同意门槛。仅当其启用时 worker 才能访问该集成。 */
  enabled: boolean;
  /** 纪元毫秒。 */
  createdAt: number;
  /** 纪元毫秒。 */
  updatedAt: number;
}

/** 用于播种 IntegrationRecord 的预设。Dwight 通过向 INTEGRATION_TEMPLATES
 *  追加来扩展目录——无需改动代理或注册表。 */
export interface IntegrationTemplate {
  kind: IntegrationKind;
  /** 默认标签（用户可编辑）。 */
  label: string;
  /** 默认源。custom-rest 为空（由用户提供）。 */
  baseUrl: string;
  authType: IntegrationAuthType;
  /** 用于 authType 'header'。 */
  authHeader?: string;
  /** 密钥字段的 UI 提示，例如 "GitHub personal access token"。 */
  secretLabel?: string;
  /** 一行：去哪里获取密钥 / 需要什么权限范围。 */
  secretHelp?: string;
  /** 供 UI 使用的 https 链接。 */
  docsUrl?: string;
  /** 默认 slug 种子。 */
  idSuggestion: string;
}

/** 集成 id：小写 slug，2–40 字符，无开头/结尾连字符。 */
export const INTEGRATION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** 代理可以注入的请求头名称（authType 'header'）。 */
export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
export const ALL_AUTH_TYPES: readonly IntegrationAuthType[] = ['none', 'bearer', 'header', 'github'];
export const ALL_KINDS: readonly IntegrationKind[] = ['github', 'custom-rest'];

/** 集成 id 的 secretRef 句柄（1:1）。 */
export function secretRefFor(id: string): string {
  return `int:${id}`;
}

/** 该认证类型是否需要存储的密钥。 */
export function authTypeNeedsSecret(t: IntegrationAuthType): boolean {
  return t !== 'none';
}

/**
 * 校验集成记录（upsert 门槛）。仿照 validateHireManifest 的风格：
 * 返回 { ok:true } 或 { ok:false, error }。默认拒绝——任何未显式允许的
 * 内容都会被拒绝。`createdAt`/`updatedAt` 由注册表盖章，因此输入时
 * 不要求提供。
 */
export function validateIntegrationRecord(
  rec: unknown
): { ok: true; value: Omit<IntegrationRecord, 'createdAt' | 'updatedAt'> } | { ok: false; error: string } {
  if (!rec || typeof rec !== 'object') return { ok: false, error: 'record must be an object' };
  const r = rec as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!INTEGRATION_SLUG_RE.test(id)) {
    return { ok: false, error: 'id must be a lowercase slug (2–40 chars, a–z 0–9 -, no leading/trailing hyphen)' };
  }
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label || label.length > 60) return { ok: false, error: 'label is required and must be <= 60 chars' };

  const kind = r.kind as IntegrationKind;
  if (!ALL_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${ALL_KINDS.join(', ')}` };

  const authType = r.authType as IntegrationAuthType;
  if (!ALL_AUTH_TYPES.includes(authType)) {
    return { ok: false, error: `authType must be one of ${ALL_AUTH_TYPES.join(', ')}` };
  }

  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  const urlCheck = validateBaseUrl(baseUrl);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };

  let authHeader: string | undefined;
  if (authType === 'header') {
    authHeader = typeof r.authHeader === 'string' ? r.authHeader.trim() : '';
    if (!authHeader || !HEADER_NAME_RE.test(authHeader)) {
      return { ok: false, error: "authType 'header' requires authHeader matching [A-Za-z0-9-]{1,64}" };
    }
  } else if (r.authHeader != null && String(r.authHeader).trim() !== '') {
    return { ok: false, error: "authHeader is only valid when authType === 'header'" };
  }

  const needsSecret = authTypeNeedsSecret(authType);
  const secretRef = needsSecret ? secretRefFor(id) : undefined;
  const enabled = r.enabled === true;

  return { ok: true, value: { id, label, kind, baseUrl, authType, authHeader, secretRef, enabled } };
}

/** 校验 baseUrl：https 源（+ 可选路径），不含用户信息，无路径穿越。
 *  回环 http 源（127.0.0.1 / [::1] / localhost）仅对用户显式注册的
 *  本地 custom-rest 目标允许。 */
export function validateBaseUrl(baseUrl: string): { ok: true; url: URL } | { ok: false; error: string } {
  if (!baseUrl) return { ok: false, error: 'baseUrl is required' };
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return { ok: false, error: 'baseUrl must be a valid URL' };
  }
  if (u.username || u.password) return { ok: false, error: 'baseUrl must not contain userinfo' };
  if (u.search || u.hash) return { ok: false, error: 'baseUrl must not contain a query or fragment' };
  if (baseUrl.includes('..')) return { ok: false, error: 'baseUrl must not contain ".."' };
  const isLoopbackHost =
    u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  if (u.protocol === 'https:') return { ok: true, url: u };
  if (u.protocol === 'http:' && isLoopbackHost) return { ok: true, url: u };
  return { ok: false, error: 'baseUrl must be https (http allowed only for 127.0.0.1/localhost)' };
}

/**
 * 构建代理转发时注入的上游认证请求头。纯函数——调用方（主进程中的
 * 代理）传入已解密的密钥；本函数不读取任何存储，也绝不记日志。
 * 返回要合并到出站请求的请求头映射（键为小写）。
 */
export function buildAuthHeaders(
  authType: IntegrationAuthType,
  authHeader: string | undefined,
  secret: string | undefined
): Record<string, string> {
  switch (authType) {
    case 'none':
      return {};
    case 'bearer':
      return secret ? { authorization: `Bearer ${secret}` } : {};
    case 'header':
      return secret && authHeader ? { [authHeader.toLowerCase()]: secret } : {};
    case 'github':
      return {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      };
    default:
      return {};
  }
}

/**
 * 将集成 baseUrl 与 worker 提供的路径拼接，把结果限定在 baseUrl 源之下
 * （不是开放代理）。若路径会逃逸该源（绝对 URL、覆盖主机、或越过基础
 * 路径的穿越）则返回 null。`pathAndQuery` 是 `/i/<integrationId>/` 之后
 * 的部分，包括任何查询串。
 */
export function resolveUpstreamUrl(baseUrl: string, pathAndQuery: string): URL | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  // 拒绝任何看起来像绝对目标或路径穿越的内容。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathAndQuery)) return null; // scheme://...
  if (pathAndQuery.startsWith('//')) return null; // 协议相对的主机覆盖
  // 在穿越检查前先解码路径，这样编码过的 `%2e%2e` 也会被捕获。
  const pathOnly = pathAndQuery.split(/[?#]/)[0];
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(pathOnly); } catch { return null; }
  if (decodedPath.split('/').some((seg) => seg === '..')) return null;

  // 将基础路径规范化为目录前缀，然后追加 worker 路径。
  const basePath = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  const rel = pathAndQuery.replace(/^\/+/, '');
  let resolved: URL;
  try {
    resolved = new URL(basePath + rel, base.origin);
  } catch {
    return null;
  }
  // 限定：同源，且解析后的路径保持在基础路径前缀之下。
  if (resolved.origin !== base.origin) return null;
  const confinePrefix = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  if (confinePrefix !== '/' && !(resolved.pathname + '/').startsWith(confinePrefix) && resolved.pathname !== base.pathname) {
    return null;
  }
  return resolved;
}

/** v1 参考模板——两个端到端参考。Dwight 在此追加更多。 */
export const INTEGRATION_TEMPLATES: IntegrationTemplate[] = [
  {
    kind: 'github',
    label: 'GitHub',
    baseUrl: 'https://api.github.com',
    authType: 'github',
    secretLabel: 'GitHub personal access token',
    secretHelp: 'Create a fine-grained or classic PAT at github.com/settings/tokens with the scopes your workers need.',
    docsUrl: 'https://docs.github.com/rest',
    idSuggestion: 'github'
  },
  {
    kind: 'custom-rest',
    label: 'Custom REST API',
    baseUrl: '',
    authType: 'bearer',
    secretLabel: 'API key / token',
    secretHelp: 'Point baseUrl at any REST API. Choose how its credential is sent: Bearer token, a custom header, or none.',
    idSuggestion: 'my-api'
  },

  // ─── 第一波 YC 工具（Dwight, P2）──────────────────────────────────────────
  // 每个工具的认证模型 + 高价值端点目录：hive/docs/integration-templates.md。
  // Gmail / Google Calendar / Salesforce 被有意暂不注册：它们通过 OAuth
  // 认证，而 IntegrationAuthType 没有 `oauth2`（OAuth 刷新是 v1 非目标——
  // spec §8）。它们被记录在 "Pending: OAuth broker" 之下。
  {
    kind: 'custom-rest',
    label: 'Linear',
    baseUrl: 'https://api.linear.app/graphql',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Linear API key',
    secretHelp: 'Linear → Settings → Security & access → Personal API keys. Sent verbatim in Authorization (no "Bearer"). Every call POSTs to /graphql.',
    docsUrl: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    idSuggestion: 'linear'
  },
  {
    kind: 'custom-rest',
    label: 'Jira',
    baseUrl: 'https://your-domain.atlassian.net/rest/api/3',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Authorization header (Basic …)',
    secretHelp: 'Basic auth: paste "Basic " + base64("<email>:<api-token>"). Token at id.atlassian.com → Security → API tokens. Replace your-domain with your Atlassian site.',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
    idSuggestion: 'jira'
  },
  {
    kind: 'custom-rest',
    label: 'Notion',
    baseUrl: 'https://api.notion.com/v1',
    authType: 'bearer',
    secretLabel: 'Notion internal integration token',
    secretHelp: 'notion.so/my-integrations → Internal Integration Secret; share target pages/DBs with it. Every request also needs header "Notion-Version: 2022-06-28" (worker sends it per request).',
    docsUrl: 'https://developers.notion.com/reference/intro',
    idSuggestion: 'notion'
  },
  {
    kind: 'custom-rest',
    label: 'Stripe',
    baseUrl: 'https://api.stripe.com/v1',
    authType: 'bearer',
    secretLabel: 'Stripe secret key',
    secretHelp: 'dashboard.stripe.com → Developers → API keys → Secret key (sk_live_/sk_test_). Restricted keys recommended. Bodies are form-encoded, not JSON.',
    docsUrl: 'https://stripe.com/docs/api',
    idSuggestion: 'stripe'
  },
  {
    kind: 'custom-rest',
    label: 'Confluence',
    baseUrl: 'https://your-domain.atlassian.net/wiki/api/v2',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Authorization header (Basic …)',
    secretHelp: 'Basic auth: paste "Basic " + base64("<email>:<api-token>") (same Atlassian token as Jira). Replace your-domain with your site.',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v2/intro/',
    idSuggestion: 'confluence'
  },
  {
    kind: 'custom-rest',
    label: 'Sentry',
    baseUrl: 'https://sentry.io/api/0',
    authType: 'bearer',
    secretLabel: 'Sentry auth token',
    secretHelp: 'sentry.io → Settings → Auth Tokens. Org-scoped routes carry your org slug in the path, e.g. /organizations/<org>/issues/.',
    docsUrl: 'https://docs.sentry.io/api/',
    idSuggestion: 'sentry'
  },
  {
    kind: 'custom-rest',
    label: 'HubSpot',
    baseUrl: 'https://api.hubapi.com',
    authType: 'bearer',
    secretLabel: 'HubSpot private app token',
    secretHelp: 'HubSpot → Settings → Integrations → Private Apps → create app → Access token (scopes crm.objects.*).',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    idSuggestion: 'hubspot'
  }
];
