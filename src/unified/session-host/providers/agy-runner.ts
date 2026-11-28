import type { ApprovalScope } from '../../approval-policy.js';
import { AgyAdapter } from '../../agy/adapter.js';
import { AgyCatalog } from '../../agy-catalog.js';
import { AgyQuotaClient } from '../../agy-quota.js';
import { AgyAcpTransport } from '../../agy-transport.js';
import type { NativeSessionRef } from '../../contracts.js';
import { AdapterSessionHostRunner } from '../hosted-port.js';
import type { RunnerContext } from '../server.js';

export interface AgySessionHostOptions {
  hostId: string;
  serviceId: string;
  ref?: NativeSessionRef;
  transport?: Omit<NonNullable<ConstructorParameters<typeof AgyAcpTransport>[0]>, 'env' | 'onStderr'>;
  catalog?: ConstructorParameters<typeof AgyCatalog>[0];
  quota?: ConstructorParameters<typeof AgyQuotaClient>[0];
  adapterOptions?: Pick<NonNullable<ConstructorParameters<typeof AgyAdapter>[5]>,
    'promptMaxTimeoutMs' | 'promptIdleTimeoutMs' | 'wakeupIdleMs'>;
  approvalPolicy?: ApprovalScope;
  createAdapter?: (options: NonNullable<ConstructorParameters<typeof AgyAdapter>[5]>) => AgyAdapter;
}

export class AgySessionHostRunner extends AdapterSessionHostRunner {
  private readonly agy: AgyAdapter;
  private sweep?: NodeJS.Timeout;

  constructor(options: AgySessionHostOptions) {
    let notify: (() => void) | undefined;
    const adapterOptions = {
      ...options.adapterOptions, disableIdleSweep: true,
      approvalPolicy: { enabled: false, ...options.approvalPolicy },
      onHostedStateChange: () => notify?.(),
    };
    const transport = options.transport;
    // Keep bootstrap configuration limited to the provider's arguments and locations.
    const adapter = options.createAdapter?.(adapterOptions) ?? new AgyAdapter(
      new AgyAcpTransport({
        ...transport, env: process.env, sandbox: transport?.sandbox ?? true, defaultMode: transport?.defaultMode ?? 'auto',
      }),
      new AgyCatalog(options.catalog), options.hostId, options.serviceId,
      options.quota ? new AgyQuotaClient(options.quota) : undefined, adapterOptions,
    );
    super(adapter, options.ref);
    this.agy = adapter;
    notify = () => this.refreshState();
  }

  override start(context: RunnerContext): void {
    super.start(context);
    this.sweep = setInterval(() => {
      if (this.ref) this.agy.reconcileHostedTurns(this.ref);
      this.refreshState();
    }, 5_000).unref();
  }

  protected override connectProvider(): Promise<void> {
    return this.agy.transport.connected ? Promise.resolve() : this.agy.transport.connect().then(() => {});
  }

  protected inspect(ref: NativeSessionRef) { return this.agy.exportHostedState(ref); }

  override async stop(): Promise<void> {
    clearInterval(this.sweep);
    await super.stop();
  }
}
