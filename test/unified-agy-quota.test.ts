import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AgyQuotaClient,
  formatAgyQuotaSummary,
  parseAgyUsageJson,
  queryAgyQuota,
  resolveAgyBinary,
  stripAnsi,
} from '../src/unified/agy-quota.js';

async function makeFakeAgy(dir: string, name: string, scriptBody: string): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, `#!/usr/bin/env node\n${scriptBody}\n`, 'utf8');
  await chmod(filePath, 0o755);
  return filePath;
}

const SAMPLE_USAGE_PAYLOAD = {
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini\x1b[31m Models',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Gemini Weekly',
              window: 'weekly',
              remaining_fraction: 0.875,
              remaining_amount: 875,
              reset_time: '2026-11-28T08:48:00Z',
            },
            {
              id: 'gemini-5h',
              name: 'Gemini 5h',
              window: '5h',
              remaining_fraction: 0.65,
              reset_time: '2026-11-22T18:00:00Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              id: '3p-weekly',
              window: 'weekly',
              remaining_fraction: 1.0,
              reset_time: '1970-01-01T00:00:00Z',
            },
            {
              id: '3p-5h',
              window: 'five_hour',
              remaining_fraction: 1.0,
              reset_time: '1970-01-01T00:00:00Z',
            },
          ],
        },
      ],
    },
  },
};

test('resolveAgyBinary prefers ~/.gemini/bin/agy, then ~/.local/bin/agy, then PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-bin-'));
  try {
    const fakeHome = join(dir, 'home');
    const pathDir = join(dir, 'pathbin');
    await mkdir(join(fakeHome, '.gemini', 'bin'), { recursive: true });
    await mkdir(join(fakeHome, '.local', 'bin'), { recursive: true });
    await mkdir(pathDir, { recursive: true });

    const pathBin = await makeFakeAgy(pathDir, 'agy', 'process.exit(0);');
    assert.equal(resolveAgyBinary(undefined, { HOME: fakeHome, PATH: pathDir }), pathBin);

    const localBin = await makeFakeAgy(join(fakeHome, '.local', 'bin'), 'agy', 'process.exit(0);');
    assert.equal(resolveAgyBinary(undefined, { HOME: fakeHome, PATH: pathDir }), localBin);

    const geminiBin = await makeFakeAgy(join(fakeHome, '.gemini', 'bin'), 'agy', 'process.exit(0);');
    assert.equal(resolveAgyBinary(undefined, { HOME: fakeHome, PATH: pathDir }), geminiBin);

    assert.equal(resolveAgyBinary('/nonexistent/custom/agy', { HOME: fakeHome, PATH: pathDir }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseAgyUsageJson strips ANSI codes, parses last-line JSON fallback, and normalizes epoch reset_time <= 86400 to null', () => {
  assert.equal(stripAnsi('\x1b[33mwarn\x1b[0m ok'), 'warn ok');

  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const noisyOutput = [
    '\x1b[33mwarning: some diagnostic line\x1b[0m',
    'info: reading quota',
    JSON.stringify(SAMPLE_USAGE_PAYLOAD),
  ].join('\n');

  const parsed = parseAgyUsageJson(noisyOutput, nowMs);
  assert.equal(parsed.error, null);
  assert.ok(parsed.windows);
  assert.equal(parsed.windows.length, 4);

  const gWeekly = parsed.windows[0]!;
  assert.equal(gWeekly.group, 'Gemini');
  assert.equal(gWeekly.label, 'Gemini 周额度');
  assert.equal(gWeekly.windowMinutes, 10080);
  assert.equal(gWeekly.remainingPercent, 87.5);
  assert.equal(gWeekly.usedPercent, 12.5);
  assert.equal(gWeekly.remainingAmount, 875);
  assert.equal(gWeekly.resetsAt, '2026-11-28T08:48:00.000Z');

  const tpWeekly = parsed.windows[2]!;
  assert.equal(tpWeekly.group, 'Claude/GPT');
  assert.equal(tpWeekly.resetsAt, null);

  const tp5h = parsed.windows[3]!;
  assert.equal(tp5h.windowType, 'short');
  assert.equal(tp5h.windowMinutes, 300);
  assert.equal(tp5h.resetsAt, null);
});

test('queryAgyQuota invokes fake agy with stdin ignored, parses JSON/ANSI, writes cache atomically, and supports offline/fallback/expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-quota-'));
  try {
    const argvFile = join(dir, 'argv.json');
    const cachePath = join(dir, 'cache', 'agy-quota.json');
    const nowMs = Date.parse('2026-11-22T12:00:00Z');

    const fakeOk = await makeFakeAgy(
      dir,
      'fake-agy-ok',
      `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
// Verify stdin is closed/EOF (DEVNULL).
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write("\\x1b[32mFetching usage...\\x1b[0m\\n");
  process.stdout.write(${JSON.stringify(JSON.stringify(SAMPLE_USAGE_PAYLOAD))} + "\\n");
});
      `,
    );

    const client = new AgyQuotaClient({ agyBin: fakeOk, cachePath, timeoutMs: 5000 });
    const live = await client.query({ nowMs });

    assert.equal(live.state, 'ok');
    assert.equal(live.source, 'live');
    assert.equal(live.fromCache, false);
    assert.equal(live.stale, false);
    assert.equal(live.health.status, 'healthy');
    assert.equal(live.short?.limitId, 'gemini-5h');
    assert.equal(live.weekly?.limitId, 'gemini-weekly');
    assert.equal(live.windows.length, 4);

    const capturedArgv = JSON.parse(await readFile(argvFile, 'utf8'));
    assert.deepEqual(capturedArgv, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '5s']);

    const cacheStat = await stat(cachePath);
    assert.equal(cacheStat.mode & 0o777, 0o600);
    const leftovers = (await readdir(join(dir, 'cache'))).filter((f) => f.startsWith('.antigravity-quota.'));
    assert.deepEqual(leftovers, []);

    // Offline read uses cache without spawning binary.
    const offlineSnap = await client.query({
      offline: true,
      agyBin: '/nonexistent/agy',
      nowMs: nowMs + 60_000,
    });
    assert.equal(offlineSnap.state, 'cached');
    assert.equal(offlineSnap.source, 'cache');
    assert.equal(offlineSnap.fromCache, true);
    assert.equal(offlineSnap.stale, false);
    assert.equal(offlineSnap.ageSeconds, 60);
    assert.equal(offlineSnap.health.status, 'unverified');

    // Live command failure falls back to cache and marks health degraded.
    const fakeFail = await makeFakeAgy(
      dir,
      'fake-agy-fail',
      `process.stderr.write("temporary error\\n"); process.exit(1);`,
    );
    const degradedSnap = await client.query({
      agyBin: fakeFail,
      nowMs: nowMs + 120_000,
    });
    assert.equal(degradedSnap.state, 'cached');
    assert.equal(degradedSnap.stale, true);
    assert.equal(degradedSnap.health.status, 'degraded');
    assert.ok(degradedSnap.health.lastFailureAt);
    assert.ok(degradedSnap.health.lastSuccessAt);

    // 5h untouched window (resetsAt=null, 300m) expires at +300m while weekly remains.
    const exp5h = await queryAgyQuota({
      offline: true,
      cachePath,
      nowMs: nowMs + 300 * 60_000,
    });
    const ids = new Set(exp5h.windows.map((w) => w.limitId));
    assert.equal(ids.has('3p-5h'), false);
    assert.equal(ids.has('3p-weekly'), true);
    assert.equal(ids.has('gemini-5h'), true);

    // After 10080m all cached windows have expired (resetsAt <= now or TTL elapsed).
    const expAll = await queryAgyQuota({
      offline: true,
      cachePath,
      nowMs: nowMs + 10080 * 60_000,
    });
    assert.equal(expAll.state, 'offline_empty');
    assert.equal(expAll.windows.length, 0);

    // Later recovery becomes healthy while retaining historical lastFailureAt.
    const recovered = await client.query({ agyBin: fakeOk, nowMs: nowMs + 180_000 });
    assert.equal(recovered.health.status, 'healthy');
    assert.equal(recovered.health.lastFailureAt, degradedSnap.health.lastFailureAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('queryAgyQuota maps exit code 2 (GEMINI_API_KEY) to api_key_mode and enforces hard timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-quota-edge-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const nowMs = Date.parse('2026-11-22T12:00:00Z');

    const fakeOk = await makeFakeAgy(
      dir,
      'fake-ok',
      `process.stdout.write(${JSON.stringify(JSON.stringify(SAMPLE_USAGE_PAYLOAD))} + "\\n");`,
    );
    await queryAgyQuota({ agyBin: fakeOk, cachePath, nowMs });

    // Exit code 2 -> api_key_mode (does NOT serve stale OAuth cache).
    const fakeApiKey = await makeFakeAgy(
      dir,
      'fake-apikey',
      `process.stderr.write("Quota is not available when using GEMINI_API_KEY\\n"); process.exit(2);`,
    );
    const apiKeySnap = await queryAgyQuota({
      agyBin: fakeApiKey,
      cachePath,
      nowMs: nowMs + 10_000,
    });
    assert.equal(apiKeySnap.state, 'api_key_mode');
    assert.equal(apiKeySnap.apiKeyMode, true);
    assert.equal(apiKeySnap.exitCode, 2);
    assert.equal(apiKeySnap.windows.length, 0);
    assert.equal(apiKeySnap.health.status, 'unverified');

    // Hanging OAuth prompt (even ignoring SIGTERM) is terminated promptly by hard timeout.
    const fakeHang = await makeFakeAgy(
      dir,
      'fake-hang',
      `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
      `,
    );
    const started = Date.now();
    const timedOutSnap = await queryAgyQuota({
      agyBin: fakeHang,
      timeoutMs: 200,
      nowMs: nowMs + 20_000,
    });
    const elapsed = Date.now() - started;
    assert.equal(timedOutSnap.timedOut, true);
    assert.equal(timedOutSnap.state, 'timeout');
    assert.equal(timedOutSnap.health.status, 'degraded');
    assert.ok(elapsed < 3000, `expected hard timeout cleanup under 3s, got ${elapsed}ms`);

    // Pretty-printed JSON after ANSI diagnostic prefix.
    const prettyDiag = `\x1b[36mChecking quota...\x1b[0m\n${JSON.stringify(SAMPLE_USAGE_PAYLOAD, null, 2)}\n`;
    const parsedPretty = parseAgyUsageJson(prettyDiag, nowMs);
    assert.equal(parsedPretty.error, null);
    assert.equal(parsedPretty.windows?.length, 4);

    // status=ERROR JSON payload surfaces error cleanly and marks health degraded.
    const fakeStatusErr = await makeFakeAgy(
      dir,
      'fake-status-err',
      `process.stdout.write(JSON.stringify({ status: 'ERROR', error: 'token expired' }) + '\\n');`,
    );
    const errSnap = await queryAgyQuota({ agyBin: fakeStatusErr, nowMs: nowMs + 30_000 });
    assert.equal(errSnap.state, 'unavailable');
    assert.equal(errSnap.health.status, 'degraded');
    assert.equal(errSnap.error, 'token expired');

    // Future cache timestamp is rejected cleanly.
    const futureCache = join(dir, 'future-cache.json');
    await writeFile(futureCache, JSON.stringify({ snapshot_ts: (nowMs + 60_000) / 1000, windows: [] }));
    const futureSnap = await queryAgyQuota({ offline: true, cachePath: futureCache, nowMs });
    assert.equal(futureSnap.state, 'offline_empty');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseAgyUsageJson and AgyQuotaClient reject out-of-range remaining_fraction, classify partial/expired states, and expose structured snapshot', async () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');

  // Out-of-range 1.4 + bad bucket must be rejected as invalid (never clamped to 100%).
  const allInvalidPayload = {
    status: 'SUCCESS',
    command: {
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'over', window: '5h', remaining_fraction: 1.4 },
              { id: 'neg', window: 'weekly', remaining_fraction: -0.2 },
            ],
          },
        ],
      },
    },
  };
  const invalidParsed = parseAgyUsageJson(JSON.stringify(allInvalidPayload), nowMs);
  assert.equal(invalidParsed.windows, null);
  assert.equal(invalidParsed.validity, 'invalid');
  assert.equal(invalidParsed.invalidBuckets, 2);
  assert.ok(invalidParsed.error?.includes('1.4'));

  // Partial valid payload: valid 0.75 + invalid 1.4 -> partial validity, invalid bucket dropped, degraded health.
  const partialPayload = {
    status: 'SUCCESS',
    command: {
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'g-5h', window: '5h', remaining_fraction: 0.75 },
              { id: 'g-bad', window: 'weekly', remaining_fraction: 1.4 },
            ],
          },
        ],
      },
    },
  };
  const partialParsed = parseAgyUsageJson(JSON.stringify(partialPayload), nowMs);
  assert.equal(partialParsed.validity, 'partial');
  assert.equal(partialParsed.invalidBuckets, 1);
  assert.equal(partialParsed.windows?.length, 1);
  assert.equal(partialParsed.windows?.[0]!.remainingPercent, 75);

  const dir = await mkdtemp(join(tmpdir(), 'agy-quota-strict-'));
  try {
    const cachePath = join(dir, 'quota-cache.json');
    const fakePartial = await makeFakeAgy(
      dir,
      'fake-partial',
      `process.stdout.write(${JSON.stringify(JSON.stringify(partialPayload))} + "\\n");`,
    );
    const client = new AgyQuotaClient({ agyBin: fakePartial, cachePath });
    assert.equal(client.snapshot(), null);

    const snap = await client.query({ nowMs });
    assert.equal(snap.validity, 'partial');
    assert.equal(snap.invalidBuckets, 1);
    assert.equal(snap.health.status, 'degraded');
    assert.deepEqual(client.snapshot()?.windows.length, 1);

    const summary = formatAgyQuotaSummary(client.snapshot());
    assert.match(summary, /部分有效/);
    assert.match(summary, /剩余 75%/);

    // Offline read after window expiry reports cacheExpired=true and validity='expired'.
    const expiredSnap = await queryAgyQuota({
      offline: true,
      cachePath,
      nowMs: nowMs + 301 * 60_000,
    });
    assert.equal(expiredSnap.state, 'offline_empty');
    assert.equal(expiredSnap.cacheExpired, true);
    assert.equal(expiredSnap.validity, 'expired');
    assert.match(formatAgyQuotaSummary(expiredSnap), /缓存已过期/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
