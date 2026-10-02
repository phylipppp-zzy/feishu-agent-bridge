import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Reads and writes the user's Claude Code settings.json for install-claude.mjs and
 * uninstall-claude-hooks.mjs. A file that cannot be understood is never overwritten, every change
 * is preceded by a timestamped backup, and the original permissions and symlink are kept.
 */

export interface ClaudeSettingsFile {
  settings: Record<string, unknown>;
  exists: boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** A missing or blank file reads as {}; invalid JSON or a non-object top level throws. */
export async function readClaudeSettings(path: string): Promise<ClaudeSettingsFile> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { settings: {}, exists: false };
    throw error;
  }
  raw = raw.replace(/^﻿/, "");
  if (!raw.trim()) return { settings: {}, exists: true };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    throw new Error(`${path} 不是合法的 JSON（${(error as Error).message}）。为避免覆盖你的设置，未做任何修改；请先修正该文件后重试。`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} 的顶层不是 JSON 对象。为避免覆盖你的设置，未做任何修改；请先修正该文件后重试。`);
  }
  return { settings: parsed as Record<string, unknown>, exists: true };
}

/** Local time as YYYYMMDDHHmmss for backup names. */
export function backupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function backup(path: string, date: Date): Promise<string> {
  const base = `${path}.bak-${backupTimestamp(date)}`;
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      // copyFile keeps the source permissions; EXCL never replaces an earlier backup.
      await copyFile(path, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || attempt >= 100) throw error;
    }
  }
}

/**
 * Backs up an existing file as `<path>.bak-<YYYYMMDDHHmmss>`, then atomically replaces it with
 * 2-space-indented JSON. A symlinked settings.json is written at its target so the link survives.
 */
export async function writeClaudeSettings(path: string, settings: Record<string, unknown>, now = new Date()): Promise<{ backupPath: string | null }> {
  let target = path;
  let mode = 0o600;
  let backupPath: string | null = null;
  try {
    target = await realpath(path);
    mode = (await stat(target)).mode & 0o777;
    backupPath = await backup(path, now);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { backupPath };
}
