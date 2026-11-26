import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AgyDiscoveredSession } from './catalog-types.js';
import type { AgyTitleCacheEntry, readAgySummaries } from './catalog-summaries.js';

export interface AgyCatalogRefreshResult {
  list: AgyDiscoveredSession[];
  titles: Map<string, AgyTitleCacheEntry>;
}

interface PendingRefreshRequest {
  resolve: (result: AgyCatalogRefreshResult) => void;
  reject: (error: Error) => void;
}

interface RefreshWorkerResponse {
  id: number;
  ok: boolean;
  list?: AgyDiscoveredSession[];
  titles?: Map<string, AgyTitleCacheEntry>;
  error?: string;
}

let sharedWorker: Worker | null = null;
let sharedWorkerSpawnCount = 0;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRefreshRequest>();

function failAllPending(error: Error): void {
  for (const [id, req] of pendingRequests) {
    pendingRequests.delete(id);
    req.reject(error);
  }
}

function getOrCreateRefreshWorker(): Worker {
  if (sharedWorker) return sharedWorker;

  const source = import.meta.url.endsWith('.ts');
  const moduleUrl = new URL(source ? './catalog-summaries.ts' : './catalog-summaries.js', import.meta.url);
  const loader = source ? createRequire(import.meta.url).resolve('tsx/cjs') : undefined;

  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const { moduleUrl, sourcePath, loader } = workerData;
      let readAgySummariesPromise = null;
      function loadScanner() {
        if (!readAgySummariesPromise) {
          readAgySummariesPromise = (async () => {
            if (loader) require(loader);
            const mod = loader ? require(sourcePath) : await import(moduleUrl);
            return mod.readAgySummaries;
          })();
        }
        return readAgySummariesPromise;
      }
      parentPort.on('message', async (msg) => {
        const { id, options, titles } = msg;
        try {
          const readAgySummaries = await loadScanner();
          const next = new Map();
          const list = readAgySummaries(options, { previous: titles, next });
          parentPort.postMessage({ id, ok: true, list, titles: next });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          parentPort.postMessage({ id, ok: false, error: message });
        }
      });
    `,
    {
      eval: true,
      execArgv: [],
      workerData: { moduleUrl: moduleUrl.href, sourcePath: fileURLToPath(moduleUrl), loader },
    },
  );

  // Do not prevent process exit when idle.
  worker.unref();
  sharedWorker = worker;
  sharedWorkerSpawnCount += 1;

  worker.on('message', (msg: RefreshWorkerResponse) => {
    const req = pendingRequests.get(msg.id);
    if (!req) return;
    pendingRequests.delete(msg.id);
    if (pendingRequests.size === 0) worker.unref();
    if (msg.ok && msg.list && msg.titles) {
      req.resolve({ list: msg.list, titles: msg.titles });
    } else {
      req.reject(new Error(msg.error ?? 'Agy catalog refresh failed'));
    }
  });

  worker.on('error', (error) => {
    if (sharedWorker === worker) sharedWorker = null;
    failAllPending(error instanceof Error ? error : new Error(String(error)));
  });

  worker.on('exit', (code) => {
    if (sharedWorker === worker) sharedWorker = null;
    if (pendingRequests.size > 0) {
      failAllPending(new Error(`Agy catalog worker exited without a result (${code})`));
    }
  });

  return worker;
}

/** Terminate the reusable refresh worker if running. */
export async function closeAgyCatalogRefreshWorker(): Promise<void> {
  const worker = sharedWorker;
  sharedWorker = null;
  if (pendingRequests.size > 0) {
    failAllPending(new Error('Agy catalog worker closed'));
  }
  if (worker) {
    await worker.terminate();
  }
}

/** Diagnostic counter for tests verifying worker reuse across refreshes. */
export function getAgyCatalogRefreshWorkerSpawnCount(): number {
  return sharedWorkerSpawnCount;
}

// The Agy database and fallback transcript titles can sit on slow local storage.
// Run the synchronous read-only scanner off the main event loop via a reusable worker.
export function refreshAgyCatalog(
  options: Parameters<typeof readAgySummaries>[0],
  titles: Map<string, AgyTitleCacheEntry>,
): Promise<AgyCatalogRefreshResult> {
  const worker = getOrCreateRefreshWorker();
  const id = nextRequestId++;
  return new Promise<AgyCatalogRefreshResult>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.ref();
    try {
      worker.postMessage({ id, options, titles });
    } catch (error) {
      pendingRequests.delete(id);
      if (pendingRequests.size === 0) worker.unref();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
