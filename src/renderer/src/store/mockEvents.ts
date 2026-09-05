// 合成事件流，让头像在等待真实 tmux/hook 接线期间真的会动。

import { useStore, type Agent, type StationKind, type ToolKind } from './store';

const STATION_BY_TOOL: Record<ToolKind, StationKind> = {
  Read: 'shelf', Edit: 'shelf', Write: 'shelf',
  Bash: 'terminal',
  WebFetch: 'web', WebSearch: 'web',
  Grep: 'shelf', Glob: 'shelf',
  TodoWrite: 'board',
  MCP: 'mcp'
};

interface ToolSample {
  tool: ToolKind;
  what: string;            // 简短 —— 用作动作文本
  lines: string[];         // 终端流输出
  thought: string;         // 第一人称助手文本，在侧边栏流式显示
}

const TOOL_SAMPLES: ToolSample[] = [
  {
    tool: 'Read', what: '正在读取 SPEC.md',
    lines: ['\x1b[36m● Read\x1b[0m SPEC.md', '   read 412 lines.'],
    thought: "先翻出规格文档，确认状态机后再动手改实现。"
  },
  {
    tool: 'Edit', what: '正在编辑 PixelPanel.tsx',
    lines: ['\x1b[36m● Edit\x1b[0m src/renderer/src/components/PixelPanel.tsx', '   +14 / -3'],
    thought: "正在收紧面板边框的数学——内缩模式下内描边偏了一个像素。"
  },
  {
    tool: 'Bash', what: '正在运行测试',
    lines: ['\x1b[36m● Bash\x1b[0m npm test', '   ✓ 24 passed'],
    thought: "先跑一遍渲染器测试套件，确保继续之前没有回归。"
  },
  {
    tool: 'WebFetch', what: '正在获取文档',
    lines: ['\x1b[36m● WebFetch\x1b[0m https://docs.example.com/hooks', '   ok 200 (1.2kb)'],
    thought: "翻一下 hooks 文档，核对 PreToolUse 载荷的结构——字段名我记得不太清。"
  },
  {
    tool: 'Glob', what: '正在搜索技能文件',
    lines: ['\x1b[36m● Glob\x1b[0m **/*.skill.md', '   23 matches'],
    thought: "把技能文件全部枚举出来，逐个检查过时的脚本路径。"
  },
  {
    tool: 'TodoWrite', what: '正在更新待办看板',
    lines: ['\x1b[36m● TodoWrite\x1b[0m 4 items'],
    thought: "把剩余工作拆成四个独立任务，好边做边跟踪进度。"
  }
];

function pickSample() {
  return TOOL_SAMPLES[Math.floor(Math.random() * TOOL_SAMPLES.length)];
}

const TICK_MS = 1800;

function stepAgent(agent: Agent) {
  const { updateAgent, pushFeed } = useStore.getState();

  if (agent.status === 'blocked') {
    // 等待用户操作；不要自动移动。
    return;
  }

  // 基于当前状态决策
  if (agent.status === 'idle') {
    // 也许开始一个新任务
    if (Math.random() < 0.4) {
      const sample = pickSample();
      const station = STATION_BY_TOOL[sample.tool];
      updateAgent(agent.id, {
        status: 'thinking',
        action: `正前往 ${station}`,
        currentStation: station,
        progress: 1
      });
    }
    return;
  }

  if (agent.status === 'thinking') {
    // 到达站位——启动工具
    // （真实环境中这会在 PreToolUse 到达时触发）

    const station = agent.currentStation ?? 'desk';
    const tool: ToolKind = station === 'shelf' ? (Math.random() < 0.5 ? 'Read' : 'Edit')
      : station === 'terminal' ? 'Bash'
      : station === 'web' ? 'WebFetch'
      : station === 'board' ? 'TodoWrite' : 'Read';
    const sample = pickSample();
    updateAgent(agent.id, {
      status: 'working',
      action: sample.what,
      carrying: tool,
      progress: Math.min(agent.progress + 1, 8),
      recentAssistantText: sample.thought,
      recentTextTs: Date.now()
    });
    sample.lines.forEach(l => pushFeed(agent.id, l));
    return;
  }

  if (agent.status === 'working') {
    // 结束当前工具：要么继续，要么稳定下来
    if (Math.random() < 0.5) {
      updateAgent(agent.id, {
        status: 'thinking',
        action: '正走回工位',
        currentStation: 'desk',
        progress: Math.min(agent.progress + 1, 8)
      });
    } else {
      // 前往新站位
      const sample = pickSample();
      const station = STATION_BY_TOOL[sample.tool];
      updateAgent(agent.id, {
        status: 'thinking',
        action: `正前往 ${station}`,
        currentStation: station,
        progress: Math.min(agent.progress + 1, 8)
      });
    }
    return;
  }
}

const MOCK_ACTS = ['request', 'inform', 'propose', 'query', 'agree'] as const;

/** 偶尔触发一条合成 agent 间消息，让办公室楼层的信封交接动画在演示模式下
 *  可见（没有真实 `claude` agent 就不会有真实 hive 路由）。场景监听该事件
 *  并在两个头像之间飞一个信封；见 OfficeFloor 的 demo 路径。 */
function maybeFlyMessage(mockIds: string[]): void {
  if (mockIds.length < 2 || Math.random() >= 0.45) return;
  const from = mockIds[Math.floor(Math.random() * mockIds.length)];
  let to = from;
  for (let i = 0; i < 6 && to === from; i++) {
    to = mockIds[Math.floor(Math.random() * mockIds.length)];
  }
  if (to === from) return;
  const act = MOCK_ACTS[Math.floor(Math.random() * MOCK_ACTS.length)];
  window.dispatchEvent(new CustomEvent('cth:demo-handoff', { detail: { from, to, act } }));
}

let interval: number | null = null;

export function startMockLoop() {
  if (interval !== null) return;
  interval = window.setInterval(() => {
    const { agents } = useStore.getState();
    // 只步进 mock agent（没有 ptyId）。真实 agent 由 pty 解析器驱动。
    for (const a of agents) if (!a.ptyId) stepAgent(a);

    const { agents: a2, updateAgent } = useStore.getState();
    for (const a of a2) {
      if (a.ptyId) continue;
      if (a.status === 'thinking' && a.currentStation === 'desk' && Math.random() < 0.4) {
        updateAgent(a.id, {
          status: 'idle',
          action: '等待中',
          carrying: undefined,
          recentAssistantText: '那件事办完了。接下来呢？',
          recentTextTs: Date.now()
        });
      }
    }

    maybeFlyMessage(a2.filter((a) => !a.ptyId).map((a) => a.id));
  }, TICK_MS) as unknown as number;
}

export function stopMockLoop() {
  if (interval !== null) {
    window.clearInterval(interval);
    interval = null;
  }
}
