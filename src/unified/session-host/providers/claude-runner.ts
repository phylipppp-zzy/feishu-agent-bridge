import { query, listSessions, getSessionMessages, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalScope } from '../../approval-policy.js';
import { ClaudeAdapter } from '../../claude-adapter.js';
import type { NativeSessionRef } from '../../contracts.js';
import { AdapterSessionHostRunner, type NativeRunnerState } from '../hosted-port.js';

type SDK = NonNullable<ConstructorParameters<typeof ClaudeAdapter>[3]>;

export interface ClaudeSessionHostOptions {
  hostId: string;
  serviceId: string;
  ref?: NativeSessionRef;
  stateDir: string;
  registryPath: string;
  claudeBin?: string;
  sdk?: SDK;
  approvalPolicy?: ApprovalScope;
}

/** Observe background task levels as the SDK iterator delivers them to ClaudeAdapter. */
function observeQuery(native: Query, observe: (message: SDKMessage) => void): Query {
  return new Proxy(native, {
    get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        for await (const message of target) {
          yield message;
          observe(message);
        }
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class ClaudeSessionHostRunner extends AdapterSessionHostRunner {
  private readonly tasks = new Set<string>();
  private tasksUnknown = false;

  constructor(options: ClaudeSessionHostOptions) {
    const sdk = options.sdk ?? { query, listSessions, getSessionMessages };
    let observe: ((message: SDKMessage) => void) | undefined;
    const path = process.env.FEISHU_SESSION_HOST_REGISTRY_DB;
    // ClaudeAdapter constructs ClaudeState synchronously. Scope the opt-in to construction
    // so SDK subprocesses and other adapters do not inherit this registry setting.
    process.env.FEISHU_SESSION_HOST_REGISTRY_DB = options.registryPath;
    let adapter: ClaudeAdapter;
    try {
      adapter = new ClaudeAdapter(options.hostId, options.serviceId, options.stateDir, {
        ...sdk, query: args => observeQuery(sdk.query(args), message => observe?.(message)),
      }, options.claudeBin, { approvalPolicy: { enabled: false, ...options.approvalPolicy } });
    } finally {
      if (path === undefined) delete process.env.FEISHU_SESSION_HOST_REGISTRY_DB;
      else process.env.FEISHU_SESSION_HOST_REGISTRY_DB = path;
    }
    super(adapter, options.ref);
    observe = message => this.observeBackground(message);
  }

  protected inspect(ref: NativeSessionRef): NativeRunnerState {
    const live = this.adapter.hasActiveNativeSession?.(ref) === true;
    return {
      pendingSubagent: live && this.tasks.size > 0,
      hasResidual: live && this.tasks.size > 0,
      residualUnknown: this.tasksUnknown || (!live && this.tasks.size > 0),
    };
  }

  private observeBackground(message: SDKMessage): void {
    if (message.type !== 'system' || message.session_id !== this.ref?.nativeSessionId) return;
    // SDK versions can add system subtypes independently of the TypeScript union.
    const event = message as unknown as Record<string, unknown>;
    if (event.subtype === 'background_tasks_changed') {
      if (Array.isArray(event.tasks) && event.tasks.every(task => task && typeof task.task_id === 'string' && task.task_id)) {
        this.tasks.clear();
        for (const task of event.tasks) this.tasks.add(task.task_id);
        this.tasksUnknown = false;
      } else this.tasksUnknown = true;
    } else if (event.subtype === 'task_started' || event.subtype === 'task_notification' || event.subtype === 'task_updated') {
      if (typeof event.task_id !== 'string' || !event.task_id) this.tasksUnknown = true;
      else if (event.subtype === 'task_started') this.tasks.add(event.task_id);
      else if (event.subtype === 'task_notification' && ['completed', 'failed', 'stopped'].includes(String(event.status))) {
        this.tasks.delete(event.task_id);
      } else if (event.subtype === 'task_updated' && event.patch && typeof event.patch === 'object' &&
          ('is_backgrounded' in event.patch && event.patch.is_backgrounded === true ||
           'status' in event.patch && ['running', 'pending'].includes(String(event.patch.status)))) {
        this.tasks.add(event.task_id);
      }
    } else return;
    this.refreshState();
  }
}
