import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { contractError, type ContractError, type ErrorCode } from './errors.js';

export const DEFAULT_AGY_BIN = '/home/zhangzy/.gemini/bin/agy';

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
  /** Path to the `agy` binary (defaults to `/home/zhangzy/.gemini/bin/agy`). */
  agyBin?: string;
  /** Optional args inserted before `acp --stdio` (e.g. a test script path when `agyBin` is `node`). */
  prependArgs?: readonly string[];
  /** Custom `--gemini-dir` passed to `agy acp`. */
  geminiDir?: string;
  /** Custom `--app-data-dir` passed to `agy acp`. */
  appDataDir?: string;
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
  /** Path to the `agy` binary (defaults to `/home/zhangzy/.gemini/bin/agy`). */
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

type PendingRpc = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  onSuccess?: (result: unknown) => void;
};

type PendingServerRequest = {
  generation: number;
  rpcId: JsonRpcId;
  method: AgyServerRequestMethod;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const SERVER_REQUEST_METHODS = new Set<string>(['session/request_permission', 'elicitation/create']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function rpcIdKey(id: JsonRpcId): string {
  return `${typeof id}:${id}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolvePositiveMs(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw contractError('invalid_request', `${name} must be a positive finite number`);
  }
  return resolved;
}

function resolveBin(agyBin: string | undefined): string {
  const bin = agyBin === undefined ? DEFAULT_AGY_BIN : agyBin.trim();
  if (!bin) {
    throw contractError('invalid_request', 'agyBin must be a non-empty string');
  }
  return bin;
}

function makeTransportError(
  code: ErrorCode,
  message: string,
  extra?: Partial<Omit<AgyTransportError, keyof ContractError>>,
): AgyTransportError {
  return { ...contractError(code, message), ...extra };
}

function mapJsonRpcError(error: JsonRpcErrorPayload): AgyTransportError {
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

function createLineParser(onLine: (line: string) => void) {
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

function writeNdjsonLine(proc: ChildProcess, payload: unknown): boolean {
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

async function terminateChildProcess(
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
          try {
            proc.kill('SIGKILL');
          } catch {}
          finalTimer = setTimeout(() => finish(proc.exitCode, proc.signalCode), 250);
        }
      }, sigkillGraceMs);
    };

    const sendSigterm = () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try {
        proc.kill('SIGTERM');
      } catch {}
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
  if (options.geminiDir !== undefined) {
    if (!options.geminiDir.trim()) throw contractError('invalid_request', 'geminiDir must be non-empty');
    args.push('--gemini-dir', options.geminiDir);
  }
  if (options.appDataDir !== undefined) {
    if (!options.appDataDir.trim()) throw contractError('invalid_request', 'appDataDir must be non-empty');
    args.push('--app-data-dir', options.appDataDir);
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

/**
 * Bidirectional stdio JSON-RPC 2.0 transport for `agy acp --stdio`.
 * Maintains monotonically increasing connection generations, health state,
 * in-flight request tracking, and generation-fenced server request replies.
 */
export class AgyAcpTransport {
  private readonly agyBin: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;

  private child: ChildProcess | null = null;
  private established = false;
  private activeGeneration: number | null = null;
  private _connectionGeneration = 0;
  private _status: AgyHealthStatus = 'unverified';
  private serial = 0;
  private connectingPromise: Promise<AgyInitializeResult> | null = null;
  private closingPromise: Promise<void> | null = null;
  private closing = false;
  private disconnectEmittedForProc: ChildProcess | null = null;

  private readonly pending = new Map<number, PendingRpc>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly respondedServerRequestKeys = new Set<string>();

  agentCapabilities: AgyAgentCapabilities | null = null;
  authMethods: AgyAuthMethod[] = [];
  agentInfo: AgyInitializeResult['agentInfo'] | null = null;
  protocolVersion: number | null = null;
  lastError: string | null = null;
  updatedAt = new Date().toISOString();

  onHealth: (status: 'healthy' | 'degraded', reason: string | null) => void = () => {};
  onDisconnect: (generation: number, reason: string) => void = () => {};
  onNotification: (notification: AgyAcpNotification) => void = () => {};
  onServerRequest: (request: AgyServerRequest) => void = () => {};

  constructor(private readonly options: AgyAcpTransportOptions = {}) {
    this.agyBin = resolveBin(options.agyBin);
    this.connectTimeoutMs = resolvePositiveMs(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs');
    this.requestTimeoutMs = resolvePositiveMs(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs');
    this.closeTimeoutMs = resolvePositiveMs(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 'closeTimeoutMs');
  }

  get connectionGeneration(): number {
    return this._connectionGeneration;
  }

  get status(): AgyHealthStatus {
    return this._status;
  }

  get connected(): boolean {
    return this.established && this.child !== null && !this.closing;
  }

  /** Advance the baseline connection generation when recovering persisted interaction state. */
  seedGeneration(minimum: number): void {
    if (!Number.isSafeInteger(minimum) || minimum < 0) {
      throw contractError('invalid_request', 'minimum generation must be a non-negative integer');
    }
    if (
      this.closing ||
      this.connectingPromise !== null ||
      this.pending.size > 0 ||
      this.pendingServerRequests.size > 0 ||
      (this.child !== null && !this.connected)
    ) {
      throw contractError('busy', 'cannot seed active transport');
    }
    if (this._connectionGeneration <= minimum) {
      this._connectionGeneration = minimum + (this.connected ? 1 : 0);
      if (this.connected) {
        this.activeGeneration = this._connectionGeneration;
      }
    }
  }

  buildArgs(): string[] {
    return buildAgyAcpArgs(this.options);
  }

  health(): AgyAcpHealthSnapshot {
    return {
      component: 'agy-acp-transport',
      status: this._status,
      reason: this.lastError ?? (this._status === 'unverified' ? 'not connected' : null),
      connected: this.connected,
      connectionGeneration: this._connectionGeneration,
      backlog: this.pending.size,
      pendingServerRequests: this.pendingServerRequests.size,
      updatedAt: this.updatedAt,
    };
  }

  /** Spawn `agy acp --stdio` and complete the ACP `initialize` handshake. */
  async connect(): Promise<AgyInitializeResult> {
    if (this.closingPromise !== null || this.closing) {
      throw contractError('busy', 'ACP transport is closing');
    }
    if (this.child !== null || this.connectingPromise !== null) {
      throw contractError('busy', 'ACP connection already active');
    }

    const args = this.buildArgs();
    const runConnect = async (): Promise<AgyInitializeResult> => {
      const proc = spawn(this.agyBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        ...(this.options.env !== undefined ? { env: this.options.env } : {}),
      });

      this.child = proc;
      this.established = false;
      this.activeGeneration = null;
      this.disconnectEmittedForProc = null;
      this.pendingServerRequests.clear();
      this.respondedServerRequestKeys.clear();

      const stdoutParser = createLineParser(line => this.handleStdoutLine(proc, line));
      const stderrParser = createLineParser(line => {
        try {
          this.options.onStderr?.(line);
        } catch {}
      });

      let earlyExitTimer: ReturnType<typeof setTimeout> | undefined;

      proc.stdin?.on('error', err => {
        if (this.child !== proc || this.closing) return;
        this.handleProcessDrop(proc, `stdin error: ${err.message}`);
      });

      proc.stdout?.on('data', chunk => {
        if (this.child !== proc) return;
        stdoutParser.push(chunk);
      });

      proc.stderr?.on('data', chunk => {
        if (this.child !== proc) return;
        stderrParser.push(chunk);
      });

      proc.on('error', err => {
        if (earlyExitTimer) clearTimeout(earlyExitTimer);
        if (this.child !== proc || this.closing) return;
        this.handleProcessDrop(proc, `process error: ${err.message}`);
      });

      proc.on('exit', (code, signal) => {
        if (this.child !== proc || this.closing) return;
        if (!earlyExitTimer) {
          earlyExitTimer = setTimeout(() => {
            if (this.child !== proc || this.closing) return;
            stdoutParser.flush();
            stderrParser.flush();
            this.handleProcessDrop(proc, this.formatExitReason(code, signal));
          }, 50);
        }
      });

      proc.on('close', (code, signal) => {
        if (earlyExitTimer) clearTimeout(earlyExitTimer);
        if (this.child !== proc) return;
        stdoutParser.flush();
        stderrParser.flush();
        if (this.closing) return;
        this.handleProcessDrop(proc, this.formatExitReason(code, signal));
      });

      let initResult!: AgyInitializeResult;
      try {
        await this.sendRequestInternal(
          proc,
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: this.options.clientCapabilities ?? {},
            clientInfo: this.options.clientInfo ?? { name: 'feishu-agent-bridge', version: '0.1.0' },
          },
          this.connectTimeoutMs,
          raw => {
            initResult = this.acceptInitializeResult(proc, raw);
          },
        );
        if (this.child !== proc || this.closing || !this.established) {
          throw contractError('temporarily_unavailable', 'ACP connection closed during initialize');
        }
        return initResult;
      } catch (err) {
        if (this.child === proc && !this.closing) {
          this.child = null;
          this.established = false;
          this.activeGeneration = null;
          this.pendingServerRequests.clear();
          const reason = err instanceof Error ? err.message : isRecord(err) && typeof err.message === 'string' ? err.message : 'ACP initialize failed';
          this.markDegraded(reason);
          await terminateChildProcess(proc, 0, Math.min(this.closeTimeoutMs, 500));
        }
        throw err;
      }
    };

    const promise = runConnect().finally(() => {
      if (this.connectingPromise === promise) {
        this.connectingPromise = null;
      }
    });
    this.connectingPromise = promise;
    return promise;
  }

  /** Send an arbitrary JSON-RPC 2.0 request over the active ACP connection. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!method || typeof method !== 'string') {
      return Promise.reject(contractError('invalid_request', 'JSON-RPC method must be a non-empty string'));
    }
    const proc = this.child;
    if (!this.connected || !proc) {
      return Promise.reject(contractError('temporarily_unavailable', 'ACP transport not connected'));
    }
    let effectiveTimeout: number;
    try {
      effectiveTimeout = resolvePositiveMs(timeoutMs, this.requestTimeoutMs, 'timeoutMs');
    } catch (err) {
      return Promise.reject(err);
    }
    return this.sendRequestInternal(proc, method, params, effectiveTimeout);
  }

  /** Send a JSON-RPC 2.0 notification (no `id`) over the active ACP connection. */
  notify(method: string, params?: unknown): void {
    if (!method || typeof method !== 'string') {
      throw contractError('invalid_request', 'JSON-RPC method must be a non-empty string');
    }
    const proc = this.child;
    if (!this.connected || !proc) {
      throw contractError('temporarily_unavailable', 'ACP transport not connected');
    }
    const payload = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    if (!writeNdjsonLine(proc, payload)) {
      this.markDegraded('send failed');
      throw contractError('outcome_unknown', 'failed to write ACP notification');
    }
  }

  /**
   * Respond with a JSON-RPC result to a pending server-initiated request.
   * Enforces exact `expectedGeneration === connectionGeneration` and single-use `rpcId` delivery.
   */
  respondServerRequest(expectedGeneration: number, rpcId: JsonRpcId, result: unknown): void {
    this.sendServerResponse(expectedGeneration, rpcId, { result });
  }

  /**
   * Respond with a JSON-RPC error to a pending server-initiated request.
   * Enforces exact `expectedGeneration === connectionGeneration` and single-use `rpcId` delivery.
   */
  respondServerError(expectedGeneration: number, rpcId: JsonRpcId, code: number, message: string, data?: unknown): void {
    if (!Number.isInteger(code)) {
      throw contractError('invalid_request', 'JSON-RPC error code must be an integer');
    }
    if (typeof message !== 'string' || !message) {
      throw contractError('invalid_request', 'JSON-RPC error message must be a non-empty string');
    }
    this.sendServerResponse(expectedGeneration, rpcId, {
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  /**
   * Idempotently close the transport: end stdin, wait up to `closeTimeoutMs`,
   * then fall back to SIGTERM and SIGKILL while rejecting any pending promises.
   */
  async close(): Promise<void> {
    if (this.closingPromise !== null) {
      return this.closingPromise;
    }

    const proc = this.child;
    if (!proc) {
      this.established = false;
      this.activeGeneration = null;
      this.rejectAllPending(contractError('outcome_unknown', 'ACP transport closed'));
      this.pendingServerRequests.clear();
      return;
    }

    this.closing = true;
    const wasEstablished = this.established;
    const generation = this.activeGeneration;
    this.established = false;
    this.activeGeneration = null;
    this.pendingServerRequests.clear();
    this.rejectAllPending(contractError('outcome_unknown', 'ACP transport closed'));

    if (wasEstablished && generation !== null) {
      this.markDegraded('connection closed');
      this.emitDisconnectOnce(proc, generation, 'connection closed');
    }

    const closing = terminateChildProcess(proc, this.closeTimeoutMs, this.closeTimeoutMs, true)
      .then(() => undefined)
      .finally(() => {
        if (this.child === proc) {
          this.child = null;
        }
        this.closing = false;
        this.closingPromise = null;
      });

    this.closingPromise = closing;
    return closing;
  }

  private acceptInitializeResult(proc: ChildProcess, raw: unknown): AgyInitializeResult {
    if (this.child !== proc || this.closing) {
      throw contractError('temporarily_unavailable', 'ACP connection closed during initialize');
    }
    if (!isRecord(raw) || typeof raw.protocolVersion !== 'number') {
      throw contractError('temporarily_unavailable', 'invalid ACP initialize response');
    }
    const result = raw as AgyInitializeResult;
    const generation = ++this._connectionGeneration;
    this.protocolVersion = result.protocolVersion;
    this.agentCapabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : null;
    this.agentInfo = isRecord(result.agentInfo) ? result.agentInfo : null;
    this.authMethods = Array.isArray(result.authMethods) ? result.authMethods.filter(isRecord) as AgyAuthMethod[] : [];
    this.activeGeneration = generation;
    this.established = true;
    this.markHealthy();
    return result;
  }

  private sendRequestInternal(
    proc: ChildProcess,
    method: string,
    params: unknown,
    timeoutMs: number,
    onSuccess?: (result: unknown) => void,
  ): Promise<unknown> {
    const id = ++this.serial;
    const payload = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.markDegraded(`request timed out: ${method}`);
        reject(contractError('outcome_unknown', `ACP request timed out: ${method}`));
      }, timeoutMs);

      const entry: PendingRpc = {
        method,
        resolve,
        reject,
        timer,
        ...(onSuccess !== undefined ? { onSuccess } : {}),
      };
      this.pending.set(id, entry);

      if (!writeNdjsonLine(proc, payload)) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.markDegraded('send failed');
        reject(contractError('outcome_unknown', `failed to send ACP request: ${method}`));
      }
    });
  }

  private sendServerResponse(
    expectedGeneration: number,
    rpcId: JsonRpcId,
    body: { result: unknown } | { error: JsonRpcErrorPayload },
  ): void {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0) {
      throw contractError('invalid_request', 'expectedGeneration must be a positive integer');
    }
    if (!isJsonRpcId(rpcId)) {
      throw contractError('invalid_request', 'invalid JSON-RPC id');
    }
    if (expectedGeneration !== this._connectionGeneration) {
      throw contractError('interaction_expired', 'connection generation mismatch');
    }
    const proc = this.child;
    if (!this.connected || !proc || this.activeGeneration !== expectedGeneration) {
      throw contractError('interaction_expired', 'ACP connection is not active for this generation');
    }

    const key = rpcIdKey(rpcId);
    if (this.respondedServerRequestKeys.has(key)) {
      throw contractError('idempotency_conflict', 'server request already responded');
    }
    const pendingReq = this.pendingServerRequests.get(key);
    if (!pendingReq || pendingReq.generation !== expectedGeneration) {
      throw contractError('interaction_expired', 'unknown or expired server request');
    }

    this.pendingServerRequests.delete(key);
    this.respondedServerRequestKeys.add(key);

    const payload = { jsonrpc: '2.0', id: rpcId, ...body };
    if (!writeNdjsonLine(proc, payload)) {
      this.markDegraded('send failed');
      throw contractError('outcome_unknown', 'failed to write ACP server response');
    }
  }

  private handleStdoutLine(proc: ChildProcess, line: string): void {
    if (this.child !== proc) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.markDegraded('invalid ACP JSON message');
      return;
    }
    if (!isRecord(parsed)) {
      this.markDegraded('invalid ACP message envelope');
      return;
    }

    const hasMethod = typeof parsed.method === 'string' && parsed.method.length > 0;
    const hasId = parsed.id !== undefined && parsed.id !== null;

    if (!hasMethod && typeof parsed.id === 'number' && this.pending.has(parsed.id)) {
      const entry = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      clearTimeout(entry.timer);

      if ('error' in parsed && parsed.error !== undefined && parsed.error !== null) {
        const errPayload: JsonRpcErrorPayload = isRecord(parsed.error)
          ? {
              code: typeof parsed.error.code === 'number' ? parsed.error.code : -32000,
              message: typeof parsed.error.message === 'string' ? parsed.error.message : 'ACP JSON-RPC error',
              ...(parsed.error.data !== undefined ? { data: parsed.error.data } : {}),
            }
          : { code: -32000, message: String(parsed.error) };
        entry.reject(mapJsonRpcError(errPayload));
        return;
      }

      if (entry.onSuccess) {
        try {
          entry.onSuccess(parsed.result);
        } catch (err) {
          entry.reject(err);
          return;
        }
      } else if (this._status === 'degraded') {
        this.markHealthy();
      }
      entry.resolve(parsed.result);
      return;
    }

    if (!this.established || this.activeGeneration === null) {
      return;
    }

    const generation = this.activeGeneration;

    if (hasMethod && hasId) {
      if (!isJsonRpcId(parsed.id)) {
        this.markDegraded('invalid server request id');
        return;
      }
      const method = parsed.method as string;
      const key = rpcIdKey(parsed.id);
      if (!SERVER_REQUEST_METHODS.has(method)) {
        writeNdjsonLine(proc, {
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        return;
      }
      if (this.pendingServerRequests.has(key) || this.respondedServerRequestKeys.has(key)) {
        writeNdjsonLine(proc, {
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32600, message: 'Duplicate server request id' },
        });
        return;
      }
      const req: PendingServerRequest = {
        generation,
        rpcId: parsed.id,
        method: method as AgyServerRequestMethod,
      };
      this.pendingServerRequests.set(key, req);
      try {
        this.onServerRequest({
          generation,
          rpcId: parsed.id,
          method: method as AgyServerRequestMethod,
          params: parsed.params,
        });
      } catch {}
      return;
    }

    if (hasMethod && !hasId) {
      try {
        this.onNotification({
          generation,
          method: parsed.method as string,
          params: parsed.params,
        });
      } catch {}
    }
  }

  private handleProcessDrop(proc: ChildProcess, reason: string): void {
    if (this.child !== proc) return;
    const wasEstablished = this.established;
    const generation = this.activeGeneration;

    this.child = null;
    this.established = false;
    this.activeGeneration = null;
    this.pendingServerRequests.clear();

    this.markDegraded(reason);
    const pendingError = wasEstablished
      ? contractError('outcome_unknown', reason)
      : contractError('temporarily_unavailable', reason);
    this.rejectAllPending(pendingError);

    if (wasEstablished && generation !== null) {
      this.emitDisconnectOnce(proc, generation, reason);
    }
  }

  private emitDisconnectOnce(proc: ChildProcess, generation: number, reason: string): void {
    if (this.disconnectEmittedForProc === proc) return;
    this.disconnectEmittedForProc = proc;
    try {
      this.onDisconnect(generation, reason);
    } catch {}
  }

  private rejectAllPending(error: ContractError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private markHealthy(): void {
    this._status = 'healthy';
    this.lastError = null;
    this.updatedAt = new Date().toISOString();
    try {
      this.onHealth('healthy', null);
    } catch {}
  }

  private markDegraded(reason: string): void {
    this._status = 'degraded';
    this.lastError = reason;
    this.updatedAt = new Date().toISOString();
    try {
      this.onHealth('degraded', reason);
    } catch {}
  }

  private formatExitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) return `ACP process exited on signal ${signal}`;
    if (code !== null) return `ACP process exited with code ${code}`;
    return 'ACP process closed';
  }
}

/**
 * Runner for `agy -p= --input-format stream-json --output-format stream-json`.
 * Parses NDJSON `init`, `step_update`, and `result` events line by line and supports cancellation.
 */
export class AgyStreamJsonRunner {
  private readonly agyBin: string;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly closeTimeoutMs: number;

  private child: ChildProcess | null = null;
  private waitPromise: Promise<AgyStreamRunResult> | null = null;
  private cancelPromise: Promise<void> | null = null;
  private _cancelled = false;
  private cancelReason = 'stream-json run cancelled';

  constructor(private readonly options: AgyStreamJsonRunnerOptions = {}) {
    this.agyBin = resolveBin(options.agyBin);
    this.defaultTimeoutMs =
      options.timeoutMs === undefined ? undefined : resolvePositiveMs(options.timeoutMs, 60_000, 'timeoutMs');
    this.closeTimeoutMs = resolvePositiveMs(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 'closeTimeoutMs');
  }

  get running(): boolean {
    return this.child !== null && this.waitPromise !== null;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  buildArgs(): string[] {
    return buildAgyStreamJsonArgs(this.options);
  }

  /**
   * Run a prompt to completion via stream-json, returning collected `init`,
   * `step_update`s, `result`, and parsed `events`.
   */
  async run(content: AgyStreamInputContent, runOptions: AgyStreamRunOptions = {}): Promise<AgyStreamRunResult> {
    if (this.running) {
      throw contractError('busy', 'stream-json runner is already active');
    }
    if (runOptions.signal?.aborted) {
      throw makeTransportError('outcome_unknown', 'stream-json run aborted before start', { cancelled: true });
    }

    const args = this.buildArgs();
    const effectiveTimeout =
      runOptions.timeoutMs !== undefined
        ? resolvePositiveMs(runOptions.timeoutMs, 60_000, 'timeoutMs')
        : this.defaultTimeoutMs;

    this._cancelled = false;
    this.cancelReason = 'stream-json run cancelled';
    this.cancelPromise = null;

    const proc = spawn(this.agyBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    });
    this.child = proc;

    const events: AgyStreamEvent[] = [];
    const steps: AgyStreamStepUpdatePayload[] = [];
    const stderrLines: string[] = [];
    let conversationId: string | null = null;
    let init: AgyStreamInitPayload | null = null;
    let result: AgyStreamResultPayload | null = null;

    const emitEvent = (ev: AgyStreamEvent) => {
      events.push(ev);
      if (ev.conversation_id) {
        conversationId = ev.conversation_id;
      }
      if (ev.event === 'init') {
        init = ev.init;
      } else if (ev.event === 'step_update') {
        steps.push(ev.step_update);
      } else if (ev.event === 'result') {
        result = ev.result;
      }
      try {
        runOptions.onEvent?.(ev);
      } catch {}
      try {
        this.options.onEvent?.(ev);
      } catch {}
    };

    const stdoutParser = createLineParser(line => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        try {
          this.options.onParseError?.(line, err);
        } catch {}
        return;
      }
      if (!isRecord(parsed)) return;
      emitEvent(normalizeStreamEvent(parsed));
    });

    const stderrParser = createLineParser(line => {
      stderrLines.push(line);
      try {
        this.options.onStderr?.(line);
      } catch {}
    });

    proc.stdin?.on('error', () => {});
    proc.stdout?.on('data', chunk => stdoutParser.push(chunk));
    proc.stderr?.on('data', chunk => stderrParser.push(chunk));

    const runPromise = new Promise<AgyStreamRunResult>((resolve, reject) => {
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let exitFallbackTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (exitFallbackTimer) clearTimeout(exitFallbackTimer);
        runOptions.signal?.removeEventListener('abort', onAbort);
        if (this.child === proc) {
          this.child = null;
        }
        this.waitPromise = null;
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        void this.cancel('stream-json run aborted');
      };

      if (runOptions.signal) {
        runOptions.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (effectiveTimeout !== undefined) {
        timeoutTimer = setTimeout(() => {
          void this.cancel('stream-json run timed out');
        }, effectiveTimeout);
      }

      proc.on('error', err => {
        fail(makeTransportError('temporarily_unavailable', `failed to spawn agy stream-json: ${err.message}`));
      });

      const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        stdoutParser.flush();
        stderrParser.flush();

        if (this._cancelled) {
          fail(
            makeTransportError('outcome_unknown', this.cancelReason, {
              cancelled: true,
              exitCode: code,
              signal,
              ...(stderrLines.length > 0 ? { stderr: stderrLines.join('\n') } : {}),
            }),
          );
          return;
        }

        if (code !== 0) {
          const stderrText = stderrLines.join('\n');
          const errCode: ErrorCode = code === 2 ? 'invalid_request' : 'temporarily_unavailable';
          const msg = stderrText || `agy stream-json exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`;
          fail(
            makeTransportError(errCode, msg, {
              exitCode: code,
              signal,
              ...(stderrText ? { stderr: stderrText } : {}),
            }),
          );
          return;
        }

        settled = true;
        cleanup();
        resolve({
          conversationId,
          init,
          steps,
          result,
          events,
          exitCode: code,
          signal,
        });
      };

      proc.on('exit', (code, signal) => {
        if (!exitFallbackTimer) {
          exitFallbackTimer = setTimeout(() => finalize(code, signal), 50);
        }
      });

      proc.on('close', (code, signal) => {
        if (exitFallbackTimer) clearTimeout(exitFallbackTimer);
        finalize(code, signal);
      });
    });

    this.waitPromise = runPromise;
    runPromise.catch(() => {});

    const inputPayload = {
      event: 'user',
      message: { content },
    };
    if (!writeNdjsonLine(proc, inputPayload)) {
      await this.cancel('failed to write stream-json input');
      return await runPromise;
    }
    if (runOptions.endInput !== false && proc.stdin && !proc.stdin.destroyed) {
      try {
        proc.stdin.end();
      } catch {}
    }

    return await runPromise;
  }

  /** Write an additional user turn message when running with `endInput: false`. */
  sendUserMessage(content: AgyStreamInputContent): void {
    const proc = this.child;
    if (!proc || !this.running || this._cancelled) {
      throw contractError('temporarily_unavailable', 'stream-json runner is not active');
    }
    if (!writeNdjsonLine(proc, { event: 'user', message: { content } })) {
      throw contractError('outcome_unknown', 'failed to write user message to stream-json stdin');
    }
  }

  /** End stdin on an active multi-turn stream-json process so it completes and exits. */
  endInput(): void {
    const proc = this.child;
    if (proc?.stdin && !proc.stdin.destroyed) {
      try {
        proc.stdin.end();
      } catch {}
    }
  }

  /** Idempotently cancel and terminate any running `stream-json` subprocess (SIGTERM -> SIGKILL). */
  async cancel(reason = 'stream-json run cancelled'): Promise<void> {
    if (this.cancelPromise !== null) {
      return this.cancelPromise;
    }
    const proc = this.child;
    if (!proc) {
      return;
    }
    this._cancelled = true;
    this.cancelReason = reason;
    const cancelling = terminateChildProcess(proc, 0, this.closeTimeoutMs, true).then(() => {});
    this.cancelPromise = cancelling;
    try {
      await cancelling;
    } finally {
      if (this.cancelPromise === cancelling) {
        this.cancelPromise = null;
      }
    }
  }
}

function normalizeStreamEvent(raw: Record<string, unknown>): AgyStreamEvent {
  const eventName = typeof raw.event === 'string' ? raw.event : '';
  const topConvId = nonEmptyString(raw.conversation_id);

  if (eventName === 'init') {
    const init = isRecord(raw.init) ? (raw.init as AgyStreamInitPayload) : {};
    return {
      event: 'init',
      ...(topConvId !== undefined ? { conversation_id: topConvId } : {}),
      init,
      raw,
    };
  }

  if (eventName === 'step_update') {
    const step = isRecord(raw.step_update) ? (raw.step_update as AgyStreamStepUpdatePayload) : {};
    const convId = topConvId ?? nonEmptyString(step.conversation_id);
    return {
      event: 'step_update',
      ...(convId !== undefined ? { conversation_id: convId } : {}),
      step_update: step,
      raw,
    };
  }

  if (eventName === 'result') {
    const res = isRecord(raw.result) ? (raw.result as AgyStreamResultPayload) : {};
    const convId = topConvId ?? nonEmptyString(res.conversation_id);
    return {
      event: 'result',
      ...(convId !== undefined ? { conversation_id: convId } : {}),
      result: res,
      raw,
    };
  }

  return {
    event: 'other',
    eventType: eventName,
    ...(topConvId !== undefined ? { conversation_id: topConvId } : {}),
    raw,
  };
}
