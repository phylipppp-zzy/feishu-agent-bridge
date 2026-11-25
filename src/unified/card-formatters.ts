import { homedir } from 'node:os';
import type { ChannelCard } from './feishu-cards.js';
import type { RunStatus, Session, TurnResidual } from './contracts.js';
import { escapeCardMarkdown, stripCardMentions } from './feishu-card-wire.js';

type DisplayStatus = RunStatus | 'completed';
const labels: Record<DisplayStatus, string> = {
  idle: '空闲',
  running: '运行中',
  waiting_approval: '等待审批',
  waiting_question: '等待回答',
  completed: '已完成',
  failed: '执行失败',
  interrupted: '已中断',
  unreachable: '连接不可用',
  read_only: '只读',
};
const templates: Partial<Record<DisplayStatus, ChannelCard['template']>> = {
  running: 'blue',
  waiting_approval: 'orange',
  waiting_question: 'orange',
  completed: 'green',
  failed: 'red',
  interrupted: 'red',
  unreachable: 'red',
  read_only: 'grey',
};

export function sessionStatusLabel(status: DisplayStatus): string {
  return labels[status] ?? '状态未知';
}

export function sessionStatusTemplate(status: DisplayStatus): ChannelCard['template'] {
  return templates[status];
}

export function formatResumeCommand(native: Session['native']): string | null {
  const id = native.nativeSessionId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return null;
  switch (native.provider) {
    case 'codex': return `codex resume ${id}`;
    case 'agy': return `agy --conversation ${id}`;
    case 'claude': return `claude --resume ${id}`;
    default: return null;
  }
}

export function shortenHomePath(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function compactProjectName(project: string): string {
  return project.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.trim() || '项目未知';
}

export function compactCardField(value: string, limit: number): string {
  const characters = [...value.replace(/\s+/gu, ' ').trim()];
  return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : characters.join('');
}

export function formatInterruptedTurn(residual?: TurnResidual): string {
  const complete = residual?.status === 'none' && residual.complete && residual.count === 0;
  const count = residual?.count == null ? '' : `（${residual.count}项）`;
  const text = complete
    ? '本轮已确认中断（未发现残留进程）。'
    : `本轮已确认中断。\n残留核对：${residual?.reason ?? '此 provider 未提供可信残留查询'}${count}`;
  const observedAt = Date.parse(residual?.observedAt ?? '');
  const beijing = new Date(observedAt + 8 * 60 * 60 * 1000);
  return Number.isFinite(beijing.getTime())
    ? `${text}\n核对时间 ${beijing.toISOString().slice(0, 16).replace('T', ' ')} 北京`
    : text;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonblank = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const strings = (value: unknown): string[] => nonblank(value) ? [value] : Array.isArray(value) ? value.filter(nonblank) : [];

function parseApprovalAction(action: string): { detail?: Record<string, unknown>; prefix: string } {
  const text = action.trim();
  // The adapters use a single JSON line, optionally preceded by a multi-line reason.
  const separator = text.lastIndexOf('\n');
  const multiline = text.match(/\n[\t ]*\{/u)?.index;
  for (const start of new Set([0, separator + 1, multiline === undefined ? 0 : multiline + 1])) {
    try {
      const detail = record(JSON.parse(text.slice(start)));
      if (detail) return { detail, prefix: text.slice(0, start).trim() };
    } catch {
      // Older adapters also supplied plain text.
    }
  }
  return { prefix: text };
}

function commandLine(value: unknown): string | undefined {
  if (nonblank(value)) return value;
  if (!Array.isArray(value) || !value.length || !value.every(arg => typeof arg === 'string')) return undefined;
  return value.map(arg => /^[a-zA-Z0-9_./:=+-]+$/u.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
}

function approvalTargets(detail: Record<string, unknown>): string[] {
  const fields = [
    detail,
    record(detail.input),
    record(detail.params),
    record(detail.rawInput),
    record(detail.args),
  ];
  const command = fields.map(field => commandLine(field?.command ?? field?.CommandLine ?? field?.commandLine)).find(Boolean);
  const paths = fields.flatMap(field => {
    if (!field) return [];
    return [
      ...['file_path', 'notebook_path', 'path', 'blockedPath', 'paths', 'grantRoot', 'Path', 'TargetFile']
        .flatMap(key => strings(field[key])),
      ...(Array.isArray(field.locations) ? field.locations.flatMap(location => strings(record(location)?.path)) : []),
      ...(Array.isArray(field.changes) ? field.changes.flatMap(change => {
        const entry = record(change);
        const kind = record(entry?.kind);
        return strings(entry?.path ?? change).concat(
          strings(entry?.movePath), strings(entry?.move_path), strings(kind?.movePath), strings(kind?.move_path),
        );
      }) : []),
    ];
  });
  return [...new Set([...(command ? [command] : []), ...paths])];
}

function shorten(value: string, size: number, suffix: string): string {
  const characters = [...value];
  return characters.length > size ? characters.slice(0, size).join('') + suffix : value;
}

const toolLabels: Record<string, string> = {
  bash: '执行命令', command: '执行命令', execute: '执行命令', run: '执行命令', run_command: '执行命令',
  file_change: '修改文件', edit: '编辑文件', multiedit: '编辑文件', write: '写入文件',
  write_to_file: '写入文件', replace_file_content: '编辑文件', multi_replace_file_content: '编辑文件',
  notebookedit: '编辑笔记本', read: '读取文件', view_file: '读取文件', glob: '查找文件', grep: '搜索内容',
};

export function formatApprovalAction(tool: string, action: string, scope: string): {
  toolLabel: string; text: string;
} {
  const toolName = stripCardMentions(tool).trim().split(/\s+/u)[0] ?? '';
  const key = toolName.toLowerCase();
  const toolLabel = Object.hasOwn(toolLabels, key) ? toolLabels[key]! : shorten(toolName, 24, '…') || '工具操作';
  const { detail, prefix } = parseApprovalAction(action);
  const reason = [detail && prefix, detail?.reason].filter(nonblank).map(stripCardMentions)
    .find(value => /\p{Script=Han}/u.test(value))
    ?? '原端要求人工确认此操作。';
  const target = detail ? approvalTargets(detail).join('\n') : prefix;
  const summary = shorten(stripCardMentions(target), 400, '\n…（其余内容已省略）')
    .replace(/`{3,}/gu, run => [...run].join('\u200b')) || '原端未提供可展示的操作详情。';
  const duration = scope === 'session' ? '本会话内同类操作' : '仅本次操作';
  return {
    toolLabel,
    text: [
      `**拦截原因**：${escapeCardMarkdown(shorten(reason.replace(/\s+/gu, ' ').trim(), 400, '…'))}`,
      `**操作内容**：\n\`\`\`\n${summary}\n\`\`\``,
      `**生效范围**：${duration}`,
    ].join('\n\n'),
  };
}
