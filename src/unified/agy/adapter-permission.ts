import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { evaluateApproval, resolveApprovalFacts, type ApprovalRequest, type ApprovalScope, type GateDecision } from '../approval-policy.js';
import { under } from '../approval-policy-paths.js';
import { payloadDigest } from '../contracts.js';
import { isRecord, isString, type Obj } from './adapter-types.js';

const commandTools = new Set(['execute', 'run_command']);
const readTools = new Set(['read', 'read_file', 'view_file', 'list_directory', 'list_dir', 'search', 'grep_search']);
const builtinAutoAllowTools = new Set(['search_web', 'list_resources', 'read_resource']);
const codexReadOnlyMcpTools = new Set(['codex_lookup', 'codex_status', 'codex_job']);
const trustedCodexServers = new Set(['codex', 'codex-bridge', 'codex_bridge']);
const safeReadOnlyKinds = new Set(['read', 'search', 'fetch', 'other']);
const mcpWrapperTools = new Set(['call_mcp_tool', 'mcp_call', 'use_mcp_tool']);
const forbiddenMcpCommandKeys = new Set(['CommandLine', 'commandLine', 'command', 'Command']);
const destructiveTools = new Set(['delete', 'delete_file', 'move', 'move_file', 'rename', 'rename_file']);
const writeTools = new Set([
  'edit', 'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file',
  ...destructiveTools,
]);
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
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

function matchTrustedReadOnlyTool(rawName: string, serverName?: string): string | null {
  const lower = rawName.trim().toLowerCase();
  const normalizedServer = serverName?.trim().toLowerCase();
  if (!lower) return null;
  if (lower === 'search_web' || lower === 'default_api:search_web') {
    return normalizedServer ? null : 'search_web';
  }
  if (builtinAutoAllowTools.has(lower)) {
    if (normalizedServer && !trustedCodexServers.has(normalizedServer)) return null;
    return lower;
  }
  if (lower.startsWith('default_api:')) {
    const leaf = lower.slice('default_api:'.length);
    if (builtinAutoAllowTools.has(leaf) || codexReadOnlyMcpTools.has(leaf)) {
      if (normalizedServer && !trustedCodexServers.has(normalizedServer)) return null;
      return leaf;
    }
    return null;
  }
  if (codexReadOnlyMcpTools.has(lower)) {
    if (normalizedServer && !trustedCodexServers.has(normalizedServer)) return null;
    return lower;
  }
  const mcpDouble = /^mcp__([a-z0-9_-]+)__([a-z0-9_-]+)$/.exec(lower);
  if (mcpDouble && trustedCodexServers.has(mcpDouble[1]!) && codexReadOnlyMcpTools.has(mcpDouble[2]!)) {
    if (normalizedServer && normalizedServer !== mcpDouble[1]) return null;
    return mcpDouble[2]!;
  }
  const mcpColon = /^(?:mcp:)?([a-z0-9_-]+):([a-z0-9_-]+)$/.exec(lower);
  if (mcpColon && trustedCodexServers.has(mcpColon[1]!) && codexReadOnlyMcpTools.has(mcpColon[2]!)) {
    if (normalizedServer && normalizedServer !== mcpColon[1]) return null;
    return mcpColon[2]!;
  }
  return null;
}

function extractFileResourcePaths(toolCall: MergedToolCall): { ok: true; paths: string[] } | { ok: false } {
  const groups = [toolCall, ...inputGroups.map(key => toolCall[key]).filter(isRecord)];
  const uris = groups.flatMap(group => ['Uri', 'uri'].map(key => group[key]).filter(isString));
  const paths: string[] = [];
  for (const uri of uris) {
    if (!/^file:/i.test(uri.trim())) continue;
    try {
      paths.push(fileURLToPath(uri.trim()));
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, paths };
}

function resolveTrustedReadOnlyTool(toolCall: MergedToolCall): string | null {
  if (identityKeys.some(key => Object.hasOwn(toolCall, key) && !isString(toolCall[key]))) {
    return null;
  }
  if (Object.hasOwn(toolCall, 'kind')) {
    const kind = String(toolCall.kind).trim().toLowerCase();
    if (!safeReadOnlyKinds.has(kind)) return null;
  }
  const rawNames = ['name', 'toolName'].map(key => toolCall[key]).filter(isString).map(v => v.trim().toLowerCase());
  if (!rawNames.length || new Set(rawNames).size !== 1) return null;
  const toolName = rawNames[0]!;
  const groups = [toolCall, ...inputGroups.map(key => toolCall[key]).filter(isRecord)];
  if (groups.some(group => Object.keys(group).some(k => forbiddenMcpCommandKeys.has(k)))) {
    return null;
  }
  const servers = groups.flatMap(group =>
    ['ServerName', 'serverName', 'server_name'].map(key => group[key]).filter(isString).map(v => v.trim().toLowerCase()),
  );
  if (new Set(servers).size > 1) return null;
  const serverName = servers[0];
  const direct = matchTrustedReadOnlyTool(toolName, serverName);
  if (direct) return direct;
  if (mcpWrapperTools.has(toolName)) {
    const mcpNames = groups.flatMap(group =>
      ['ToolName', 'toolName', 'tool_name'].map(key => group[key]).filter(isString).map(v => v.trim().toLowerCase()),
    );
    if (!mcpNames.length || new Set(mcpNames).size !== 1) return null;
    return matchTrustedReadOnlyTool(mcpNames[0]!, serverName);
  }
  return null;
}

async function resolveSafeSessionBrainRoot(brainRoot: string, sessionId: string): Promise<string | null> {
  if (!SAFE_SESSION_ID_RE.test(sessionId) || sessionId.includes('..')) return null;
  const resolvedBrainRoot = resolve(brainRoot);
  const physicalBrainRoot = await realpath(resolvedBrainRoot).catch(() => null);
  const candidate = join(resolvedBrainRoot, sessionId);
  const meta = await lstat(candidate).catch(() => null);
  if (meta) {
    if (meta.isSymbolicLink() || !meta.isDirectory()) return null;
    const physicalCandidate = await realpath(candidate).catch(() => null);
    if (!physicalCandidate || !physicalBrainRoot) return null;
    if (physicalCandidate === physicalBrainRoot || !under(physicalCandidate, physicalBrainRoot)) return null;
    return candidate;
  }
  return null;
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
  const homeDir = resolve(approvalPolicy?.homeDir ?? homedir());
  const readOnlyTool = resolveTrustedReadOnlyTool(toolCall);
  let forcedRequest: { request: ApprovalRequest; cwd?: string } | null = null;
  if (readOnlyTool) {
    if (hasAgyToolCallConflicts(toolCall)) {
      return { kind: 'ask', reason: '工具调用参数存在冲突，请确认最新参数。' };
    }
    if (readOnlyTool === 'read_resource') {
      const extracted = extractFileResourcePaths(toolCall);
      if (!extracted.ok) {
        return { kind: 'ask', reason: '无法解析本地资源路径，需人工审批' };
      }
      if (extracted.paths.length > 0) {
        forcedRequest = { request: { kind: 'read', paths: extracted.paths } };
      } else {
        return { kind: 'allow_once' };
      }
    } else {
      return { kind: 'allow_once' };
    }
  }
  const types = identityKeys.map(key => toolCall[key]).filter(isString).map(value => value.toLowerCase());
  const { request, cwd } = forcedRequest ?? approvalRequest(toolCall, types);
  const workingDirectory = cwd ? (isAbsolute(cwd) ? cwd : `${project}/${cwd}`) : project;
  const sessionBrainRoots: string[] = [];
  if (sessionId) {
    const brainRoot = resolve(approvalPolicy?.brainDir ?? join(homeDir, '.gemini', 'antigravity-cli', 'brain'));
    const safeBrain = await resolveSafeSessionBrainRoot(brainRoot, sessionId);
    if (safeBrain) sessionBrainRoots.push(safeBrain);
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
