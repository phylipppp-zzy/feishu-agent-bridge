import { spawn, type ChildProcess } from 'node:child_process';
import { contractError, type ContractError } from '../errors.js';
import {
  buildAgyAcpArgs,
  createLineParser,
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isJsonRpcId,
  isRecord,
  mapJsonRpcError,
  resolveBin,
  resolvePositiveMs,
  rpcIdKey,
  SERVER_REQUEST_METHODS,
  terminateChildProcess,
  writeNdjsonLine,
  type AgyAcpHealthSnapshot,
  type AgyAcpNotification,
  type AgyAcpTransportOptions,
  type AgyAgentCapabilities,
  type AgyAuthMethod,
  type AgyHealthStatus,
  type AgyInitializeResult,
  type AgyServerRequest,
  type AgyServerRequestMethod,
  type JsonRpcErrorPayload,
  type JsonRpcId,
} from './transport-common.js';

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
  respondServerRequest(expectedGeneration: number, rpcId: JsonRpcId, result: unknown, beforeWrite?: () => void): Promise<void> {
    const { stdin, line } = this.claimServerResponse(expectedGeneration, rpcId, { result }, beforeWrite);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (reason) {
          if (this.connected && this.connectionGeneration === expectedGeneration) this.markDegraded(reason);
          reject(contractError('outcome_unknown', reason));
        } else resolve();
      };
      const timer = setTimeout(() => finish('ACP server response write receipt timed out'), this.requestTimeoutMs);
      try {
        stdin.write(line, 'utf8', error => finish(error ? 'failed to write ACP server response' : undefined));
      } catch {
        finish('failed to write ACP server response');
      }
    });
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
    const { stdin, line } = this.claimServerResponse(expectedGeneration, rpcId, {
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
    try {
      stdin.write(line, 'utf8');
    } catch {
      this.markDegraded('send failed');
      throw contractError('outcome_unknown', 'failed to write ACP server error');
    }
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

  private claimServerResponse(
    expectedGeneration: number,
    rpcId: JsonRpcId,
    body: { result: unknown } | { error: JsonRpcErrorPayload },
    beforeWrite?: () => void,
  ) {
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
    const stdin = proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw contractError('interaction_expired', 'ACP response stream is no longer writable');
    }
    const line = `${JSON.stringify({ jsonrpc: '2.0', id: rpcId, ...body })}\n`;

    beforeWrite?.();
    this.pendingServerRequests.delete(key);
    this.respondedServerRequestKeys.add(key);
    return { stdin, line };
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
