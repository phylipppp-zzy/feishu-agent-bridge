import { type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { contractError, type ContractError, type ErrorCode } from '../errors.js';

export const DEFAULT_AGY_BIN = join(homedir(), '.gemini', 'bin', 'agy');

export type JsonRpcId = string | number;
export type AgyHealthStatus = 'healthy' | 'degraded' | 'unverified';
export type AgyServerRequestMethod = 'session/request_permission' | 'elicitation/create';
export type AgyEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgyStreamMode = 'accept-edits' | 'auto' | 'plan';

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface AgyTransportError extends ContractError {
  rpcCode?: number;
  rpcData?: unknown;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  cancelled?: boolean;
}

export interface AgyAuthMethod {
  id: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface AgyAgentCapabilities {
  loadSession?: boolean;
  load_session?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
    [key: string]: unknown;
  };
  sessionCapabilities?: Record<string, unknown>;
  session_capabilities?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgyInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgyAgentCapabilities;
  agentInfo?: { name?: string; version?: string; [key: string]: unknown };
  authMethods?: AgyAuthMethod[];
  [key: string]: unknown;
}

export interface AgyAcpNotification {
  generation: number;
  method: string;
  params: unknown;
}

export interface AgyServerRequest {
  generation: number;
  rpcId: JsonRpcId;
  method: AgyServerRequestMethod;
  params: unknown;
}

export interface AgyAcpHealthSnapshot {
  component: 'agy-acp-transport';
  status: AgyHealthStatus;
  reason: string | null;
  connected: boolean;
  connectionGeneration: number;
  backlog: number;
  pendingServerRequests: number;
  updatedAt: string;
}

export interface AgyAcpTransportOptions {
  /** Path to the `agy` binary (defaults to `$HOME/.gemini/bin/agy`). */
  agyBin?: string;
  /** Directory for versioned binaries (defaults to FEISHU_AGY_STABLE_BIN_DIR when set). */
  stableBinDir?: string;
  /** Optional args inserted before `acp --stdio` (e.g. a test script path when `agyBin` is `node`). */
  prependArgs?: readonly string[];
  /** Whether to pass `--process-per-session` to `agy acp` (defaults to `true`). */
  processPerSession?: boolean;
  /** Custom `--gemini-dir` passed to `agy acp`. */
  geminiDir?: string;
  /** Custom `--app-data-dir` passed to `agy acp`. */
  appDataDir?: string;
  /** Optional default execution mode passed as `--mode <mode>` to `agy acp`. */
  defaultMode?: AgyStreamMode | (string & {});
  /** Optional additional workspace directories passed as repeated `--add-dir <dir>` flags. */
  addDirs?: readonly string[];
  /** Whether to pass `--sandbox` to `agy acp`. */
  sandbox?: boolean;
  /** Whether to pass `--disable-telemetry` to `agy acp`. */
  disableTelemetry?: boolean;
  /** Additional CLI flags appended to `agy acp --stdio`. */
  extraArgs?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  onStderr?: (line: string) => void;
}

export interface AgyRequestOptions {
  /** Hard wall-clock ceiling in ms. */
  timeoutMs?: number;
  /** Activity-renewed inactivity timeout in ms. */
  idleTimeoutMs?: number;
  /** Session ID whose `session/update` and server requests renew `idleTimeoutMs`. */
  sessionId?: string;
  /** When true, the idle timer defers expiry while waiting on user interaction. */
  isWaitingForUser?: () => boolean;
  /** Optional synchronous callback invoked when the request settles, before subsequent stdout lines are processed. */
  onSettled?: (outcome: { ok: true; result: unknown } | { ok: false; error: unknown }) => void;
}

export interface AgyStreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface AgyStreamInitPayload {
  model?: string;
  cwd?: string;
  agent?: string;
  tools?: string[];
  permission_mode?: string;
  json_schema?: unknown;
  expanded_commands?: Array<{ name?: string; type?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type AgyStepType =
  | 'user_input'
  | 'agent_response'
  | 'system_message'
  | 'command_output'
  | 'error_message'
  | 'tool_group'
  | 'checkpoint'
  | 'subagent'
  | 'finish'
  | 'unknown'
  | (string & {});

export interface AgyStreamStepUpdatePayload {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: AgyStepType;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyStreamUsage;
  tool_info?: {
    name?: string;
    parameters?: unknown;
    output?: unknown;
    error?: { type?: string; message?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  subagent_info?: {
    subagents?: Array<{
      type_name?: string;
      role?: string;
      initial_prompt?: string;
      conversation_id?: string;
      log_uri?: string;
      workspace_uris?: string[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgyStreamResultPayload {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  structured_output?: unknown;
  json_schema?: unknown;
  usage?: AgyStreamUsage;
  command?: { name?: string; data?: unknown; [key: string]: unknown };
  denied_actions?: Array<{ action?: string; display_name?: string; [key: string]: unknown }>;
  finished_reason?: string;
  [key: string]: unknown;
}

export type AgyStreamEvent =
  | { event: 'init'; conversation_id?: string; init: AgyStreamInitPayload; raw: Record<string, unknown> }
  | { event: 'step_update'; conversation_id?: string; step_update: AgyStreamStepUpdatePayload; raw: Record<string, unknown> }
  | { event: 'result'; conversation_id?: string; result: AgyStreamResultPayload; raw: Record<string, unknown> }
  | { event: 'other'; eventType: string; conversation_id?: string; raw: Record<string, unknown> };

export type AgyStreamInputContent = string | Array<{ type: 'text'; text: string }>;

export interface AgyStreamJsonRunnerOptions {
  /** Path to the `agy` binary (defaults to `$HOME/.gemini/bin/agy`). */
  agyBin?: string;
  /** Optional args inserted before `-p= --input-format stream-json --output-format stream-json`. */
  prependArgs?: readonly string[];
  /** Existing conversation ID passed as `--conversation <id>`. */
  conversationId?: string;
  /** Model override passed as `--model <model>`. */
  model?: string;
  /** Effort level passed as `--effort <effort>`. Note: conflicts with effort-suffixed `--model`. */
  effort?: AgyEffortLevel | (string & {});
  /** Print-mode permission/plan mode passed as `--mode <mode>`. */
  mode?: AgyStreamMode | (string & {});
  /** Enables `--sandbox`. */
  sandbox?: boolean;
  /** Extra CLI flags appended after standard flags. */
  extraArgs?: readonly string[];
  cwd?: string;
  /** Environment variables (use `HOME` here to isolate `agy -p`, since `--gemini-dir` is ACP-only). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  onEvent?: (event: AgyStreamEvent) => void;
  onStderr?: (line: string) => void;
  onParseError?: (line: string, error: unknown) => void;
}

export interface AgyStreamRunOptions {
  endInput?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: AgyStreamEvent) => void;
}

export interface AgyStreamRunResult {
  conversationId: string | null;
  init: AgyStreamInitPayload | null;
  steps: AgyStreamStepUpdatePayload[];
  result: AgyStreamResultPayload | null;
  events: AgyStreamEvent[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
export const DEFAULT_CLIENT_CAPABILITIES: Record<string, unknown> = {
  elicitation: {
    form: {},
  },
};
export const SERVER_REQUEST_METHODS = new Set<string>(['session/request_permission', 'elicitation/create']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function rpcIdKey(id: JsonRpcId): string {
  return `${typeof id}:${id}`;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolvePositiveMs(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw contractError('invalid_request', `${name} must be a positive finite number`);
  }
  return resolved;
}

export function resolveBin(agyBin: string | undefined): string {
  const bin = agyBin === undefined ? DEFAULT_AGY_BIN : agyBin.trim();
  if (!bin) {
    throw contractError('invalid_request', 'agyBin must be a non-empty string');
  }
  return bin;
}

export function makeTransportError(
  code: ErrorCode,
  message: string,
  extra?: Partial<Omit<AgyTransportError, keyof ContractError>>,
): AgyTransportError {
  return { ...contractError(code, message), ...extra };
}

export function mapJsonRpcError(error: JsonRpcErrorPayload): AgyTransportError {
  let code: ErrorCode = 'temporarily_unavailable';
  if (error.code === -32000 && /auth/i.test(error.message)) {
    code = 'unauthorized';
  } else if (error.code === -32600 || error.code === -32602) {
    code = 'invalid_request';
  } else if (error.code === -32601) {
    code = 'unsupported';
  }
  return makeTransportError(code, error.message, {
    rpcCode: error.code,
    ...(error.data !== undefined ? { rpcData: error.data } : {}),
  });
}

export function createLineParser(onLine: (line: string) => void) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const emit = (raw: string) => {
    const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (trimmed.length > 0) onLine(trimmed);
  };
  return {
    push(chunk: Buffer | string): void {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    },
    flush(): void {
      buffer += decoder.end();
      if (buffer.length > 0) {
        emit(buffer);
        buffer = '';
      }
    },
  };
}

export function writeNdjsonLine(proc: ChildProcess, payload: unknown): boolean {
  if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
    return false;
  }
  try {
    proc.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw err;
    }
  }

  try {
    proc.kill(signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw err;
  }
}

const agyChildren = new Set<ChildProcess>();

function killAgyChildrenAtExit(): void {
  for (const proc of agyChildren) killProcessTree(proc, 'SIGKILL');
}

export function trackAgyChildForExit(proc: ChildProcess): void {
  // ACP can have many live children. Keep one parent exit listener for all of them.
  if (agyChildren.size === 0) process.once('exit', killAgyChildrenAtExit);
  agyChildren.add(proc);
  const unregister = () => {
    proc.off('exit', unregister);
    proc.off('close', unregister);
    agyChildren.delete(proc);
    if (agyChildren.size === 0) process.off('exit', killAgyChildrenAtExit);
  };
  proc.once('exit', unregister);
  proc.once('close', unregister); // Failed spawns may only emit close.
}

export async function terminateChildProcess(
  proc: ChildProcess,
  sigtermGraceMs: number,
  sigkillGraceMs: number,
  endStdinFirst = true,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return { exitCode: proc.exitCode, signal: proc.signalCode };
  }

  return new Promise(resolve => {
    let settled = false;
    let sigtermTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (sigtermTimer) clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (finalTimer) clearTimeout(finalTimer);
      proc.removeListener('close', onClose);
      proc.removeListener('exit', onExit);
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, signal });
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code, signal);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      // Allow stdio close to flush first, but do not hang if a grandchild holds the pipe open.
      if (!finalTimer) {
        finalTimer = setTimeout(() => finish(code, signal), 50);
      }
    };

    proc.once('close', onClose);
    proc.once('exit', onExit);

    const scheduleSigkill = () => {
      sigkillTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          killProcessTree(proc, 'SIGKILL');
          finalTimer = setTimeout(() => finish(proc.exitCode, proc.signalCode), 250);
        }
      }, sigkillGraceMs);
    };

    const sendSigterm = () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      killProcessTree(proc, 'SIGTERM');
      scheduleSigkill();
    };

    if (endStdinFirst && proc.stdin && !proc.stdin.destroyed) {
      try {
        proc.stdin.end();
      } catch {}
    }

    if (sigtermGraceMs <= 0) {
      sendSigterm();
    } else {
      sigtermTimer = setTimeout(sendSigterm, sigtermGraceMs);
    }
  });
}

/** Build CLI arguments for `agy acp --stdio`. */
export function buildAgyAcpArgs(options: AgyAcpTransportOptions = {}): string[] {
  const args: string[] = [...(options.prependArgs ?? []), 'acp', '--stdio'];
  if (options.processPerSession !== false) {
    args.push('--process-per-session');
  }
  if (options.geminiDir !== undefined) {
    if (!options.geminiDir.trim()) throw contractError('invalid_request', 'geminiDir must be non-empty');
    args.push('--gemini-dir', options.geminiDir);
  }
  if (options.appDataDir !== undefined) {
    if (!options.appDataDir.trim()) throw contractError('invalid_request', 'appDataDir must be non-empty');
    args.push('--app-data-dir', options.appDataDir);
  }
  if (options.addDirs?.length) {
    for (const dir of options.addDirs) {
      if (typeof dir !== 'string' || !dir.trim()) {
        throw contractError('invalid_request', 'addDirs entries must be non-empty strings');
      }
      args.push('--add-dir', dir);
    }
  }
  if (options.sandbox) args.push('--sandbox');
  if (options.disableTelemetry) args.push('--disable-telemetry');
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

/** Build CLI arguments for `agy -p= --input-format stream-json --output-format stream-json`. */
export function buildAgyStreamJsonArgs(options: AgyStreamJsonRunnerOptions = {}): string[] {
  const args: string[] = [
    ...(options.prependArgs ?? []),
    '-p=',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ];
  if (options.conversationId !== undefined) {
    if (!options.conversationId.trim()) throw contractError('invalid_request', 'conversationId must be non-empty');
    args.push('--conversation', options.conversationId);
  }
  if (options.model !== undefined) {
    if (!options.model.trim()) throw contractError('invalid_request', 'model must be non-empty');
    args.push('--model', options.model);
  }
  if (options.effort !== undefined) {
    if (!options.effort.trim()) throw contractError('invalid_request', 'effort must be non-empty');
    args.push('--effort', options.effort);
  }
  if (options.mode !== undefined) {
    if (!options.mode.trim()) throw contractError('invalid_request', 'mode must be non-empty');
    args.push('--mode', options.mode);
  }
  if (options.sandbox) args.push('--sandbox');
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}
