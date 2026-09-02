/**
 * Realtime Michael —— 语音动作工具（卡片 rt-5，第二阶段）。
 *
 * 把语音 Michael 变成编排者的写侧函数工具：ping / dispatch / steer /
 * task CRUD / spawn-hire / kill / pause / halt / edit-schedule。这些是
 * THIN 的——每个工具只把一条 {verb, ...args} 转发给主进程
 * （src/main/realtimeActions.ts），后者拥有整套安全主干：软 vs 破坏性
 * 分级、两步口头回显确认、独立 token 规则、硬性白名单（禁 kill-god /
 * 批量操作）、以及 michael-voice 归因。渲染端是不可信侧，所以它不持有
 * 任何策略——只回显 main 返回的内容（`res.spoken`）。
 *
 * 确认流程：破坏性工具返回一段回显（"…say 'confirm' or 'kill'"），main
 * 暂存一条待处理动作。模型随后用用户说出的短语调用 `confirm_action` 来
 * 提交，或用 `cancel_action` 丢弃它。因为每次工具调用都会静音麦克风
 * （session.ts agent_tool_start），confirm_action 内的提交发生在麦克风
 * 空闲时——不会有杂音音频混入同意。
 *
 * 与只读工具一起注册：session.ts 使用
 *   tools: [...realtimeReadTools(), ...realtimeActionTools()]
 */
import { tool } from '@openai/agents-realtime';

const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** 把一条 verb + args 转发给主动作主干并返回其口头结果。
 *  针对 rt-5 线上 bug 埋点：任何失败都会把 verb + 原始 args 记到（人类
 *  可见的）渲染端控制台，让下一次复现可以自我诊断。 */
async function act(verb: string, input: unknown): Promise<string> {
  // 优雅守卫：若 preload 桥缺失（例如 dev 热重载让渲染端领先于过期的
  // preload），说明原因而不是抛出晦涩错误。
  if (typeof window.cth?.realtimeAction !== 'function') {
    console.error('[realtime-action] window.cth.realtimeAction is not available — restart the app to load the rt-5 preload.', { verb });
    return '此版本尚不支持语音操作——请尝试重启应用。';
  }
  try {
    const res = await window.cth.realtimeAction({ verb, ...obj(input) });
    if (!res?.ok) console.warn('[realtime-action] verb=%s rejected: %s', verb, res?.spoken, { input });
    return res?.spoken || '完成。';
  } catch (e) {
    console.error('[realtime-action] verb=%s threw:', verb, e, { input });
    const msg = e instanceof Error ? e.message : 'an unknown error';
    return `我无法完成该操作（${msg}）。`;
  }
}

export function realtimeActionTools(): ReturnType<typeof tool>[] {
  return [
    // ── 软写入（立即执行）─────────────────────────────────
    tool({
      name: 'ping_agent',
      description:
        '给单个 agent 发送一条简短消息（提醒或便条）。软操作——立即执行，无需确认。用于「告诉 Oscar X」或「跟 Jim 打个招呼」。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要发送消息的 agent 名称或 id。' },
          message: { type: 'string', description: '想对他们说的话。' }
        },
        required: ['agentId', 'message'],
        additionalProperties: false
      },
      execute: (input) => act('ping', input)
    }),
    tool({
      name: 'dispatch_agent',
      description:
        '以结构化的四部分工单（目标、背景、约束、完成标准）将任务下发给某个 agent 的收件箱。软操作——立即执行。用于「让 Jim 构建 X」或「让 Oscar 调查 Y」。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要下发的 agent 名称或 id。' },
          objective: { type: 'string', description: '目标——他们应该完成什么。' },
          context: { type: 'string', description: '可选。他们需要的背景。' },
          constraints: { type: 'string', description: '可选。需要遵守的限制/护栏。' },
          doneWhen: { type: 'string', description: '可选。完成标准。' }
        },
        required: ['agentId', 'objective'],
        additionalProperties: false
      },
      execute: (input) => act('dispatch', input)
    }),
    tool({
      name: 'steer_agent',
      description:
        '向运行中的 agent 注入实时引导，在不停止它的前提下重新定向。软操作——立即执行。这是优先动词：「让 Jim 先专注这个 bug」「引导 Oscar 避开那个方案」。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '要引导的 agent 名称或 id。' },
          text: { type: 'string', description: '要注入的引导内容。' }
        },
        required: ['agentId', 'text'],
        additionalProperties: false
      },
      execute: (input) => act('steer', input)
    }),
    tool({
      name: 'create_task',
      description:
        '向任务看板添加一张新卡片。软操作——立即执行。用于「创建一个 X 任务」，可选指派给某人。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题。' },
          description: { type: 'string', description: '可选。更多详情。' },
          assignee: { type: 'string', description: '可选。负责它的 agent id/名称。' },
          priority: { type: 'number', description: '可选。1（最高）到 10。' }
        },
        required: ['title'],
        additionalProperties: false
      },
      execute: (input) => act('create_task', input)
    }),
    tool({
      name: 'assign_task',
      description: '将现有任务指派给某个 agent。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要指派的任务 id 或标题。' },
          assignee: { type: 'string', description: '负责它的 agent id/名称。' }
        },
        required: ['taskId', 'assignee'],
        additionalProperties: false
      },
      execute: (input) => act('assign_task', input)
    }),
    tool({
      name: 'update_task',
      description:
        '修改现有任务：其状态（todo/doing/blocked/done）、结果备注或负责人。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要更新的任务 id 或标题。' },
          status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'], description: '可选的新状态。' },
          result: { type: 'string', description: '可选的结果备注。' },
          assignee: { type: 'string', description: '可选的新负责人。' }
        },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: (input) => act('update_task', input)
    }),

    // ── 等待派发任务完成（rt-12 会话内等待）────────────────
    tool({
      name: 'wait_for',
      description:
        '等待你下发的任务完成，然后汇报结果。用于「告诉我 X 什么时候完成」或「完成后告诉我」。受超时限制。（发完即忘则不需要它——完成会自动播报。）',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要等待的任务 id（或下发关联 id）。' },
          timeoutSeconds: { type: 'number', description: '可选的最长等待秒数（默认 120，最大 600）。' }
        },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: async (input) => {
        try {
          const a = obj(input);
          const taskId = str(a.taskId);
          if (!taskId) return '我需要一个任务 id 才能等待。';
          const secs = typeof a.timeoutSeconds === 'number' && a.timeoutSeconds > 0 ? Math.min(a.timeoutSeconds, 600) : 120;
          const res = await window.cth.realtimeWaitFor(taskId, secs * 1000);
          if (res && 'timedOut' in res && res.timedOut) {
            return `等待之后它仍在运行——它一完成我就会通知你。`;
          }
          return (res && 'summary' in res && res.summary) || '该任务已完成。';
        } catch (e) {
          console.error('[realtime-action] wait_for threw:', e);
          const msg = e instanceof Error ? e.message : 'an unknown error';
          return `我无法等待该任务（${msg}）。`;
        }
      }
    }),

    // ── 破坏性 / 高代价（需要回显确认）─────────────────────
    tool({
      name: 'spawn_agent',
      description:
        '聘用一个新的 agent 工作者（provider 引擎 + 可选角色）。这不是立即执行的；会先请求口头确认。用户确认后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: '引擎：claude（默认）、codex、gemini、opencode、crush、pi、qwen、copilot、cursor。' },
          role: { type: 'string', description: '可选。新 agent 的角色/职责。' },
          name: { type: 'string', description: '可选。该 agent 的名称。' },
          cwd: { type: 'string', description: '可选。工作目录；默认为 hive 根目录。' }
        },
        required: [],
        additionalProperties: false
      },
      execute: (input) => act('spawn', input)
    }),
    tool({
      name: 'kill_agent',
      description:
        '终止一个运行中的 agent（关闭其终端并归档）。破坏性操作——不会立即执行；会返回回显并要求口头确认。用户确认后，调用 confirm_action。禁止杀死 god 编排器或一次性终止所有 agent。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要终止的 agent 名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('kill', input)
    }),
    tool({
      name: 'pause_agent',
      description:
        '暂停一个运行中的 agent（暂停期间不再行动，直到恢复）。破坏性操作——不会立即执行；会返回回显并要求口头确认。用户确认后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要暂停的 agent 名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('pause', input)
    }),
    tool({
      name: 'halt_agent',
      description:
        '让运行中的 agent 停止（强制停止其当前工作）。破坏性操作——不会立即执行；会返回回显并要求口头确认。用户确认后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要停止的 agent 名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('halt', input)
    }),
    tool({
      name: 'edit_schedule',
      description:
        '启用、禁用或删除一个循环调度的任务。破坏性操作——不会立即执行；会返回回显并要求口头确认。用户确认后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: {
          missionId: { type: 'string', description: '要编辑的调度 id 或标签。' },
          action: { type: 'string', enum: ['enable', 'disable', 'delete'], description: '要对它做什么。' }
        },
        required: ['missionId', 'action'],
        additionalProperties: false
      },
      execute: (input) => act('edit_schedule', input)
    }),

    // ── v0.3.4 全控制动词 ─────────────────────────────────
    tool({
      name: 'resume_agent',
      description:
        '恢复一个已暂停或已停止的 agent，让其工具重新运作。软操作——立即执行。这是对 pause_agent / halt_agent 的撤销操作。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要恢复的 agent 名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('resume', input)
    }),
    tool({
      name: 'set_auto_delivery',
      description:
        '暂停或恢复向某个 agent 的自动消息队列投递。暂停 = 队列中的消息会一直等待直到恢复。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'agent 名称或 id。' },
          state: { type: 'string', enum: ['pause', 'resume'], description: 'pause 保持队列挂起；resume 让它继续流动。' }
        },
        required: ['agentId', 'state'],
        additionalProperties: false
      },
      execute: (input) => act('auto_delivery', input)
    }),
    tool({
      name: 'gate_tool',
      description:
        '为某个 agent 封锁（gate）或解除封锁一个指定的工具——例如为 Jim gate Bash。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'agent 名称或 id。' },
          tool: { type: 'string', description: '确切的工具名称，例如 Bash、WebFetch、Edit。' },
          state: { type: 'string', enum: ['gate', 'allow'], description: 'gate 封锁它；allow 移除封锁。' }
        },
        required: ['agentId', 'tool', 'state'],
        additionalProperties: false
      },
      execute: (input) => act('gate_tool', input)
    }),
    tool({
      name: 'delete_task',
      description:
        '按标题或 id 从看板上删除一张任务卡片。软操作——立即执行（若弄错了可重建）。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '要删除的任务标题或 id。' } },
        required: ['taskId'],
        additionalProperties: false
      },
      execute: (input) => act('delete_task', input)
    }),
    tool({
      name: 'unarchive_agent',
      description: '把已归档的 agent 重新带回花名册。软操作——立即执行。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '已归档的 agent 名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('unarchive', input)
    }),
    tool({
      name: 'clear_agent_context',
      description:
        "为某个 agent 排队一次上下文清除（/clear）——抹除其对当前会话的工作记忆；投递会等待该 agent 空闲。破坏性操作——会返回回显并要求口头确认（'clear' 或 'confirm'）。用户确认后，调用 confirm_action。对 god 编排器也允许（它可以恢复其会话）。",
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要清除上下文的 agent 名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('clear_context', input)
    }),
    tool({
      name: 'archive_agent',
      description:
        '归档一个 agent——将其移出战场，历史保留（unarchive 可将其找回）。破坏性操作——会返回回显并要求口头确认。用户确认后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string', description: '要归档的 agent 名称或 id。' } },
        required: ['agentId'],
        additionalProperties: false
      },
      execute: (input) => act('archive', input)
    }),
    tool({
      name: 'create_schedule',
      description:
        '创建一个新的循环调度，按固定间隔向某个 agent 发送消息。破坏性操作——会返回回显并要求口头确认。用户确认后，调用 confirm_action。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '该调度的简短名称。' },
          prompt: { type: 'string', description: '每次触发时 agent 收到的消息。' },
          intervalMinutes: { type: 'number', description: '触发频率，以分钟计（最小 5）。默认 60。' },
          to: { type: 'string', description: '目标 agent 名称或 id。默认：god 编排器。' }
        },
        required: ['label', 'prompt'],
        additionalProperties: false
      },
      execute: (input) => act('create_schedule', input)
    }),
    tool({
      name: 'update_setting',
      description:
        "从允许语音修改的设置列表中修改一个应用设置。外观/低风险键（notifications、officeTheme、terminalTheme、freeflowEnabled、strongKeepalive、autoUpdate、tvShowOffices、realtimeIdleDisconnectMs）立即生效；改变行为的键（autoMode、defaultModel、godProvider、godModel、maxConcurrentWorkers、costCapTokens、maxTurns、slackEnabled、webhookEnabled、semanticMemory、multiWindow）会返回带旧值→新值的回显，需要口头确认（'setting' 或 'confirm'）——然后调用 confirm_action。密钥、文件夹以及任何未列出项都会被拒绝。",
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '确切的设置键，例如 autoMode 或 notifications。' },
          value: { type: 'string', description: '新值：true/false、数字或选项名称。' }
        },
        required: ['key', 'value'],
        additionalProperties: false
      },
      execute: (input) => act('update_setting', input)
    }),

    // ── 确认 / 取消（驱动两阶段提交）───────────────────────
    tool({
      name: 'confirm_action',
      description:
        '提交当前等待确认的破坏性操作，使用用户刚刚说出的确切措辞。仅在破坏性工具返回回显且用户口头确认之后调用。Main 会拒绝一句单纯的「是的」——请传入用户真实说的话。',
      parameters: {
        type: 'object',
        properties: { phrase: { type: 'string', description: '用户实际说出的确认措辞。' } },
        required: ['phrase'],
        additionalProperties: false
      },
      execute: async (input) => {
        if (typeof window.cth?.realtimeActionConfirm !== 'function') {
          console.error('[realtime-action] window.cth.realtimeActionConfirm is not available — restart the app.');
          return '此版本尚不支持语音操作——请尝试重启应用。';
        }
        try {
          const res = await window.cth.realtimeActionConfirm({ phrase: str(obj(input).phrase) });
          if (!res?.ok) console.warn('[realtime-action] confirm rejected: %s', res?.spoken, { input });
          return res?.spoken || '完成。';
        } catch (e) {
          console.error('[realtime-action] confirm threw:', e, { input });
          const msg = e instanceof Error ? e.message : 'an unknown error';
          return `我无法确认该操作（${msg}）。`;
        }
      }
    }),
    tool({
      name: 'cancel_action',
      description: '取消当前等待确认的破坏性操作。当用户拒绝或改变主意时调用。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        try {
          const res = await window.cth?.realtimeActionCancel?.();
          return res?.spoken || '已取消。';
        } catch (e) {
          console.error('[realtime-action] cancel threw:', e);
          return '已取消。';
        }
      }
    })
  ];
}
