import { spawn, type ChildProcess } from 'node:child_process';
import { contractError, type ErrorCode } from '../errors.js';
import {
  buildAgyStreamJsonArgs,
  createLineParser,
  DEFAULT_CLOSE_TIMEOUT_MS,
  isRecord,
  makeTransportError,
  nonEmptyString,
  resolveBin,
  resolvePositiveMs,
  terminateChildProcess,
  trackAgyChildForExit,
  writeNdjsonLine,
  type AgyStreamEvent,
  type AgyStreamInitPayload,
  type AgyStreamInputContent,
  type AgyStreamJsonRunnerOptions,
  type AgyStreamResultPayload,
  type AgyStreamRunOptions,
  type AgyStreamRunResult,
  type AgyStreamStepUpdatePayload,
} from './transport-common.js';

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
      detached: process.platform !== 'win32',
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    });
    trackAgyChildForExit(proc);
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
