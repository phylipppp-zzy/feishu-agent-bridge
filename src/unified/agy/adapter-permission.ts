import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { evaluateApproval, resolveApprovalFacts, type ApprovalRequest, type ApprovalScope, type GateDecision } from '../approval-policy.js';
import { payloadDigest } from '../contracts.js';
import { isRecord, isString, type Obj } from './adapter-types.js';

const commandTools = new Set(['execute', 'run_command']);
const readTools = new Set(['read', 'read_file', 'view_file', 'list_directory', 'list_dir', 'search', 'grep_search']);
const destructiveTools = new Set(['delete', 'delete_file', 'move', 'move_file', 'rename', 'rename_file']);
const writeTools = new Set([
  'edit', 'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file',
  ...destructiveTools,
]);
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

export function agyOnceOption(options: unknown, kind: 'allow_once' | 'reject_once'): string | null {
  const raw = Array.isArray(options) ? options.filter(isRecord) : [];
  const option = raw.find(row => row.kind === kind && isString(row.optionId) &&
      (!reservedOptions.has(row.optionId) || row.optionId === kind))
    ?? raw.find(row => row.kind === undefined && row.optionId === kind);
  const id = option?.optionId;
  return isString(id) && raw.filter(row => row.optionId === id).length === 1 ? id : null;
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
      if (key === 'Overwrite' || key === 'Append') return typeof value === 'boolean';
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

export async function classifyAgyPermission(
  toolCall: MergedToolCall,
  project: string,
  approvalPolicy?: ApprovalScope,
): Promise<GateDecision> {
  const types = identityKeys.map(key => toolCall[key]).filter(isString).map(value => value.toLowerCase());
  const { request, cwd } = approvalRequest(toolCall, types);
  const workingDirectory = cwd ? (isAbsolute(cwd) ? cwd : `${project}/${cwd}`) : project;
  const decision = evaluateApproval(await resolveApprovalFacts(request, {
    ...approvalPolicy,
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
