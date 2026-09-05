import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { ProviderLogo } from './ProviderLogo';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import { type AccentColorName } from '@/design/tokens';
import type { HireManifest } from '@shared/hire';
import { hireQueueProgress } from '@shared/hireQueue';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import {
  OSS_LOCAL_PICKS,
  OSS_PROVIDER_PICKS,
  localSlugFor,
  hasOssQuickPicks,
  OSS_BLOG_LINKS
} from '@shared/ossModels';
import {
  type AgentProvider,
  type HarnessConfig,
  AGENT_PROVIDER_PRESETS,
  buildSpawnCommand,
  tokenizeCommand,
  modelsForProvider,
  inferAgentProvider,
  providerPreset,
  isClaudeProvider
} from '@/store/config';
import { useRtl } from '@/i18n/useDirection';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

// OSS 快速选择芯片样式 (ondev-c) —— 与模型选择器芯片保持一致。
const ossChip = (active: boolean, accent: AccentColorName): CSSProperties => ({
  padding: '3px 8px 1px',
  background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
  boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12,
  color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
});
const ossGroupHead: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 4
};
const ossLink: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

// 一键简报模板 —— 用一句精炼、开箱即用的角色描述填充「描述 + 目标」，
// 避免用户面对空白字段（第 7 项）。模板 BRIEFINGS 保持英文（它们会成为
// 代理提示词 —— 参见 i18n 报告）；只有选择器标签被翻译。
const DESCRIPTION_TEMPLATES: { labelKey: string; description: string; goal: string }[] = [
  {
    labelKey: 'addAgent.templatesHint.repoJanitor.label',
    description: '让代码库保持整洁健康',
    goal: '持续寻找死代码、lint 错误、不稳定测试和小型安全重构。修复安全的部分，对有风险的部分留备注。未经标注不改变行为。'
  },
  {
    labelKey: 'addAgent.templatesHint.docsWriter.label',
    description: '让文档与代码保持同步',
    goal: '关注使 README 和文档过时的代码变更并及时更新。面向新人写作，多用具体示例，少用空泛叙述。'
  },
  {
    labelKey: 'addAgent.templatesHint.bugTriager.label',
    description: '调查并定位 bug 根因',
    goal: '对每个报告的问题：先复现，再定位根因，然后提出带证据的最小修复。未确认根因不修复。'
  },
  {
    labelKey: 'addAgent.templatesHint.researchAssistant.label',
    description: '收集并汇总信息',
    goal: '对给出的问题跨多个来源进行研究，核实关键结论，返回简洁、有引用的摘要。'
  },
  {
    labelKey: 'addAgent.templatesHint.releaseManager.label',
    description: '准备并发布版本',
    goal: '追踪自上次发布以来上线的内容，更新变更日志和版本号，起草清晰的发布说明。'
  }
];

// 用户交给任意 AI 以生成 hire 清单（hire manifest）的复制粘贴提示词。它固定了
// 导入器接受的确切 JSON 结构，并以需要填写的段落收尾，让用户补充自己的细节
// （第 7 项）。与 HireManifest 模式保持同步（src/shared/hire.ts）——provider
// 白名单是 claude | codex | kimi | qwen。
const HIRE_PROMPT = `你正在设计一个 "hire"——为 Munder Difflin（一个运行一组 CLI 编码代理的应用）准备一个可直接生成（spawn）的 AI 代理。只输出一个 JSON 对象（hire manifest），除此之外什么都不输出。

让这个代理真正有用：给它一个鲜明的角色、一个具体的长驻目标，以及一段能让它表现得像其 CLI 引擎（Claude Code、Codex、Kimi Code 或 Qwen Code）专家操作者的描述。它应当知道如何使用终端、读写文件、运行和检查命令、善用可用的 skills 与 MCP 工具、在 memory 里做笔记，并在无人手把手的情况下自主朝目标工作。

返回 EXACTLY 这个结构（省略你不需要的可选字段；保持 spec 字符串原样）：

{
  "spec": "munder-difflin/hire@1",
  "name": "Jim",
  "description": "一行角色说明——这个代理是干什么的",
  "goal": "注入到每次提示的长驻指令——具体且以结果为导向",
  "provider": "claude",
  "model": "claude-opus-4-8[1m]",
  "capabilities": ["code-review", "docs"],
  "isolate": false,
  "tokenCap": 2000000,
  "author": "你的名字"
}

规则：
- "provider" 必须是以下之一：claude | codex | kimi | qwen。"model" 必须是该 provider 的真实模型 id（例如 claude-opus-4-8[1m]、gpt-5.6-luna、kimi-code/k3、qwen3-coder-plus）。
- 不要包含 shell 命令或这些字段之外的任何标志。
- 让 "description" + "goal" 足够具体，使代理在第一个回合就知道该做什么。

--- 在下方补充你的细节（AI 应使用这些） ---
角色 / 我希望这个代理做什么：
首选引擎（claude / codex / kimi / qwen），如果有的话：
要遵守的仓库、工具、风格或约束：
`;

// 「添加代理」表单有 11+ 个字段，因此按分区组织，用户通过左侧栏索引在各区之间
// 跳转（一次只显示一个区）。Engine 承载 Command（它是由 provider+model+flags
// 组装出的 spawn 命令）；Workspace 把 Folder + Git isolation + Resume 聚合在一起
// （都是「在哪里/如何运行」）。Capabilities 在这里不是字段——它来自导入的 hire
// 清单（固定在顶部的横幅）。
type SectionKey = 'identity' | 'workspace' | 'engine' | 'briefing';
const SECTIONS: { key: SectionKey; labelKey: string; hintKey: string }[] = [
  { key: 'identity',  labelKey: 'addAgent.sections.identity.label',  hintKey: 'addAgent.sections.identity.hint' },
  { key: 'workspace', labelKey: 'addAgent.sections.workspace.label', hintKey: 'addAgent.sections.workspace.hint' },
  { key: 'engine',    labelKey: 'addAgent.sections.engine.label',    hintKey: 'addAgent.sections.engine.hint' },
  { key: 'briefing',  labelKey: 'addAgent.sections.briefing.label',  hintKey: 'addAgent.sections.briefing.hint' }
];

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
}

export interface AddAgentModalProps {
  onClose: () => void;
  config: HarnessConfig;
  /** 把配置变更（例如从本弹窗注册的项目）提升回 App，让其余 UI——以及本弹窗
   *  下次打开时——都能看到它们。 */
  onConfigChange?: (config: HarnessConfig) => void;
}

export function AddAgentModal({ onClose, config, onConfigChange }: AddAgentModalProps) {
  const { t: tr } = useTranslation();
  const rtl = useRtl();
  const addAgent = useStore(s => s.addAgent);
  // 深链接和文件批次共用同一个 FIFO。只有队首会填充表单；每个条目仍然需要
  // 显式的 spawn 或跳过。
  const hireQueue = useStore(s => s.hireQueue);
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const finishPendingHire = useStore(s => s.finishPendingHire);
  const pendingHire = hireQueue.pending[0];
  const reviewProgress = hireQueueProgress(hireQueue);

  const knownCharacter = (c?: string): OfficeCharacterName =>
    (OFFICE_CAST.some(m => m.name === c) ? (c as OfficeCharacterName) : DEFAULT_CHARACTER);
  const knownAccent = (a?: string): AccentColorName =>
    (ACCENTS.includes(a as AccentColorName) ? (a as AccentColorName) : 'sky');
  /** 输入的名字所对应的剧组成员（如果有）。
   *
   *  角色方块已经会设置名字（点击 Meredith 会把代理命名为 Meredith），但
   *  这种耦合是单向的，所以输入 "Meredith" 时头像仍停留在之前选中的角色上，
   *  实际是 Jim 默认。这与 issue #191 是同一缺失默认值的另一个方向——那里
   *  是省略 `character` 的清单总是落到 Jim。
   *
   *  无匹配时返回 null，调用方不去动头像，因此刻意选择的头像不会被继续输入
   *  覆盖。 */
  const characterForName = (n: string): OfficeCharacterName | null => {
    const q = n.trim().toLowerCase();
    if (!q) return null;
    const hit = OFFICE_CAST.find(c => c.displayName.toLowerCase() === q || c.name === q);
    return hit ? hit.name : null;
  };
  /** 为清单本地构建的 spawn 命令：来自本地配置构建器的 provider 预设 + model，
   *  并追加清单中已验证的 flags。清单永远不能自行指定二进制程序。 */
  const hireCommand = (m: HireManifest): string => {
    const prov: AgentProvider = m.provider ?? inferAgentProvider(config.defaultCommand);
    const base = buildSpawnCommand(config, m.model, prov);
    return m.commandFlags?.length ? `${base} ${m.commandFlags.join(' ')}` : base;
  };

  // 默认 provider 跟随全局默认命令（除非用户重新配置，否则是 claude）；
  // 只有 Claude 会继承模型。
  const initialProvider = inferAgentProvider(config.defaultCommand);
  const initialModel = isClaudeProvider(initialProvider) ? config.defaultModel : undefined;

  const [name, setName] = useState(pendingHire?.name ?? 'Jim');
  const [character, setCharacter] = useState<OfficeCharacterName>(knownCharacter(pendingHire?.character));
  const [accent, setAccent] = useState<AccentColorName>(knownAccent(pendingHire?.accent));
  const [cwd, setCwd] = useState<string>(config.registeredRepos[0] ?? '');
  // 已注册项目的本地镜像，这样从这里添加的项目会立即显示为快速选项
  // （`config` prop 是打开时拍摄的快照）。
  const [repos, setRepos] = useState<string[]>(config.registeredRepos);
  const [provider, setProvider] = useState<AgentProvider>(pendingHire?.provider ?? initialProvider);
  const [model, setModel] = useState<string | undefined>(
    pendingHire ? pendingHire.model : initialModel
  );
  const [command, setCommand] = useState(
    pendingHire ? hireCommand(pendingHire) : buildSpawnCommand(config, initialModel, initialProvider)
  );
  const [description, setDescription] = useState(pendingHire?.description ?? 'a fresh harness');
  const [hireMeta, setHireMeta] = useState<HireManifest | null>(pendingHire);

  // 选择模型会重建命令；命令字段对高级用户保持可编辑（它才是实际 spawn 的
  // 事实来源）。
  const pickModel = (id?: string) => {
    setModel(id);
    setCommand(buildSpawnCommand(config, id, provider));
  };
  // 切换 provider 会把模型重置为该 CLI 的默认值，并从 provider 的预设二进制
  // 重建命令（所以 Antigravity spawn `agy`、Codex spawn `codex`，而不是配置的
  // `claude`）。对于 'custom'，我们保留用户输入的命令而不是清空它。
  const pickProvider = (id: AgentProvider) => {
    setProvider(id);
    // 预填模型：Claude 用全局 defaultModel；其他引擎用 Settings → AI Engines
    // 中按引擎设置的默认值（providerDefaultModels），否则用 CLI 默认值。
    // 这正是让那个 Settings 字段生效的关键（Dwight NIT-1）。
    const nextModel = isClaudeProvider(id) ? config.defaultModel : config.providerDefaultModels?.[id];
    setModel(nextModel);
    const nextPreset = providerPreset(id);
    if (!isClaudeProvider(id) && !nextPreset.resumeFlag && !nextPreset.resumeSubcommand) {
      setResumeSessionId('');
      setFolderNote(undefined);
    }
    if (id === 'custom') {
      setCommand(command.trim() || config.defaultCommand || '');
      return;
    }
    setCommand(buildSpawnCommand(config, nextModel, id));
  };
  const preset = providerPreset(provider);
  const [goal, setGoal] = useState(pendingHire?.goal ?? '');
  const [isolate, setIsolate] = useState(pendingHire?.isolate ?? false);
  // #2 —— 可选的、用于继续的 Claude session id。设置后，spawn 会把该会话的
  // 转录写入 cwd 的项目目录，并以 `--resume` 启动。
  const [resumeSessionId, setResumeSessionId] = useState('');
  const resuming = resumeSessionId.trim().length > 0;
  // 当文件夹由粘贴的 session id 自动填充时显示的提示。
  const [folderNote, setFolderNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // 左侧栏索引当前显示的是哪个配置区。
  const [section, setSection] = useState<SectionKey>('identity');
  // 「用 AI 生成 hire」辅助——显示一段复制粘贴提示词（第 7 项）。
  const [showHirePrompt, setShowHirePrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const copyHirePrompt = async () => {
    try {
      await navigator.clipboard.writeText(HIRE_PROMPT);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
    } catch { /* 剪贴板被阻止 —— 下方的 textarea 可选作后备 */ }
  };

  // Esc 只关闭本弹窗。Capture 可以阻止全屏终端的窗口级处理器也去关闭下面的
  // 视图。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // 零步骤恢复：输入 session id 后，从转录中查它最初运行所在的 cwd，并预填
  // Folder，这样用户不必自己去找 worktree。之后仍可覆盖文件夹。在 blur 时运行，
  // 避免每次按键都触发解析器。
  const resolveFolderFromSession = async () => {
    const sid = resumeSessionId.trim();
    if (!sid) { setFolderNote(undefined); return; }
    const resolved = await window.cth.resolveSessionCwd(sid);
    if (resolved) { setCwd(resolved); setFolderNote(tr('addAgent.folderFromSession', { path: resolved })); }
    else setFolderNote(undefined);
  };

  const pickFolder = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setCwd(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** 立即把 `path` 注册为项目（文件夹快速选项）：去重后前插、选中它、持久化到
   *  配置，并把变更提升上去使其生效。 */
  const registerProject = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    const next = [p, ...repos.filter((r) => r !== p)];
    setRepos(next);
    setCwd(p);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      // Main 在持久化 registeredRepos 时会展开 `~`，所以要采纳存储后的
      // （绝对路径）列表——否则输入的 "~/dev/foo" 在本弹窗的状态里保持字面值，
      // 并跟着进入 spawn。
      const stored = updated.registeredRepos ?? next;
      setRepos(stored);
      if (stored[0]) setCwd(stored[0]);
      onConfigChange?.(updated);
    } catch { /* 尽力持久化 */ }
  };

  /** 从项目快速选项中去掉 `path`。
   *
   *  只是从列表中移除。磁盘上的文件夹绝不被触碰，这正是要点：用完的项目应该
   *  停止占据选择器，而不删除任何东西。 */
  const unregisterProject = async (path: string) => {
    const next = repos.filter((r) => r !== path);
    setRepos(next);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      setRepos(updated.registeredRepos ?? next);
      onConfigChange?.(updated);
    } catch { /* 尽力持久化 */ }
  };

  /** 一步完成：挑选一个全新的文件夹并把它注册为项目。 */
  const addProject = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) await registerProject(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** 把导入的清单应用到每个表单字段（文件导入路径）。命令从 provider 预设 +
   *  已验证的 flags 在本地重建——清单永远无法注入 spawn 二进制。导入从不
   *  spawn。 */
  const applyManifest = (m: HireManifest) => {
    setHireMeta(m);
    setName(m.name);
    // 清单若指定了代理名却省略 `character`，应获得匹配的头像而不是 Jim 默认
    // 头像（issue #191）。
    setCharacter(m.character ? knownCharacter(m.character) : (characterForName(m.name ?? '') ?? knownCharacter(undefined)));
    setAccent(knownAccent(m.accent));
    setProvider(m.provider ?? initialProvider);
    setModel(m.model);
    setCommand(hireCommand(m));
    setDescription(m.description ?? 'a fresh harness');
    setGoal(m.goal ?? '');
    setIsolate(m.isolate ?? false);
    setResumeSessionId('');
    setFolderNote(undefined);
    setSection('identity');
  };

  // 推进批次时会保持本弹窗挂载。当队列头变化时重新填充每个表单字段，这样在
  // 审查一个 hire 时所做的编辑不会泄漏到下一个。
  useLayoutEffect(() => {
    if (pendingHire) applyManifest(pendingHire);
  // applyManifest 有意闭包捕获这个已打开弹窗使用的配置快照；队列推进不会
  // 替换该快照。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHire]);

  const advanceHireReview = () => {
    const next = hireQueue.pending[1];
    // pendingHire effect 会用新的队首重新填充每个表单字段。
    finishPendingHire();
    if (!next) onClose();
  };

  const importHire = async () => {
    setError(undefined);
    const res = await window.cth.importHireFiles();
    if (res.manifests.length > 0) enqueuePendingHires(res.manifests);
    if (res.errors.length > 0) {
      setError(`已跳过 ${res.errors.length} 个无效文件: ${res.errors.join(' · ')}`);
    } else if (!res.ok && res.error && res.error !== 'cancelled') {
      setError(res.error);
    }
  };

  const skipHire = () => {
    if (!pendingHire) return;
    setError(undefined);
    advanceHireReview();
  };

  const submit = async () => {
    setError(undefined);
    // 必填字段可能位于用户尚未打开的分区，所以在提示错误的同时跳到出问题的
    // 分区——该字段绝不会被隐藏。
    if (!name.trim()) { setError(tr('addAgent.errName')); setSection('identity'); return; }
    if (!cwd) { setError(tr('addAgent.errFolder')); setSection('workspace'); return; }
    if (!command.trim()) { setError(tr('addAgent.errCommand')); setSection('engine'); return; }

    setBusy(true);
    const id = uniqueId(name);
    const ptyId = `pty-${id}`;
    // 把可编辑的命令字段拆成 argv 风格的片段交给 node-pty。
    // 感知引号，这样类似 "Gemini 3.1 Pro (High)" 的 agy 模型标签——或命令上
    // 追加的任何 auto-mode flags——仍作为单个参数。
    const [exe, ...args] = tokenizeCommand(command.trim());
    const spawnRes = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      provider,
      args,
      cols: 100,
      rows: 30,
      // 设置后，主进程会在自己的 git worktree 中 spawn 该代理。
      // 恢复会话时强制关闭——`--resume` 需要真实 cwd 的转录，而不是一个带
      // 不同（空）项目目录的全新 worktree。
      isolate: resuming ? false : isolate,
      // #2 —— 在此代理的 cwd 中继续一个已有的 Claude 会话。
      resumeSessionId: resuming ? resumeSessionId.trim() : undefined,
      // 在 hive 中为这个代理做供给（memory + mailbox + identity/protocol）。
      hive: {
        id,
        name: name.trim(),
        provider,
        cwd,
        role: description.trim() || undefined,
        // hire 清单可能携带已验证的 capability 标签（路由提示）。
        capabilities: hireMeta?.capabilities
      }
    });
    if (!spawnRes.ok) {
      setBusy(false);
      setError(spawnRes.error ?? '生成失败');
      return;
    }
    // #2 —— 请求的 resume session id 在哪里都找不到；main 回退到了全新会话。
    // 不阻塞 spawn，但要让它可见。
    if (resuming && spawnRes.resumeNotFound) {
      console.warn(`[add-agent] resume session "${resumeSessionId.trim()}" not found — started a fresh session`);
    }

    // Main 在接收时展开 `~`，并回显它实际 spawn 进的绝对路径——记录那个路径，
    // 这样该代理的 cwd 与 hive 注册表一致（并且重启后仍然有效，因为重启后
    // 没有任何东西会重新展开它）。
    const spawnedCwd = spawnRes.cwd || cwd;
    // 启用 git isolation 时，代理在自己的 worktree 中运行，但其 PROJECT 仍然是
    // 用户挑选的文件夹。用 worktree 的名字标记代理只是可见的一半；有害的一半是
    // 把那个 worktree 提升进下面的 registeredRepos，导致项目快速选项变成一列
    // 一次性的 worktree。与发送给 main 的 `isolate` 保持一致，后者在恢复会话时
    // 被强制关闭。
    const projectCwd = (!resuming && isolate) ? cwd.trim() : spawnedCwd;
    const agent: Agent = {
      id,
      name: name.trim(),
      character,
      accent,
      description: description.trim() || 'a fresh harness',
      project: basename(projectCwd),
      tmuxTarget: '',
      cwd: spawnedCwd,
      goal: goal.trim() || undefined,
      status: 'idle',
      action: resuming && spawnRes.resumeNotFound ? '会话不存在——全新开始' : '正在启动',
      progress: 0,
      currentStation: 'desk',
      ptyId,
      command: command.trim(),
      provider,
      model,
      // 持久化解析出的 worktree 路径（仅当 isolation 确实供给了一个时才设置），
      // 以便重启后能重新进入这个确切的 worktree——参见 restoreTeam。
      worktreePath: spawnRes.worktreePath,
      // Crush（seedDelivery:'type-into-tui'）把它的 hive 协议交回这里，而不是放在
      // argv 上；useHive 会在启动后把它输入到 TUI 中。(ondev-b)
      seedPrompt: spawnRes.seedPrompt,
      recentTextTs: Date.now()
    };
    addAgent(agent);
    // 为下一次 hire 记住这个文件夹：把它提升到 registeredRepos 快速选项的最前
    // （弹窗的默认 cwd），这样连续 hire 会落在同一项目里，无需重新挑选。
    if (projectCwd && repos[0] !== projectCwd) {
      const nextRepos = [projectCwd, ...repos.filter((r) => r !== projectCwd && r !== cwd)];
      try {
        const updated = await window.cth.updateConfig({ registeredRepos: nextRepos });
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    // hire 清单可能携带按代理计算的 token 预算——把它应用到 main 中最新的
    // agentTokenCaps 映射。推进批次前要 await 它：下一个 hire 会复用这个挂载中
    // 的弹窗，绝不能与过期的配置写入竞争。
    if (hireMeta?.tokenCap) {
      try {
        const updated = await window.cth.setAgentTokenCap(id, hireMeta.tokenCap);
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    setBusy(false);
    if (pendingHire) {
      advanceHireReview();
    } else {
      onClose();
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // 必须位于全屏终端/文件浮层（250/280）及其悬停弹出层之上。全屏的「添加代理」
        // 按钮也使用这同一个弹窗。
        zIndex: 500
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 940, maxWidth: '95vw' }}>
        <PixelPanel
          variant="dialog"
          title={tr('addAgent.title')}
          style={{ padding: 16 }}
          noPadding
        >
          {/* 带左侧边栏索引的分区配置。表单有 11+ 个字段，因此按 4 个区块
              （身份 / 工作区 / 引擎 / 简报）分组，一次只显示一个；侧边栏在
              它们之间跳转。hire 导入审核横幅、错误信息和底部操作区固定
              在区块面板四周。maxHeight 让对话框保持在视口内
              （标题栏保持固定）。 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, maxHeight: '86vh', overflowY: 'auto' }}>
            {hireMeta && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-lemon-light, #fdf3cf)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontSize: 12,
                color: 'var(--cth-ink-900)',
                display: 'flex', flexDirection: 'column', gap: 2
              }}>
                <span>
                  📋 {tr('addAgent.hireImported')} <strong>{hireMeta.name}</strong>
                  {hireMeta.author ? <> · {tr('addAgent.byAuthor', { author: hireMeta.author })}</> : null}
                  {reviewProgress ? <> · {tr('addAgent.hireProgress', { current: reviewProgress.current, total: reviewProgress.total })}</> : null}
                </span>
                <span>{tr('addAgent.reviewFields')}</span>
                {hireMeta.commandFlags && hireMeta.commandFlags.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>{tr('addAgent.hireFlags')}</span>
                    {hireMeta.commandFlags.map((f, i) => (
                      <code
                        key={`${f}-${i}`}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-paprika-light, #f6d3c4)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {f}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.skills && hireMeta.skills.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>{tr('addAgent.hireSkills')}</span>
                    {hireMeta.skills.map((s) => (
                      <code
                        key={s}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-mint-light, #d0f0e0)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-mint-700, #1f7a4d)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {s}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.mcpServers && hireMeta.mcpServers.length > 0 && (() => {
                  const safe = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier === 'safe-readonly'
                  );
                  const consent = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier !== 'safe-readonly'
                  );
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
                      {safe.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>{tr('addAgent.mcpSafe')}:</span>
                          {safe.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-sky-light, #d0e8f8)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-sky-700, #1f5a8a)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                        </span>
                      )}
                      {consent.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>{tr('addAgent.mcpConsent')}:</span>
                          {consent.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-paprika-light, #f6d3c4)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
                            {tr('addAgent.mcpEnableInSettings')}
                          </span>
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* 侧边栏索引 + 当前活动区块的字段 */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* 左侧 —— 区块索引。Capabilities 不是导航项：它不是用户字段，
                  它随导入的 hire manifest 一起带入（见上方横幅）。 */}
              <nav style={{ width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {SECTIONS.map((s, i) => {
                  const active = section === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => setSection(s.key)}
                      style={{
                        textAlign: 'left', padding: '6px 9px 5px', border: 'none', cursor: 'pointer',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                          : 'inset 0 0 0 1px var(--cth-ink-100)',
                        display: 'flex', flexDirection: 'column', gap: 1
                      }}
                    >
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '13px',
                        color: 'var(--cth-ink-900)', textTransform: 'uppercase',
                        display: 'flex', alignItems: 'baseline', gap: 6
                      }}>
                        <span style={{ color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)' }}>{i + 1}</span>
                        {tr(s.labelKey)}
                      </span>
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                        {tr(s.hintKey)}
                      </span>
                    </button>
                  );
                })}
              </nav>

              {/* 右侧 —— 当前活动区块的字段 */}
              <div style={{ flex: 1, minWidth: 0, minHeight: 260, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {section === 'identity' && (
                  <>
                    <Row label={tr('addAgent.name')}>
                      <input
                        value={name}
                        onChange={(e) => {
                          const next = e.target.value;
                          setName(next);
                          const match = characterForName(next);
                          if (match) setCharacter(match);
                        }}
                        placeholder={tr('addAgent.namePlaceholder')}
                        style={inputStyle}
                      />
                    </Row>

                    <Row label={tr('addAgent.character')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {OFFICE_CAST.map(c => (
                          <button
                            key={c.name}
                            onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                            title={c.blurb}
                            style={{
                              padding: 4,
                              background: character === c.name ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                              boxShadow: character === c.name
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                : 'inset 0 0 0 1px var(--cth-ink-100)',
                              cursor: 'pointer',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                              border: 'none', width: 56
                            }}
                          >
                            <div style={{ width: 44, height: 56, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                              <SpritePortrait character={c.name} scale={2} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                          </button>
                        ))}
                      </div>
                    </Row>

                    <Row label={tr('addAgent.color')}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {ACCENTS.map(a => (
                          <button
                            key={a}
                            onClick={() => setAccent(a)}
                            style={{
                              width: 32, height: 32,
                              background: `var(--cth-${a})`,
                              boxShadow: accent === a
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
                                : 'inset 0 0 0 1px var(--cth-ink-300)',
                              cursor: 'pointer',
                              border: 'none'
                            }}
                            aria-label={a}
                          />
                        ))}
                      </div>
                    </Row>
                  </>
                )}

                {section === 'workspace' && (
                  <>
                    <Row label={tr('addAgent.project')}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          {repos.length > 0 ? tr('addAgent.pickProject') : tr('addAgent.noProjects')}
                        </span>
                        <button
                          onClick={addProject}
                          title={tr('addAgent.addProjectTitle')}
                          style={{
                            flexShrink: 0, padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> {tr('addAgent.addProject')}
                        </button>
                      </div>
                      {repos.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          {repos.map((r) => (
                            /* 每个 chip 两个按钮：选择该项目，或把它从这个列表中去掉。
                               嵌套在 span 里而不是用一个按钮，这样移除控件不会
                               成为按钮里的按钮。 */
                            <span
                              key={r}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'stretch',
                                background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: cwd === r
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)'
                              }}
                            >
                              <button
                                onClick={() => setCwd(r)}
                                title={r}
                                style={{
                                  padding: '3px 4px 1px 8px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                {basename(r)}
                              </button>
                              <button
                                onClick={() => unregisterProject(r)}
                                title={`Remove ${basename(r)} from this list. The folder itself is left alone.`}
                                aria-label={`Remove ${basename(r)} from the project list`}
                                style={{
                                  padding: '3px 6px 1px 2px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  lineHeight: 1,
                                  color: 'var(--cth-ink-500)',
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={cwd}
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder={tr('addAgent.projectPlaceholder')}
                          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                        />
                        <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <Icon name="folder" /> {tr('addAgent.pick')}
                          </span>
                        </PixelButton>
                      </div>
                      {cwd.trim() && !repos.includes(cwd.trim()) && (
                        <button
                          onClick={() => registerProject(cwd)}
                          title={tr('addAgent.saveAsProjectTitle')}
                          style={{
                            alignSelf: 'flex-start', marginTop: 2,
                            padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> {tr('addAgent.saveAsProject')}
                        </button>
                      )}
                    </Row>

                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: resuming ? 'not-allowed' : 'pointer', opacity: resuming ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={resuming ? false : isolate}
                        disabled={resuming}
                        onChange={(e) => setIsolate(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: resuming ? 'not-allowed' : 'pointer' }}
                      />
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                        {tr('addAgent.gitIsolation')}
                      </span>
                    </label>

                    <Row label={tr('addAgent.resumeSession')}>
                      <input
                        value={resumeSessionId}
                        onChange={(e) => { setResumeSessionId(e.target.value); setFolderNote(undefined); }}
                        onBlur={resolveFolderFromSession}
                        placeholder={tr('addAgent.resumePlaceholder')}
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                      />
                      {folderNote && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-mint, var(--cth-ink-700))' }}>
                          {folderNote}
                        </span>
                      )}
                      {resuming && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                          {tr('addAgent.resumeNote')}
                        </span>
                      )}
                    </Row>
                  </>
                )}

                {section === 'engine' && (
                  <>
                    <Row label={tr('addAgent.provider')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {AGENT_PROVIDER_PRESETS.map((p) => {
                          const active = provider === p.id;
                          return (
                            <button
                              key={p.id}
                              onClick={() => pickProvider(p.id)}
                              title={
                                p.id === 'codex'
                                  ? tr('addAgent.providerCodex')
                                    : p.id === 'custom'
                                      ? tr('addAgent.providerCustom')
                                      : p.label
                              }
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none',
                                display: 'inline-flex', alignItems: 'center', gap: 6
                              }}
                            >
                              <ProviderLogo provider={p.id} size={14} />
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>

                    {preset.supportsModel && <Row label={tr('addAgent.model')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(() => {
                          // 导入的 hire 可能指定比此选择器硬编码列表更新的模型（例如
                          // claude-fable-5）。把它作为一张真实选中的卡片展示出来，而
                          // 不是让选择器看起来像没设置——无论如何命令字段都已承载它。
                          const known = modelsForProvider(provider);
                          return model && !known.some((m) => m.id === model)
                            ? [...known, { id: model, label: tr('addAgent.fromHire', { model }) }]
                            : known;
                        })().map((m) => {
                          const active = (model ?? '') === (m.id ?? '');
                          return (
                            <button
                              key={m.label}
                              onClick={() => pickModel(m.id)}
                              title={m.id ?? tr('addAgent.cliDefaultModel')}
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                              }}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>}

                    {/* OSS 模型快速选择 (ondev-c) —— 来自已验证目录的本地 + 第三方提供方
                        候选清单。点击会设置引擎正确的 slug（OpenCode `local/<tag>`、Crush/pi
                        `ollama/<tag>`；provider slug 在各引擎间一致）
                        并重建命令。 */}
                    {hasOssQuickPicks(provider) && (
                      <Row label={tr('addAgent.ossModels')}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div>
                            <div style={ossGroupHead}>{tr('addAgent.ossLocal')}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_LOCAL_PICKS.map((p) => {
                                const slug = localSlugFor(provider, p.tag);
                                const active = (model ?? '') === slug;
                                return (
                                  <button
                                    key={p.tag}
                                    onClick={() => pickModel(slug)}
                                    title={tr('addAgent.ossLocalTitle', { slug, ram: p.minRam, tag: p.tag })}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <div style={ossGroupHead}>{tr('addAgent.ossByok')}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_PROVIDER_PICKS.map((p) => {
                                const active = (model ?? '') === p.slug;
                                return (
                                  <button
                                    key={p.slug}
                                    onClick={() => pickModel(p.slug)}
                                    title={tr('addAgent.ossByokTitle', { slug: p.slug, keyEnv: p.keyEnv })}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </Row>
                    )}

                    {(provider === 'qwen') && (
                      <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px', margin: '2px 0 6px' }}>
                        {tr('addAgent.byokNote')}
                        {' '}
                        <a
                          href={OSS_BLOG_LINKS.openModels}
                          onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.openModels); }}
                          style={ossLink}
                        >{tr('addAgent.runOnOpenModels')}</a>
                        {' '}
                        <a
                          href={OSS_BLOG_LINKS.macMini}
                          onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.macMini); }}
                          style={ossLink}
                        >{tr('addAgent.setUpMacMini')}</a>.
                      </div>
                    )}

                    <Row label={config.autoMode && preset.autoFlag ? tr('addAgent.commandAuto') : tr('addAgent.command')}>
                      <input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder={
                          provider === 'codex'
                              ? 'codex'
                              : provider === 'custom'
                                ? 'your-agent-cli'
                                : 'claude'
                        }
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                      />
                    </Row>
                  </>
                )}

                {section === 'briefing' && (
                  <>
                    <Row label={tr('addAgent.templates')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {DESCRIPTION_TEMPLATES.map((t) => (
                          <button
                            key={t.labelKey}
                            onClick={() => { setDescription(t.description); setGoal(t.goal); }}
                            title={t.goal}
                            style={{
                              padding: '3px 8px 1px',
                              background: 'var(--cth-cream-100)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                              color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                            }}
                          >
                            {tr(t.labelKey)}
                          </button>
                        ))}
                      </div>
                    </Row>

                    <Row label={tr('addAgent.description')}>
                      <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={tr('addAgent.descriptionPlaceholder')}
                        style={inputStyle}
                      />
                    </Row>

                    <Row label={tr('addAgent.goal')}>
                      <textarea
                        dir={rtl ? 'auto' : undefined}
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        placeholder={tr('addAgent.goalPlaceholder')}
                        rows={2}
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'none' }}
                      />
                    </Row>
                  </>
                )}
              </div>
            </div>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            {/* 导入 hire 说明 + AI 提示词生成器（第 7 项） */}
            <div style={{
              padding: '8px 10px',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
                  {tr('addAgent.importHireDesc')}
                </span>
                <button
                  onClick={() => setShowHirePrompt((v) => !v)}
                  style={{
                    flexShrink: 0,
                    padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                    background: showHirePrompt ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                  }}
                >
                  {showHirePrompt ? tr('addAgent.hideAIPrompt') : tr('addAgent.generateWithAI')}
                </button>
              </div>
              {showHirePrompt && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
                    {tr('addAgent.aiPromptHint')}
                  </span>
                  <textarea
                    readOnly
                    value={HIRE_PROMPT}
                    onFocus={(e) => e.currentTarget.select()}
                    rows={10}
                    style={{
                      ...inputStyle,
                      width: '100%',
                      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
                      resize: 'vertical', background: 'var(--cth-paper-100)'
                    }}
                  />
                  <div>
                    <PixelButton variant="secondary" size="sm" onClick={copyHirePrompt}>
                      {copiedPrompt ? tr('addAgent.copied') : tr('addAgent.copyPrompt')}
                    </PixelButton>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton
                variant="secondary"
                size="md"
                onClick={importHire}
                disabled={busy}
                title={tr('addAgent.importHireBtnTitle')}
              >
                {tr('addAgent.importHireBtn')}
              </PixelButton>
              <div style={{ flex: 1 }} />
              {pendingHire && (
                <PixelButton variant="secondary" size="md" onClick={skipHire} disabled={busy}>{tr('addAgent.skipHire')}</PixelButton>
              )}
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>{tr('common.cancel')}</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? tr('addAgent.spawning') : tr('addAgent.spawn')}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}
