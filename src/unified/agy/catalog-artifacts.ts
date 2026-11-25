import { constants, existsSync } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AGY_EXCLUDED_ARTIFACT_DIRS,
  assertValidConversationId,
  DEFAULT_AGY_ARTIFACT_EXTENSIONS,
  DEFAULT_MAX_ARTIFACT_BYTES,
  expandHomePath,
  isInside,
  MAX_ARTIFACT_SCAN_DEPTH,
  MAX_ARTIFACT_SCAN_ENTRIES,
  MEDIA_TYPES,
  resolveAgyBrainDirs,
  SECRET_FILENAME_RE,
  sha256,
  SIDECAR_FILENAME_RE,
  type AgyArtifactEntry,
  type AgyArtifactOptions,
} from './catalog-types.js';

function isExcludedDirName(name: string, includeScratch: boolean): boolean {
  if (name.startsWith('.')) return true;
  if (includeScratch && name === 'scratch') return false;
  return AGY_EXCLUDED_ARTIFACT_DIRS.has(name);
}

/** Check whether a relative artifact path under `<brainDir>/<conversationId>/` must be excluded. */
export function isExcludedAgyArtifactPath(
  relPath: string,
  options: { includeScratch?: boolean } = {},
): boolean {
  const includeScratch = options.includeScratch === true;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..') return true;
  const segments = normalized.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i]!;
    if (isExcludedDirName(dir, includeScratch)) return true;
  }
  const fileName = segments[segments.length - 1]!;
  if (fileName.startsWith('.')) return true;
  if (isExcludedDirName(fileName, includeScratch)) return true;
  if (SIDECAR_FILENAME_RE.test(fileName)) return true;
  if (SECRET_FILENAME_RE.test(fileName)) return true;
  return false;
}

function normalizeAllowedExtensions(allowedExtensions?: readonly string[]): Set<string> {
  if (!allowedExtensions) return DEFAULT_AGY_ARTIFACT_EXTENSIONS;
  return new Set(allowedExtensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)));
}

async function canonicalizeSymlinkRoots(roots?: readonly string[]): Promise<string[]> {
  if (!roots?.length) return [];
  const canonical: string[] = [];
  for (const r of roots) {
    if (typeof r !== 'string' || !r.trim()) continue;
    const abs = resolve(expandHomePath(r.trim()));
    try {
      const real = await realpath(abs);
      if (!canonical.includes(real)) canonical.push(real);
    } catch {
      // Skip non-existent roots gracefully.
    }
  }
  return canonical;
}

function isSafeSymlinkTarget(canonicalTarget: string, canonicalSymlinkRoots: readonly string[], includeScratch: boolean): boolean {
  const matchedRoot = canonicalSymlinkRoots.find((root) => isInside(canonicalTarget, root));
  if (!matchedRoot) return false;
  const rel = relative(matchedRoot, canonicalTarget);
  const segments = rel ? rel.split(sep).filter(Boolean) : [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.startsWith('.')) return false;
    if (isExcludedDirName(seg, includeScratch)) return false;
    if (i === segments.length - 1 && (SIDECAR_FILENAME_RE.test(seg) || SECRET_FILENAME_RE.test(seg))) {
      return false;
    }
  }
  const leaf = basename(canonicalTarget);
  if (leaf.startsWith('.') || SIDECAR_FILENAME_RE.test(leaf) || SECRET_FILENAME_RE.test(leaf)) {
    return false;
  }
  return true;
}

async function resolveArtifactSessionDir(
  conversationId: string,
  options: { brainDir?: string; brainDirs?: readonly string[]; appDataDir?: string },
): Promise<{ canonicalBrainDir: string; canonicalSessionDir: string } | null> {
  assertValidConversationId(conversationId);
  const brainDirs = resolveAgyBrainDirs(options);
  for (const brainDir of brainDirs) {
    if (!existsSync(brainDir)) continue;
    const canonicalBrainDir = await realpath(brainDir);
    const sessionDir = join(canonicalBrainDir, conversationId);
    let info;
    try {
      info = await lstat(sessionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
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
  return null;
}

async function readSafeArtifactBytes(
  filePath: string,
  canonicalSessionDir: string,
  maxBytes: number,
  canonicalSymlinkRoots: readonly string[] = [],
  includeScratch = false,
): Promise<{ bytes: Buffer; size: number; mtimeMs: number; canonicalPath: string }> {
  const info = await lstat(filePath);
  const isSymlink = info.isSymbolicLink();
  if (!isSymlink && !info.isFile()) {
    throw new Error(`refusing non-regular artifact file: ${filePath}`);
  }
  if (isSymlink && canonicalSymlinkRoots.length === 0) {
    throw new Error(`refusing symlink or non-regular artifact file: ${filePath}`);
  }
  const canonicalPath = await realpath(filePath);
  const insideSession = isInside(canonicalPath, canonicalSessionDir);
  const insideSymlinkWhitelist =
    canonicalSymlinkRoots.length > 0 && isSafeSymlinkTarget(canonicalPath, canonicalSymlinkRoots, includeScratch);

  if (isSymlink) {
    if (!insideSymlinkWhitelist) {
      throw new Error(`symlink artifact escapes allowlisted roots: ${filePath}`);
    }
  } else if (!insideSession && !insideSymlinkWhitelist) {
    throw new Error(`artifact escapes session directory: ${filePath}`);
  }

  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxBytes) {
      throw new Error(`invalid artifact size or type: ${filePath}`);
    }
    try {
      const fdPath = await realpath(`/proc/self/fd/${handle.fd}`);
      const fdAllowed =
        fdPath === canonicalPath &&
        (isInside(fdPath, canonicalSessionDir) ||
          (canonicalSymlinkRoots.length > 0 && isSafeSymlinkTarget(fdPath, canonicalSymlinkRoots, includeScratch)));
      if (!fdAllowed) {
        throw new Error(`artifact path changed during open: ${filePath}`);
      }
    } catch (err) {
      // /proc/self/fd may not exist on non-Linux hosts; re-throw security errors.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const buf = Buffer.alloc(fileStat.size);
    let offset = 0;
    while (offset < fileStat.size) {
      const { bytesRead } = await handle.read(buf, offset, fileStat.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      bytes: buf.subarray(0, offset),
      size: offset,
      mtimeMs: fileStat.mtimeMs,
      canonicalPath,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Scan `<brainDir>/<conversationId>/` for allowlisted artifact files (reports, markdown, images, code/data).
 * Strictly excludes `.system_generated/`, `.tempmediaStorage/`, `browser_sandbox/`, `.user_uploaded/`,
 * `.git/`, `.jj/`, sidecar metadata/resolved/url JSONs, credentials, and non-whitelisted symlinks.
 * `scratch/` is excluded by default and can be enabled on demand via `options.includeScratch`.
 */
export async function discoverAgyArtifacts(
  conversationId: string,
  options: AgyArtifactOptions = {},
): Promise<AgyArtifactEntry[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const allowedExts = normalizeAllowedExtensions(options.allowedExtensions);
  const includeScratch = options.includeScratch === true;
  const canonicalSymlinkRoots = await canonicalizeSymlinkRoots(options.allowedSymlinkRoots);

  const dirs = await resolveArtifactSessionDir(conversationId, options);
  if (!dirs) return [];

  const { canonicalSessionDir } = dirs;
  const entries: AgyArtifactEntry[] = [];
  const visitedDirs = new Set<string>([canonicalSessionDir]);
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

      if (info.isSymbolicLink()) {
        if (canonicalSymlinkRoots.length === 0) continue;
        let targetPath: string;
        let targetStat;
        try {
          targetPath = await realpath(fullPath);
          if (!isSafeSymlinkTarget(targetPath, canonicalSymlinkRoots, includeScratch)) continue;
          targetStat = await stat(targetPath);
        } catch {
          continue;
        }
        if (targetStat.isDirectory()) {
          if (isExcludedDirName(ent.name, includeScratch)) continue;
          if (visitedDirs.has(targetPath)) continue;
          visitedDirs.add(targetPath);
          await walk(targetPath, relPath, depth + 1);
          continue;
        }
        if (!targetStat.isFile()) continue;
        if (isExcludedAgyArtifactPath(relPath, { includeScratch })) continue;
        const ext = extname(ent.name).toLowerCase();
        if (!allowedExts.has(ext)) continue;
        if (targetStat.size < 0 || targetStat.size > maxBytes) continue;
        try {
          const readRes = await readSafeArtifactBytes(
            fullPath,
            canonicalSessionDir,
            maxBytes,
            canonicalSymlinkRoots,
            includeScratch,
          );
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
        continue;
      }

      if (info.isDirectory()) {
        if (isExcludedDirName(ent.name, includeScratch)) continue;
        await walk(fullPath, relPath, depth + 1);
        continue;
      }

      if (!info.isFile()) continue;
      if (isExcludedAgyArtifactPath(relPath, { includeScratch })) continue;

      const ext = extname(ent.name).toLowerCase();
      if (!allowedExts.has(ext)) continue;
      if (info.size < 0 || info.size > maxBytes) continue;

      try {
        const readRes = await readSafeArtifactBytes(
          fullPath,
          canonicalSessionDir,
          maxBytes,
          canonicalSymlinkRoots,
          includeScratch,
        );
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
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const allowedExts = normalizeAllowedExtensions(options.allowedExtensions);
  const includeScratch = options.includeScratch === true;
  const canonicalSymlinkRoots = await canonicalizeSymlinkRoots(options.allowedSymlinkRoots);

  if (typeof relPath !== 'string' || !relPath || isAbsolute(relPath) || relPath.includes('\0')) {
    throw new Error('relative artifact path required');
  }

  const dirs = await resolveArtifactSessionDir(conversationId, options);
  if (!dirs) throw new Error(`agy session directory not found: ${conversationId}`);
  const { canonicalSessionDir } = dirs;

  const targetPath = resolve(canonicalSessionDir, relPath);
  const rel = relative(canonicalSessionDir, targetPath).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`artifact path escapes session directory: ${relPath}`);
  }
  if (isExcludedAgyArtifactPath(rel, { includeScratch })) {
    throw new Error(`artifact path is excluded by security policy: ${rel}`);
  }

  const ext = extname(basename(targetPath)).toLowerCase();
  if (!allowedExts.has(ext)) {
    throw new Error(`artifact extension is not allowlisted: ${ext || '(none)'}`);
  }

  // Verify intermediate directory segments (allowing whitelisted symlinks when configured).
  const segments = rel.split('/');
  let cursor = canonicalSessionDir;
  for (let i = 0; i < segments.length - 1; i++) {
    cursor = join(cursor, segments[i]!);
    const dirStat = await lstat(cursor);
    if (dirStat.isSymbolicLink()) {
      if (canonicalSymlinkRoots.length === 0) {
        throw new Error(`refusing symlinked or invalid directory segment: ${segments[i]}`);
      }
      const targetDir = await realpath(cursor);
      if (!isSafeSymlinkTarget(targetDir, canonicalSymlinkRoots, includeScratch)) {
        throw new Error(`symlinked directory escapes allowlisted roots: ${segments[i]}`);
      }
      const resolvedStat = await stat(targetDir);
      if (!resolvedStat.isDirectory()) {
        throw new Error(`refusing non-directory symlink target: ${segments[i]}`);
      }
      cursor = targetDir;
    } else if (!dirStat.isDirectory()) {
      throw new Error(`refusing symlinked or invalid directory segment: ${segments[i]}`);
    }
  }

  const leafPath = join(cursor, segments[segments.length - 1]!);
  const readRes = await readSafeArtifactBytes(
    leafPath,
    canonicalSessionDir,
    maxBytes,
    canonicalSymlinkRoots,
    includeScratch,
  );
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
