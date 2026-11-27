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
      ...[
        'file_path', 'notebook_path', 'path', 'blockedPath', 'paths', 'grantRoot',
        'Path', 'TargetFile', 'targetFile', 'FilePath', 'filePath', 'AbsolutePath', 'absolutePath',
        'SourcePath', 'sourcePath', 'DestinationPath', 'destinationPath',
        'TargetDirectory', 'targetDirectory', 'DirectoryPath', 'directoryPath',
        'SearchDirectory', 'searchDirectory', 'Cwd', 'cwd', 'WorkingDirectory', 'workingDirectory',
      ]
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
  file_change: '修改文件', edit: '编辑文件', edit_file: '编辑文件', multiedit: '编辑文件', write: '写入文件',
  write_file: '写入文件', write_to_file: '写入文件', replace_file_content: '编辑文件', multi_replace_file_content: '编辑文件',
  notebookedit: '编辑笔记本', read: '读取文件', read_file: '读取文件', view_file: '读取文件',
  list_dir: '查看目录', glob: '查找文件', find_by_name: '查找文件', grep: '搜索内容', grep_search: '搜索内容',
  search_web: '网页搜索', read_url_content: '读取网页', manage_task: '任务管理', schedule: '定时任务',
  send_message: '发送消息', invoke_subagent: '调用子代理', generate_image: '生成图像',
};

const DETAIL_WRAPPER_KEYS = new Set([
  'sessionUpdate', 'toolCallId', 'status', 'kind', 'reason', 'rawInput',
  'args', 'input', 'params', 'locations', 'content', 'type', 'name', 'title',
]);

const SENSITIVE_KEY_RE = /(?:^|[_-])(secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|app[_-]?secret|authorization|cookie|set[_-]?cookie|credential|credentials|bearer|auth[_-]?(?:token|key|header|secret))(?:$|[_-])/iu;
const AUTH_SCHEME_VALUE_RE = /^((?:Bearer|Basic)\s+)\S+$/iu;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
  return SENSITIVE_KEY_RE.test(normalized);
}

function redactSensitive(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return AUTH_SCHEME_VALUE_RE.test(trimmed) ? trimmed.replace(AUTH_SCHEME_VALUE_RE, '$1[已脱敏]') : value;
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? '[已脱敏]' : redactSensitive(v, depth + 1);
  }
  return out;
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  const obj = record(value);
  return obj && Object.keys(obj).length > 0 ? obj : undefined;
}

function formatEntryValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const safe = AUTH_SCHEME_VALUE_RE.test(trimmed) ? trimmed.replace(AUTH_SCHEME_VALUE_RE, '$1[已脱敏]') : trimmed;
    return shorten(safe, 400, '…');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(redactSensitive(value));
    if (!serialized || serialized === '{}' || serialized === '[]') return null;
    return shorten(serialized, 400, '…');
  } catch {
    return null;
  }
}

function formatStructuredEntries(obj: Record<string, unknown> | undefined, skip?: ReadonlySet<string>): string[] {
  if (!obj) return [];
  const entries: string[] = [];
  let omitted = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (skip?.has(k)) continue;
    if (v === undefined || v === null) continue;
    const formatted = isSensitiveKey(k) ? '[已脱敏]' : formatEntryValue(v);
    if (!formatted) continue;
    if (entries.length >= 12) {
      omitted += 1;
      continue;
    }
    entries.push(`${k}: ${formatted}`);
  }
  if (omitted > 0) entries.push(`…（其余 ${omitted} 项已省略）`);
  return entries;
}

function extractPrefixedMcpToolName(tool: string, detail?: Record<string, unknown>): string | undefined {
  const candidates = [
    nonblank(detail?.name) ? detail.name.trim() : undefined,
    nonblank(detail?.title) ? detail.title.trim() : undefined,
    stripCardMentions(tool).trim(),
  ].filter(nonblank);
  for (const candidate of candidates) {
    const match = candidate.match(/^(?:Run\s+)?(mcp_[A-Za-z0-9_-]+)$/iu);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function formatPrefixedMcpLabel(raw: string): string {
  const withoutPrefix = raw.replace(/^mcp_/iu, '');
  if (withoutPrefix.startsWith('agy-fast_fast_')) return `MCP · agy-fast/${withoutPrefix.slice('agy-fast_fast_'.length)}`;
  if (withoutPrefix.startsWith('codex-bridge_codex_')) return `MCP · codex/${withoutPrefix.slice('codex-bridge_codex_'.length)}`;
  return `MCP · ${shorten(withoutPrefix, 24, '…')}`;
}

function extractMcpToolName(detail?: Record<string, unknown>): string | undefined {
  if (!detail) return undefined;
  const fields = [detail, record(detail.args), record(detail.input), record(detail.params), record(detail.rawInput)];
  for (const field of fields) {
    if (!field) continue;
    if (nonblank(field.ToolName)) return field.ToolName.trim();
    if (nonblank(field.toolName)) return field.toolName.trim();
  }
  return undefined;
}

function extractToolSummary(detail?: Record<string, unknown>): string | undefined {
  if (!detail) return undefined;
  const fields = [detail, record(detail.args), record(detail.input), record(detail.params), record(detail.rawInput)];
  for (const field of fields) {
    if (!field) continue;
    if (nonblank(field.toolSummary)) return field.toolSummary.trim();
    if (nonblank(field.ToolSummary)) return field.ToolSummary.trim();
  }
  return undefined;
}

function approvalFallbackSummary(detail: Record<string, unknown>, tool: string): { summary: string; compactTarget: string } {
  const fields = [detail, record(detail.args), record(detail.input), record(detail.params), record(detail.rawInput)];
  const server = fields
    .map(f => (nonblank(f?.ServerName) ? f.ServerName : nonblank(f?.serverName) ? f.serverName : nonblank(f?.server) ? f.server : undefined)?.trim())
    .find(Boolean);
  const mcpTool = extractMcpToolName(detail);
  const prefixedMcp = extractPrefixedMcpToolName(tool, detail);
  const toolSummary = extractToolSummary(detail);
  const uri = fields
    .map(f => (nonblank(f?.Uri) ? f.Uri : nonblank(f?.uri) ? f.uri : undefined)?.trim())
    .find(Boolean);
  const mcpArgs = fields.map(f => nonEmptyRecord(f?.Arguments) ?? nonEmptyRecord(f?.arguments)).find(Boolean);
  if (mcpTool || server || uri) {
    const baseHeader = [server, mcpTool].filter(Boolean).join(' / ');
    const header = uri ? (baseHeader ? `${baseHeader} (${uri})` : uri) : baseHeader;
    const lines = formatStructuredEntries(mcpArgs);
    return {
      summary: [header, ...lines].filter(Boolean).join('\n'),
      compactTarget: toolSummary || header || lines[0] || '',
    };
  }
  const title = nonblank(detail.title) ? detail.title.trim() : '';
  const name = nonblank(detail.name) ? detail.name.trim() : '';
  const header = prefixedMcp ? formatPrefixedMcpLabel(prefixedMcp) : (title || name);
  const payloads = [nonEmptyRecord(detail.args), nonEmptyRecord(detail.input), nonEmptyRecord(detail.params), nonEmptyRecord(detail.rawInput)];
  for (const payload of payloads) {
    if (!payload) continue;
    const lines = formatStructuredEntries(payload);
    if (lines.length) {
      const cwd = nonblank(payload.cwd) ? shortenHomePath(payload.cwd.trim()) : '';
      const mcpCompact = toolSummary
        ? (cwd ? `${toolSummary} (${cwd})` : toolSummary)
        : (prefixedMcp && cwd ? `${prefixedMcp} (${cwd})` : '');
      const redundantHeader = !title || title.toLowerCase() === tool.trim().toLowerCase() || title.toLowerCase() === name.toLowerCase();
      return {
        summary: [header, ...(toolSummary ? [`摘要: ${toolSummary}`] : []), ...lines].filter(Boolean).join('\n'),
        compactTarget: mcpCompact || (redundantHeader ? lines[0]! : title),
      };
    }
  }
  const directLines = formatStructuredEntries(detail, DETAIL_WRAPPER_KEYS);
  const redundantHeader = !title || title.toLowerCase() === tool.trim().toLowerCase() || title.toLowerCase() === name.toLowerCase();
  return {
    summary: [header, ...directLines].filter(Boolean).join('\n'),
    compactTarget: toolSummary || (directLines.length && redundantHeader ? directLines[0]! : (header || directLines[0] || '')),
  };
}

function resolveApprovalToolLabel(tool: string, detail?: Record<string, unknown>): string {
  const stripped = stripCardMentions(tool).trim();
  const mcpTool = extractMcpToolName(detail) ?? stripped.match(/(?:^|\s)MCP\s+Tool\s+(\S+)/iu)?.[1];
  if (mcpTool) return `MCP · ${shorten(stripCardMentions(mcpTool).trim(), 20, '…')}`;
  const prefixedMcp = extractPrefixedMcpToolName(tool, detail);
  if (prefixedMcp) return formatPrefixedMcpLabel(prefixedMcp);
  const toolName = stripped.split(/\s+/u)[0] ?? '';
  const key = toolName.toLowerCase();
  if (Object.hasOwn(toolLabels, key)) return toolLabels[key]!;
  if (nonblank(detail?.name)) {
    const detailKey = detail.name.trim().toLowerCase();
    if (Object.hasOwn(toolLabels, detailKey)) return toolLabels[detailKey]!;
  }
  return shorten(toolName, 24, '…') || '工具操作';
}

export function formatApprovalAction(tool: string, action: string, scope: string): {
  toolLabel: string; compactTarget: string; text: string;
} {
  const { detail, prefix } = parseApprovalAction(action);
  const toolLabel = resolveApprovalToolLabel(tool, detail);
  const reason = [detail && prefix, detail?.reason].filter(nonblank).map(stripCardMentions)
    .find(value => /\p{Script=Han}/u.test(value))
    ?? '原端要求人工确认此操作。';
  const isMcpTool = Boolean(detail && (extractMcpToolName(detail) || extractPrefixedMcpToolName(tool, detail)));
  const targets = detail && !isMcpTool ? approvalTargets(detail) : (detail ? [] : [prefix]);
  const rawTargets = targets.join('\n');
  const fallback = !rawTargets && detail ? approvalFallbackSummary(detail, tool) : null;
  const target = rawTargets || fallback?.summary || '';
  const cleanTarget = stripCardMentions(target);
  const compactSource = stripCardMentions(fallback?.compactTarget ?? targets[0] ?? '').trim();
  const lineCount = compactSource.split(/\r\n?|\n/u).length;
  let compactTarget = compactSource;
  if (lineCount > 1) {
    const suffix = `（${lineCount} 行）`;
    const characters = [...compactSource.replace(/\s+/gu, ' ')];
    const limit = 80 - [...suffix].length;
    const preview = characters.length <= limit ? characters.join('')
      : `${characters.slice(0, limit - 13).join('')}…${characters.slice(-12).join('')}`;
    compactTarget = preview + suffix;
  }
  const summary = shorten(cleanTarget, 2000, '\n…（其余内容已省略）')
    .replace(/`{3,}/gu, run => [...run].join('\u200b')) || '原端未提供可展示的操作详情。';
  const duration = scope === 'session' || scope === 'allow_always' ? '本会话内同类操作' : '仅本次操作';
  return {
    toolLabel,
    compactTarget,
    text: [
      `**拦截原因**：${escapeCardMarkdown(shorten(reason.replace(/\s+/gu, ' ').trim(), 600, '…'))}`,
      `**操作内容**：\n\`\`\`\n${summary}\n\`\`\``,
      `**生效范围**：${duration}`,
    ].join('\n\n'),
  };
}
