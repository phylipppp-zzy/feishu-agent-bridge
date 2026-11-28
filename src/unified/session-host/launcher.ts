import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, readFileSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SessionHostClient } from './client.js';
import {
  checkPrivateSocket, counter, currentUid, defaultRuntimeDir, errno, HostError, metadataRef, openPrivateFile,
  privateDirectory, readMetadata, readSecret, runtimePaths, sameRef, sha256, type HostIdentity, type HostMetadata,
  type RuntimePaths,
} from './protocol.js';
import { hostPinId, SessionHostRegistry, type RegisteredInstance, type ReservedIdentity } from './registry.js';

const run = promisify(execFile);
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const FLOCK = '/usr/bin/flock';
const PIN_REASON = 'session-host';

export interface ProcessStamp {
  bootId: string;
  startTicks: string;
}

export function processStamp(pid: number): ProcessStamp | null {
  counter(pid, 'pid', 1);
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  let stat: string;
  try {
    stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  } catch (error) {
    if (errno(error, 'ENOENT') || errno(error, 'ESRCH')) return null;
    throw error;
  }
  // Field 2 is parenthesized and may itself contain spaces or parentheses.
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  if (end < 0 || !startTicks || !/^\d+$/.test(startTicks)) throw new Error('invalid process stat');
  return fields[0] === 'Z' || fields[0] === 'X' ? null : { bootId, startTicks };
}

export function isStampedProcessAlive(record: ProcessStamp & { pid: number }): boolean {
  const actual = processStamp(record.pid);
  return actual !== null && actual.bootId === record.bootId && actual.startTicks === record.startTicks;
}

export function sessionHostUnit(key: string): string {
  return 'feishu-session-host-' + key;
}

/**
 * Linux flock locks the open file description. fd 3 in the helper is a duplicate
 * of the host's fd, so helper exit does not release the lock. Never unlink a lock
 * inode or explicitly unlock a descriptor inherited by a detached child.
 */
export function acquireFileLock(path: string, inheritedFd?: number): number | null {
  const fd = inheritedFd ?? openPrivateFile(path, constants.O_RDWR | constants.O_CREAT);
  try {
    if (inheritedFd !== undefined) {
      const checked = openPrivateFile(path, constants.O_RDWR);
      try {
        const own = fstatSync(fd);
        const expected = fstatSync(checked);
        if (own.dev !== expected.dev || own.ino !== expected.ino) throw new HostError('unauthorized', 'invalid inherited lock');
      } finally {
        closeSync(checked);
      }
    }
    const result = spawnSync(FLOCK, ['--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 2000,
    });
    if (result.error) throw result.error;
    if (result.status === 0) return fd;
    if (result.status === 75) {
      closeSync(fd);
      return null;
    }
    throw new Error('flock failed with status ' + result.status);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function optionalMetadata(paths: RuntimePaths): HostMetadata | undefined {
  try {
    return readMetadata(paths.metadata);
  } catch (error) {
    if (errno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function socketIsLive(path: string): Promise<boolean> {
  try {
    checkPrivateSocket(path);
  } catch (error) {
    if (errno(error, 'ENOENT')) return Promise.resolve(false);
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const done = () => socket.destroy();
    socket.setTimeout(500, () => {
      done();
      reject(new HostError('temporarily_unavailable', 'socket liveness probe timed out'));
    });
    socket.once('connect', () => {
      done();
      resolve(true);
    });
    socket.once('error', error => {
      done();
      if (errno(error, 'ECONNREFUSED') || errno(error, 'ENOENT')) resolve(false);
      else reject(error);
    });
  });
}

async function unitIsLive(unit: string, currentPid?: number): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await run(SYSTEMCTL, [
      '--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=MainPID', unit,
    ], { timeout: 1500, env: baseEnvironment() }));
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'
        && /^LoadState=not-found$/m.test(error.stdout)) return false;
    throw new HostError('temporarily_unavailable', 'systemd unit liveness could not be verified');
  }
  const values = new Map(stdout.trim().split('\n').map(line => {
    const equal = line.indexOf('=');
    return [line.slice(0, equal), line.slice(equal + 1)];
  }));
  if (currentPid !== undefined && values.get('MainPID') === String(currentPid)) return false;
  const active = values.get('ActiveState');
  if (active === 'inactive' || active === 'failed') return false;
  if (active === 'active' || active === 'activating' || active === 'deactivating' || active === 'reloading'
      || active === 'refreshing' || active === 'maintenance') return true;
  throw new HostError('temporarily_unavailable', 'cannot determine systemd unit state');
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!errno(error, 'ENOENT')) throw error;
  }
}

/** Caller holds the runtime flock. A PID mismatch alone is insufficient to remove a socket. */
export async function clearStaleHost(
  paths: RuntimePaths, key: string, registry: SessionHostRegistry, releaseDir: string, currentPid?: number,
): Promise<void> {
  const metadata = optionalMetadata(paths);
  const instance = registry.getInstanceByKey(key);
  const records: (HostMetadata | RegisteredInstance)[] = [
    ...(metadata ? [metadata] : []), ...(instance && instance.state !== 'closed' ? [instance] : []),
  ];
  for (const record of records) {
    if (record.unit && record.unit !== sessionHostUnit(key) + '.service') {
      throw new HostError('identity_mismatch', 'unit name differs from session key');
    }
    if (isStampedProcessAlive(record)) throw new HostError('busy', 'host process is still alive');
  }
  if (await socketIsLive(paths.socket)) throw new HostError('busy', 'socket is still live');
  for (const unit of new Set(records.map(record => record.unit))) {
    if (unit && await unitIsLive(unit, currentPid)) throw new HostError('busy', 'session host unit is still active');
  }
  // Recheck after asynchronous unit probes. The flock prevents another conforming binder.
  if (records.some(isStampedProcessAlive) || await socketIsLive(paths.socket)) {
    throw new HostError('busy', 'host became live during stale check');
  }
  removeIfPresent(paths.socket);
  removeIfPresent(paths.metadata);
  removeIfPresent(paths.secret);
  if (instance && instance.state !== 'closed') registry.markInstanceState(key, 'closed', instance.instanceId);
  for (const pin of registry.listActivePins()) {
    if (pin.key === key && pin.reason === PIN_REASON && pin.pinId === hostPinId(key, pin.releaseDir)
        && pin.releaseDir !== releaseDir) registry.unpinRelease(pin.pinId);
  }
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    XDG_RUNTIME_DIR: '/run/user/' + currentUid(),
    NODE_OPTIONS: '--no-warnings',
  };
}

const providerEnv: Readonly<Record<string, readonly string[]>> = {
  agy: ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'],
  claude: ['HOME', 'CLAUDE_CONFIG_DIR'],
  codex: ['HOME', 'CODEX_HOME'],
  mock: ['FEISHU_SESSION_HOST_ALLOW_TEST_RUNNER'],
  echo: ['FEISHU_SESSION_HOST_ALLOW_TEST_RUNNER'],
};

function hostEnvironment(provider: string): NodeJS.ProcessEnv {
  const env = baseEnvironment();
  const allowed = Object.hasOwn(providerEnv, provider) ? providerEnv[provider] : undefined;
  for (const name of allowed ?? []) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if ((provider === 'mock' || provider === 'echo') && process.env.NODE_ENV === 'test') env.NODE_ENV = 'test';
  return env;
}

export interface LauncherOptions {
  stateDir: string;
  releaseDir: string;
  runtimeDir?: string;
  nodeBin?: string;
  hostEntryScript?: string;
  configFile?: string;
  allowDetachedFallback?: boolean;
  detachedOnly?: boolean;
  readinessTimeoutMs?: number;
}
type LaunchCommand = { executable: string; args: string[]; env: NodeJS.ProcessEnv };

function busUnavailable(error: unknown): boolean {
  if (errno(error, 'ENOENT')) return true;
  if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') return false;
  return /failed to connect to (?:user (?:scope )?|session )?bus|failed to open bus|no medium found|\$DBUS_SESSION_BUS_ADDRESS and \$XDG_RUNTIME_DIR not defined/i
    .test(error.stderr);
}

export class SessionHostLauncher {
  readonly stateDir: string;
  readonly releaseDir: string;
  readonly runtimeDir: string;
  private readonly fallback: boolean;
  private readonly nodeBin: string;
  private readonly hostEntryScript: string;
  private readonly timeout: number;

  constructor(private readonly options: LauncherOptions) {
    this.stateDir = resolve(options.stateDir);
    this.releaseDir = resolve(options.releaseDir);
    this.runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
    this.fallback = options.allowDetachedFallback ?? (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development');
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.hostEntryScript = resolve(this.releaseDir, options.hostEntryScript ?? 'dist/src/unified/session-host/host-main.js');
    this.timeout = counter(options.readinessTimeoutMs ?? 10_000, 'readinessTimeoutMs', 1);
    if (!isAbsolute(this.nodeBin)) throw new HostError('invalid_request', 'node binary must be absolute');
    if (options.detachedOnly && !this.fallback) throw new HostError('invalid_request', 'detached startup must be enabled');
  }

  buildSystemdCommand(provider: string, key: string, managerNames: readonly string[] = []): LaunchCommand {
    runtimePaths(this.runtimeDir, key);
    const env = hostEnvironment(provider);
    const unset = managerNames.filter(name => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && !Object.hasOwn(env, name));
    return {
      executable: SYSTEMD_RUN, env: baseEnvironment(),
      args: [
        '--user', '--unit=' + sessionHostUnit(key), '--service-type=exec', '--property=KillMode=control-group',
        '--property=UMask=0077', '--working-directory=' + this.releaseDir, '--expand-environment=no',
        ...(unset.length ? ['--property=UnsetEnvironment=' + unset.join(' ')] : []),
        ...Object.entries(env).map(([name, value]) => '--setenv=' + name + '=' + value),
        '--', this.nodeBin, ...this.hostArgs(provider, key),
      ],
    };
  }

  async launch(identity: HostIdentity): Promise<{ key: string; metadata: HostMetadata }> {
    const registry = new SessionHostRegistry(this.stateDir);
    let launchLock: number | null = null;
    const deadline = performance.now() + this.timeout;
    try {
      const reservedKey = identity.length === 5 ? registry.reserveKeyForCreate(identity) : registry.reserveKeyForRef(identity);
      const key = identity.length === 5 ? reservedKey : registry.getBoundCreateKey(identity) ?? reservedKey;
      const paths = runtimePaths(this.runtimeDir, key);
      privateDirectory(this.runtimeDir, true);
      const statePath = privateDirectory(resolve(this.stateDir, 'session-host', key), true);
      while ((launchLock = acquireFileLock(resolve(statePath, 'launch.lock'))) === null) {
        if (performance.now() >= deadline) throw new HostError('temporarily_unavailable', 'another launcher is still starting the host');
        await sleep(25);
      }
      const pinId = hostPinId(key, this.releaseDir);
      registry.pinRelease(pinId, key, this.releaseDir, PIN_REASON);
      let lock = acquireFileLock(paths.lock);
      let detached: ChildProcess | undefined;
      let systemdStarted = false;
      try {
        const existing = await this.probe(registry, paths, key, deadline);
        if (existing) {
          this.reuseInstance(registry, key, existing, pinId);
          return { key, metadata: existing };
        }
        if (lock !== null) {
          await clearStaleHost(paths, key, registry, this.releaseDir);
          if (performance.now() >= deadline) throw new HostError('temporarily_unavailable', 'launch deadline expired');
          const identity = registry.getIdentity(key);
          if (!identity) throw new HostError('identity_mismatch', 'missing reserved host identity');
          const provider = identity.identity.length === 5 ? identity.identity[1] : identity.identity[0];
          // The service acquires its own lock. Keep the launch guard while releasing the host fd.
          closeSync(lock);
          lock = null;
          registry.pinRelease(pinId, key, this.releaseDir, PIN_REASON);
          systemdStarted = !this.options.detachedOnly && await this.startSystemd(provider, key, deadline);
          if (!systemdStarted) {
            lock = acquireFileLock(paths.lock);
            if (lock !== null) {
              detached = await this.spawnDetached(provider, key, lock);
              closeSync(lock);
              lock = null;
            }
          }
        }
        do {
          const metadata = await this.probe(registry, paths, key, deadline);
          if (metadata) {
            this.reuseInstance(registry, key, metadata, pinId);
            return { key, metadata };
          }
          if (detached && (detached.exitCode !== null || detached.signalCode !== null)) {
            lock = acquireFileLock(paths.lock);
            if (lock !== null) {
              await clearStaleHost(paths, key, registry, this.releaseDir);
              registry.unpinRelease(pinId);
            }
            throw new HostError('temporarily_unavailable', 'detached host exited before readiness');
          }
          if (performance.now() >= deadline) break;
          await sleep(25);
        } while (true);
        const liveUnit = systemdStarted && await unitIsLive(sessionHostUnit(key) + '.service');
        throw new HostError('temporarily_unavailable', liveUnit
          ? 'host readiness timed out; systemd unit remains active and pinned'
          : 'host readiness timed out; its launch remains pinned');
      } finally {
        if (lock !== null) closeSync(lock);
      }
    } finally {
      if (launchLock !== null) closeSync(launchLock);
      registry.close();
    }
  }

  private reuseInstance(registry: SessionHostRegistry, key: string, meta: HostMetadata, candidatePin: string): void {
    if (meta.releaseDir === this.releaseDir) return;
    registry.markInstanceState(key, 'draining', meta.instanceId);
    registry.unpinRelease(candidatePin);
  }

  private hostArgs(provider: string, key: string): string[] {
    return [this.hostEntryScript, '--provider', provider, '--key', key, '--runtime-dir', resolve(this.runtimeDir),
      '--state-dir', this.stateDir, '--release-dir', this.releaseDir,
      ...(this.options.configFile ? ['--config-file', resolve(this.options.configFile)] : [])];
  }

  private async startSystemd(provider: string, key: string, deadline: number): Promise<boolean> {
    const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
    try {
      const { stdout } = await run(SYSTEMCTL, ['--user', 'show-environment'], { env: baseEnvironment(), timeout: remaining() });
      const names = stdout.split('\n').map(line => line.slice(0, line.indexOf('=')));
      const command = this.buildSystemdCommand(provider, key, names);
      await run(command.executable, command.args, { env: command.env, timeout: remaining() });
      return true;
    } catch (error) {
      if (this.fallback && busUnavailable(error)) return false;
      if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          && /already exists|already loaded/i.test(error.stderr)) return true;
      throw new HostError('temporarily_unavailable', busUnavailable(error)
        ? 'systemd user bus is unavailable' : 'systemd session host start failed');
    }
  }

  private spawnDetached(provider: string, key: string, lock: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.nodeBin, this.hostArgs(provider, key), {
        cwd: this.releaseDir, detached: true, stdio: ['ignore', 'ignore', 'ignore', lock],
        env: { ...hostEnvironment(provider), FEISHU_SESSION_HOST_LOCK_FD: '3' },
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve(child);
      });
    });
  }

  private async probe(registry: SessionHostRegistry, paths: RuntimePaths, key: string, deadline: number): Promise<HostMetadata | undefined> {
    const metadata = optionalMetadata(paths);
    if (!metadata || !isStampedProcessAlive(metadata)) return undefined;
    if (metadata.unit !== null && metadata.unit !== sessionHostUnit(key) + '.service') throw new HostError('identity_mismatch');
    if (metadata.unit === null && !this.fallback) throw new HostError('temporarily_unavailable', 'detached host is disabled');
    const identity = registry.getIdentity(key);
    if (!identity) throw new HostError('identity_mismatch');
    if (!matchesIdentity(identity, metadata)) {
      const instance = registry.getInstanceByKey(key);
      if (metadata.sessionId === null && identity.identity.length === 5 && instance?.instanceId === metadata.instanceId
          && instance.sessionId === identity.ref?.[3]) return undefined; // Create publication is being updated.
      throw new HostError('identity_mismatch', 'host metadata differs from reserved identity');
    }
    try {
      if (metadata.keyId !== sha256(readSecret(paths.secret))) throw new HostError('unauthorized', 'host key ID changed');
      const hello = await SessionHostClient.probe({
        runtimeDir: this.runtimeDir, key, expectedRef: metadataRef(metadata),
        clientId: 'launcher-probe', bridgeEpoch: 1,
        requestTimeoutMs: Math.max(1, Math.min(500, Math.ceil(deadline - performance.now()))),
      });
      if (hello.instanceId !== metadata.instanceId || hello.releaseDir !== metadata.releaseDir) {
        throw new HostError('identity_mismatch', 'authenticated host differs from metadata');
      }
      return isStampedProcessAlive(metadata) ? metadata : undefined;
    } catch (error) {
      if (errno(error, 'ENOENT') || (error instanceof HostError && error.code === 'temporarily_unavailable')) return undefined;
      if (error instanceof HostError && error.code === 'identity_mismatch') {
        const next = optionalMetadata(paths);
        if (!next || next.sessionId !== metadata.sessionId || next.instanceId !== metadata.instanceId) return undefined;
      }
      throw error;
    }
  }
}

function matchesIdentity(reserved: ReservedIdentity, metadata: HostMetadata): boolean {
  const tuple = reserved.identity.length === 5 ? reserved.identity.slice(1) : reserved.identity;
  return metadata.provider === tuple[0] && metadata.hostId === tuple[1] && metadata.serviceId === tuple[2]
    && sameRef(reserved.ref, metadataRef(metadata));
}

