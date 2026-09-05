/**
 * 默认 MCP 服务器目录（Workstream 3）。一个零依赖、主进程与渲染进程
 * 均可导入的注册表，登记 Munder Difflin 可以接入每个 agent 每会话
 * `settings.json` 的 MCP 服务器。保持不含 electron/UI/node 导入。
 *
 * 层级决定同意门槛：
 *   - 'safe-readonly' → 无密钥、不会在 agent cwd 之外做破坏性写入；默认
 *                       开启（`defaultEnabled:true`）。`filesystem`/`git`
 *                       在合并时限定于 agent cwd（绝不整盘）。
 *   - 'write'         → 可以变更工作区之外的状态；默认关闭，需同意。
 *   - 'secret'        → 需要 API 密钥/令牌/连接串；默认关闭，需同意。
 *
 * 真正的合并（catalog ∩ enabled、filesystem/git 的 cwd 限定、id 命名空间化、
 * 非致命解析）是 Workstream 3 的 `buildDefaultMcpServers`/`hookSettings`
 * 工作——本模块只声明条目、层级与种子默认值。
 *
 * 注意：若干参考服务器以 Python（uvx）而非 npm（npx）形态分发。下面的命令
 * 反映每个服务器的真实传输方式；无法对照已安装服务器验证的条目会标记为
 * `// TODO-verify`。Workstream 3 让解析失败的服务器对 agent 非致命。
 */

export type McpTier = 'safe-readonly' | 'write' | 'secret';

export interface McpCatalogEntry {
  /** 稳定的目录 id（也是 `config.mcpDefaults` 中的同意键）。合并步骤
   *  会为写入的服务器 id 加命名空间（如 `munder-<id>`），避免覆盖用户自己的
   *  同名 `~/.claude` MCP 服务器。 */
  id: string;
  /** 供同意 UI 显示的人类可读标签。 */
  label: string;
  /** 供同意 UI / hire 导入预览使用的一行描述。 */
  description: string;
  /** MCP stdio 服务器启动规格。`filesystem`/`git` 携带一个占位 cwd
   *  参数，Workstream 3 在合并时用 agent cwd 替换它。 */
  spec: {
    command: string;
    args: string[];
    /** 必需的 env（如 API 令牌）。仅存在于 write/secret 条目；值由同意
     *  流程提供，绝不在此处硬编码。 */
    env?: Record<string, string>;
  };
  tier: McpTier;
  /** `config.mcpDefaults[id].enabled` 的种子值。恒等于 (tier === 'safe-readonly')。 */
  defaultEnabled: boolean;
}

/** 默认 MCP 组合。安全/只读服务器开启；任何写入工作区之外或需要
 *  密钥的服务器在用户同意前保持关闭。 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  // ─── 安全、只读、无密钥——默认开启 ──────────────────────────────────────
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning scratchpad. No I/O, no secrets.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'time',
    label: 'Time',
    description: 'Current time and timezone conversions.',
    // 参考时间服务器以 Python 形态分发。 // TODO-verify 传输方式（uvx 还是 npm 移植版）
    spec: { command: 'uvx', args: ['mcp-server-time'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch a URL and return its content as markdown (read-only HTTP GET).',
    // 参考 fetch 服务器以 Python 形态分发。 // TODO-verify 传输方式（uvx 还是 npm 移植版）
    spec: { command: 'uvx', args: ['mcp-server-fetch'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'context7',
    label: 'Context7 Docs',
    description: 'Up-to-date library/framework documentation lookups.',
    spec: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'filesystem',
    label: 'Filesystem (cwd)',
    description: 'Read/edit files within the agent workspace only (scoped to cwd at spawn).',
    // 末尾参数是允许的根目录——Workstream 3 在合并时用 agent cwd
    // 替换此占位符，因此绝不可能是整盘。
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<cwd>'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'git',
    label: 'Git (cwd)',
    description: 'Inspect git status/log/diff for the workspace repo (scoped to cwd at spawn).',
    // 参考 git 服务器以 Python 形态分发；`--repository <cwd>` 在合并时设置。
    // TODO-verify 传输方式（uvx 还是 npm 移植版）。
    spec: { command: 'uvx', args: ['mcp-server-git', '--repository', '<cwd>'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },

  // ─── 写入 / 密钥——默认关闭，需同意 ──────────────────────────────────────
  {
    id: 'github-token',
    label: 'GitHub',
    description: 'Read/write GitHub issues, PRs, and repos. Requires a personal access token.',
    spec: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }
    },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'db',
    label: 'Database',
    description: 'Query a SQL database. Requires a connection string.',
    // TODO-verify 针对用户数据库引擎的确切服务器包（假定为 Postgres）。
    spec: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DATABASE_URL: '' }
    },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'email-calendar',
    label: 'Email & Calendar',
    description: 'Read/send mail and read/write calendar events. Requires account credentials.',
    // TODO-verify 提供商包（假定为 Gmail/Google Calendar）。
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gsuite'], env: { GOOGLE_OAUTH_TOKEN: '' } },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'search-with-key',
    label: 'Web Search',
    description: 'Keyed web search. Requires a search-provider API key.',
    // TODO-verify 提供商包（假定为 Brave Search）。
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '' } },
    tier: 'secret',
    defaultEnabled: false
  }
];

/** 按 id 查找目录条目。 */
export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/** id 是否为已知的 safe-readonly 服务器（hire 清单无需呈现给人类同意
 *  即可请求的唯一层级——Workstream 3 校验）。 */
export function isSafeReadonlyMcp(id: string): boolean {
  return mcpCatalogEntry(id)?.tier === 'safe-readonly';
}

/** `DEFAULTS.mcpDefaults` 的种子——由目录派生，因此两者永不漂移
 *  （safe-readonly 开启，write/secret 关闭）。 */
export function defaultMcpDefaults(): Record<string, { enabled: boolean }> {
  const out: Record<string, { enabled: boolean }> = {};
  for (const e of MCP_CATALOG) out[e.id] = { enabled: e.defaultEnabled };
  return out;
}
