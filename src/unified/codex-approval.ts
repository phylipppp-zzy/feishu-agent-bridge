import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { unwrapShellCommand } from '../execution-policy.js';
import { parseShellCommands } from './approval-policy-shell.js';
import {
  evaluateApproval, evaluateApprovalGrant, resolveApprovalFacts,
  type ApprovalContext, type ApprovalRequest, type GateDecision,
} from './approval-policy.js';
import { under } from './approval-policy-paths.js';
import type { CatalogRoot } from './local-catalog.js';
import type { RuntimeConfig } from './runtime.js';

const shells = new Set(['bash', 'zsh', 'sh'].flatMap(name => [name, `/bin/${name}`, `/usr/bin/${name}`]));
const commonFields = ['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'availableDecisions'];
const fileFields = new Set([...commonFields, 'changes', 'grantRoot', 'grant_root']);
const commandFields = new Set([
  ...commonFields, 'kind', 'approvalId', 'environmentId', 'command', 'cwd', 'commandActions',
]);
const additiveCommandFields = new Set([
  'networkApprovalContext', 'additionalPermissions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments',
]);
const unknownScope = '无法确认审批请求是否会扩大权限范围，需人工审批';

export function isLocalCodexEndpoint(endpoint: string): boolean {
  if (endpoint === 'codex-proxy://default') return true;
  const url = URL.parse(endpoint);
  return !!url && ['ws:', 'wss:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

export function codexFilesystemProof(endpoint: string, shared: boolean | undefined, sources: readonly CatalogRoot[] = []) {
  const roots = sources.filter(source => source.provider === 'codex').map(source => source.directory);
  return async (nativePath: unknown): Promise<boolean> => {
    if (endpoint === 'codex-proxy://default' || shared === true) return true;
    if (shared === false || !isLocalCodexEndpoint(endpoint) || typeof nativePath !== 'string' || !isAbsolute(nativePath)) return false;
    const path = await realpath(nativePath).catch(() => null);
    if (!path || !(await stat(path).catch(() => null))?.isFile()) return false;
    const localRoots = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
    return localRoots.some(root => root !== null && path !== root && under(path, root));
  };
}

export function codexApprovalChoices(value: unknown) {
  const choices = Array.isArray(value) ? value : value === undefined ? ['accept', 'decline'] : [];
  return {
    allow: choices.includes('accept') ? 'accept' as const : undefined,
    deny: choices.includes('decline') ? 'decline' as const : choices.includes('cancel') ? 'cancel' as const : undefined,
  };
}

export function runtimeApprovalScope(config: RuntimeConfig) {
  const policy = config.approvalPolicy;
  const writeRoots = [...new Set(policy?.extraWriteRoots ?? [])];
  const readRoots = [...new Set([
    ...(config.outputRoots ?? []),
    ...(policy?.extraTrustedRoots ?? []),
    ...writeRoots,
  ])];
  return {
    enabled: policy?.enabled !== false,
    ...(config.allowedProjectRoots !== undefined ? { allowedRoots: config.allowedProjectRoots } : {}),
    readRoots,
    writeRoots,
    ...(policy?.homeDir !== undefined ? { homeDir: policy.homeDir } : {}),
  };
}

function commandText(command: unknown): string | undefined {
  if (typeof command === 'string') {
    const program = command.split(' ', 1)[0]!;
    if (!shells.has(program)) return command;
    const script = unwrapShellCommand(command);
    if (script === command) return command;
    const outer = parseShellCommands(command);
    const wrapper = outer?.[0];
    // The decoded script must be exactly one outer word with no surrounding shell operations.
    return outer?.length === 1 && wrapper?.words.length === 3 && wrapper.words[2] === script
      && !wrapper.redirects.length && !wrapper.next ? script : command;
  }
  if (!Array.isArray(command) || command.length !== 3) return;
  const [program, option, script] = command;
  if (typeof program === 'string' && shells.has(program) && (option === '-lc' || option === '-c')
    && typeof script === 'string') return script;
}

export async function evaluateCodexApproval(
  command: boolean,
  params: Record<string, unknown>,
  paths: readonly string[] | undefined,
  context: ApprovalContext,
  completePaths = true,
): Promise<GateDecision> {
  const known = command ? commandFields : fileFields;
  const validCwd = params.cwd == null || (typeof params.cwd === 'string' && isAbsolute(params.cwd) && !params.cwd.includes('\0'));
  const inspectionContext = { ...context };
  if (!validCwd) delete inspectionContext.cwd;
  const script = command ? commandText(params.command) : undefined;
  const request: ApprovalRequest = command
    ? { kind: 'command', ...(script ? { command: script } : {}) }
    : { kind: 'write', ...(paths ? { paths } : {}) };
  const grants = ['grantRoot', 'grant_root'].filter(field => params[field] != null);
  const decisions = await Promise.all([
    ...grants.map(field => evaluateApprovalGrant(params[field], inspectionContext)),
    resolveApprovalFacts(request, inspectionContext).then(evaluateApproval),
  ]);
  const decision = decisions.find(result => result.kind === 'deny')
    ?? decisions.find(result => result.kind === 'ask') ?? decisions.at(-1)!;
  if (decision.kind === 'deny') return decision;
  if (!completePaths || !validCwd || !context.project
    || Object.keys(params).some(field => !known.has(field)
      && !(command && additiveCommandFields.has(field) && params[field] == null))
    || (command && ((params.kind !== undefined && params.kind !== 'command') || params.environmentId != null))) {
    return { kind: 'ask', reason: unknownScope };
  }
  if (decision.kind === 'allow_once' && !codexApprovalChoices(params.availableDecisions).allow) {
    return { kind: 'ask', reason: '原端未提供单次允许选项' };
  }
  return decision;
}
