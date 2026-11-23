#!/usr/bin/env node
// Local owner-only Wave 2 operator CLI for WatchHub and DecisionSyncStore.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SEVERITY_MAP = new Map([
  ['low', 'low'],
  ['medium', 'normal'],
  ['normal', 'normal'],
  ['high', 'high'],
  ['critical', 'high'],
]);

const STATUS_MAP = new Map([
  ['abnormal', 'alert'],
  ['recovered', 'recovered'],
  ['alert', 'alert'],
  ['waiting', 'waiting'],
  ['failed', 'failed'],
  ['info', 'info'],
]);

const WATCH_SOURCES = new Set([
  'watch',
  'stopwatch',
  'claude_waiting',
  'claude_stop_failure',
  'codex_status',
  'agy_status',
]);

const DECISION_KINDS = new Set(['business_decision', 'execution_auth']);
const DECISION_STATUSES = new Set(['pending', 'answered', 'expired', 'cancelled']);

async function loadUnifiedModule(name) {
  const distPath = join(REPO_ROOT, 'dist', 'src', 'unified', `${name}.js`);
  if (existsSync(distPath)) {
    return import(pathToFileURL(distPath).href);
  }
  const srcPath = join(REPO_ROOT, 'src', 'unified', `${name}.ts`);
  return import(pathToFileURL(srcPath).href);
}

function parseFlags(args, booleanFlags = new Set()) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token || !token.startsWith('--') || token.length <= 2) {
      throw new Error(`unexpected argument: ${token ?? ''}`);
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      if (out[key] !== undefined) throw new Error(`duplicate flag: --${key}`);
      out[key] = true;
      continue;
    }
    const val = args[++i];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    if (out[key] !== undefined) throw new Error(`duplicate flag: --${key}`);
    out[key] = val;
  }
  return out;
}

function requireAllowedFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new Error(`unsupported flag: --${key}`);
    }
  }
}

async function loadOwnerConfig(configPath, validateRuntimeConfig) {
  if (!configPath || !isAbsolute(configPath)) {
    throw new Error('--config must be an absolute path');
  }
  const info = await stat(configPath);
  if (!info.isFile()) {
    throw new Error('config path must be a regular file');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('config file must be owned by the current user');
  }
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid configuration JSON');
  }
  const runtimeConfig = parsed.runtime && typeof parsed.runtime === 'object' ? parsed.runtime : parsed;
  validateRuntimeConfig(runtimeConfig);
  return runtimeConfig;
}

function parseOptionsArg(raw) {
  if (!raw || !raw.trim()) throw new Error('--options must be non-empty id:label,...');
  const seen = new Set();
  const options = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new Error(`invalid option format (expected id:label): ${part}`);
    }
    const id = trimmed.slice(0, idx).trim();
    const label = trimmed.slice(idx + 1).trim();
    if (!id || !label || seen.has(id)) {
      throw new Error(`invalid or duplicate option: ${part}`);
    }
    seen.add(id);
    options.push({ id, label });
  }
  if (!options.length) throw new Error('--options must contain at least one option');
  return options;
}

export async function main(args, deps = {}) {
  const log = deps.log ?? console.log;
  const fail = deps.fail ?? console.error;
  try {
    const [subcommand, ...rest] = args;
    if (!subcommand || !['watch-ingest', 'decision-create', 'decision-list'].includes(subcommand)) {
      throw new Error(
        'usage: node scripts/wave2-operator.mjs <watch-ingest|decision-create|decision-list> --config <abs-path> ...',
      );
    }

    const runtimeMod = await (deps.loadRuntime ?? (() => loadUnifiedModule('runtime')))();

    if (subcommand === 'watch-ingest') {
      const flags = parseFlags(rest);
      requireAllowedFlags(
        flags,
        new Set(['config', 'source', 'object', 'severity', 'status', 'title', 'summary', 'session', 'task', 'event-id']),
      );
      const config = await loadOwnerConfig(flags.config, runtimeMod.validateRuntimeConfig);
      if (!config.watchHub?.enabled) {
        throw new Error('watchHub is not enabled in configuration');
      }
      if (!flags.source || !WATCH_SOURCES.has(flags.source)) {
        throw new Error(`invalid --source (allowed: ${[...WATCH_SOURCES].join(', ')})`);
      }
      const severity = SEVERITY_MAP.get(flags.severity ?? '');
      if (!severity) {
        throw new Error('invalid --severity (allowed: low|medium|high|critical)');
      }
      const state = STATUS_MAP.get(flags.status ?? '');
      if (!state) {
        throw new Error('invalid --status (allowed: abnormal|recovered)');
      }
      if (!flags.object?.trim() || !flags.title?.trim() || !flags.summary?.trim()) {
        throw new Error('--object, --title, and --summary are required');
      }

      const watchMod = await (deps.loadWatchHub ?? (() => loadUnifiedModule('watch-hub')))();
      const dbPath =
        config.watchHub.dbPath ?? join(dirname(resolve(config.channelDb)), 'watch-hub.sqlite');
      const noopPort = {
        send: async () => {
          throw new Error('operator CLI does not deliver directly');
        },
        update: async () => {
          throw new Error('operator CLI does not deliver directly');
        },
      };
      const hub = new watchMod.WatchHub({
        dbPath,
        owner: { source: 'feishu', subject: config.ownerOpenId },
        destination: config.watchHub.destination,
        allowedDestinations: new Set(config.allowedDestinations),
        port: noopPort,
      });
      try {
        const sourceRef =
          flags.session || flags.task
            ? {
                ...(flags.session ? { sessionId: flags.session } : {}),
                ...(flags.task ? { taskId: flags.task } : {}),
              }
            : undefined;
        const result = await hub.ingest({
          eventId: flags['event-id'] ?? `op-watch-${randomUUID()}`,
          source: flags.source,
          objectId: flags.object.trim(),
          state,
          occurredAt: new Date().toISOString(),
          severity,
          title: flags.title.trim(),
          summary: flags.summary.trim(),
          ...(sourceRef ? { sourceRef } : {}),
        });
        log(JSON.stringify({ ok: true, result }));
      } finally {
        hub.close();
      }
      return 0;
    }

    if (subcommand === 'decision-create') {
      const flags = parseFlags(rest, new Set(['allow-free-text']));
      requireAllowedFlags(
        flags,
        new Set([
          'config',
          'kind',
          'title',
          'prompt',
          'options',
          'id',
          'session',
          'allow-free-text',
          'target',
          'executor',
          'expiry',
          'action-digest',
        ]),
      );
      const config = await loadOwnerConfig(flags.config, runtimeMod.validateRuntimeConfig);
      if (!config.decisionSync?.enabled) {
        throw new Error('decisionSync is not enabled in configuration');
      }
      if (!flags.kind || !DECISION_KINDS.has(flags.kind)) {
        throw new Error('invalid --kind (allowed: business_decision|execution_auth)');
      }
      if (!flags.title?.trim() || !flags.prompt?.trim()) {
        throw new Error('--title and --prompt are required');
      }
      const options = parseOptionsArg(flags.options);
      const decisionId = flags.id?.trim() || `dec-${randomUUID().slice(0, 12)}`;

      const decisionMod = await (deps.loadDecisionSync ?? (() => loadUnifiedModule('decision-sync')))();
      const dbPath =
        config.decisionSync.dbPath ?? join(dirname(resolve(config.channelDb)), 'decision-sync.sqlite');
      const store = new decisionMod.DecisionSyncStore({
        dbPath,
        ...(config.decisionSync.markdownPath ? { defaultDocPath: config.decisionSync.markdownPath } : {}),
        ...(config.decisionSync.protectedReadOnlyPaths
          ? { protectedReadOnlyPaths: new Set(config.decisionSync.protectedReadOnlyPaths) }
          : {}),
        authorizeActor: (actor) => actor.source === 'feishu' && actor.subject === config.ownerOpenId,
      });
      try {
        const executionSpec =
          flags.kind === 'execution_auth'
            ? {
                actionDigest:
                  flags['action-digest']?.trim() ||
                  createHash('sha256')
                    .update(JSON.stringify([decisionId, flags.title.trim(), flags.prompt.trim()]))
                    .digest('hex'),
                target: flags.target?.trim() || 'operator-target',
                expiry: flags.expiry?.trim() || new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                executorId: flags.executor?.trim() || 'wave2-operator',
              }
            : null;
        const decision = store.createDecision({
          decisionId,
          kind: flags.kind,
          title: flags.title.trim(),
          prompt: flags.prompt.trim(),
          options,
          allowFreeText: flags['allow-free-text'] === true,
          source: {
            system: 'wave2-operator',
            ...(flags.session ? { sessionId: flags.session.trim() } : {}),
          },
          ...(executionSpec ? { executionSpec } : {}),
        });
        let syncResult = null;
        if (config.decisionSync.markdownPath) {
          syncResult = store.syncMarkdownDocument(config.decisionSync.markdownPath, {
            createIfMissing: true,
            triggerDecisionId: decision.decisionId,
            triggerDecisionVersion: decision.version,
          });
        }
        const latest = store.getDecision(decision.decisionId);
        log(JSON.stringify({ ok: true, decision: latest, ...(syncResult ? { syncResult } : {}) }));
      } finally {
        store.close();
      }
      return 0;
    }

    // decision-list
    const flags = parseFlags(rest);
    requireAllowedFlags(flags, new Set(['config', 'kind', 'status']));
    const config = await loadOwnerConfig(flags.config, runtimeMod.validateRuntimeConfig);
    if (!config.decisionSync?.enabled) {
      throw new Error('decisionSync is not enabled in configuration');
    }
    if (flags.kind && !DECISION_KINDS.has(flags.kind)) {
      throw new Error('invalid --kind (allowed: business_decision|execution_auth)');
    }
    if (flags.status && !DECISION_STATUSES.has(flags.status)) {
      throw new Error('invalid --status (allowed: pending|answered|expired|cancelled)');
    }
    const decisionMod = await (deps.loadDecisionSync ?? (() => loadUnifiedModule('decision-sync')))();
    const dbPath =
      config.decisionSync.dbPath ?? join(dirname(resolve(config.channelDb)), 'decision-sync.sqlite');
    const store = new decisionMod.DecisionSyncStore({
      dbPath,
      ...(config.decisionSync.markdownPath ? { defaultDocPath: config.decisionSync.markdownPath } : {}),
      ...(config.decisionSync.protectedReadOnlyPaths
        ? { protectedReadOnlyPaths: new Set(config.decisionSync.protectedReadOnlyPaths) }
        : {}),
    });
    try {
      const decisions = store.listDecisions({
        ...(flags.kind ? { kind: flags.kind } : {}),
        ...(flags.status ? { status: flags.status } : {}),
      });
      log(
        JSON.stringify({
          ok: true,
          decisions: decisions.map((d) => ({
            decisionId: d.decisionId,
            kind: d.kind,
            title: d.title,
            status: d.status,
            syncStatus: d.syncStatus,
            version: d.version,
            updatedAt: d.updatedAt,
          })),
        }),
      );
    } finally {
      store.close();
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(JSON.stringify({ ok: false, error: message }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
