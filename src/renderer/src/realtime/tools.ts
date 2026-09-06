/**
 * Realtime Michael —— 只读工具（rt-4，Realtime Michael 第一阶段）。
 *
 * 替代 rt-2 占位 no-op 的真实函数工具。每个都是对已驱动办公室楼层 UI 的
 * window.cth 桥的薄、只读包装，格式化为简短的口语散文——TTS 语音会把这些
 * 读出来，所以不能有 markdown、项目符号字符、星号。第一阶段在结构上就是
 * 只读的：这个文件里没有一个变更调用（动作工具是 rt-5，暂缓）。
 *
 * 安全：工具在 RENDERER 中运行，只触碰已暴露的只读 IPC。真实 OpenAI 密钥
 * 绝不在此出现（rt-1 的 mint 让它只留在 main）。而且 get_config 绝不转储
 * HarnessConfig——那个对象携带机密（groqApiKey、slack/webhook tokens）；
 * 我们只暴露一份手工挑选的非敏感白名单。
 *
 * 集成（rt-2 的 src/renderer/src/realtime/session.ts —— Jim 的文件）：
 *   import { realtimeReadTools, realtimeSessionSummary } from './tools';
 *   ...
 *   tools: realtimeReadTools()            // 在 `tools:` 字段处替换 placeholderTools()
 * 并且可选地把 `await realtimeSessionSummary()` 前置拼到 agent 指令上，
 * 作为热启动导向。session.ts 里的 agent_tool_start / agent_tool_end
 * 麦克风空闲生命周期与工具无关，所以换用后原样存活。
 */
import { tool } from '@openai/agents-realtime';

// ─── 口语散文格式化辅助 ──────────────────────────────────────

/** 相对“x 前”的 unix-毫秒时间戳；语音安全且防御性。 */
function ago(ts: unknown): string {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '未知时间';
  const ms = Date.now() - ts;
  if (ms < 5_000) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return `${d} 天前`;
}

/** 把毫秒间隔人性化成口语节奏（“每 5 分钟”）。 */
function every(ms: unknown): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '节奏未知';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '每分钟或更频繁';
  if (m < 60) return `每 ${m} 分钟`;
  const h = Math.round(m / 60);
  return `每 ${h} 小时`;
}

function plural(n: number, one: string, many = one): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** 把大数字压缩成语音表达（1.2 千 / 3.4 百万）。 */
function tokens(n: unknown): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} 百万`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)} 千`;
  return `${Math.round(v)}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + '（已截断）' : s;
}

/** 路径的尾端文件夹名——对语音友好（人设除非被要求，否则避免完整读文件
 *  路径）。例如 /a/b/cth-voice-tools → cth-voice-tools。 */
function shortDir(p: string): string {
  const parts = (p || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** 把 markdown 剥成纯口语散文（标题、强调、项目符号、链接、代码围栏）并
 *  折叠空白。 */
function despan(md: string): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};

const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** 包装一个工具体，让读取失败降级为口语句子而不是拒绝模型的工具调用。 */
async function spoken(fn: () => Promise<string>, what: string): Promise<string> {
  try {
    const out = (await fn()).trim();
    return out || `现在没有找到任何${what}。`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : '未知错误';
    return `刚才无法读取${what}（${msg}）。`;
  }
}

// ─── 只读工具 ──────────────────────────────────────────────────────────

/**
 * 真正的第一阶段只读工具。返回数组，让 rt-2 的会话能直接传给 `tools:`，
 * 替换 placeholderTools()。
 */
export function realtimeReadTools(): ReturnType<typeof tool>[] {
  return [
    // ── get_fleet_status ──────────────────────────────────────────────────
    tool({
      name: 'get_fleet_status',
      description:
        '当前 agent hive 里都有谁：多少 agent、哪些活跃哪些已归档、god 调度器是谁，以及每个活跃 agent 的名称、角色和引擎。当用户问谁在工作、谁在楼层上、或要一份名单时调用此工具。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const reg = await window.cth.hiveRegistry();
          const entries = Object.entries(obj(reg.agents));
          if (!entries.length) return 'hive 还没有注册任何 agent。';
          const active = entries.filter(([, a]) => !obj(a).archived);
          const archived = entries.length - active.length;
          const godId = reg.godId;
          const godName = godId ? str(obj(obj(reg.agents)[godId]).name) || godId : null;
          const lines = active
            .filter(([id]) => id !== godId)
            .map(([, a]) => {
              const m = obj(a);
              const name = str(m.name) || '未命名 agent';
              const role = str(m.role);
              const provider = str(m.provider) || 'claude';
              const status = str(m.status) || '未知';
              return `${name}${role ? `，角色 ${role}` : ''}，引擎 ${provider}（${status}）`;
            });
          const head = `Hive 里有 ${plural(active.length, '个活跃 agent')}${
            archived ? `，另有 ${plural(archived, '个已归档 agent')}` : ''
          }。`;
          const god = godName ? ` ${godName} 是 god 调度器。` : '';
          const roster = lines.length ? ` 当前活跃成员：${lines.join('；')}。` : '';
          return head + god + roster;
        }, '舰队状态')
    }),

    // ── get_tasks ─────────────────────────────────────────────────────────
    tool({
      name: 'get_tasks',
      description:
        '当前任务看板：多少任务处于待办、进行中、阻塞和完成状态，以及进行中和阻塞任务的标题与负责人。可按单个状态过滤。当用户问团队在做什么、什么被阻塞了、或进度如何时调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['todo', 'doing', 'blocked', 'done'],
            description: '可选。把答案限定为某一种状态。'
          }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const filter = typeof a.status === 'string' ? a.status : null;
          const raw = await window.cth.hiveTasks();
          const list = Array.isArray(obj(raw).tasks) ? (obj(raw).tasks as unknown[]) : [];
          if (!list.length) return '任务看板是空的。';
          const tasks = list.map(obj);
          const by = (s: string): Record<string, unknown>[] => tasks.filter((t) => str(t.status) === s);
          const counts = `${plural(by('todo').length, '个待办')}、${by('doing').length} 个进行中、${plural(
            by('blocked').length,
            '个阻塞'
          )}、${by('done').length} 个已完成`;
          const describe = (t: Record<string, unknown>): string => {
            const who = str(t.assignee);
            return `「${clip(str(t.title) || str(t.id) || '未命名', 90)}」${who ? `（${who}）` : ''}`;
          };
          if (filter) {
            const sel = by(filter);
            if (!sel.length) return `目前没有处于 ${filter} 状态的任务。总体：${counts}。`;
            return `${plural(sel.length, '个任务')} 处于 ${filter}：${sel.slice(0, 12).map(describe).join('；')}。`;
          }
          const doing = by('doing');
          const blocked = by('blocked');
          const detail = [
            doing.length ? `进行中：${doing.slice(0, 8).map(describe).join('；')}。` : '',
            blocked.length ? `阻塞：${blocked.slice(0, 8).map(describe).join('；')}。` : ''
          ]
            .filter(Boolean)
            .join(' ');
          return `共有 ${plural(tasks.length, '个任务')}：${counts}。${detail ? ' ' + detail : ''}`;
        }, '任务看板')
    }),

    // ── get_cost ──────────────────────────────────────────────────────────
    tool({
      name: 'get_cost',
      description:
        '本会话 hive 的用量：所有 agent 的 token 总数，以及用量最高的几个。仅以 token 报告（不涉及金额）。当用户问及用量或 token 消耗时调用此工具。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const snap = await window.cth.telemetrySnapshot();
          const usage = Array.isArray(snap.usage) ? snap.usage : [];
          if (!usage.length) return '本会话还没有记录到任何 token 用量。';
          let totIn = 0;
          let totOut = 0;
          const perAgent = new Map<string, number>();
          for (const s of usage) {
            const m = obj(s);
            const inTok = typeof m.input === 'number' ? m.input : 0;
            const outTok = typeof m.output === 'number' ? m.output : 0;
            totIn += inTok;
            totOut += outTok;
            const id = str(m.agentId) || '未知';
            perAgent.set(id, (perAgent.get(id) ?? 0) + inTok + outTok);
          }
          const top = [...perAgent.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([id, tok]) => `${id} 用了 ${tokens(tok)} token`);
          return `本会话至今 hive 共用了 ${tokens(totIn)} 输入、${tokens(totOut)} 输出 token，涉及 ${plural(
            perAgent.size,
            '个 agent'
          )}。${top.length ? ` 用量最高：${top.join('、')}。` : ''}`;
        }, 'token 用量')
    }),

    // ── get_triggers ──────────────────────────────────────────────────────
    tool({
      name: 'get_triggers',
      description:
        '无需人工输入即可触发 hive 的触发器。目前它报告的是定时计划：hive 按定时器运行的周期性任务，包括标签、节奏、接收者，以及各自上次触发时间。其他触发器类型——webhook 和入站组织消息——在其他地方配置，不在此列出。当用户问及触发器、定时计划、周期任务、心跳或自动化时调用此工具。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const missions = await window.cth.listMissions();
          const list = Array.isArray(missions) ? missions : [];
          if (!list.length) return '当前没有配置任何定时任务。';
          const enabled = list.filter((m) => obj(m).enabled);
          if (!enabled.length) return `共有 ${plural(list.length, '个定时任务')}，但全部处于停用状态。`;
          const lines = enabled.slice(0, 8).map((m) => {
            const o = obj(m);
            const label = str(o.label) || '一个任务';
            const to = str(o.to);
            const last = o.lastFiredAt ? `，上次触发于 ${ago(o.lastFiredAt)}` : '，尚未触发过';
            return `${label} ${every(o.intervalMs)}${to ? `，发给 ${to}` : ''}${last}`;
          });
          return `共有 ${plural(enabled.length, '个启用的定时任务')}：${lines.join('；')}。`;
        }, '定时计划')
    }),

    // ── get_config ────────────────────────────────────────────────────────
    tool({
      name: 'get_config',
      description:
        'hive 的非敏感设置：自主模式、默认模型与 god 引擎、预算上限、worker 数量上限、熔断器，以及哪些功能处于开启状态。绝不返回机密或 API 密钥。当用户问 hive 如何配置、上限或预算是多少、或某个功能是否启用时调用此工具。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const c = await window.cth.getConfig();
          // 手工挑选的非敏感白名单。绝不遍历整个对象——它携带
          // groqApiKey、slack/webhook tokens 和签名机密。通过 obj() 读取，
          // 这样渲染端的 HarnessConfig 镜像可以滞后于 main 的那份（它在三个
          // 文件间手工镜像）而不会弄坏我们。
          const cc = obj(c);
          const parts: string[] = [];
          parts.push(`自主模式：${c.autoMode ? '开启' : '关闭'}。`);
          if (c.defaultModel) parts.push(`默认模型为 ${c.defaultModel}。`);
          if (c.godProvider || c.godModel)
            parts.push(`god 调度器运行 ${[c.godProvider, c.godModel].filter(Boolean).join(' ')}。`);
          if (typeof cc.maxConcurrentWorkers === 'number')
            parts.push(`最多 ${plural(cc.maxConcurrentWorkers, '个 worker')} 并发运行。`);
          // 去除金钱化：只报告 token 上限（不报美元上限），并避开金钱字眼。
          // $ 失控守卫仍然存在并会触发；只是不说出来。
          if (typeof c.costCapTokens === 'number' && c.costCapTokens > 0)
            parts.push(`token 上限：${tokens(c.costCapTokens)}。`);
          const breakerOn = obj(c.circuitBreaker).enabled;
          parts.push(`熔断器：${breakerOn ? '已启用' : '关闭'}。`);
          parts.push(`桌面通知：${c.notifications ? '开启' : '关闭'}。`);
          const features = [
            c.slackEnabled && 'Slack',
            c.webhookEnabled && 'webhook',
            c.freeflowEnabled && 'Free Flow 语音',
            c.realtimeVoiceEnabled && '实时语音（本会话）',
            c.semanticMemory && '语义记忆',
            obj(c.knowledgeGraph).enabled && '知识图谱'
          ].filter(Boolean);
          if (features.length) parts.push(`已启用功能：${features.join('、')}。`);
          return parts.join(' ');
        }, '配置信息')
    }),

    // ── get_memory ────────────────────────────────────────────────────────
    tool({
      name: 'get_memory',
      description:
        "读取团队的记忆。你随时都可以用它作答——它绝不会走进死胡同。传入 query 可搜索 hive 学到的一切；传入 agentId 可读取某一个 agent 的笔记（对任何 agent 都有效，无论活跃还是已归档）；两者都传则在该 agent 的笔记内搜索；都不传则返回记忆状态。可用时使用语义搜索，否则对所有 agent 的记忆文件做直接文本搜索。当用户问团队学到了什么、记住了什么、决定了什么或记录了什么时候调用此工具。",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选。要在团队记忆中搜索什么。' },
          agentId: { type: 'string', description: '可选。要读取或限定搜索范围的 agent id——任何 agent，无论活跃还是已归档。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const query = str(a.query).trim();
          const agentId = str(a.agentId).trim();

          // 跨每个 agent 的 memory.md（包括已归档的）、看板与任务做直接文本
          // 回退——有或没有语义记忆 CLI 都能工作，所以查询绝不会走进死胡同。
          // 可选地收窄到单个 agent。
          const textFallback = async (q: string, onlyAgent?: string): Promise<string> => {
            const res = await window.cth.textSearch(q);
            if (!res.ok || !res.results.length) return '';
            let hits = res.results;
            if (onlyAgent) hits = hits.filter((r) => r.source.startsWith(`${onlyAgent}/`) || r.source === onlyAgent);
            if (!hits.length) return '';
            const bySource = new Map<string, string[]>();
            for (const r of hits.slice(0, 14)) {
              const who = r.source.replace(/\/memory\.md$/, '');
              if (!bySource.has(who)) bySource.set(who, []);
              bySource.get(who)!.push(r.excerpt);
            }
            const lines = [...bySource.entries()].slice(0, 6).map(([who, ex]) => `${who} 记录：${ex.slice(0, 2).join('；')}`);
            return `来自团队的笔记——${lines.join('。')}。`;
          };

          // query + agentId → 在单个 agent 内搜索（先语义分支，再文本）。
          if (query && agentId) {
            const res = await window.cth.searchMemory(query, agentId);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query, agentId);
            if (tf) return clip(tf, 1600);
            const mem = await window.cth.hiveMemory(agentId);
            const ql = query.toLowerCase();
            const matched = mem.split('\n').map((l) => l.trim()).filter((l) => l.toLowerCase().includes(ql)).slice(0, 8);
            if (matched.length) return clip(`来自 ${agentId} 的记忆——${matched.join(' ')}`, 1600);
            return mem.trim()
              ? `我读了 ${agentId} 的记忆，但没有找到与「${query}」相关的内容。`
              : `${agentId} 还没有记录任何记忆。`;
          }

          // 仅 query → 先跨整个宫庭做语义搜索，再回退到所有 agent 的文本。
          if (query) {
            const res = await window.cth.searchMemory(query);
            if (res.ok && res.output.trim()) return clip(res.output.trim(), 1600);
            const tf = await textFallback(query);
            if (tf) return clip(tf, 1600);
            return `我搜索了团队的记忆，但没有找到与「${query}」相关的内容。`;
          }

          // 仅 agentId → 直接读取该 agent 的笔记（任何 agent，活跃或已归档）。
          if (agentId) {
            const mem = await window.cth.hiveMemory(agentId);
            return mem.trim() ? clip(mem.trim(), 1600) : `${agentId} 还没有记录任何记忆。`;
          }

          // 都没有 → 状态，但要讲清楚搜索永远可用。
          const status = await window.cth.memoryStatus();
          const sem = status.active
            ? '语义记忆处于启用状态'
            : status.available
            ? '语义记忆已启用但处于空闲'
            : '语义记忆当前离线';
          return `${sem}——但我随时都可以全文搜索每个 agent 的笔记，无论活跃还是已归档。你可以让我搜索某个主题，或点名某个 agent 读取其记忆。`;
        }, '记忆')
    }),

    // ── get_activity ──────────────────────────────────────────────────────
    tool({
      name: 'get_activity',
      description:
        '最近的 hive 活动日志：生成、归档、消息等生命周期事件，最新的在前。当用户问刚才发生了什么、要最近活动、或要逐条回顾时调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '可选。汇总多少条最近事件（默认 12，最多 40）。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 12;
          const log = await window.cth.hiveLog(want);
          const list = Array.isArray(log) ? log : [];
          if (!list.length) return '目前还没有记录到任何 hive 活动。';
          const lines = list
            .slice(-want)
            .reverse()
            .map((e) => {
              const o = obj(e);
              const kind = str(o.kind) || str(o.event) || '事件';
              const who = str(o.agentId) || str(o.name) || str(o.from);
              const when = ago(o.ts);
              return `${kind}${who ? `，由 ${who}` : ''} ${when}`;
            });
          return `最近活动：${lines.join('；')}。`;
        }, '活动日志')
    }),

    // ── get_messages ──────────────────────────────────────────────────────
    tool({
      name: 'get_messages',
      description:
        "读取 hive 消息的实际内容——agent 们在收件箱和发件箱里对彼此说了什么，而不只是发生了某个事件。当用户想知道某条消息说了什么、某人问了或报告了什么、或要跟上最新动态时使用此工具。传入 agentId 聚焦某个 agent 的邮箱，传入 messageId 完整读取某一条消息，或都不传以读取整个楼层的最近消息。机密和密钥在到达你之前总会先被剥离，所以可以放心引用正文。",
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '可选。聚焦某个 agent 的收件箱和发件箱（id，或你手上有的准确 id）。' },
          messageId: { type: 'string', description: '可选。按 id 完整读取某一条消息。' },
          limit: { type: 'number', description: '可选。汇总多少条最近消息（默认 8，最多 40）。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const agentId = str(a.agentId).trim();
          const messageId = str(a.messageId).trim();
          const limit = typeof a.limit === 'number' && isFinite(a.limit) ? Math.max(1, Math.min(40, Math.round(a.limit))) : 8;

          // 相对视角说出一条消息正文。from→to + subject + body。
          const speakOne = (m: { from: string; to: string; subject: string; body: string; created_at: string; requires_reply: boolean }, full: boolean): string => {
            const subj = str(m.subject).trim();
            const body = despan(str(m.body)).trim();
            const head = `${str(m.from) || '某人'} 发给 ${str(m.to) || '某人'}${subj ? `，主题「${clip(subj, 80)}」` : ''} ${ago(Date.parse(m.created_at))}`;
            if (!body) return `${head}，没有正文。`;
            return `${head}：${clip(body, full ? 700 : 220)}${m.requires_reply ? '（对方请求了回复）' : ''}`;
          };

          if (messageId) {
            const found = await window.cth.hiveMessages({ id: messageId });
            if (!found.length) return `找不到 id 为 ${messageId} 的消息。`;
            return `这条消息——${speakOne(found[0], true)}。`;
          }

          const msgs = await window.cth.hiveMessages(agentId ? { agentId, limit } : { limit });
          if (!msgs.length)
            return agentId ? `在 ${agentId} 的邮箱里没有看到任何消息。` : '目前还没有可读取的 hive 消息。';
          const scope = agentId ? `${agentId} 的邮箱` : '整个楼层';
          const lines = msgs.slice(0, limit).map((m) => speakOne(m, false));
          return `来自${scope}的${plural(lines.length, '条最近消息')}：${lines.join('。')}。`;
        }, '消息')
    }),

    // ── get_agent_detail ──────────────────────────────────────────────────
    tool({
      name: 'get_agent_detail',
      description:
        '关于某一个 agent 的全部已知信息：名称、角色、运行引擎与模型、工作目录、活跃还是已归档、实时状态、上下文窗口占用、累计 token 用量、熔断器状态、最近做了什么，以及是否已记录记忆。当用户问某个具体 agent——在哪里工作、在哪个目录、状态如何、或要完整状态时调用此工具。接受 id 或名称。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要查询的 agent id 或友好名称（例如 "kevin-mqpbq43v" 或 "Kevin"）。' }
        },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const want = str(a.agentId).trim().toLowerCase();
          if (!want) return '请告诉我你指的是哪个 agent。';
          const dir = await window.cth.hiveAgentDirectory();
          const list = Array.isArray(dir.agents) ? dir.agents : [];
          const e =
            list.find((x) => x.id.toLowerCase() === want) ??
            list.find((x) => x.name.toLowerCase() === want) ??
            list.find((x) => x.id.toLowerCase().startsWith(want) || x.name.toLowerCase().startsWith(want));
          if (!e) return `没有找到与「${str(a.agentId)}」匹配的 agent。`;
          const parts: string[] = [];
          const role = e.role ? `，角色 ${e.role}` : '';
          const where = e.archived
            ? '已归档——其终端已关闭，但工作目录和记忆都还在'
            : `活跃，状态为 ${e.status}`;
          parts.push(`${e.name}${role}，运行引擎 ${e.provider}${e.model ? `，模型 ${e.model}` : ''}，${where}。`);
          if (e.cwd)
            parts.push(
              `工作目录：${e.cwd}${e.cwdValid === false ? '，这不是一个有效目录——在那里生成 agent 会失败' : ''}。`
            );
          if (typeof e.contextPct === 'number') parts.push(`其上下文窗口已使用 ${e.contextPct}%。`);
          else if (typeof e.contextTokens === 'number') parts.push(`其上下文约 ${tokens(e.contextTokens)} token。`);
          if (e.tokens) parts.push(`它累计使用了 ${tokens(e.tokens)} token。`);
          parts.push(`熔断器：${e.breaker}。`);
          if (e.lastTool) parts.push(`最近使用的工具是 ${e.lastTool}${typeof e.lastActiveSecAgo === 'number' ? `，${ago(Date.now() - e.lastActiveSecAgo * 1000)}` : ''}。`);
          if (e.inboxBacklog) parts.push(`收件箱里还有 ${plural(e.inboxBacklog, '条消息')} 待处理。`);
          parts.push(e.hasMemory ? '它已记录记忆——可以让我读取。' : '它还没有记录多少记忆。');
          return parts.join(' ');
        }, 'agent 详情')
    }),

    // ── list_agents ───────────────────────────────────────────────────────
    tool({
      name: 'list_agents',
      description:
        '完整名单，包括已归档（非活跃）agent：每个人的名称、引擎、活跃或已归档状态、工作目录、上下文占用和熔断器状态。用它枚举所有人（包括非活跃 agent），或回答「X 在哪里工作」「谁已归档」「谁接近上下文上限」。若只要当前活跃的 worker，get_fleet_status 更轻量。',
      parameters: {
        type: 'object',
        properties: {
          includeArchived: { type: 'boolean', description: '默认为 true。设为 false 则只列出活跃 agent。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) =>
        spoken(async () => {
          const a = obj(input);
          const includeArchived = a.includeArchived !== false;
          const dir = await window.cth.hiveAgentDirectory();
          const all = Array.isArray(dir.agents) ? dir.agents : [];
          if (!all.length) return 'hive 中还没有注册任何 agent。';
          const active = all.filter((e) => !e.archived);
          const archived = all.filter((e) => e.archived);
          const near = active
            .filter((e) => typeof e.contextPct === 'number' && e.contextPct >= 70)
            .map((e) => `${e.name} 已用 ${e.contextPct}%`);
          const describe = (e: typeof all[number]): string =>
            `${e.name}，引擎 ${e.provider}${e.cwd ? `，位于 ${shortDir(e.cwd)}` : ''}${
              typeof e.contextPct === 'number' ? `，上下文已用 ${e.contextPct}%` : ''
            }`;
          const parts: string[] = [];
          parts.push(
            `${plural(active.length, '个活跃 agent')}${archived.length ? `，另有 ${plural(archived.length, '个已归档 agent')}` : ''}。`
          );
          if (active.length) parts.push(`活跃：${active.slice(0, 12).map(describe).join('；')}。`);
          if (includeArchived && archived.length)
            parts.push(
              `已归档：${archived
                .slice(0, 12)
                .map((e) => `${e.name}${e.cwd ? `（最后位于 ${shortDir(e.cwd)}）` : ''}`)
                .join('；')}。`
            );
          if (near.length) parts.push(`接近上下文上限：${near.join('、')}。`);
          return parts.join(' ');
        }, 'agent 名单')
    }),

    // ── get_board ─────────────────────────────────────────────────────────
    tool({
      name: 'get_board',
      description:
        'hive 的计划叙事——调度器用散文形式维护的、人类可读的看板（当前计划、优先级和备注）。当用户问计划、策略、路线图、或看板上写了什么时调用此工具。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const board = await window.cth.hiveBoard();
          const text = despan(board || '');
          if (!text) return '当前看板是空的。';
          return clip(text, 1800);
        }, '看板')
    }),

    // ── get_floor_state (v0.3.4) ──────────────────────────────────────────
    tool({
      name: 'get_floor_state',
      description:
        '一次调用拿到实时楼层：每个活跃 agent 的当前状态、上下文占用、熔断器状态和收件箱积压，外加进行中的任务。返回紧凑 JSON 加一行口语总结。适合「大家都在做什么」这类问题。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const dir = await window.cth.hiveAgentDirectory();
          const tasksRaw = (await window.cth.hiveTasks()) as { tasks?: unknown } | null;
          const tasks = Array.isArray(tasksRaw?.tasks) ? (tasksRaw!.tasks as unknown[]).map(obj) : [];
          const rows = (Array.isArray(dir?.agents) ? (dir.agents as unknown[]) : [])
            .map(obj)
            .filter((a) => !a.archived)
            .map((a) => ({
              name: str(a.name) || str(a.id),
              status: str(a.status) || '未知',
              engine: str(a.provider) || undefined,
              contextPct: typeof a.contextPct === 'number' ? a.contextPct : undefined,
              breaker: str(a.breaker) && str(a.breaker) !== 'healthy' ? str(a.breaker) : undefined,
              inbox: typeof a.inboxBacklog === 'number' && a.inboxBacklog > 0 ? a.inboxBacklog : undefined
            }));
          const doing = tasks.filter((t) => str(t.status) === 'doing').map((t) => ({ title: str(t.title), owner: str(t.assignee) || undefined }));
          const blocked = tasks.filter((t) => str(t.status) === 'blocked').map((t) => ({ title: str(t.title), owner: str(t.assignee) || undefined }));
          const summary = `楼层上有 ${plural(rows.length, '个 agent')}，${doing.length} 个进行中，${blocked.length} 个阻塞。`;
          // 按 Realtime 提示指引标记的 JSON：模型可直接逐字引用的精确字段，
          // 口语行则单独给出。
          return `${summary} DATA: ${JSON.stringify({ agents: rows, doing, blocked })}`;
        }, '楼层状态')
    }),

    // ── get_app_info (v0.3.4) ─────────────────────────────────────────────
    tool({
      name: 'get_app_info',
      description:
        '关于 Munder Difflin 应用本身：当前运行的版本和最新的发布说明（更新日志）。用于回答「这是什么版本」或「这个版本有什么新功能」。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () =>
        spoken(async () => {
          const info = await window.cth.appInfo();
          const notes = despan(info.changelog || '');
          return `这是 Munder Difflin ${info.version} 版本。${notes ? `最新发布说明：${clip(notes, 1600)}` : '该版本未附带发布说明。'}`;
        }, '应用信息')
    })
  ];
}

/**
 * Michael 打开会话时可携带的一段简短、预加载的导向——hive 规模、god 是谁、
 * 有多少任务在进行中——让第一个回答无需工具往返即有据可依。尽力而为：
 * 读取失败返回 ''，调用方可以安全地把它拼到 agent 指令上。
 */
export async function realtimeSessionSummary(): Promise<string> {
  try {
    // v0.3.4：一张紧凑的 PER-AGENT 表格，而不只是计数——大多数“发生了什么”
    // 类问题仅凭它就该能回答，零工具往返。作为第一个对话项注入（不是注入
    // 指令），让缓存的提示前缀保持字节稳定。
    const [dir, tasksRaw] = await Promise.all([
      window.cth.hiveAgentDirectory(),
      window.cth.hiveTasks()
    ]);
    const rows = (Array.isArray(dir?.agents) ? (dir.agents as unknown[]) : []).map(obj).filter((a) => !a.archived);
    const godRow = rows.find((a) => a.isGod === true);
    const lines = rows.slice(0, 20).map((a) => {
      const bits = [
        `${str(a.name) || str(a.id)} 状态：${str(a.status) || '未知'}`,
        str(a.provider) ? `引擎 ${str(a.provider)}` : '',
        typeof a.contextPct === 'number' ? `上下文已用 ${Math.round(a.contextPct as number)}%` : '',
        str(a.breaker) && str(a.breaker) !== 'healthy' ? `熔断器 ${str(a.breaker)}` : '',
        typeof a.inboxBacklog === 'number' && (a.inboxBacklog as number) > 0 ? `${a.inboxBacklog} 条未读` : ''
      ].filter(Boolean);
      return bits.join('，');
    });
    const list = Array.isArray(obj(tasksRaw).tasks) ? (obj(tasksRaw).tasks as unknown[]).map(obj) : [];
    const doing = list.filter((t) => str(t.status) === 'doing');
    const blocked = list.filter((t) => str(t.status) === 'blocked');
    const taskLine = [
      doing.length
        ? `进行中：${doing.slice(0, 5).map((t) => `「${str(t.title)}」${str(t.assignee) ? `，负责 ${str(t.assignee)}` : ''}`).join('；')}。`
        : '看板上没有进行中的任务。',
      blocked.length ? `阻塞：${blocked.slice(0, 4).map((t) => `「${str(t.title)}」`).join('；')}。` : ''
    ].filter(Boolean).join(' ');
    return (
      `连接时的楼层快照——${plural(rows.length, '个活跃 agent')}` +
      `${godRow ? `，${str(godRow.name)} 与你一同调度` : ''}。 ` +
      `逐个 agent：${lines.join(' | ') || '无'}。 ` +
      taskLine +
      ` 通话过程中情况变化时，你还会收到简短的 "(Floor update: …)"（楼层更新）提示——请以它们为准，优先于这份快照。` +
      ` 你和 god（打字端调度器）共享整个楼层；任务看板是唯一的事实来源。`
    );
  } catch {
    return '';
  }
}
