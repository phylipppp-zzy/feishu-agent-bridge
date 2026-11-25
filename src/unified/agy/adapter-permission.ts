import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { evaluateApproval, resolveApprovalFacts, type ApprovalRequest, type ApprovalScope, type GateDecision } from '../approval-policy.js';
import { payloadDigest } from '../contracts.js';
import { isRecord, isString, type Obj } from './adapter-types.js';

const commandTools = new Set(['execute', 'run_command']);
const readTools = new Set(['read', 'read_file', 'view_file', 'list_directory', 'list_dir', 'search', 'grep_search']);
const autoAllowReadOnlyTools = new Set([
  'search_web',
  'list_resources',
  'read_resource',
  'codex_lookup',
  'codex_status',
  'codex_job',
]);
const mcpWrapperTools = new Set(['call_mcp_tool', 'mcp_call', 'use_mcp_tool']);
const destructiveTools = new Set(['delete', 'delete_file', 'move', 'move_file', 'rename', 'rename_file']);
const writeTools = new Set([
  'edit', 'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file',
  ...destructiveTools,
]);
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const pathKeys = [
  'Path', 'path', 'TargetFile', 'targetFile', 'FilePath', 'filePath', 'AbsolutePath', 'absolutePath',
  'SourcePath', 'sourcePath', 'DestinationPath', 'destinationPath', 'TargetDirectory', 'targetDirectory',
  'DirectoryPath', 'directoryPath', 'SearchDirectory', 'searchDirectory',
];
const cwdKeys = ['Cwd', 'cwd', 'WorkingDirectory', 'workingDirectory'];
const commandKeys = ['CommandLine', 'commandLine'];
const identityKeys = ['name', 'toolName', 'kind'];
const inputGroups = ['rawInput', 'args'];
const envelopeStrings = new Set(['toolCallId', ...identityKeys]);
const displayUpdates = new Set(['sessionUpdate', 'title', 'status']);
const conflicts = Symbol('conflicting tool call fields');
type MergedToolCall = Obj & { [conflicts]?: true };
const reservedOptions = new Set(['allow_always', 'reject_always', 'allow_once', 'reject_once']);

export function hasAgyToolCallConflicts(toolCall: MergedToolCall): boolean {
  return toolCall[conflicts] === true;
}

export function agyApprovalFingerprint(toolCall: Obj): string {
  return payloadDigest(Object.fromEntries(Object.entries(toolCall).filter(([key]) => !displayUpdates.has(key))));
}

export function mergeAgyToolCall(previous: MergedToolCall | undefined, update: Obj): MergedToolCall {
  if (!previous) return update;
  const merged: MergedToolCall = { ...previous, ...update };
  for (const key of Object.keys(update)) {
    const oldFields = previous[key];
    const newFields = update[key];
    if (inputGroups.includes(key) && isRecord(oldFields) && isRecord(newFields)) {
      if (Object.entries(newFields).some(([field, value]) =>
        Object.hasOwn(oldFields, field) && !isDeepStrictEqual(oldFields[field], value))) merged[conflicts] = true;
      merged[key] = { ...oldFields, ...newFields };
    } else if (!displayUpdates.has(key) &&
        Object.hasOwn(previous, key) && !isDeepStrictEqual(oldFields, newFields)) {
      merged[conflicts] = true;
    }
  }
  return merged;
}

function uniqueOptionId(raw: Obj[], option: Obj | undefined): string | null {
  const id = option?.optionId;
  return isString(id) && raw.filter(row => row.optionId === id).length === 1 ? id : null;
}

export function agyOnceOption(options: unknown, kind: 'allow_once' | 'reject_once'): string | null {
  const raw = Array.isArray(options) ? options.filter(isRecord) : [];
  const exact = raw.find(row => row.kind === kind && isString(row.optionId) &&
      (!reservedOptions.has(row.optionId) || row.optionId === kind))
    ?? raw.find(row => row.kind === undefined && row.optionId === kind);
  const exactId = uniqueOptionId(raw, exact);
  if (exactId) return exactId;
  const fallbackKinds = kind === 'allow_once' ? ['allow'] : ['reject', 'deny'];
  const fallback = raw.find(row => isString(row.kind) && fallbackKinds.includes(row.kind) &&
      isString(row.optionId) && !reservedOptions.has(row.optionId))
    ?? raw.find(row => row.kind === undefined && isString(row.optionId) && fallbackKinds.includes(row.optionId));
  return uniqueOptionId(raw, fallback);
}

export function agyAlwaysOption(options: unknown, kind: 'allow_always' | 'reject_always' = 'allow_always'): string | null {
  const raw = Array.isArray(options) ? options.filter(isRecord) : [];
  const option = raw.find(row => row.kind === kind && isString(row.optionId) &&
      (!reservedOptions.has(row.optionId) || row.optionId === kind))
    ?? raw.find(row => row.kind === undefined && row.optionId === kind);
  return uniqueOptionId(raw, option);
}

export function agyPermissionOptions(options: unknown): {
  allowOnce: string | null;
  allowAlways: string | null;
  rejectOnce: string | null;
  rejectAlways: string | null;
} {
  return {
    allowOnce: agyOnceOption(options, 'allow_once'),
    allowAlways: agyAlwaysOption(options, 'allow_always'),
    rejectOnce: agyOnceOption(options, 'reject_once'),
    rejectAlways: agyAlwaysOption(options, 'reject_always'),
  };
}

export function agyPermissionOutcome(optionId: string | null) {
  return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
}

const isNonNegativeInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function validInputField(key: string, value: unknown, kind: 'command' | 'read' | 'write'): boolean {
  if (kind === 'command') {
    if (commandKeys.includes(key) || cwdKeys.includes(key)) return isString(value);
    if (key === 'BypassSandbox') return value === false;
    if (key === 'IsDaemon') return typeof value === 'boolean';
    if (key === 'WaitMsBeforeAsync' || key === 'NotificationTimeoutSeconds') return isNonNegativeInteger(value);
  } else {
    if (pathKeys.includes(key)) return isString(value);
    if (['StartLine', 'EndLine', 'ByteOffset'].includes(key)) return isNonNegativeInteger(value);
    if (kind === 'read') {
      if (['Query', 'Pattern'].includes(key)) return typeof value === 'string';
      if (key === 'CaseSensitive') return typeof value === 'boolean';
    } else {
      if (['Content', 'Target', 'Replacement', 'TargetContent', 'ReplacementContent', 'CodeContent'].includes(key)) {
        return typeof value === 'string';
      }
      if (key === 'Overwrite' || key === 'Append' || key === 'EmptyFile') return typeof value === 'boolean';
      if (key === 'ArtifactMetadata') {
        return isRecord(value) && Object.entries(value).every(([metaKey, metaValue]) => {
          if (metaKey === 'Summary' || metaKey === 'ArtifactType') return typeof metaValue === 'string';
          if (metaKey === 'UserFacing' || metaKey === 'RequestFeedback') return typeof metaValue === 'boolean';
          return false;
        });
      }
    }
  }
  return key === 'toolSummary' && typeof value === 'string';
}

function readInputFields(toolCall: Obj, kind: 'command' | 'read' | 'write'): [string, unknown][] | null {
  const input: [string, unknown][] = [];
  for (const [key, value] of Object.entries(toolCall)) {
    if (displayUpdates.has(key)) continue;
    if (inputGroups.includes(key)) {
      if (!isRecord(value)) return null;
      input.push(...Object.entries(value));
    } else if (envelopeStrings.has(key)) {
      if (typeof value !== 'string') return null;
    } else if (key === 'locations') {
      if (!Array.isArray(value) || (kind === 'command' && value.length > 0) || !value.every(location =>
        isRecord(location) && isString(location.path) && Object.entries(location).every(([field, fieldValue]) =>
          field === 'path' || field === 'line' && isNonNegativeInteger(fieldValue)))) return null;
      input.push(...value.map(location => ['path', location.path] as [string, unknown]));
    } else if (key === 'content' || key === 'rawOutput' || key === '_meta') {
      if (value !== null && !(Array.isArray(value) && value.length === 0) &&
          !(isRecord(value) && Object.keys(value).length === 0)) return null;
    } else {
      input.push([key, value]);
    }
  }
  return input.every(([key, value]) => validInputField(key, value, kind)) ? input : null;
}

function approvalRequest(toolCall: MergedToolCall, types: string[]): { request: ApprovalRequest; cwd?: string } {
  const unknown = { request: { kind: 'unknown' } } as const;
  if (!types.length || identityKeys.some(key => Object.hasOwn(toolCall, key) && !isString(toolCall[key]))) {
    return unknown;
  }
  const kind = types.every(type => commandTools.has(type)) ? 'command'
    : types.every(type => readTools.has(type)) ? 'read'
    : types.every(type => writeTools.has(type)) ? 'write'
    : null;
  if (!kind) return unknown;
  const input = readInputFields(toolCall, kind);
  if (!input) return unknown;
  const values = (keys: readonly string[]) => input.filter(([key]) => keys.includes(key)).map(([, value]) => value).filter(isString);
  if (kind !== 'command') {
    // ACP locations supplement the actual input path, which must also be present.
    const args = inputGroups.map(key => toolCall[key]).filter(isRecord);
    if (![toolCall, ...args].some(group => pathKeys.some(key => Object.hasOwn(group, key)))) return unknown;
    const paths = values(pathKeys);
    return { request: { kind, paths } };
  }
  const commands = new Set(values(commandKeys));
  const cwd = new Set(values(cwdKeys));
  const command = commands.values().next().value;
  if (!command || commands.size !== 1 || cwd.size > 1) return unknown;
  const workingDirectory = cwd.values().next().value;
  if (workingDirectory?.startsWith('~')) return unknown;
  return { request: { kind, command }, ...(workingDirectory ? { cwd: workingDirectory } : {}) };
}

function normalizeToolLeaf(value: string): string {
  const lower = value.trim().toLowerCase();
  const byDoubleUnderscore = lower.includes('__') ? lower.slice(lower.lastIndexOf('__') + 2) : lower;
  const byColon = byDoubleUnderscore.includes(':') ? byDoubleUnderscore.slice(byDoubleUnderscore.lastIndexOf(':') + 1) : byDoubleUnderscore;
  return byColon.includes('/') ? byColon.slice(byColon.lastIndexOf('/') + 1) : byColon;
}

function isAutoAllowReadOnlyTool(toolCall: MergedToolCall, types: string[]): boolean {
  if (!types.length || identityKeys.some(key => Object.hasOwn(toolCall, key) && !isString(toolCall[key]))) {
    return false;
  }
  const leaves = types.map(normalizeToolLeaf);
  if (leaves.every(leaf => autoAllowReadOnlyTools.has(leaf))) return true;
  if (leaves.some(leaf => mcpWrapperTools.has(leaf))) {
    const groups = [toolCall, ...inputGroups.map(key => toolCall[key]).filter(isRecord)];
    const mcpNames = groups.flatMap(group =>
      ['ToolName', 'toolName', 'tool_name'].map(key => group[key]).filter(isString).map(normalizeToolLeaf),
    );
    return mcpNames.length > 0 && mcpNames.every(name => autoAllowReadOnlyTools.has(name));
  }
  return false;
}

export async function classifyAgyPermission(
  toolCall: MergedToolCall,
  project: string,
  approvalPolicy?: ApprovalScope,
  sessionId?: string,
): Promise<GateDecision> {
  if (approvalPolicy?.enabled === false) {
    return { kind: 'ask', reason: '部署配置已停用自动审批，需人工审批' };
  }
  const types = identityKeys.map(key => toolCall[key]).filter(isString).map(value => value.toLowerCase());
  if (isAutoAllowReadOnlyTool(toolCall, types)) {
    if (hasAgyToolCallConflicts(toolCall)) {
      return { kind: 'ask', reason: '工具调用参数存在冲突，请确认最新参数。' };
    }
    return { kind: 'allow_once' };
  }
  const { request, cwd } = approvalRequest(toolCall, types);
  const workingDirectory = cwd ? (isAbsolute(cwd) ? cwd : `${project}/${cwd}`) : project;
  const effectiveSessionId = sessionId ?? (isString(toolCall.sessionId) ? toolCall.sessionId : undefined);
  const sessionBrainRoots: string[] = [];
  if (effectiveSessionId && SAFE_SESSION_ID_RE.test(effectiveSessionId) && !effectiveSessionId.includes('..')) {
    const brainRoot = resolve(approvalPolicy?.brainDir ?? join(approvalPolicy?.homeDir ?? homedir(), '.gemini', 'antigravity-cli', 'brain'));
    sessionBrainRoots.push(join(brainRoot, effectiveSessionId));
  }
  const mergedWriteRoots = [...new Set([...(approvalPolicy?.writeRoots ?? []), ...sessionBrainRoots])];
  const mergedReadRoots = [...new Set([...(approvalPolicy?.readRoots ?? []), ...mergedWriteRoots])];
  const decision = evaluateApproval(await resolveApprovalFacts(request, {
    ...approvalPolicy,
    ...(mergedReadRoots.length ? { readRoots: mergedReadRoots } : {}),
    ...(mergedWriteRoots.length ? { writeRoots: mergedWriteRoots } : {}),
    cwd: workingDirectory,
    project,
  }));
  if (decision.kind !== 'deny' && hasAgyToolCallConflicts(toolCall)) {
    return { kind: 'ask', reason: '工具调用参数存在冲突，请确认最新参数。' };
  }
  if (decision.kind === 'allow_once' && types.some(type => destructiveTools.has(type))) {
    return { kind: 'ask', reason: '此操作会移动或删除文件，请确认。' };
  }
  return decision;
}
