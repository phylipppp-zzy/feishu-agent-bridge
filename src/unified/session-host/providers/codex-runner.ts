import type { ApprovalScope } from '../../approval-policy.js';
import { CodexAdapter } from '../../codex-adapter.js';
import { CodexTransport } from '../../codex-transport.js';
import type { NativeSessionRef, TurnResidual } from '../../contracts.js';
import { AdapterSessionHostRunner, type NativeRunnerState } from '../hosted-port.js';
import type { RunnerContext } from '../server.js';

export interface CodexSessionHostOptions {
  hostId: string;
  serviceId: string;
  ref?: NativeSessionRef;
  codexEndpoint: string;
  approvalPolicy?: ApprovalScope;
  createAdapter?: () => CodexAdapter;
}

export class CodexSessionHostRunner extends AdapterSessionHostRunner {
  private readonly codex: CodexAdapter;
  private readonly residual = new Map<string, TurnResidual['status']>();
  private probe?: NodeJS.Timeout;
  private checking = false;

  constructor(options: CodexSessionHostOptions) {
    const adapter = options.createAdapter?.() ?? new CodexAdapter(
      new CodexTransport(options.codexEndpoint), options.hostId, options.serviceId,
      { approvalPolicy: { enabled: false, ...options.approvalPolicy } },
    );
    super(adapter, options.ref);
    this.codex = adapter;
  }

  override start(context: RunnerContext): void {
    super.start(context);
    this.probe = setInterval(() => { void this.refreshResidual(); }, 1_000).unref();
  }

  protected override connectProvider(): Promise<void> {
    return this.codex.transport.connected ? Promise.resolve() : this.codex.transport.connect();
  }

  protected inspect(ref: NativeSessionRef): NativeRunnerState {
    const state = this.codex.exportHostedState(ref);
    const statuses = state.residualTurnIds.map(id => this.residual.get(id) ?? 'unknown');
    return {
      ...state, hasResidual: statuses.includes('running'),
      residualUnknown: state.residualUnknown || statuses.includes('unknown') ||
        (!this.codex.transport.connected && state.residualTurnIds.length > 0),
    };
  }

  private async refreshResidual(): Promise<void> {
    const ref = this.ref;
    if (!ref || this.checking || !this.codex.hasActiveNativeSession(ref)) return;
    const turns = this.codex.exportHostedState(ref).residualTurnIds;
    if (!turns.length) return;
    this.checking = true;
    try {
      for (const id of turns) this.residual.set(id, (await this.codex.inspectTurnResidual(ref, id)).status);
      this.refreshState();
    } finally {
      this.checking = false;
    }
  }

  override async stop(): Promise<void> {
    clearInterval(this.probe);
    await super.stop();
    this.codex.transport.close();
  }
}
