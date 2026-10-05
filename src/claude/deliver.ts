import { glob, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Files sent by one `/deliver`; the rest are listed as not sent. */
export const DELIVER_MAX_FILES = 20;
/** Feishu's limit for a file message (im/v1/files). */
export const DELIVER_FILE_BYTES = 30 * 1024 * 1024;
/** Feishu's limit for an image message (im/v1/images); larger images go out as files. */
export const DELIVER_IMAGE_BYTES = 10 * 1024 * 1024;
/** Formats Feishu shows as an image message. SVG is not among them (the upload fails with 234011). */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
/** Directories whose contents are never sent: credentials, keys and tool settings. */
const PRIVATE_DIRS = new Set([".git", ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config", ".claude"]);
/** File names that look like credentials. */
const SECRET_NAME = /^\.env(?:\..*)?$|^\.(?:netrc|npmrc|pypirc|git-credentials)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:pem|key|p12|pfx|jks|keystore)$|secret|credential|passw/i;
const GLOB_CHARS = /[*?[\]{}]/;

export interface Deliverable {
  path: string;
  /** How the file is named in the card: relative to the session's directory when inside it. */
  label: string;
  size: number;
  kind: "image" | "file";
}

export interface DeliverySelection {
  files: Deliverable[];
  skipped: Array<{ label: string; reason: string }>;
}

/** Paths separated by spaces; a path containing spaces is written in double quotes. */
export function deliverArguments(args: string): string[] {
  return [...args.matchAll(/"([^"]+)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function privateReason(path: string): string | null {
  if (path.split(sep).some((part) => PRIVATE_DIRS.has(part))) return "位于不发送的目录（如 .git、.ssh、.config）";
  if (SECRET_NAME.test(basename(path))) return "文件名像密钥或凭据";
  return null;
}

/**
 * Resolves what `/deliver` names: files, directories (their files, not subdirectories)
 * and glob patterns, relative to the session's directory. Only regular files under
 * ALLOWED_ROOT that do not look like credentials are selected.
 */
export async function selectDeliverables(args: readonly string[], cwd: string | null, allowedRoot: string): Promise<DeliverySelection> {
  const root = await realpath(allowedRoot).catch(() => resolve(allowedRoot));
  const base = cwd ?? root;
  const label = (path: string) => {
    const rel = relative(base, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    const home = homedir();
    return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  };
  const candidates: Array<{ path: string; arg: string }> = [];
  const skipped: DeliverySelection["skipped"] = [];
  for (const arg of args) {
    const expanded = arg === "~" ? homedir() : arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
    const absolute = resolve(base, expanded);
    if (GLOB_CHARS.test(expanded)) {
      const matches: string[] = [];
      for await (const match of glob(absolute)) matches.push(match);
      if (!matches.length) skipped.push({ label: arg, reason: "没有匹配的文件" });
      for (const match of matches.sort()) candidates.push({ path: match, arg });
      continue;
    }
    const info = await stat(absolute).catch(() => null);
    if (!info) { skipped.push({ label: arg, reason: "不存在" }); continue; }
    if (info.isDirectory()) {
      const entries = (await readdir(absolute, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
      if (!entries.length) skipped.push({ label: arg, reason: "目录里没有文件（子目录不展开）" });
      for (const name of entries) candidates.push({ path: join(absolute, name), arg });
      continue;
    }
    candidates.push({ path: absolute, arg });
  }

  const files: Deliverable[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const path = await realpath(candidate.path).catch(() => null);
    if (!path) { skipped.push({ label: label(candidate.path), reason: "无法读取" }); continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const name = label(path);
    if (!within(path, root)) { skipped.push({ label: name, reason: "不在允许的目录（ALLOWED_ROOT）内" }); continue; }
    const secret = privateReason(path);
    if (secret) { skipped.push({ label: name, reason: secret }); continue; }
    if (!info.size) { skipped.push({ label: name, reason: "空文件，飞书不接受" }); continue; }
    if (info.size > DELIVER_FILE_BYTES) { skipped.push({ label: name, reason: `超过 30 MB（${formatBytes(info.size)}）` }); continue; }
    if (files.length >= DELIVER_MAX_FILES) { skipped.push({ label: name, reason: `一次最多发送 ${DELIVER_MAX_FILES} 个文件` }); continue; }
    const image = IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) && info.size <= DELIVER_IMAGE_BYTES;
    files.push({ path, label: name, size: info.size, kind: image ? "image" : "file" });
  }
  return { files, skipped };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Entries `/ls` shows in one card; the rest are counted. */
export const LIST_MAX_ENTRIES = 80;

export interface DirectoryEntry { name: string; kind: "dir" | "file"; size: number; mtimeMs: number }

export type DirectoryListing =
  | { kind: "dir"; path: string; entries: DirectoryEntry[]; total: number; hidden: number; parent: string | null }
  | { kind: "file"; path: string; entry: DirectoryEntry }
  | { kind: "error"; message: string };

/**
 * What `/ls` shows: the entries of a directory under ALLOWED_ROOT, directories first, each
 * group by name. Dot entries are counted but left out unless asked for, as `ls` does.
 */
export async function listDirectory(arg: string, cwd: string | null, allowedRoot: string, showHidden = false): Promise<DirectoryListing> {
  const root = await realpath(allowedRoot).catch(() => resolve(allowedRoot));
  const base = cwd ?? root;
  const expanded = arg === "~" ? homedir() : arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
  const path = await realpath(resolve(base, expanded || ".")).catch(() => null);
  if (!path) return { kind: "error", message: `不存在：${arg || base}` };
  if (!within(path, root)) return { kind: "error", message: "只能查看允许的目录（ALLOWED_ROOT）内的内容。" };
  if (path.split(sep).some((part) => PRIVATE_DIRS.has(part))) return { kind: "error", message: "这个目录不对飞书开放（如 .git、.ssh、.config）。" };
  const info = await stat(path).catch(() => null);
  if (!info) return { kind: "error", message: `无法读取：${arg || base}` };
  if (!info.isDirectory()) return { kind: "file", path, entry: { name: basename(path), kind: "file", size: info.size, mtimeMs: info.mtimeMs } };
  const dirents = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!dirents) return { kind: "error", message: `无法读取目录：${arg || base}` };
  const visible = dirents.filter((entry) => showHidden || !entry.name.startsWith("."));
  const entries: DirectoryEntry[] = [];
  for (const entry of visible) {
    // Symbolic links are shown as what they point to.
    const target = await stat(join(path, entry.name)).catch(() => null);
    if (!target) continue;
    entries.push({ name: entry.name, kind: target.isDirectory() ? "dir" : "file", size: target.isDirectory() ? 0 : target.size, mtimeMs: target.mtimeMs });
  }
  entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);
  return { kind: "dir", path, entries: entries.slice(0, LIST_MAX_ENTRIES), total: entries.length, hidden: dirents.length - visible.length,
    parent: path !== root ? resolve(path, "..") : null };
}
