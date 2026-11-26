import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PlatformObservation } from './adapter.js';
import type { NativeSessionRef, Turn } from './contracts.js';

const phases = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type ToolPhase = typeof phases[number];
export interface ToolProgress {
  turnId: string;
  callId: string;
  phase: ToolPhase;
  tool: string;
  summary: string;
}

export const isTerminalTool = (phase: ToolPhase): boolean => phase !== 'pending' && phase !== 'running';
export const isTerminalTurn = (status: Turn['status'] | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'interrupted';

export function nativeTimestamp(value: unknown, unit: 'auto' | 'ms' = 'auto'): string | null {
  if (typeof value === 'number') {
    const ms = unit === 'auto' && value < 1e11 ? value * 1000 : value;
    return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function short(value: string, limit: number): string {
  const chars = [...value];
  return chars.length <= limit ? value : chars.slice(0, limit - 1).join('') + '…';
}
const toolName = (name: unknown): string =>
  typeof name === 'string' && /^[\w.:-]{1,48}$/.test(name) ? name : 'tool';
const inputObject = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};

function displayPath(value: unknown, project?: string): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f<>\x60$=]/.test(value)) return '';
  let path = value.trim();
  if (!path || path.includes('://')) return '';
  if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
  if (!isAbsolute(path)) return short(path.replace(/^\.\//, ''), 120);
  for (const root of [project, homedir()]) {
    if (!root || !isAbsolute(root)) continue;
    const local = relative(root, path);
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep)) {
      return short(root === project ? local : '~/' + local, 120);
    }
  }
  return short(basename(path), 120);
}

/** Shell input can include credentials, interpolated values, or entire scripts.
 * Render only recognized command intents and omit arbitrary arguments. */
function commandSummary(value: unknown): string {
  const script = Array.isArray(value) && value.length === 3 && typeof value[0] === 'string' && /^(?:.*\/)?(?:bash|sh|zsh)$/.test(value[0]) &&
    (value[1] === '-c' || value[1] === '-lc') ? value[2] : value;
  if (typeof script !== 'string') return '';
  const words = script.trimStart().slice(0, 512).split(/[\s;&|<>()]+/);
  const [program = '', task = ''] = words;
  const executable = basename(program);
  const safeTasks: Record<string, string[]> = {
    npm: ['test', 'run', 'install', 'ci'], pnpm: ['test', 'run', 'install'],
    yarn: ['test', 'run', 'install'], git: ['status', 'diff', 'log', 'show', 'add', 'commit', 'push'],
    python: ['-m'], python3: ['-m'], docker: ['build', 'run', 'ps'],
  };
  if (['cat', 'ls', 'pwd', 'rg', 'pytest', 'make', 'node', 'tsc', 'bash', 'sh', 'curl', 'uv', 'cargo'].includes(executable)) {
    return executable;
  }
  if (Object.hasOwn(safeTasks, executable)) {
    if (executable === 'npm' && task === 'run' && ['check', 'build', 'test', 'lint'].includes(words[2] ?? '')) {
      return `npm run ${words[2]}`;
    }
    return safeTasks[executable]!.includes(task) ? `${executable} ${task}` : executable;
  }
  return '';
}

function safeLabel(value: unknown, limit = 48): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned ? short(cleaned, limit) : '';
}

function summarizeSpecialTool(tool: string, data: Record<string, unknown>): string | null {
  switch (tool) {
    case 'swarm': {
      const action = safeLabel(data.action, 24);
      const name = safeLabel(data.name, 28);
      const title = safeLabel(data.title, 40);
      if (action === 'add') return `🐝 Swarm 启动成员${name ? `：${name}` : ''}`;
      if (action === 'title') return `🐝 Swarm 命名${title ? `：${title}` : ''}`;
      if (action === 'status') return '🐝 Swarm 检查成员状态';
      if (action === 'kill') return `🐝 Swarm 结束成员${name ? `：${name}` : ''}`;
      if (action === 'model') return `🐝 Swarm 切换模型${name ? `：${name}` : ''}`;
      if (action === 'models') return '🐝 Swarm 查询模型配额';
      return action ? `🐝 Swarm · ${action}` : '🐝 Swarm 协作';
    }
    case 'swarm_wait':
      return '🐝 Swarm 等待成员回报';
    case 'post_message':
      return '🐝 Swarm 协作板发帖';
    case 'read_board':
      return '🐝 Swarm 读取协作板';
    case 'invoke_subagent': {
      const role = safeLabel(data.Role ?? data.TypeName, 36);
      return `🤖 派发子代理${role ? `：${role}` : ''}`;
    }
    case 'manage_subagents':
      return '🤖 管理子代理';
    case 'send_message':
      return '🤖 通知子代理';
    case 'run_workflow': {
      const desc = safeLabel(data.Description, 40);
      return `⚙️ 运行工作流${desc ? `：${desc}` : ''}`;
    }
    case 'schedule':
      return '⏰ 设置定时/等待任务';
    case 'call_mcp_tool': {
      const name = data.ToolName ?? data.tool_name;
      const server = data.ServerName ?? data.server_name;
      if (server === 'codex-bridge_codex' || typeof name === 'string' && name.startsWith('codex_')) {
        const { tier, action, job_id: jobId } = inputObject(data.Arguments ?? data.arguments);
        const safeTier = tier === 'sol' || tier === 'astra' || tier === 'astra-deep' || tier === 'luna' ? tier : '';
        const labels: Record<string, string> = {
          codex_engineer: '工程实现',
          codex_review: '代码审查',
          codex_followup: '续接会话',
          codex_lookup: '低成本检索',
          codex_status: '状态查询',
        };
        const label = name === 'codex_job' ? (action === 'wait' ? '等待作业' : action === 'cancel' ? '取消作业' : '查询作业') :
          typeof name === 'string' && Object.hasOwn(labels, name) ? labels[name] : '工具调用';
        const job = typeof jobId === 'string' && /^(?:(?:job-(?:\d{8}-\d{6}-)?)?[a-f\d]{8}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(jobId)
          ? ` …${jobId.slice(-8)}` : '';
        return `⚡ Codex MCP (${[safeTier, label].filter(Boolean).join(' · ')}${job})`;
      }
      const mcpTool = safeLabel(name, 40);
      return `🔌 MCP${mcpTool ? `：${mcpTool}` : ''}`;
    }
    case 'ask_question':
      return '❓ 等待用户回答';
    case 'search_web': {
      const q = safeLabel(data.query, 36);
      return `🌐 联网检索${q ? `：${q}` : ''}`;
    }
    default:
      return null;
  }
}

export function summarizeTool(name: unknown, input: unknown, project?: string): Pick<ToolProgress, 'tool' | 'summary'> {
  const tool = toolName(name);
  const data = inputObject(input);
  const special = summarizeSpecialTool(tool, data);
  if (special) return { tool, summary: short(special, 120) };
  const detail = commandSummary(data.command ?? data.CommandLine) ||
    displayPath(data.file_path ?? data.path ?? data.TargetFile ?? data.FilePath ?? data.Path ?? data.AbsolutePath ?? data.DirectoryPath, project);
  return { tool, summary: short(detail ? `${tool} · ${detail}` : tool, 120) };
}

export function readToolProgress(value: unknown): ToolProgress | undefined {
  const { turnId, callId, phase, tool, summary } = inputObject(value);
  if (typeof turnId !== 'string' || !turnId || turnId.length > 512 ||
      typeof callId !== 'string' || !callId || callId.length > 512 ||
      !phases.includes(phase as ToolPhase) || typeof tool !== 'string' || toolName(tool) !== tool ||
      typeof summary !== 'string' || !summary || [...summary].length > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(summary)) return;
  return { turnId, callId, phase: phase as ToolPhase, tool, summary };
}

/** One tracker per native connection or active turn. A richer same-phase update
 * replaces its summary without adding a second execution record. */
export class ToolProgressTracker {
  private readonly calls = new Map<string, ToolProgress>();
  clear(): void { this.calls.clear(); }

  observe(ref: NativeSessionRef, generation: number, turnId: string, callId: string, phase: ToolPhase,
    detail?: Pick<ToolProgress, 'tool' | 'summary'>): PlatformObservation | undefined {
    const key = JSON.stringify([ref.nativeSessionId, generation, turnId, callId]);
    const prior = this.calls.get(key);
    if (prior && (isTerminalTool(prior.phase) && phase !== prior.phase || prior.phase === 'running' && phase === 'pending')) return;
    const genericMcp = detail?.tool === 'call_mcp_tool' && detail.summary === '🔌 MCP' && prior?.tool === detail.tool;
    const description = !detail || genericMcp || prior && detail.summary === detail.tool &&
      (prior.tool !== 'tool' || detail.tool === 'tool') ? prior : detail;
    const data = readToolProgress({
      turnId, callId, phase, tool: description?.tool ?? 'tool', summary: description?.summary ?? 'tool',
    });
    if (!data || prior?.phase === phase && prior.tool === data.tool && prior.summary === data.summary) return;
    this.calls.delete(key);
    this.calls.set(key, data);
    if (this.calls.size > 4096) this.calls.delete(this.calls.keys().next().value!);
    const eventId = randomUUID(), now = new Date().toISOString();
    return { type: 'event', ref, connectionGeneration: generation, event: {
      schemaVersion: 1, eventId, sessionId: ref.nativeSessionId, objectId: callId, objectRevision: 0,
      sequence: 0, type: 'tool.updated', occurredAt: now, receivedAt: now, operationId: null, cursor: eventId, data,
    } };
  }
}

const codexTools: Record<string, string> = {
  commandExecution: 'Bash', fileChange: 'edit_file', mcpToolCall: 'mcp_tool',
  dynamicToolCall: 'dynamic_tool', webSearch: 'web_search', imageView: 'view_image',
  imageGeneration: 'image_generation', collabAgentToolCall: 'agent_tool',
};

export function codexToolProgress(item: Record<string, unknown>, completed: boolean, project?: string) {
  if (typeof item.type !== 'string' || !Object.hasOwn(codexTools, item.type) ||
    typeof item.id !== 'string' || !item.id) return;
  const name = typeof item.tool === 'string' ? item.tool : codexTools[item.type];
  const change = Array.isArray(item.changes) ? inputObject(item.changes[0]) : {};
  const detail = summarizeTool(name, { command: item.command, path: change.path ?? item.path }, project);
  const phase: ToolPhase = !completed ? 'running' :
    item.status === 'failed' || item.status === 'declined' || item.success === false ||
    item.error != null || typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'failed' :
    item.status === 'cancelled' || item.status === 'interrupted' ? 'cancelled' : 'succeeded';
  return { callId: item.id, phase, detail };
}

export function agyToolProgress(call: Record<string, unknown>, project?: string, initial = false) {
  const phase = new Map<unknown, ToolPhase>([
    ['pending', 'pending'], ['in_progress', 'running'], ['completed', 'succeeded'],
    ['failed', 'failed'], ['cancelled', 'cancelled'],
  ]).get(call.status ?? (initial ? 'pending' : null));
  if (!phase) return;
  const kind = call.kind;
  const name = call.name ?? (kind === 'execute' ? 'Bash' : kind === 'read' ? 'read_file' :
    kind === 'edit' ? 'edit_file' : kind === 'search' ? 'search' : kind);
  const input = inputObject(call.rawInput);
  const location = Array.isArray(call.locations) ? inputObject(call.locations[0]) : {};
  return { phase, detail: summarizeTool(name, { ...input, path: input.path ?? location.path }, project) };
}
