import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

export const DEFAULT_AGY_GEMINI_BIN = join(homedir(), '.gemini', 'bin', 'agy');
export const DEFAULT_AGY_LOCAL_BIN = join(homedir(), '.local', 'bin', 'agy');
export const DEFAULT_AGY_QUOTA_TIMEOUT_MS = 15_000;
const MAX_SUBPROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_FALLBACK_WINDOW_MINUTES = 10_080;

// Matches CSI, OSC, and 2-byte ESC sequences.
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;
const CTRL_CHARS_RE = /[\x00-\x1f\x7f]+/g;

export type AgyQuotaState =
  | 'ok'
  | 'cached'
  | 'api_key_mode'
  | 'timeout'
  | 'unavailable'
  | 'offline_empty';

export type AgyQuotaHealthStatus = 'healthy' | 'degraded' | 'unverified';

export type AgyQuotaValidity = 'valid' | 'partial' | 'invalid' | 'cached' | 'expired' | 'unavailable';

export interface AgyQuotaWindow {
  group: string;
  label: string;
  name: string;
  limitId: string;
  windowMinutes: number;
  windowType: 'weekly' | 'short' | 'other';
  usedPercent: number;
  remainingPercent: number;
  remainingAmount: number | null;
  disabled: boolean;
  resetsAt: string | null;
  snapshotAt: string;
  ageSeconds: number;
  stale: boolean;
}

export interface AgyQuotaHealthProjection {
  component: 'agy_quota';
  status: AgyQuotaHealthStatus;
  reason: string | null;
  updatedAt: string | null;
  lastObservedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  backlog: null;
  unknown: null;
  lastDeliveryAt: null;
}

export interface AgyQuotaSnapshot {
  state: AgyQuotaState;
  validity: AgyQuotaValidity;
  source: 'live' | 'cache' | 'none';
  apiKeyMode: boolean;
  fromCache: boolean;
  stale: boolean;
  cacheExpired: boolean;
  timedOut: boolean;
  exitCode: number | null;
  binaryPath: string | null;
  short: AgyQuotaWindow | null;
  weekly: AgyQuotaWindow | null;
  windows: AgyQuotaWindow[];
  invalidBuckets: number;
  warnings: string[];
  lastSnapshotAt: string | null;
  observedAt: string;
  ageSeconds: number;
  error: string | null;
  health: AgyQuotaHealthProjection;
}

export interface AgyUsageParseResult {
  windows: AgyQuotaWindow[] | null;
  error: string | null;
  validity: 'valid' | 'partial' | 'invalid';
  invalidBuckets: number;
  warnings: string[];
}

export interface AgyQuotaQueryOptions {
  agyBin?: string;
  cachePath?: string;
  offline?: boolean;
  timeoutMs?: number;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  printArgStyle?: 'separate' | 'equals';
  previousHealth?: AgyQuotaHealthProjection | null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Remove ANSI escape codes from CLI output or embedded JSON strings. */
export function stripAnsi(text: string): string {
  return typeof text === 'string' ? text.replace(ANSI_ESCAPE_RE, '') : '';
}

function safeId(value: unknown, maxLen = 159): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripAnsi(value).replace(CTRL_CHARS_RE, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    return ms >= 0 && ms <= 253_402_300_799_000 ? ms : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return ms >= 0 && ms <= 253_402_300_799_000 ? ms : null;
  }
  return null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/')) return join(homeDir, filePath.slice(2));
  return filePath;
}

function findInPath(command: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve `agy` binary path.
 * Explicit path/name overrides defaults; otherwise checks `~/.gemini/bin/agy`, `~/.local/bin/agy`, and `PATH`.
 */
export function resolveAgyBinary(configured?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const homeDir = env.HOME || homedir();
  if (configured && configured.trim()) {
    const raw = configured.trim();
    const expanded = expandHome(raw, homeDir);
    if (raw.startsWith('~') || raw.includes(sep) || raw.includes('/')) {
      const resolved = resolve(expanded);
      return isExecutableFile(resolved) ? resolved : null;
    }
    return findInPath(raw, env.PATH);
  }

  const geminiBin = join(homeDir, '.gemini', 'bin', 'agy');
  if (isExecutableFile(geminiBin)) return geminiBin;

  const localBin = join(homeDir, '.local', 'bin', 'agy');
  if (isExecutableFile(localBin)) return localBin;

  return findInPath('agy', env.PATH);
}

function normalizeGroupShortName(name: unknown): string {
  const cleaned = safeId(name, 40);
  if (!cleaned) return '默认组';
  const low = cleaned.toLowerCase();
  if (low.includes('gemini')) return 'Gemini';
  if (low.includes('claude') || low.includes('gpt')) return 'Claude/GPT';
  return cleaned;
}

function parseJsonObjectFromOutput(rawText: string): { parsed: Record<string, unknown> | null; parseError: string | null } {
  const cleaned = stripAnsi(rawText).trim();
  if (!cleaned) return { parsed: null, parseError: 'empty usage output' };

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const val: unknown = JSON.parse(candidate);
      return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(cleaned);
  if (direct) return { parsed: direct, parseError: null };

  // Fallback 1: last line starting with `{` (leading diagnostic lines before JSON line).
  const lines = cleaned.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!.trim();
    if (ln.startsWith('{')) {
      const row = tryParse(ln);
      if (row) return { parsed: row, parseError: null };
    }
  }

  // Fallback 2: multi-line pretty JSON preceded by diagnostic lines.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().startsWith('{')) {
      const block = lines.slice(i).join('\n').trim();
      const row = tryParse(block);
      if (row) return { parsed: row, parseError: null };
    }
  }

  return { parsed: null, parseError: 'invalid JSON in agy /usage output' };
}

/**
 * Parse raw stdout of `agy -p /usage --output-format json` into normalized quota windows.
 * Strictly validates `remaining_fraction` in `[0, 1]` (never clamping out-of-range values to 0%/100%)
 * and classifies payloads into `valid`, `partial`, or `invalid`.
 */
export function parseAgyUsageJson(
  rawText: string,
  snapshotMs: number = Date.now(),
): AgyUsageParseResult {
  const { parsed, parseError } = parseJsonObjectFromOutput(rawText);
  if (!parsed) {
    return { windows: null, error: parseError, validity: 'invalid', invalidBuckets: 0, warnings: [] };
  }

  if (parsed.status !== 'SUCCESS') {
    const errText = safeId(parsed.error, 200) ?? `agy /usage status=${String(parsed.status ?? 'unknown')}`;
    return { windows: null, error: errText, validity: 'invalid', invalidBuckets: 0, warnings: [] };
  }

  const command = parsed.command;
  const data =
    command && typeof command === 'object' && !Array.isArray(command)
      ? (command as Record<string, unknown>).data
      : undefined;
  const groups =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).groups
      : undefined;

  if (!Array.isArray(groups)) {
    return {
      windows: null,
      error: 'missing groups array in agy /usage output',
      validity: 'invalid',
      invalidBuckets: 0,
      warnings: [],
    };
  }

  const snapIso = new Date(snapshotMs).toISOString();
  const windows: AgyQuotaWindow[] = [];
  let invalidBuckets = 0;
  const warnings: string[] = [];

  for (const grp of groups) {
    if (!grp || typeof grp !== 'object' || Array.isArray(grp)) {
      invalidBuckets += 1;
      warnings.push('invalid quota group entry (expected object)');
      continue;
    }
    const g = grp as Record<string, unknown>;
    const group = normalizeGroupShortName(g.name);
    if (!Array.isArray(g.buckets)) {
      invalidBuckets += 1;
      warnings.push(`quota group "${group}" missing buckets array`);
      continue;
    }

    for (const rawBucket of g.buckets) {
      if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) {
        invalidBuckets += 1;
        warnings.push(`invalid quota bucket in group "${group}"`);
        continue;
      }
      const b = rawBucket as Record<string, unknown>;
      const frac = b.remaining_fraction;
      if (typeof frac !== 'number' || !Number.isFinite(frac) || frac < 0 || frac > 1) {
        invalidBuckets += 1;
        const bucketId = safeId(b.id, 60) ?? safeId(b.window, 40) ?? 'unknown';
        warnings.push(
          `invalid remaining_fraction for ${group}/${bucketId}: ${String(frac)} (expected [0, 1])`,
        );
        continue;
      }

      const rem = frac * 100;
      const winRaw = safeId(b.window, 40) ?? '';
      let windowType: AgyQuotaWindow['windowType'] = 'other';
      let winLabel = winRaw || '窗口';
      let windowMinutes = 0;

      if (winRaw === 'weekly') {
        windowType = 'weekly';
        winLabel = '周额度';
        windowMinutes = 10_080;
      } else if (winRaw === '5h' || winRaw === 'five_hour') {
        windowType = 'short';
        winLabel = '5小时';
        windowMinutes = 300;
      }

      const resetMs = parseEpochMs(b.reset_time);
      // Antigravity emits 1970-01-01T00:00:00Z (<= 86400s) when a rolling window is untouched (100%).
      const resetsAt = resetMs !== null && resetMs > 86_400_000 ? new Date(resetMs).toISOString() : null;

      const remAmountRaw = b.remaining_amount;
      const remainingAmount =
        typeof remAmountRaw === 'number' && Number.isSafeInteger(remAmountRaw) && remAmountRaw >= 0
          ? remAmountRaw
          : null;

      const limitId = safeId(b.id) ?? (winRaw || 'window');
      const name = safeId(b.name, 80) ?? `${group} ${winLabel}`;

      windows.push({
        group,
        label: `${group} ${winLabel}`,
        name,
        limitId,
        windowMinutes,
        windowType,
        usedPercent: round4(100 - rem),
        remainingPercent: round4(rem),
        remainingAmount,
        disabled: b.disabled === true,
        resetsAt,
        snapshotAt: snapIso,
        ageSeconds: 0,
        stale: false,
      });
    }
  }

  if (windows.length === 0) {
    return {
      windows: null,
      error: warnings[0] ?? 'no valid quota buckets in agy /usage output',
      validity: 'invalid',
      invalidBuckets,
      warnings,
    };
  }
  return {
    windows,
    error: null,
    validity: invalidBuckets > 0 ? 'partial' : 'valid',
    invalidBuckets,
    warnings,
  };
}

function selectSummaryWindows(windows: readonly AgyQuotaWindow[]): {
  short: AgyQuotaWindow | null;
  weekly: AgyQuotaWindow | null;
} {
  const weekly =
    windows.find((w) => w.group === 'Gemini' && w.windowType === 'weekly') ??
    windows.find((w) => w.windowType === 'weekly') ??
    null;
  const short =
    windows.find((w) => w.group === 'Gemini' && w.windowType === 'short') ??
    windows.find((w) => w.windowType === 'short') ??
    null;
  return { short, weekly };
}

function lastSnapshotIso(windows: readonly AgyQuotaWindow[]): string | null {
  let latest: string | null = null;
  for (const w of windows) {
    if (w.snapshotAt && (latest === null || w.snapshotAt > latest)) {
      latest = w.snapshotAt;
    }
  }
  return latest;
}

function normalizeCachedWindow(raw: unknown, snapSec: number, nowSec: number, staleFlag: boolean): AgyQuotaWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;

  const resetsRaw = item.resetsAt !== undefined ? item.resetsAt : item.resets_at;
  const resetsAt = typeof resetsRaw === 'string' && resetsRaw.trim() ? resetsRaw.trim() : null;
  const resetMs = resetsAt ? parseEpochMs(resetsAt) : null;
  if (resetsAt !== null && resetMs === null) return null;
  if (resetMs !== null && resetMs / 1000 <= nowSec) return null;

  const winMinsRaw = item.windowMinutes !== undefined ? item.windowMinutes : item.window_minutes;
  const winMins =
    typeof winMinsRaw === 'number' && Number.isFinite(winMinsRaw) && winMinsRaw > 0
      ? winMinsRaw
      : DEFAULT_FALLBACK_WINDOW_MINUTES;

  if (resetMs === null && nowSec - snapSec >= winMins * 60) {
    return null;
  }

  const group = safeId(item.group, 40) ?? '默认组';
  const winTypeRaw = item.windowType !== undefined ? item.windowType : item.window_type;
  const windowType: AgyQuotaWindow['windowType'] =
    winTypeRaw === 'weekly' || winTypeRaw === 'short' || winTypeRaw === 'other' ? winTypeRaw : 'other';
  const label = safeId(item.label, 80) ?? group;
  const name = safeId(item.name, 80) ?? label;
  const limitId = safeId(item.limitId !== undefined ? item.limitId : item.limit_id) ?? 'window';

  const remRaw = item.remainingPercent !== undefined ? item.remainingPercent : item.remaining_percent;
  const usedRaw = item.usedPercent !== undefined ? item.usedPercent : item.used_percent;
  if (typeof remRaw !== 'number' || !Number.isFinite(remRaw) || remRaw < 0 || remRaw > 100) return null;
  const remainingPercent = round4(remRaw);
  const usedPercent =
    typeof usedRaw === 'number' && Number.isFinite(usedRaw) && usedRaw >= 0 && usedRaw <= 100
      ? round4(usedRaw)
      : round4(100 - remainingPercent);

  const snapshotAtRaw = item.snapshotAt !== undefined ? item.snapshotAt : item.snapshot_at;
  const snapshotAt =
    typeof snapshotAtRaw === 'string' && parseEpochMs(snapshotAtRaw) !== null
      ? new Date(parseEpochMs(snapshotAtRaw)!).toISOString()
      : new Date(snapSec * 1000).toISOString();

  const remAmtRaw = item.remainingAmount !== undefined ? item.remainingAmount : item.remaining_amount;
  const remainingAmount =
    typeof remAmtRaw === 'number' && Number.isSafeInteger(remAmtRaw) && remAmtRaw >= 0 ? remAmtRaw : null;

  return {
    group,
    label,
    name,
    limitId,
    windowMinutes: typeof winMinsRaw === 'number' && Number.isFinite(winMinsRaw) && winMinsRaw >= 0 ? winMinsRaw : 0,
    windowType,
    usedPercent,
    remainingPercent,
    remainingAmount,
    disabled: item.disabled === true,
    resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
    snapshotAt,
    ageSeconds: Math.max(0, Math.floor(nowSec - snapSec)),
    stale: staleFlag,
  };
}

/** Read unexpired Antigravity quota windows from an optional local JSON cache file. */
export async function readAgyQuotaCache(
  cachePath: string,
  nowMs: number = Date.now(),
  markStale = false,
): Promise<{ windows: AgyQuotaWindow[]; ageSeconds: number; snapshotAt: string; expired: boolean } | null> {
  let raw: string;
  try {
    raw = await readFile(resolve(cachePath), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const snapSec = Number(obj.snapshot_ts);
  const nowSec = nowMs / 1000;
  if (!Number.isFinite(snapSec) || snapSec <= 0 || snapSec > nowSec) return null;

  const rawWindows = Array.isArray(obj.windows) ? obj.windows : [];
  const valid: AgyQuotaWindow[] = [];
  for (const w of rawWindows) {
    const normalized = normalizeCachedWindow(w, snapSec, nowSec, markStale);
    if (normalized) valid.push(normalized);
  }
  if (valid.length === 0) {
    if (rawWindows.length > 0) {
      return {
        windows: [],
        ageSeconds: Math.max(0, Math.floor(nowSec - snapSec)),
        snapshotAt: new Date(snapSec * 1000).toISOString(),
        expired: true,
      };
    }
    return null;
  }

  return {
    windows: valid,
    ageSeconds: Math.max(0, Math.floor(nowSec - snapSec)),
    snapshotAt: lastSnapshotIso(valid) ?? new Date(snapSec * 1000).toISOString(),
    expired: false,
  };
}

/** Atomically persist quota snapshot to an optional local cache file with `0600` permissions. */
export async function writeAgyQuotaCache(
  cachePath: string,
  windows: readonly AgyQuotaWindow[],
  nowMs: number = Date.now(),
): Promise<void> {
  const target = resolve(cachePath);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.antigravity-quota.${randomUUID()}.tmp`);
  try {
    const payload = JSON.stringify({
      snapshot_ts: nowMs / 1000,
      windows,
    });
    await writeFile(tmp, payload, { mode: 0o600, flag: 'wx' });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

interface ExecQuotaResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

function buildAgyQuotaArgs(timeoutMs: number, style: 'separate' | 'equals' = 'separate'): string[] {
  const timeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const promptArgs = style === 'equals' ? ['-p=/usage'] : ['-p', '/usage'];
  return [...promptArgs, '--output-format', 'json', '--print-timeout', `${timeoutSecs}s`];
}

function runAgyUsageProcess(
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ExecQuotaResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(binaryPath, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    });

    const finish = (result: ExecQuotaResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore if already exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 500);
      killTimer.unref();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_SUBPROCESS_OUTPUT_BYTES) return;
      const take = chunk.subarray(0, MAX_SUBPROCESS_OUTPUT_BYTES - outBytes);
      outBytes += take.length;
      stdout += take.toString('utf8');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_SUBPROCESS_OUTPUT_BYTES) return;
      const take = chunk.subarray(0, MAX_SUBPROCESS_OUTPUT_BYTES - errBytes);
      errBytes += take.length;
      stderr += take.toString('utf8');
    });

    child.once('error', (err) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        spawnError: err.message,
      });
    });

    child.once('close', (code) => {
      finish({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        spawnError: null,
      });
    });
  });
}

function looksLikeCliFlagSyntaxError(stderr: string): boolean {
  const clean = stripAnsi(stderr);
  return /(?:flags? provided but not defined|flag needs an argument|unexpected argument)/i.test(clean);
}

/** Project a quota query snapshot into the unified `healthy` / `degraded` / `unverified` health format. */
export function projectAgyQuotaHealth(
  snapshot: Omit<AgyQuotaSnapshot, 'health'>,
  previous?: AgyQuotaHealthProjection | null,
): AgyQuotaHealthProjection {
  const prevSuccessAt = previous?.lastSuccessAt ?? null;
  const prevFailureAt = previous?.lastFailureAt ?? null;
  const prevFailureReason = previous?.lastFailureReason ?? null;

  if (snapshot.state === 'ok') {
    if (snapshot.validity === 'partial') {
      const reason = `部分配额桶数值无效已忽略（${snapshot.invalidBuckets} 项）`;
      return {
        component: 'agy_quota',
        status: 'degraded',
        reason,
        updatedAt: snapshot.observedAt,
        lastObservedAt: snapshot.observedAt,
        lastSuccessAt: snapshot.lastSnapshotAt ?? snapshot.observedAt,
        lastFailureAt: snapshot.observedAt,
        lastFailureReason: reason,
        backlog: null,
        unknown: null,
        lastDeliveryAt: null,
      };
    }
    return {
      component: 'agy_quota',
      status: 'healthy',
      reason: null,
      updatedAt: snapshot.observedAt,
      lastObservedAt: snapshot.observedAt,
      lastSuccessAt: snapshot.lastSnapshotAt ?? snapshot.observedAt,
      lastFailureAt: prevFailureAt,
      lastFailureReason: prevFailureReason,
      backlog: null,
      unknown: null,
      lastDeliveryAt: null,
    };
  }

  if (snapshot.state === 'api_key_mode') {
    return {
      component: 'agy_quota',
      status: 'unverified',
      reason: snapshot.error ?? 'GEMINI_API_KEY 模式无账号额度',
      updatedAt: snapshot.observedAt,
      lastObservedAt: snapshot.observedAt,
      lastSuccessAt: prevSuccessAt,
      lastFailureAt: prevFailureAt,
      lastFailureReason: prevFailureReason,
      backlog: null,
      unknown: null,
      lastDeliveryAt: null,
    };
  }

  if (snapshot.state === 'offline_empty' || (snapshot.state === 'cached' && !snapshot.stale)) {
    return {
      component: 'agy_quota',
      status: 'unverified',
      reason:
        snapshot.state === 'cached'
          ? '离线读取本地缓存额度，未实时核验'
          : (snapshot.error ?? '离线模式且无可用额度缓存'),
      updatedAt: snapshot.observedAt,
      lastObservedAt: snapshot.observedAt,
      lastSuccessAt: snapshot.lastSnapshotAt ?? prevSuccessAt,
      lastFailureAt: prevFailureAt,
      lastFailureReason: prevFailureReason,
      backlog: null,
      unknown: null,
      lastDeliveryAt: null,
    };
  }

  const failureReason = snapshot.error ?? '获取 Antigravity 额度失败';
  return {
    component: 'agy_quota',
    status: 'degraded',
    reason: snapshot.state === 'cached' ? `${failureReason}（已回退本地缓存）` : failureReason,
    updatedAt: snapshot.observedAt,
    lastObservedAt: snapshot.observedAt,
    lastSuccessAt: snapshot.lastSnapshotAt ?? prevSuccessAt,
    lastFailureAt: snapshot.observedAt,
    lastFailureReason: failureReason,
    backlog: null,
    unknown: null,
    lastDeliveryAt: null,
  };
}

/**
 * Query Antigravity quota via `agy -p /usage --output-format json --print-timeout ...`
 * with `stdin=DEVNULL`, hard timeout, exit code 2 (`GEMINI_API_KEY`) mapping, and optional local cache fallback.
 */
export async function queryAgyQuota(options: AgyQuotaQueryOptions = {}): Promise<AgyQuotaSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGY_QUOTA_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('invalid timeoutMs');
  }

  const env = options.env;
  const offline = options.offline === true;
  const binaryPath = offline ? null : resolveAgyBinary(options.agyBin, env);

  let liveError: string | null = null;
  let exitCode: number | null = null;
  let timedOut = false;
  let apiKeyMode = false;
  let liveWindows: AgyQuotaWindow[] | null = null;
  let liveValidity: 'valid' | 'partial' | 'invalid' = 'invalid';
  let invalidBuckets = 0;
  let warnings: string[] = [];

  if (!offline) {
    if (!binaryPath) {
      liveError = '未找到可用的 agy 二进制文件';
    } else {
      const args = buildAgyQuotaArgs(timeoutMs, options.printArgStyle ?? 'separate');
      const proc = await runAgyUsageProcess(binaryPath, args, timeoutMs, env);
      exitCode = proc.exitCode;
      timedOut = proc.timedOut;

      if (proc.timedOut) {
        liveError = `agy /usage 执行超时（>${timeoutMs}ms）`;
      } else if (proc.spawnError) {
        liveError = `agy /usage 启动失败: ${proc.spawnError}`;
      } else if (proc.exitCode === 2 && !looksLikeCliFlagSyntaxError(proc.stderr)) {
        apiKeyMode = true;
        liveError = 'GEMINI_API_KEY 模式无账号额度';
      } else if (proc.exitCode !== 0) {
        const parsedErr = parseAgyUsageJson(proc.stdout, nowMs).error;
        const stderrHint = safeId(proc.stderr.split(/\r?\n/).find((l) => l.trim()), 160);
        liveError = parsedErr ?? stderrHint ?? `agy /usage 退出码 ${String(proc.exitCode)}`;
      } else {
        const parsed = parseAgyUsageJson(proc.stdout, nowMs);
        liveValidity = parsed.validity;
        invalidBuckets = parsed.invalidBuckets;
        warnings = parsed.warnings;
        if (parsed.windows) {
          liveWindows = parsed.windows;
        } else {
          liveError = parsed.error ?? '未解析到有效的额度窗口';
        }
      }
    }
  }

  if (liveWindows) {
    if (options.cachePath) {
      const resolvedCachePath = resolve(expandHome(options.cachePath, env?.HOME || homedir()));
      await writeAgyQuotaCache(resolvedCachePath, liveWindows, nowMs).catch(() => undefined);
    }
    const { short, weekly } = selectSummaryWindows(liveWindows);
    const snapAt = lastSnapshotIso(liveWindows) ?? observedAt;
    const base: Omit<AgyQuotaSnapshot, 'health'> = {
      state: 'ok',
      validity: liveValidity,
      source: 'live',
      apiKeyMode: false,
      fromCache: false,
      stale: false,
      cacheExpired: false,
      timedOut: false,
      exitCode,
      binaryPath,
      short,
      weekly,
      windows: liveWindows,
      invalidBuckets,
      warnings,
      lastSnapshotAt: snapAt,
      observedAt,
      ageSeconds: 0,
      error: null,
    };
    return { ...base, health: projectAgyQuotaHealth(base, options.previousHealth) };
  }

  if (apiKeyMode) {
    const base: Omit<AgyQuotaSnapshot, 'health'> = {
      state: 'api_key_mode',
      validity: 'unavailable',
      source: 'live',
      apiKeyMode: true,
      fromCache: false,
      stale: false,
      cacheExpired: false,
      timedOut: false,
      exitCode,
      binaryPath,
      short: null,
      weekly: null,
      windows: [],
      invalidBuckets: 0,
      warnings: [],
      lastSnapshotAt: options.previousHealth?.lastSuccessAt ?? null,
      observedAt,
      ageSeconds: 0,
      error: liveError,
    };
    return { ...base, health: projectAgyQuotaHealth(base, options.previousHealth) };
  }

  let cacheExpired = false;
  if (options.cachePath) {
    const resolvedCachePath = resolve(expandHome(options.cachePath, env?.HOME || homedir()));
    const cached = await readAgyQuotaCache(resolvedCachePath, nowMs, !offline);
    if (cached && !cached.expired) {
      const { short, weekly } = selectSummaryWindows(cached.windows);
      const base: Omit<AgyQuotaSnapshot, 'health'> = {
        state: 'cached',
        validity: 'cached',
        source: 'cache',
        apiKeyMode: false,
        fromCache: true,
        stale: !offline,
        cacheExpired: false,
        timedOut,
        exitCode,
        binaryPath,
        short,
        weekly,
        windows: cached.windows,
        invalidBuckets,
        warnings,
        lastSnapshotAt: cached.snapshotAt,
        observedAt,
        ageSeconds: cached.ageSeconds,
        error: liveError,
      };
      return { ...base, health: projectAgyQuotaHealth(base, options.previousHealth) };
    }
    if (cached?.expired) {
      cacheExpired = true;
    }
  }

  const base: Omit<AgyQuotaSnapshot, 'health'> = {
    state: offline ? 'offline_empty' : timedOut ? 'timeout' : 'unavailable',
    validity: cacheExpired ? 'expired' : liveValidity === 'invalid' && invalidBuckets > 0 ? 'invalid' : 'unavailable',
    source: 'none',
    apiKeyMode: false,
    fromCache: false,
    stale: false,
    cacheExpired,
    timedOut,
    exitCode,
    binaryPath,
    short: null,
    weekly: null,
    windows: [],
    invalidBuckets,
    warnings,
    lastSnapshotAt: options.previousHealth?.lastSuccessAt ?? null,
    observedAt,
    ageSeconds: 0,
    error: offline
      ? cacheExpired
        ? '离线模式且本地额度缓存已过期'
        : '离线模式且无可用额度缓存'
      : liveError,
  };
  return { ...base, health: projectAgyQuotaHealth(base, options.previousHealth) };
}

/** Format a structured quota snapshot into human-readable summary lines for `/quota` and `/health`. */
export function formatAgyQuotaSummary(snapshot: AgyQuotaSnapshot | null): string {
  if (!snapshot) return 'Antigravity 额度：尚未采样';
  if (snapshot.state === 'api_key_mode') {
    return 'Antigravity 额度：当前为 GEMINI_API_KEY 模式（无账号额度窗口）';
  }
  const lines: string[] = [];
  const stateLabel =
    snapshot.validity === 'valid'
      ? '实时有效'
      : snapshot.validity === 'partial'
        ? `部分有效（忽略 ${snapshot.invalidBuckets} 个非法桶）`
        : snapshot.validity === 'cached'
          ? snapshot.stale
            ? `缓存回退（已滞后 ${snapshot.ageSeconds}s）`
            : `离线缓存（采样于 ${snapshot.ageSeconds}s 前）`
          : snapshot.validity === 'expired'
            ? '缓存已过期'
            : snapshot.validity === 'invalid'
              ? '数值无效'
              : '不可用';
  lines.push(`Antigravity 额度状态：${stateLabel}`);
  if (snapshot.windows.length > 0) {
    for (const w of snapshot.windows) {
      const resetPart = w.resetsAt ? `，重置 ${w.resetsAt}` : '';
      const disabledPart = w.disabled ? '（已禁用）' : '';
      lines.push(`- ${w.label}：剩余 ${w.remainingPercent}%（已用 ${w.usedPercent}%${resetPart}）${disabledPart}`);
    }
  } else if (snapshot.error) {
    lines.push(`原因：${snapshot.error}`);
  }
  if (snapshot.lastSnapshotAt) {
    lines.push(`采样时间：${snapshot.lastSnapshotAt}`);
  }
  return lines.join('\n');
}

/** Stateful quota client retaining health history (`lastSuccessAt`, `lastFailureAt`) and last structured snapshot across polls. */
export class AgyQuotaClient {
  private lastSnapshot: AgyQuotaSnapshot | null = null;
  private lastHealth: AgyQuotaHealthProjection = {
    component: 'agy_quota',
    status: 'unverified',
    reason: '尚未观测 Antigravity 额度',
    updatedAt: null,
    lastObservedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    backlog: null,
    unknown: null,
    lastDeliveryAt: null,
  };

  constructor(private readonly defaults: Omit<AgyQuotaQueryOptions, 'previousHealth'> = {}) {}

  async query(overrides: Omit<AgyQuotaQueryOptions, 'previousHealth'> = {}): Promise<AgyQuotaSnapshot> {
    const snapshot = await queryAgyQuota({
      ...this.defaults,
      ...overrides,
      previousHealth: this.lastHealth,
    });
    this.lastSnapshot = snapshot;
    this.lastHealth = snapshot.health;
    return snapshot;
  }

  snapshot(): AgyQuotaSnapshot | null {
    return this.lastSnapshot ? structuredClone(this.lastSnapshot) : null;
  }

  health(): AgyQuotaHealthProjection {
    return { ...this.lastHealth };
  }
}
