import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveAllowedPath(candidate: string, allowedRoot: string): Promise<string> {
  const root = await realpath(allowedRoot);
  const requested = await realpath(isAbsolute(candidate) ? candidate : resolve(root, candidate));
  const rel = relative(root, requested);
  // `..project` is a legal sibling name, not a parent traversal. Only an
  // actual `..` segment means the canonical target escaped the allowed root.
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return requested;
  throw new Error(`Path is outside ALLOWED_ROOT: ${candidate}`);
}

/**
 * Like resolveAllowedPath for a file that may not exist yet (a file to be written): the nearest
 * existing ancestor is canonicalised and the missing tail is kept as given.
 */
export async function resolveAllowedTarget(candidate: string, allowedRoot: string): Promise<string> {
  const root = await realpath(allowedRoot);
  let existing = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const missing: string[] = [];
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      missing.unshift(basename(existing)); existing = dirname(existing);
    }
  }
  if (missing.some((segment) => segment === "..")) throw new Error(`Path is outside ALLOWED_ROOT: ${candidate}`);
  const requested = resolve(existing, ...missing);
  const rel = relative(root, requested);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return requested;
  throw new Error(`Path is outside ALLOWED_ROOT: ${candidate}`);
}
