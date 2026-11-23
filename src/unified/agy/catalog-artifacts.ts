import { constants, existsSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AGY_EXCLUDED_ARTIFACT_DIRS,
  assertValidConversationId,
  DEFAULT_AGY_ARTIFACT_EXTENSIONS,
  DEFAULT_AGY_BRAIN_DIR,
  DEFAULT_MAX_ARTIFACT_BYTES,
  expandHomePath,
  isInside,
  MAX_ARTIFACT_SCAN_DEPTH,
  MAX_ARTIFACT_SCAN_ENTRIES,
  MEDIA_TYPES,
  SECRET_FILENAME_RE,
  sha256,
  SIDECAR_FILENAME_RE,
  type AgyArtifactEntry,
  type AgyArtifactOptions,
} from './catalog-types.js';

/** Check whether a relative artifact path under `<brainDir>/<conversationId>/` must be excluded. */
export function isExcludedAgyArtifactPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..') return true;
  const segments = normalized.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i]!;
    if (dir.startsWith('.') || AGY_EXCLUDED_ARTIFACT_DIRS.has(dir)) return true;
  }
  const fileName = segments[segments.length - 1]!;
  if (fileName.startsWith('.')) return true;
  if (AGY_EXCLUDED_ARTIFACT_DIRS.has(fileName)) return true;
  if (SIDECAR_FILENAME_RE.test(fileName)) return true;
  if (SECRET_FILENAME_RE.test(fileName)) return true;
  return false;
}

function normalizeAllowedExtensions(allowedExtensions?: readonly string[]): Set<string> {
  if (!allowedExtensions) return DEFAULT_AGY_ARTIFACT_EXTENSIONS;
  return new Set(allowedExtensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)));
}

async function resolveArtifactSessionDir(
  conversationId: string,
  brainDir: string,
): Promise<{ canonicalBrainDir: string; canonicalSessionDir: string } | null> {
  assertValidConversationId(conversationId);
  if (!existsSync(brainDir)) return null;
  const canonicalBrainDir = await realpath(brainDir);
  const sessionDir = join(canonicalBrainDir, conversationId);
  let info;
  try {
    info = await lstat(sessionDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`refusing symlinked or non-directory artifact root: ${sessionDir}`);
  }
  const canonicalSessionDir = await realpath(sessionDir);
  if (!isInside(canonicalSessionDir, canonicalBrainDir)) {
    throw new Error(`artifact root escapes brainDir: ${sessionDir}`);
  }
  return { canonicalBrainDir, canonicalSessionDir };
}

async function readSafeArtifactBytes(
  filePath: string,
  canonicalSessionDir: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; size: number; mtimeMs: number; canonicalPath: string }> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing symlink or non-regular artifact file: ${filePath}`);
  }
  const canonicalPath = await realpath(filePath);
  if (!isInside(canonicalPath, canonicalSessionDir)) {
    throw new Error(`artifact escapes session directory: ${filePath}`);
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`invalid artifact size or type: ${filePath}`);
    }
    try {
      const fdPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isInside(fdPath, canonicalSessionDir) || fdPath !== canonicalPath) {
        throw new Error(`artifact path changed during open: ${filePath}`);
      }
    } catch (err) {
      // /proc/self/fd may not exist on non-Linux hosts; re-throw security errors.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buf, offset, stat.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      bytes: buf.subarray(0, offset),
      size: offset,
      mtimeMs: stat.mtimeMs,
      canonicalPath,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Scan `<brainDir>/<conversationId>/` for allowlisted artifact files (reports, markdown, images).
 * Strictly excludes `.system_generated/`, `scratch/`, `.tempmediaStorage/`, `browser_sandbox/`,
 * `.user_uploaded/`, `.git/`, `.jj/`, sidecar metadata/resolved/url JSONs, symlinks, and credentials.
 */
export async function discoverAgyArtifacts(
  conversationId: string,
  options: AgyArtifactOptions = {},
): Promise<AgyArtifactEntry[]> {
  const brainDir = resolve(expandHomePath(options.brainDir ?? DEFAULT_AGY_BRAIN_DIR));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const allowedExts = normalizeAllowedExtensions(options.allowedExtensions);

  const dirs = await resolveArtifactSessionDir(conversationId, brainDir);
  if (!dirs) return [];

  const { canonicalSessionDir } = dirs;
  const entries: AgyArtifactEntry[] = [];
  let visited = 0;

  const walk = async (currentDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > MAX_ARTIFACT_SCAN_DEPTH) return;
    const dirents = (await readdir(currentDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const ent of dirents) {
      if (++visited > MAX_ARTIFACT_SCAN_ENTRIES) {
        throw new Error('agy artifact scan budget exceeded');
      }
      const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const fullPath = join(currentDir, ent.name);

      let info;
      try {
        info = await lstat(fullPath);
      } catch {
        continue;
      }

      // Never follow symlinks inside brain/<id>/ (prevents escape and sidecar leaks).
      if (info.isSymbolicLink()) continue;

      if (info.isDirectory()) {
        if (ent.name.startsWith('.') || AGY_EXCLUDED_ARTIFACT_DIRS.has(ent.name)) continue;
        await walk(fullPath, relPath, depth + 1);
        continue;
      }

      if (!info.isFile()) continue;
      if (isExcludedAgyArtifactPath(relPath)) continue;

      const ext = extname(ent.name).toLowerCase();
      if (!allowedExts.has(ext)) continue;
      if (info.size < 0 || info.size > maxBytes) continue;

      try {
        const readRes = await readSafeArtifactBytes(fullPath, canonicalSessionDir, maxBytes);
        entries.push({
          artifactId: sha256(JSON.stringify([conversationId, readRes.canonicalPath])),
          conversationId,
          relativePath: relPath,
          path: readRes.canonicalPath,
          name: ent.name,
          mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
          size: readRes.size,
          mtimeMs: readRes.mtimeMs,
          contentVersion: sha256(readRes.bytes),
        });
      } catch {
        continue;
      }
    }
  };

  await walk(canonicalSessionDir, '', 0);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

/** Validate and read a specific artifact relative path inside `<brainDir>/<conversationId>/`. */
export async function readAgyArtifact(
  conversationId: string,
  relPath: string,
  options: AgyArtifactOptions & { expectedContentVersion?: string } = {},
): Promise<{ entry: AgyArtifactEntry; content: Uint8Array }> {
  const brainDir = resolve(expandHomePath(options.brainDir ?? DEFAULT_AGY_BRAIN_DIR));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const allowedExts = normalizeAllowedExtensions(options.allowedExtensions);

  if (typeof relPath !== 'string' || !relPath || isAbsolute(relPath) || relPath.includes('\0')) {
    throw new Error('relative artifact path required');
  }

  const dirs = await resolveArtifactSessionDir(conversationId, brainDir);
  if (!dirs) throw new Error(`agy session directory not found: ${conversationId}`);
  const { canonicalSessionDir } = dirs;

  const targetPath = resolve(canonicalSessionDir, relPath);
  const rel = relative(canonicalSessionDir, targetPath).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`artifact path escapes session directory: ${relPath}`);
  }
  if (isExcludedAgyArtifactPath(rel)) {
    throw new Error(`artifact path is excluded by security policy: ${rel}`);
  }

  const ext = extname(basename(targetPath)).toLowerCase();
  if (!allowedExts.has(ext)) {
    throw new Error(`artifact extension is not allowlisted: ${ext || '(none)'}`);
  }

  // Verify no intermediate directory is a symlink before opening target.
  const segments = rel.split('/');
  let cursor = canonicalSessionDir;
  for (let i = 0; i < segments.length - 1; i++) {
    cursor = join(cursor, segments[i]!);
    const dirStat = await lstat(cursor);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`refusing symlinked or invalid directory segment: ${segments[i]}`);
    }
  }

  const readRes = await readSafeArtifactBytes(targetPath, canonicalSessionDir, maxBytes);
  const contentVersion = sha256(readRes.bytes);
  if (options.expectedContentVersion && options.expectedContentVersion !== contentVersion) {
    throw new Error('artifact content version mismatch');
  }

  return {
    entry: {
      artifactId: sha256(JSON.stringify([conversationId, readRes.canonicalPath])),
      conversationId,
      relativePath: rel,
      path: readRes.canonicalPath,
      name: basename(readRes.canonicalPath),
      mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
      size: readRes.size,
      mtimeMs: readRes.mtimeMs,
      contentVersion,
    },
    content: readRes.bytes,
  };
}
