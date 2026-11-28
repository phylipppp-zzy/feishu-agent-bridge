import { randomUUID } from 'node:crypto';
import { closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ApprovalScope } from '../approval-policy.js';
import type { NativeSessionRef } from '../contracts.js';
import { AgySessionHostRunner, type AgySessionHostOptions } from './providers/agy-runner.js';
import { ClaudeSessionHostRunner } from './providers/claude-runner.js';
import { CodexSessionHostRunner } from './providers/codex-runner.js';
import { SessionHostJournal } from './journal.js';
import { acquireFileLock, clearStaleHost, processStamp, sessionHostUnit } from './launcher.js';
import {
  counter, HostError, json, nonce, object, parseJson, privateDirectory, readPrivateFile,
  runtimePaths, sha256, string, writePrivateAtomic, type Fields, type HostMetadata,
} from './protocol.js';
import { hostPinId, SessionHostRegistry, type InstanceState } from './registry.js';
import { SessionHostServer, type RunnerCommand, type RunnerContext, type SessionHostRunner } from './server.js';

export interface HostMainOptions {
  provider: string;
  key: string;
  runtimeDir: string;
  stateDir: string;
  releaseDir: string;
  configFile?: string;
}

function parseArguments(argv: readonly string[]): HostMainOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === undefined || !['--provider', '--key', '--runtime-dir', '--state-dir', '--release-dir', '--config-file'].includes(flag)
        || values.has(flag)) throw new HostError('invalid_request', 'invalid host arguments');
    values.set(flag, string(argv[i + 1], flag));
  }
  const read = (flag: string) => string(values.get(flag), flag);
  const configFile = values.get('--config-file');
  return {
    provider: read('--provider'), key: read('--key'), runtimeDir: read('--runtime-dir'),
    stateDir: read('--state-dir'), releaseDir: read('--release-dir'),
    ...(configFile ? { configFile } : {}),
  };
}

interface RunnerBootstrap {
  hostId: string;
  serviceId: string;
  ref?: NativeSessionRef;
  registryPath: string;
}

export async function runSessionHost(
  options: HostMainOptions,
  createRunner: (provider: string, config: Fields, bootstrap: RunnerBootstrap) => SessionHostRunner = createProviderRunner,
): Promise<void> {
  process.umask(0o077);
  const paths = runtimePaths(options.runtimeDir, options.key);
  privateDirectory(options.runtimeDir, true);
  const inherited = process.env.FEISHU_SESSION_HOST_LOCK_FD;
  if (inherited !== undefined && inherited !== '3') throw new HostError('unauthorized', 'invalid detached lock descriptor');
  const systemd = process.env.INVOCATION_ID !== undefined && inherited === undefined;
  if (!systemd && inherited === undefined && process.env.NODE_ENV !== 'test') {
    throw new HostError('unauthorized', 'host must be started through its launcher');
  }
  const lock = acquireFileLock(paths.lock, inherited === '3' ? 3 : undefined);
  if (lock === null) throw new HostError('busy', 'session host lock is held');
  try {
    const registry = new SessionHostRegistry(resolve(options.stateDir));
    try {
      const reserved = registry.getIdentity(options.key);
      const identity = reserved?.identity;
      if (!reserved || !identity) throw new HostError('identity_mismatch', 'host key was not reserved');
      const [provider, hostId, serviceId] = identity.length === 4 ? identity : [identity[1], identity[2], identity[3]];
      if (options.provider !== provider) throw new HostError('identity_mismatch', 'provider differs from reservation');
      const releaseDir = resolve(options.releaseDir);
      if (!registry.listActivePins().some(pin => pin.pinId === hostPinId(options.key, releaseDir)
          && pin.key === options.key && pin.releaseDir === releaseDir && pin.reason === 'session-host')) {
        throw new HostError('invalid_request', 'host release must be pinned before startup');
      }
      await clearStaleHost(paths, options.key, registry, releaseDir, process.pid);
      const config = options.configFile ? object(parseJson(new TextDecoder('utf-8', { fatal: true })
        .decode(readPrivateFile(options.configFile)))) : {};
      const stamp = processStamp(process.pid);
      if (!stamp) throw new Error('host process is absent from procfs');
      const secret = nonce();
      const keyBytes = Buffer.from(secret, 'hex');
      const metadata: HostMetadata = {
        pid: process.pid, unit: systemd ? sessionHostUnit(options.key) + '.service' : null,
        releaseDir, protocolVersion: 1, provider, sessionId: reserved.ref?.[3] ?? null, hostId, serviceId,
        instanceId: randomUUID(), startedAt: new Date().toISOString(), ...stamp, keyId: sha256(keyBytes),
      };
      const tuning: { idleTimeoutMs?: number; heartbeatMs?: number; maxRingEntries?: number; maxRingBytes?: number } = {};
      for (const name of ['idleTimeoutMs', 'heartbeatMs', 'maxRingEntries', 'maxRingBytes'] as const) {
        if (config[name] !== undefined) tuning[name] = counter(config[name], name, 1);
      }
      const journal = new SessionHostJournal(options.stateDir, options.key);
      try {
        registry.upsertInstance(options.key, metadata, 'starting');
        const runner = createRunner(provider, config, {
          hostId, serviceId, registryPath: registry.path,
          ...(reserved.ref ? { ref: { provider: provider as NativeSessionRef['provider'], hostId, serviceId,
            nativeSessionId: reserved.ref[3] } } : {}),
        });
        writePrivateAtomic(paths.secret, secret);
        let state: InstanceState = 'ready';
        let published = false;
        const server = new SessionHostServer({
          runtimeDir: options.runtimeDir, key: options.key, ref: reserved.ref, instanceId: metadata.instanceId,
          releaseDir, secret: keyBytes, journal, runner, ...tuning,
          bindNativeSession: nativeId => {
            const ref = registry.bindCreateToNativeSession(options.key, nativeId);
            metadata.sessionId = nativeId;
            if (published) {
              writePrivateAtomic(paths.metadata, json(metadata));
              registry.markInstanceState(options.key, state, metadata.instanceId);
            }
            return ref;
          },
          onState: value => {
            state = value;
            if (metadata.sessionId !== null) registry.markInstanceState(options.key, state, metadata.instanceId);
          },
          isReleaseRetired: () => registry.getInstanceByKey(options.key)?.state === 'draining',
          onError: error => console.error('Session host internal failure (' + (error instanceof HostError ? error.code : 'internal') + ')'),
        });
        const shutdown = () => { void server.close(); };
        try {
          await server.listen();
          writePrivateAtomic(paths.metadata, json(metadata));
          published = true;
          if (metadata.sessionId !== null) registry.markInstanceState(options.key, state, metadata.instanceId);
          process.once('SIGTERM', shutdown);
          process.once('SIGINT', shutdown);
          await server.closed;
          unlinkSync(paths.metadata);
          unlinkSync(paths.secret);
          registry.finishInstance(options.key, metadata.instanceId, releaseDir);
        } finally {
          process.removeListener('SIGTERM', shutdown);
          process.removeListener('SIGINT', shutdown);
          await server.close();
        }
      } finally {
        journal.close();
      }
    } finally {
      registry.close();
    }
  } finally {
    closeSync(lock);
  }
}

function createProviderRunner(provider: string, config: Fields, bootstrap: RunnerBootstrap): SessionHostRunner {
  if (provider !== 'agy' && provider !== 'claude' && provider !== 'codex') return createTestRunner(provider);
  const approval = config.approvalPolicy === undefined ? {} : object(config.approvalPolicy);
  const approvalPolicy: ApprovalScope = { ...approval, enabled: approval.enabled === true };
  if (provider === 'agy') {
    return new AgySessionHostRunner({
      ...bootstrap, approvalPolicy,
      ...(config.transport === undefined ? {} : { transport: object(config.transport) as NonNullable<AgySessionHostOptions['transport']> }),
      ...(config.catalog === undefined ? {} : { catalog: object(config.catalog) }),
      ...(config.quota === undefined ? {} : { quota: object(config.quota) }),
      ...(config.adapterOptions === undefined ? {} : { adapterOptions: object(config.adapterOptions) }),
    });
  }
  if (provider === 'claude') {
    return new ClaudeSessionHostRunner({
      ...bootstrap, approvalPolicy, stateDir: string(config.claudeStateDir, 'claudeStateDir'),
      ...(config.claudeBin === undefined ? {} : { claudeBin: string(config.claudeBin, 'claudeBin') }),
    });
  }
  return new CodexSessionHostRunner({
    ...bootstrap, approvalPolicy, codexEndpoint: string(config.codexEndpoint, 'codexEndpoint'),
  });
}

function createTestRunner(provider: string): SessionHostRunner {
  if ((provider !== 'echo' && provider !== 'mock')
      || (process.env.FEISHU_SESSION_HOST_ALLOW_TEST_RUNNER !== '1' && process.env.NODE_ENV !== 'test')) {
    throw new HostError('temporarily_unavailable', 'provider runner is not installed');
  }
  return new EchoRunner();
}

class EchoRunner implements SessionHostRunner {
  readonly capabilities = { echo: true, attachments: true, steer: 'unsupported' };
  private readonly timers = new Set<NodeJS.Timeout>();

  validateCommand(command: RunnerCommand): void {
    if (!['echo', 'pending', 'resolve', 'schedule', 'create'].includes(command.kind)) {
      throw new HostError('invalid_request', 'unsupported test runner command');
    }
    if (command.kind === 'echo') return;
    const args = object(command.args);
    if (command.kind === 'create') string(args.nativeSessionId, 'nativeSessionId');
    if (command.kind === 'pending' || command.kind === 'resolve') string(args.id, 'interaction id');
    if (command.kind === 'schedule') counter(args.delayMs, 'delayMs', 1);
  }

  execute(command: RunnerCommand, context: RunnerContext): unknown {
    const state = context.getState();
    switch (command.kind) {
      case 'echo': {
        const attachment = command.attachment
          ? { byteLength: command.attachment.byteLength, sha256: sha256(command.attachment) } : null;
        context.emit({ type: 'echo', value: command.args, attachment });
        return { value: command.args, attachment };
      }
      case 'pending': {
        const args = object(command.args);
        const interaction = { id: string(args.id, 'interaction id'), prompt: args.prompt ?? null };
        if (state.pendingInteraction !== null) return { accepted: false, reason: 'interaction already pending' };
        context.emit({ type: 'pending', interaction }, { state: { ...state, pendingInteraction: interaction } });
        return { accepted: true };
      }
      case 'resolve': {
        const args = object(command.args);
        if (state.pendingInteraction === null || args.id !== object(state.pendingInteraction).id) {
          return { resolved: false };
        }
        context.emit({ type: 'resolved', id: args.id, answer: args.answer ?? null }, {
          terminal: true, state: { ...state, pendingInteraction: null },
        });
        return { resolved: true };
      }
      case 'schedule': {
        const args = object(command.args);
        const delay = counter(args.delayMs, 'delayMs', 1);
        if (delay > 60_000 || state.pendingWakeup) return { scheduled: false };
        context.setState({ ...state, pendingWakeup: true });
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          context.emit({ type: 'scheduled', value: args.value ?? null }, {
            terminal: true, state: { ...context.getState(), pendingWakeup: false },
          });
        }, delay);
        this.timers.add(timer);
        return { scheduled: true };
      }
      case 'create':
        return { ref: context.bindNativeSession(string(object(command.args).nativeSessionId, 'nativeSessionId')) };
      default:
        throw new HostError('invalid_request', 'unsupported test runner command');
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

if (import.meta.main) {
  try {
    await runSessionHost(parseArguments(process.argv.slice(2)));
  } catch (error) {
    // Bootstrap configuration and provider errors may contain secrets.
    console.error('Session host startup/shutdown failed (' + (error instanceof HostError ? error.code : 'internal') + ')');
    process.exitCode = 1;
  }
}
