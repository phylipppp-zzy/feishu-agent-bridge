import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AgyDiscoveredSession } from './catalog-types.js';
import type { AgyTitleCacheEntry, readAgySummaries } from './catalog-summaries.js';

export interface AgyCatalogRefreshResult {
  list: AgyDiscoveredSession[];
  titles: Map<string, AgyTitleCacheEntry>;
}

// The Agy database and fallback transcript titles can sit on slow local storage.
// Run the synchronous read-only scanner off the main event loop.
export function refreshAgyCatalog(
  options: Parameters<typeof readAgySummaries>[0],
  titles: Map<string, AgyTitleCacheEntry>,
): Promise<AgyCatalogRefreshResult> {
  const source = import.meta.url.endsWith('.ts');
  const moduleUrl = new URL(source ? './catalog-summaries.ts' : './catalog-summaries.js', import.meta.url);
  const loader = source ? createRequire(import.meta.url).resolve('tsx/cjs') : undefined;
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      async function scan() {
        const { options, titles, moduleUrl, sourcePath, loader } = workerData;
        if (loader) require(loader);
        const { readAgySummaries } = loader ? require(sourcePath) : await import(moduleUrl);
        const next = new Map();
        const list = readAgySummaries(options, { previous: titles, next });
        parentPort.postMessage({ list, titles: next });
      }
      scan().catch(error => setImmediate(() => { throw error; }));
    `, {
      eval: true,
      execArgv: [],
      workerData: { options, titles, moduleUrl: moduleUrl.href, sourcePath: fileURLToPath(moduleUrl), loader },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`Agy catalog worker exited without a result (${code})`)));
  });
}
