import type { ModelOption, Provider } from './contracts.js';
import { providerTitlePrefix, type ChannelCard } from './feishu-cards.js';

export interface ModelCardTaskScope {
  taskId: string;
  rootGeneration: number;
  activeRevision: number;
  targetId: string;
  targetGeneration: number;
  sessionId: string;
}

const AGY_CURATED_ORDER: ReadonlyArray<{ id: string; tag: string }> = [
  { id: 'gemini-4-carbon', tag: '深度推理' },
  { id: 'gemini-4-neon', tag: '均衡推荐' },
  { id: 'gemini-4-hydrogen', tag: '轻量快速' },
];

const AGY_CURATED_RANK = new Map(AGY_CURATED_ORDER.map((item, idx) => [item.id, idx]));
const AGY_CURATED_TAG = new Map(AGY_CURATED_ORDER.map((item) => [item.id, item.tag]));

export function buildMainHelpCard(): ChannelCard {
  return {
    title: '帮助',
    text: [
      '主群常用入口：',
      '• /sessions — 查看并打开已有会话',
      '• /new — 新建会话（Antigravity / Codex / Claude）',
      '• /task <标题> — 新建多后端任务话题',
      '• /health — 查看服务健康状态',
      '',
      '发送 /help admin 查看运维与调试命令。',
    ].join('\n'),
    actions: [
      { label: '会话列表', value: { action: 'list' } },
      { label: '新建会话', value: { action: 'new_help' } },
    ],
  };
}

export function buildAdminHelpCard(): ChannelCard {
  return {
    title: '帮助 · 运维管理',
    text: [
      '运维与调试命令：',
      '• /health — 查看各后端与通道健康状态',
      '• /pending — 查看待完成操作',
      '• /panel — 打开当前会话控制面板',
      '• /unbind — 解除当前话题的会话绑定',
      '• /export — 导出当前会话历史为 Markdown 文件',
    ].join('\n'),
    actions: [],
  };
}

export function buildSessionHelpCard(
  provider: Provider,
  accessMode: 'read_only' | 'interactive',
): ChannelCard {
  const name = providerTitlePrefix(provider);
  const lines: string[] = [`${name} 会话工作区命令：`, `• 直接发送消息 — 与 ${name} 对话`];
  if (provider === 'agy') {
    lines.push('• /swarm <任务目标> — 启动多 Agent 协同模式');
  }
  lines.push('• /model — 查看或切换模型与推理强度');
  if (provider === 'codex') {
    lines.push('• /steer <补充> — 向当前唯一运行轮追加引导输入');
  }
  lines.push(
    '• /stop — 中断当前回复',
    '• /ls — 浏览项目目录文件',
    '• /file — 查看并下载会话产物文件',
    '• /history — 查看会话历史',
  );
  const actions: ChannelCard['actions'] = [];
  if (accessMode === 'read_only') {
    lines.push('', '当前话题为只读镜像，点击下方按钮可一键接入并续聊。');
    actions.push({ label: '一键接入并续聊', value: { action: 'upgrade' } });
  }
  return {
    title: `帮助 · ${name}`,
    text: lines.join('\n'),
    actions,
  };
}

export function buildTaskTopicHelpCard(activeProvider?: Provider | null): ChannelCard {
  const header = activeProvider
    ? `任务话题命令（当前活跃后端：${providerTitlePrefix(activeProvider)}）：`
    : '任务话题命令：';
  return {
    title: '帮助 · 任务话题',
    text: [
      header,
      '• 直接发送消息 — 向当前活跃后端对话',
      '• /task — 打开任务面板并切换后端目标',
      '• /handoff <目标ID> — 预览并交接上下文到另一后端',
      '• /model — 查看或切换当前后端模型',
      '• /swarm <任务目标> — 在 Antigravity 目标下启动多 Agent 协同',
      '• /stop — 中断当前回复',
      '• /ls / /file — 浏览项目文件与会话产物',
    ].join('\n'),
    actions: [],
  };
}

export function buildMainChatTopicOnlyGuidanceCard(isSwarm = false): ChannelCard {
  const text = isSwarm
    ? '该命令需要在具体会话话题中使用（仅 Antigravity 交互会话支持 /swarm）。请先发送 /sessions 打开已有会话，或发送 /new 新建会话。'
    : '该命令需要在具体会话话题中使用。请先发送 /sessions 打开已有会话，或发送 /new 新建会话。';
  return {
    title: '请在会话话题中使用',
    text,
    actions: [
      { label: '会话列表', value: { action: 'list' } },
      { label: '新建会话', value: { action: 'new_help' } },
    ],
  };
}

export function buildSwarmReadOnlyAgyCard(): ChannelCard {
  return {
    title: '无法直接启动 /swarm',
    text: '此 Antigravity 话题当前为只读镜像，无法直接启动 /swarm。点击下方按钮一键接入后即可使用。',
    actions: [{ label: '一键接入并续聊', value: { action: 'upgrade' } }],
  };
}

export function buildSwarmUnsupportedCard(): ChannelCard {
  return {
    title: '当前会话不支持 /swarm',
    text: '当前会话不支持 /swarm（仅 Antigravity 交互会话支持）。可在主群发送 /new 新建 Antigravity 会话。',
    actions: [],
  };
}

export function sortCuratedModels(provider: Provider, items: readonly ModelOption[]): ModelOption[] {
  if (provider !== 'agy') return [...items];
  return items
    .map((item, idx) => ({ item, idx, rank: AGY_CURATED_RANK.get(item.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.idx - b.idx))
    .map((entry) => entry.item);
}

export function formatCuratedModelLabel(provider: Provider, model: ModelOption): string {
  if (provider === 'agy') {
    const tag = AGY_CURATED_TAG.get(model.id);
    if (tag) return `${model.label} · ${tag}`;
  }
  return model.label;
}

export function buildModelsCard(options: {
  provider: Provider;
  items: readonly ModelOption[];
  nextCursor?: string | null;
  confirmed?: { model: string | null; preferences: Record<string, string> } | null;
  revision: number;
  controlGeneration: number;
  readOnly?: boolean;
  title?: string;
  taskScope?: ModelCardTaskScope;
}): ChannelCard {
  const ordered = sortCuratedModels(options.provider, options.items);
  const scopeExtra = options.taskScope ? { ...options.taskScope } : {};
  const actions: ChannelCard['actions'] = [];

  if (!options.readOnly) {
    for (const m of ordered) {
      const displayLabel = formatCuratedModelLabel(options.provider, m);
      if (m.reasoningEfforts?.length) {
        for (const effort of m.reasoningEfforts) {
          actions.push({
            label: `${displayLabel} / ${effort}`,
            value: {
              action: 'settings',
              model: m.id,
              preferences: { reasoningEffort: effort },
              revision: options.revision,
              controlGeneration: options.controlGeneration,
              ...scopeExtra,
            },
          });
        }
      } else {
        actions.push({
          label: displayLabel,
          value: {
            action: 'settings',
            model: m.id,
            preferences: {},
            revision: options.revision,
            controlGeneration: options.controlGeneration,
            ...scopeExtra,
          },
        });
      }
    }
  }

  if (options.nextCursor) {
    actions.push({
      label: '下一页',
      value: {
        action: 'models',
        cursor: options.nextCursor,
        ...scopeExtra,
      },
    });
  }

  const lines: string[] = [];
  if (options.confirmed !== undefined) {
    lines.push(
      options.confirmed
        ? `已提交的下一轮设置（请求值）：${options.confirmed.model ?? '默认'}${options.confirmed.preferences.reasoningEffort ? ' / ' + options.confirmed.preferences.reasoningEffort : ''}；实际模型与强度以原生运行结果及策略为准。`
        : '尚无已提交的下一轮设置；实际模型与强度以原生运行结果及策略为准。',
    );
  }
  if (options.readOnly) {
    lines.push('当前目标为只读模式，无法切换模型。');
  }
  if (ordered.length) {
    for (const m of ordered) {
      const displayLabel = formatCuratedModelLabel(options.provider, m);
      lines.push(
        `${displayLabel}${m.reasoningEfforts?.length ? '：' + m.reasoningEfforts.join('、') : ''}`,
      );
    }
  } else {
    lines.push('暂无可选模型。');
  }

  return {
    title: options.title ?? '模型',
    text: lines.join('\n'),
    actions,
  };
}
