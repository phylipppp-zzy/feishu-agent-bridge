import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function resolveAllowedPath(candidate: string, allowedRoot: string): Promise<string> {
  const root = await realpath(allowedRoot);
  const requested = await realpath(isAbsolute(candidate) ? candidate : resolve(root, candidate));
  const rel = relative(root, requested);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return requested;
  throw new Error(`Path is outside ALLOWED_ROOT: ${candidate}`);
}
