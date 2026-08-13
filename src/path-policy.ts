import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveAllowedPath(candidate: string, allowedRoot: string): Promise<string> {
  const root = await realpath(allowedRoot);
  const requested = await realpath(isAbsolute(candidate) ? candidate : resolve(root, candidate));
  const rel = relative(root, requested);
  // `..project` is a legal sibling name, not a parent traversal. Only an
  // actual `..` segment means the canonical target escaped the allowed root.
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return requested;
  throw new Error(`Path is outside ALLOWED_ROOT: ${candidate}`);
}
