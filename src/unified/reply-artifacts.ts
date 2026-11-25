import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artifact, ContentBlock } from './contracts.js';

export function projectRelativePath(project: string, path: string): string | undefined {
  if (!isAbsolute(project) || !path || path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path)) return;
  try {
    if (/^(?:local)?file:\/\/\//i.test(path)) path = fileURLToPath(path.replace(/^localfile:/i, 'file:'));
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(path)) return;
      try { path = decodeURIComponent(path); } catch { /* A literal percent is valid in a local name. */ }
      if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
    }
  } catch { return; }
  if (/[\x00-\x1f\x7f\\]/.test(path)) return;
  const result = relative(project, resolve(project, path));
  if (result && !isAbsolute(result) && result !== '..' && !result.startsWith('..' + sep)) return result;
}

function* replyPaths(blocks: readonly ContentBlock[]): Iterable<string> {
  const pattern = /!?\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^)\s]+)(?:\s+["'][^\r\n]*?["'])?\s*\)|`([^`\r\n]+)`|(?:^|[\s("'\[，：])((?:(?:local)?file:\/\/\/|~\/|\.{1,2}\/|\/)?[\p{L}\p{N}_.%~/-]+\/[\p{L}\p{N}_.%~-]+|[\p{L}\p{N}_%~-][\p{L}\p{N}_.%~-]*\.[\p{L}\p{N}]+\.?)(?=$|[\s)"'\],;!?，。；：])/gu;
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const match of block.text.matchAll(pattern)) {
      const path = match[1] ?? match[2] ?? match[3];
      if (path) yield match[3] ? path.replace(/[.,;]$/, '') : path.trim().replace(/^<|>$/g, '');
    }
  }
}

export function matchRegisteredReplyFiles(project: string, blocks: readonly ContentBlock[], registered: readonly Artifact[], limit = 3): Artifact[] {
  if (limit <= 0) return [];
  const byId = new Map(registered.map(file => [file.artifactId, file]));
  const byPath = new Map(registered.filter(file => file.relativePath).map(file => [file.relativePath, file]));
  const result = new Map<string, Artifact>();
  for (const block of blocks) {
    if (block.type !== 'artifact') continue;
    const file = byId.get(block.artifactId);
    if (file) result.set(file.artifactId, file);
    if (result.size === limit) return [...result.values()];
  }
  for (const path of replyPaths(blocks)) {
    const file = byPath.get(projectRelativePath(project, path));
    if (file) result.set(file.artifactId, file);
    if (result.size === limit) break;
  }
  return [...result.values()];
}
