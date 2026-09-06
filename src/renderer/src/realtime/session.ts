/**
 * Realtime Michael —— 渲染端语音会话（卡片 rt-2，第一阶段 = 只读语音）。
 *
 * 语音编排者在 RENDERER 里跑在 WebRTC 之上，与 OpenAI `gpt-realtime-2`
 * 做语音到语音对话。渲染端从不持有真实 OpenAI 密钥：它请 MAIN 铸造一个
 * 短期的 EPHEMERAL 客户端密钥（`realtime:mintToken`，见
 * src/main/realtime.ts），并用它连接。
 *
 * 我们驱动一个 CUSTOM `OpenAIRealtimeWebRTC` 传输（不是裸 `'webrtc'`
 * 字符串），以便：(a) 自己打开麦克风，带回声消除 + 噪声抑制 + 自动增益
 * （并尊重用户选择的设备——Oscar 的 rt-8 seam），(b) 拥有回放的 <audio>
 * 输出端。轮转使用带插话的语义 VAD（用户打断时模型会截断自己的话）。
 *
 * 第一阶段是只读的 connect→listen→respond 往返。agent 运行 Kevin 的 rt-4
 * 只读工具（get_fleet_status / get_tasks / get_cost / get_triggers /
 * get_config / get_memory / get_activity）和 god 的 rt-6 “Michael” 人设，
 * 因此 agent_tool_start/agent_tool_end 生命周期会触发，麦克风在工具调用
 * 期间静音并在其返回后恢复——这是第一阶段的验收条件。还没有 hive
 * 动作工具（rt-5，暂缓）。
 *
 * 形态镜像 freeflow/recorder.ts：单一模块级会话（同一时刻只有一条语音
 * 循环），通过 `useRealtimeMichael()` hook 经 useSyncExternalStore 暴露。
 *
 * 分支 feat/realtime-michael。见 board.md “🎙 REALTIME MICHAEL”。
 */
import { useSyncExternalStore } from 'react';
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from '@openai/agents-realtime';
import { realtimeReadTools, realtimeSessionSummary } from './tools';
import { realtimeActionTools } from './actions';
import { resetRealtimeCost, recordRealtimeUsage, endRealtimeCost, isRealtimeIdle, getRealtimeCostSnapshot } from './costStore';

/**
 * 语音循环状态机：
 *   off        — 无会话（初始 / 断开后 / 致命错误）
 *   connecting — 铸造 token + 打开 WebRTC 连接
 *   listening  — 已连接，麦克风活跃，等待 / 聆听用户
 *   responding — 模型正在生成 / 播放语音回复
 *   working    — 工具调用进行中；麦克风静音直到它返回
 */
export type RealtimeStatus = 'off' | 'connecting' | 'listening' | 'responding' | 'working';

export interface RealtimeMichaelState {
  status: RealtimeStatus;
  /** 最后一个错误（无密钥、铸造失败、麦克风被拒、传输错误…）。connect 时清除。 */
  error: string | null;
  /** 麦克风当前是否静音（`working` 期间为 true）。 */
  muted: boolean;
  /** 实际使用的实时模型（来自铸造结果的 sessionConfig）。 */
  model: string | null;
  /** 临时 token 的 Unix 秒级过期时间，若 main 报告了的话。 */
  expiresAt: number | null;
  /** 选定的输入设备（Oscar 的设备选择器，rt-8）。null = 系统默认。 */
  deviceId: string | null;
  /** 选定的输出/扬声器设备（Oscar 的扬声器选择器，rt-8）。null = 系统默认。 */
  outputDeviceId: string | null;
}

/** gpt-realtime-2 的声音（看板：Cedar / Marin）。god 在 rt-6 定稿。 */
const REALTIME_VOICE = 'cedar';

/** Michael 在语音会话连接时率先说出的暖场白，让他主动问候用户而不是坐在
 *  沉默里等对方开口。每次连接随机挑一个，让问候有所变化。硬编码常量
 *  （绝非用户/外部文本）——安全原样说出，无需净化。 */
const GREETINGS = [
  "嗨，最近怎么样？",
  "嘿，还好吗？",
  "你好，我能帮你什么？",
  "嘿，我是 Michael——有什么能帮你的？",
  "嗨！今天咱们忙什么？",
  "嘿，很高兴听到你。在想什么？",
  "你好！你需要什么？",
  "嘿，我洗耳恭听——出什么事了？"
];

/** Michael 的语音人设（rt-6 —— 最终的第一阶段指令，由 god 撰写）。Michael
 *  是只读的：他通过 rt-4 只读工具汇报 hive，但还不采取任何行动。 */
const MICHAEL_PERSONA =
  `You are Michael — the voice of the orchestrator ("god") of a hive of autonomous Claude coding agents. The person you're talking to is the human who runs the hive; treat them as the boss you're briefing.

VOICE & STYLE. You speak out loud over a live connection. Be concise and natural — like a sharp, calm chief of staff giving a verbal briefing. Lead with the answer in one sentence, then add detail only if it helps. Never read markdown, file paths, or code aloud unless asked. Use plain spoken numbers and names. Brevity is fine; the human can always ask for more.

WHAT YOU CAN LOOK UP. You have live awareness of the WHOLE hive: a floor snapshot arrives when the call connects, short "(Floor update: …)" notes arrive as things change — trust those first — and your tools cover everything else. ALWAYS call the relevant tool before answering a factual question you can't answer from the snapshot and updates. Your read tools:
- get_floor_state — the live floor in one call: every agent's status, context fill, breaker and inbox, plus in-flight tasks, as precise data. Prefer this for "what's everyone doing".
- get_app_info — the Munder Difflin app itself: its version and the latest release notes. Use for "what version is this" or "what's new in this release".
- get_fleet_status — the live roster: who is active, who the god orchestrator is, and each worker's name, role, and engine.
- list_agents — the FULL roster INCLUDING archived (inactive) agents, with each agent's engine, working directory, context fill, and breaker state. Use it to enumerate everyone, find who is archived, or see who is near their context limit.
- get_agent_detail — everything about ONE agent (by name or id): its engine and model, its WORKING DIRECTORY, whether it's active or archived, live status, how full its context window is, tokens used, breaker state, and whether it has memory.
- get_memory — read the team's memory. You can ALWAYS answer with this: search across everyone, read ONE agent's notes (active OR archived), or search within a single agent. It never dead-ends.
- get_tasks — the kanban board: counts plus the in-progress and blocked cards with their owners.
- get_board — the orchestrator's plan narrative, in prose.
- get_triggers — what fires the hive without a human: today the recurring scheduled missions. Webhooks and inbound organization messages are the other trigger types, but they are configured elsewhere and this tool does not list them.
- get_config — non-sensitive settings (autonomy, default model, caps, breaker, which features are on). Never secrets.
- get_cost — token usage across the hive.
- get_activity — the recent hive activity log: WHAT happened (spawns, archives, messages), as events.
- get_messages — the CONTENT of messages agents sent each other: what was actually said in inboxes and outboxes. Use it to brief the operator on what a message SAID, not just that it happened — read one agent's mailbox, one message by id, or the latest across the floor. Secrets and keys are stripped before you see them, so you can quote bodies safely.

NEVER say "I can't access that", "the tool doesn't allow that", or "I don't have that" BEFORE you have actually CALLED a tool. You CAN read any agent's memory (active OR archived), any agent's working directory, full per-agent status, token usage, context-window fill, schedules, configuration, and the board. When a question is about the hive, call the matching tool FIRST and answer with specific facts — real names, real statuses, real numbers — never a vague guess. Only if a tool genuinely returns nothing do you say so, plainly and briefly.

HIVE VOCABULARY. Agents have an id like "creed-mqp3l5wn" and a friendly name like "Creed"; refer to them by name. "god" is the orchestrator whose voice you are. A card's status is todo, doing, blocked, or done. The circuit breaker is healthy, or steering an agent that's looping or idle. Blocked usually means waiting on the human.

WHAT YOU CAN DO. Beyond reporting, you can ACT on the hive by voice: ping an agent, dispatch a task as a 4-part work order, steer a running agent, create / assign / update / delete task cards, hire a new agent, pause / RESUME / halt / kill agents, pause or resume an agent's message delivery, gate a tool for an agent, archive or unarchive an agent, clear an agent's context, create or edit schedules, and change app settings from the allowed list. Soft actions — ping, dispatch, steer, task edits, resume, delivery pause/resume, tool gating, unarchive, and cosmetic settings — happen immediately. Destructive or expensive ones — hire, kill, pause, halt, archive, clear context, schedule changes, and behavior-changing settings — are NEVER done silently: you read the action back and wait for the human to confirm out loud.

TOOL LATENCY. Tool calls take a moment. When you're about to call one, first say a short natural filler out loud — "let me check the floor", "one second, pulling that up" — then call it. Never sit silent through a look-up, and never invent the result before the tool returns.

CONFIRMATION POLICY (safety-critical). For any destructive or expensive action: (1) call the tool, which returns a spoken echo-back naming the exact action and target; (2) say that echo-back and ASK the human to confirm; (3) only after they clearly confirm — by saying the word "confirm" or the action verb itself, for example "confirm" or "kill", and NEVER just "yes" — call confirm_action with their exact words; (4) if they decline, hesitate, or change the subject, call cancel_action. Never confirm on the human's behalf, never treat a bare "yes" or ambient speech as consent, and if you're unsure whether they really confirmed, ask again rather than acting. Killing, pausing, halting, or archiving the god orchestrator, and acting on all agents at once, are forbidden — if asked, refuse and say why. Clearing the god's context IS allowed, behind the same confirm. Every action you take is attributed to you as michael-voice. Never claim to have done something you didn't, and never invent state.

SHARED FLOOR (you are not the only orchestrator). god — the typing orchestrator — also acts on this hive, and every action you take is announced to god as michael-voice. The task board is the single source of truth. Before you dispatch work, create or assign tasks, or hire, glance at recent activity (your get_activity tool, and the snapshot you were given) so you don't duplicate or contradict something god just did. If you see god already handled what's asked, say so instead of doing it again.

INTERACTION. If a request is ambiguous, briefly confirm what you understood before answering. Keep the human oriented and in control.`;

let state: RealtimeMichaelState = {
  status: 'off',
  error: null,
  muted: false,
  model: null,
  expiresAt: null,
  deviceId: null,
  outputDeviceId: null
};
const listeners = new Set<() => void>();

/** 唯一条活跃会话（同一时刻只有一条语音循环，与 freeflow 的录音器相同）。 */
let session: RealtimeSession | null = null;
/** 我们打开的麦克风流（以便拆除时停止其轨道）。 */
let stream: MediaStream | null = null;
/** Michael 声音的 <audio> 输出端。 */
let audioEl: HTMLAudioElement | null = null;
/** 防止重叠的 connect() 调用竞争异步 mint/connect。 */
let connecting = false;
/** rt-12：完成推送的退订句柄，仅在会话活跃期间启用。 */
let offCompletion: (() => void) | null = null;
let offFloorDelta: (() => void) | null = null;
/** rt-9 成本守卫：周期 tick，在硬性成本上限到达、或空闲麦克风挂起过久时
 *  自动断开（遏制被遗忘会话的失控音频开销）。 */
let costGuardTimer: ReturnType<typeof setInterval> | null = null;
/** 配置缺省时的默认空闲自动断开窗口（毫秒）。从最初的 45 秒提高到 3 分钟，
 *  让正常的思考/阅读停顿不再掉线；用户经 config.realtimeIdleDisconnectMs
 *  调整（或关闭）。 */
const DEFAULT_IDLE_DISCONNECT_MS = 180_000;
const COST_GUARD_TICK_MS = 10_000;

/** N3-seam（rt-10 加固）：完成摘要携带派发目标文本。它 CANNOT 越权——
 *  MAIN 独立门控每个破坏性/禁止操作（Pam 已确认）——但在把它作为系统通知
 *  注入模型之前先中和它（纵深防御）：折叠换行、去掉框住我通知的括号、
 *  移除角色标记 + 经典提示注入开场、并限制长度。Jim 在其发出的摘要上做
 *  匹配的 watcher 侧半边。 */
function sanitizeForVoice(s: string): string {
  return (s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[()]/g, '')
    .replace(/\b(?:ignore|disregard|forget|override)\b[^.!?]*\b(?:previous|above|prior|instruction|system|prompt)\b[^.!?]*/gi, '')
    .replace(/\b(?:system|assistant|developer|user)\s*:/gi, '')
    .replace(/\bnew instructions?\b[^.!?]*/gi, '')
    .replace(/\byou are (?:now )?[^.!?]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function setState(patch: Partial<RealtimeMichaelState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** 把会话生命周期事件挂到我们的状态机上。 */
function wire(s: RealtimeSession): void {
  // 模型开始 / 停止向用户播放语音。
  s.on('audio_start', () => {
    if (state.status !== 'working') setState({ status: 'responding' });
  });
  s.on('audio_stopped', () => {
    // 只有不在工具调用中途时才回退到 listening。
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // 用户盖过模型说话（插话）——semantic_vad 配 interruptResponse 会自动
  // 截断助手回合；我们只反映它。
  s.on('audio_interrupted', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });
  // 回合完全结束——安全重置为 listening（已在则无操作）。
  s.on('agent_end', () => {
    if (state.status !== 'working') setState({ status: 'listening' });
  });

  // 工具调用生命周期：工具运行期间静音麦克风，避免用户盖过副作用，然后
  // 恢复。（第一阶段运行 rt-4 只读工具；rt-5 动作工具自动继承这一点。）
  s.on('agent_tool_start', () => {
    try {
      s.mute(true);
    } catch {
      /* 静音是尽力而为 */
    }
    setState({ status: 'working', muted: true });
  });
  s.on('agent_tool_end', () => {
    try {
      s.mute(false);
    } catch {
      /* 尽力而为 */
    }
    setState({ status: 'listening', muted: false });
  });

  // 传输/模型错误。显示消息；保持连接（会话能从瞬时错误恢复）。硬性
  // 传输掉线由 disconnect() 处理。
  s.on('error', (err) => {
    const e = (err as { error?: unknown })?.error;
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '语音会话出错';
    setState({ error: msg });
  });

  // rt-9 成本表：每次完成的响应在原始传输的 `response.done` 事件上报
  // token 用量。直接交给 Oscar 的成本 store（其规范化器容忍 camel/snake
  // 大小写 + 缺失字段）。尽力而为——绝不弄断循环。
  s.on('transport_event', (event) => {
    try {
      const ev = event as { type?: string; response?: { usage?: unknown } };
      if (ev.type === 'response.done' && ev.response?.usage) {
        recordRealtimeUsage(ev.response.usage as Parameters<typeof recordRealtimeUsage>[0], Date.now());
      }
    } catch {
      /* 计量是尽力而为 */
    }
  });
}

/** 停止麦克风 + 释放音频输出端。可安全重复调用。 */
function teardownMedia(): void {
  if (stream) {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
  }
  stream = null;
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.srcObject = null;
    } catch {
      /* ignore */
    }
  }
  audioEl = null;
}

/** 让 getUserMedia 失败变得可读。 */
function micFriendly(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('permission') || m.includes('notallowed') || m.includes('denied'))
    return 'microphone permission denied — allow mic access to talk to Michael';
  if (m.includes('notfound') || m.includes('device'))
    return 'no microphone found — check your input device';
  return msg;
}

/**
 * 为实时会话打开/关闭主进程麦克风权限闸（Oscar 的 rt-8 闸，
 * src/main/index.ts）。该闸只在 `freeflowEnabled || realtimeVoiceEnabled`
 * 为 true 时授予 getUserMedia，且检查是 SYNCHRONOUS——所以我们必须先把
 * `realtimeVoiceEnabled` 翻成 true 并让它落地，再打开麦克风，然后在拆除/
 * 出错时再翻回 false。（我们刻意不按密钥存在性做闸：OpenAI 密钥与 CLI
 * 引擎共享，那样会给仅 CLI 用户打开麦克风——一个护栏回归。）
 */
async function setMicGate(on: boolean): Promise<void> {
  try {
    await window.cth.updateConfig({ realtimeVoiceEnabled: on });
  } catch {
    /* 若配置写入失败，getUserMedia 会在下面浮出拒绝 */
  }
}

/**
 * 把选定的输出设备应用到我们的 <audio> 输出端（Oscar 的扬声器选择器，
 * rt-8）。`setSinkId` 仅 Chromium/Electron 有、不在每个 lib.dom 里，所以
 * 我们做特性检测 + 收窄类型转换。尽力而为：设备消失或不受支持时停在默认
 * 输出端（传 '' 选择系统默认）。
 */
async function applyOutputSink(el: HTMLAudioElement, deviceId: string | null): Promise<void> {
  const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sink.setSinkId !== 'function') return;
  try {
    await sink.setSinkId(deviceId ?? '');
  } catch {
    /* 设备不可用 / 不受支持——回退到默认输出端 */
  }
}

/**
 * 连接语音循环：铸造临时 token、打开麦克风（EC/NS/AGC）、打开带语义 VAD
 * 轮转的 WebRTC RealtimeSession，并开始聆听。幂等——已在连接/已连接时为
 * no-op。
 */
export async function connect(): Promise<void> {
  if (connecting || (session && state.status !== 'off')) return;
  connecting = true;
  setState({ status: 'connecting', error: null });
  try {
    const mint = await window.cth.realtimeMintToken();
    if (!mint.ok) {
      setState({ status: 'off', error: mint.error });
      return;
    }

    // 在 getUserMedia 之前打开主进程麦克风闸。Oscar 的 rt-8 权限检查是
    // 同步的，所以麦克风打开时 `realtimeVoiceEnabled` 必须已是 true；
    // 拆除/出错时再把它关闭。
    await setMicGate(true);

    // 带回声消除 + 噪声抑制 + 自动增益的麦克风，尊重用户选择的设备
    // （Oscar 的 rt-8 选择器）。getUserMedia 会浮出权限拒绝。
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    if (state.deviceId) audioConstraints.deviceId = { exact: state.deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // 我们自己的 Michael 声音 <audio> 输出端，路由到选定的扬声器（rt-8）。
    audioEl = new Audio();
    audioEl.autoplay = true;
    await applyOutputSink(audioEl, state.outputDeviceId);

    const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audioEl });
    // 热启动：一段简短、尽力而为的 hive 快照，让 Michael 的第一个回答无需
    // 工具往返即有据可依（rt-4 realtimeSessionSummary）。失败返回 '' / 绝不
    // 抛错。
    let warmStart = await realtimeSessionSummary().catch(() => '');
    // rt-12：补上会话未打开期间完成的完成项，让 Michael 能像“我们上次
    // 通话以来”那样在热启动里提到它们（关闭会话队列）。
    try {
      const queued = await window.cth.realtimeDrainCompletions();
      if (Array.isArray(queued) && queued.length) {
        const lines = queued.map((c) => c.summary).filter(Boolean).join(' ');
        if (lines) warmStart = `${warmStart}\nCompletions since you last spoke: ${lines} Mention these to the user when it's natural.`.trim();
      }
    } catch {
      /* 热启动补尽是尽力而为 */
    }
    // v0.3.4：快照不再烘焙进指令——一个字节稳定的人设+工具前缀能在回合和
    // 会话间完全命中提示缓存（缓存输入便宜约 99%）。快照作为下面的第一个
    // conversation item 进入，楼层观察者在通话中追加增量。
    const agent = new RealtimeAgent({
      name: 'Michael',
      instructions: MICHAEL_PERSONA,
      tools: [...realtimeReadTools(), ...realtimeActionTools()]
    });
    const s = new RealtimeSession(agent, {
      transport,
      model: mint.sessionConfig.model,
      config: {
        outputModalities: ['audio'],
        voice: REALTIME_VOICE,
        audio: {
          input: {
            // 自然的回合边界 + 自动插话（被打断时截断）。
            turnDetection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              createResponse: true,
              interruptResponse: true
            }
          },
          output: { voice: REALTIME_VOICE }
        }
      }
    });
    wire(s);

    // 这个临时客户端密钥就是本次连接的 apiKey；真实 OpenAI 密钥永远到不了
    // 渲染端。
    await s.connect({ apiKey: mint.token, model: mint.sessionConfig.model });

    session = s;
    resetRealtimeCost(Date.now()); // rt-9：启动实时会话成本表
    // v0.3.4：静默上下文注入——裸 conversation.item.create，不带
    // response.create，让模型吸收该项而不开口。（此 SDK 版本的 sendMessage
    // 总会触发响应，所以我们下探到传输层走静默路径。）
    const injectSilent = (text: string): void => {
      try {
        s.transport.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }]
          }
        } as never);
      } catch { /* 注入是尽力而为 */ }
    };
    // 连接快照作为第一个 conversation item 进入（下面的问候开启对话；
    // 这只是一个立足点）。
    if (warmStart) {
      injectSilent(`(Floor snapshot at connect — orientation only, call your tools for detail: ${sanitizeForVoice(warmStart)})`);
    }
    // 楼层增量——保持 Michael 画面实时的静默追加，不触碰缓存的指令前缀。
    offFloorDelta = window.cth.onRealtimeFloorDelta?.((d) => {
      if (session !== s) return;
      injectSilent(`(Floor update: ${sanitizeForVoice(d.text)}. Mention it only when relevant — don't interrupt.)`);
    }) ?? null;
    // rt-12：把会话标记为活跃（main 现在改为推送完成项而不是排队），并
    // 订阅，让检测到的完成项让 Michael 不请自来说出来。
    void window.cth.realtimeSetSessionLive(true);
    offCompletion = window.cth.onRealtimeCompletion((c) => {
      try {
        // 作为系统框定的通知喂给它，让模型转述而不是当作用户请求；
        // semantic_vad 不会打断一个活跃回合。N3-seam：注入前净化摘要
        // （纵深防御）。
        session?.sendMessage(
          `(System notification — a task you dispatched just finished: ${sanitizeForVoice(c.summary)}) Briefly let the user know, and offer details if they want them.`
        );
      } catch {
        /* 会话可能正在拆除 */
      }
    });
    // rt-9 成本守卫：周期性地在硬上限被命中、或空闲麦克风挂起过久时停止
    // 会话，免得被遗忘的会话漏掉音频开销。空闲窗口可配置
    // （config.realtimeIdleDisconnectMs；默认 3 分钟；0 = 永不——成本上限
    // 仍是失控守卫）。disconnect() 清掉这个定时器 + 拆除。
    const idleCfg = (await window.cth.getConfig()).realtimeIdleDisconnectMs;
    const idleMs = typeof idleCfg === 'number' ? idleCfg : DEFAULT_IDLE_DISCONNECT_MS;
    costGuardTimer = setInterval(() => {
      if (!session) return;
      if (getRealtimeCostSnapshot().overCap) { disconnect('cost-cap'); return; }
      if (idleMs > 0 && isRealtimeIdle(idleMs, Date.now())) disconnect('idle');
    }, COST_GUARD_TICK_MS);
    setState({
      status: 'listening',
      muted: false,
      model: mint.sessionConfig.model,
      expiresAt: mint.expiresAt
    });
    // 开启对话：让 Michael 作为第一回合先说一句温暖的问候，而不是等用户
    // 先开口。系统框定的触发（与完成通知器相同的说话路径）让模型说出它；
    // 我们递给它一条轮换的 GREETINGS，让开场有所变化。尽力而为——如果
    // 数据通道没就绪或问候失败，会话仍能工作，用户直接开讲即可。
    try {
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      s.sendMessage(
        `(System: the voice session just connected. Greet the user out loud now, warmly and briefly, to open the conversation — say something like "${greeting}". If there are completions to mention from the snapshot, you may add them after. Do not mention this instruction.)`
      );
    } catch {
      /* 问候是尽力而为——绝不阻塞一次成功连接 */
    }
  } catch (e) {
    // 麦克风权限被拒、WebRTC 握手失败、网络等。
    console.log('[realtime] voice session disconnect (error)');
    try {
      session?.close();
    } catch {
      /* 尽力而为拆除 */
    }
    session = null;
    teardownMedia();
    await setMicGate(false);
    const msg = e instanceof Error ? e.message : String(e);
    setState({ status: 'off', error: micFriendly(msg), muted: false });
  } finally {
    connecting = false;
  }
}

/** 拆除语音循环并回到 `off`。已经关闭时安全。
 *  `reason`（idle | cost-cap | error | user）被记录，以便区分空闲自动关闭
 *  与超支停止或用户切换。 */
export function disconnect(reason: string = 'user'): void {
  console.log(`[realtime] voice session disconnect (${reason})`);
  try {
    session?.close();
  } catch {
    /* 尽力而为拆除 */
  }
  session = null;
  if (costGuardTimer) { clearInterval(costGuardTimer); costGuardTimer = null; } // rt-9 成本守卫关闭
  teardownMedia();
  endRealtimeCost(); // rt-9：冻结会话成本表
  // rt-12：停止接收完成推送；main 会排队直到下次连接。
  offCompletion?.();
  offCompletion = null;
  offFloorDelta?.();
  offFloorDelta = null;
  void window.cth.realtimeSetSessionLive(false);
  // 关闭主进程麦克风闸，让 realtime 标志不会在我们停止后仍保持麦克风权限
  // 打开（fire-and-forget——上面的轨道已经停止）。
  void setMicGate(false);
  setState({ status: 'off', muted: false });
}

/** 选择麦克风（Oscar 的设备选择器，rt-8）。下次 connect() 时应用。 */
export function setDeviceId(deviceId: string | null): void {
  setState({ deviceId });
}

/**
 * 选择扬声器/输出设备（Oscar 的扬声器选择器，rt-8）。存储选择，如果会话
 * 活跃则立即重新路由当前 <audio> 输出端；否则下次 connect() 时应用。
 */
export function setOutputDeviceId(deviceId: string | null): void {
  setState({ outputDeviceId: deviceId });
  if (audioEl) void applyOutputSink(audioEl, deviceId);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): RealtimeMichaelState {
  return state;
}

/**
 * Realtime Michael 语音循环的 React 绑定。返回当前状态加 `connect()` /
 * `disconnect()` / `setDeviceId()`。整个渲染端共享同一条会话，所以每个
 * 消费方看到的状态一致。
 */
export function useRealtimeMichael(): RealtimeMichaelState & {
  connect: () => Promise<void>;
  disconnect: () => void;
  setDeviceId: (deviceId: string | null) => void;
  setOutputDeviceId: (deviceId: string | null) => void;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snap, connect, disconnect, setDeviceId, setOutputDeviceId };
}
