#!/usr/bin/env node
// Candidate entry point. Importing this module has no runtime or network side effects.
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function main(args, deps = {}) {
  const log = deps.log ?? console.log;
  const fail = deps.fail ?? console.error;
  let live, closing;
  const close = () => closing ??= Promise.resolve().then(() => live?.close());
  try {
    let run = false, configPath;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run' && !run) run = true;
      else if (args[i] === '--config' && !configPath && args[i + 1] && !args[i + 1].startsWith('--')) configPath = args[++i];
      else throw new Error('usage');
    }
    if (!configPath || !isAbsolute(configPath)) throw new Error('usage');
    if (run) {
      const s = await stat(configPath);
      if (!s.isFile() || (s.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw new Error('private configuration required');
    }
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['runtime', 'sdkDb'].includes(k)) || typeof config.sdkDb !== 'string' || !isAbsolute(config.sdkDb)) throw new Error('invalid configuration');
    const runtimeModule = await (deps.loadRuntime ?? (() => import('../dist/src/unified/runtime.js')))();
    runtimeModule.validateRuntimeConfig(config.runtime);
    if (!config.runtime.artifactStatePath || !Array.isArray(config.runtime.catalogSources) || !Array.isArray(config.runtime.allowedProjectRoots) || !Array.isArray(config.runtime.outputRoots)) throw new Error('incomplete configuration');
    if (!run) { log('Configuration syntax validated; no state opened or connections started.'); return 0; }
    const env = deps.env ?? process.env;
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('credentials missing');
    live = await runtimeModule.createLiveRuntime(config.runtime, { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET }, config.sdkDb);
    const signals = deps.signals ?? process;
    let resolveSignal, signalled = false;
    const stopped = new Promise(resolve => { resolveSignal = resolve; });
    const onSignal = () => {
      if (signalled) return;
      signalled = true;
      // Begin closing immediately, including while start is pending.
      resolveSignal(close().then(() => ({ kind: 'stopped' }), () => ({ kind: 'close-failed' })));
    };
    signals.on('SIGINT', onSignal); signals.on('SIGTERM', onSignal);
    try {
      // Both outcomes are observed even if shutdown wins the race.
      const started = Promise.resolve().then(() => live.start()).then(
        () => ({ kind: 'started' }), () => ({ kind: 'start-failed' }));
      const outcome = await Promise.race([started, stopped]);
      if (outcome.kind === 'start-failed') throw new Error('start failed');
      if (outcome.kind === 'close-failed') throw new Error('close failed');
      if (outcome.kind === 'started' && !signalled) {
        log('Unified runtime started.');
        const result = await stopped;
        if (result.kind === 'close-failed') throw new Error('close failed');
      } else if (signalled) {
        const result = await stopped;
        if (result.kind === 'close-failed') throw new Error('close failed');
      }
    } finally {
      signals.removeListener('SIGINT', onSignal); signals.removeListener('SIGTERM', onSignal);
      await close();
    }
    return 0;
  } catch {
    try { await close(); } catch { /* report failure without exposing private data */ }
    fail('Unified runtime failed; check configuration and protected service logs.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
