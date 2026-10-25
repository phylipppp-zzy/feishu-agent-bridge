import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { card, configureCardUi, markdown } from "../card-kit.js";
import { FeishuClient } from "../feishu.js";
import { cardContentBytes, headByBytes } from "../text-limits.js";
import type { CardDefinition } from "../types.js";

/** Command-line tool that sends a Markdown report to the group the Claude bridge is bound to, as a new topic. */

const USAGE = `用法：node dist/src/claude/notify.js --title <标题> (--markdown-file <路径> | --text <正文>) [--attach <路径>]... [--env-file <路径>] [--dry-run]`;

/** Bytes of the card body kept before cutting; Feishu rejects cards over about 30 KB, and the header and notice need room. */
const BODY_BYTES = 24_000;
export const TRUNCATION_NOTICE = "（正文过长，已截断，全文见附件）";

export const DEFAULT_ENV_FILE = join(homedir(), ".config", "feishu-claude-bridge", "env");

/** A mistake in the command line; the tool exits with 2. */
export class UsageError extends Error {}

export interface NotifyArgs {
  title: string;
  markdownFile: string | null;
  text: string | null;
  attach: string[];
  envFile: string;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[], defaultEnvFile = DEFAULT_ENV_FILE): NotifyArgs {
  const values = new Map<string, string[]>();
  let dryRun = false;
  const valueOptions = new Set(["title", "markdown-file", "text", "attach", "env-file"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new UsageError(`不认识的参数：${arg}`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (name === "dry-run" && eq === -1) { dryRun = true; continue; }
    if (!valueOptions.has(name)) throw new UsageError(`不认识的参数：--${name}`);
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else { value = argv[index + 1]; index += 1; }
    if (value === undefined) throw new UsageError(`--${name} 缺少取值`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const single = (name: string): string | null => {
    const list = values.get(name);
    if (!list) return null;
    if (list.length > 1) throw new UsageError(`--${name} 只能给一次`);
    if (!list[0]!.trim()) throw new UsageError(`--${name} 不能为空`);
    return list[0]!;
  };
  const title = single("title");
  if (!title) throw new UsageError("缺少 --title");
  const markdownFile = single("markdown-file");
  const text = single("text");
  if ((markdownFile === null) === (text === null)) throw new UsageError("--markdown-file 和 --text 必须二选一");
  const attach = values.get("attach") ?? [];
  if (attach.some((path) => !path.trim())) throw new UsageError("--attach 不能为空");
  return { title, markdownFile, text, attach, envFile: single("env-file") ?? defaultEnvFile, dryRun };
}

/** Parses a systemd EnvironmentFile: KEY=VALUE lines, optional quotes, `#` or `;` comment lines. */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\nt])/g, (_, char: string) => char === "n" ? "\n" : char === "t" ? "\t" : char);
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** `env` plus the variables of the env file that `env` does not have yet; a missing file adds nothing. */
export async function loadEnv(envFile: string, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  let content = "";
  try { content = await readFile(envFile, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`无法读取环境文件 ${envFile}：${(error as Error).message}`);
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(parseEnvFile(content))) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

export interface NotifyCredentials { appId: string; appSecret: string; stateDir: string }

/** Only what the tool needs; unlike loadClaudeConfig it does not ask for FEISHU_BIND_TOKEN. */
export function readCredentials(env: NodeJS.ProcessEnv, envFile: string): NotifyCredentials {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error(`缺少飞书凭据 FEISHU_APP_ID / FEISHU_APP_SECRET：环境变量里没有，环境文件 ${envFile} 里也没有（或文件不存在）`);
  }
  return { appId, appSecret, stateDir: resolve(env.STATE_DIR ?? join(homedir(), ".local", "state", "feishu-claude-bridge")) };
}

/** The report card: title in the header, Markdown body, cut to the card limit with a notice when too long. */
export function buildNotifyCard(title: string, body: string): { card: CardDefinition; truncated: boolean } {
  const truncated = cardContentBytes(body) > BODY_BYTES;
  const shown = truncated ? `${headByBytes(body, BODY_BYTES, cardContentBytes).trimEnd()}\n\n${TRUNCATION_NOTICE}` : body;
  return { card: card(title, "blue", [markdown(shown || "（没有正文）")]), truncated };
}

export interface Attachment { name: string; data: Buffer }

/** Reads every attachment up front, so a missing file fails before anything is sent. */
export async function loadAttachments(paths: readonly string[]): Promise<Attachment[]> {
  const result: Attachment[] = [];
  for (const path of paths) {
    let info;
    try { info = await stat(path); } catch { throw new Error(`附件不存在：${path}`); }
    if (!info.isFile()) throw new Error(`附件不是文件：${path}`);
    result.push({ name: basename(path), data: await readFile(path) });
  }
  return result;
}

/** The group id the Claude bridge is bound to, read from its database without writing to it; null when unbound. */
export async function readChatId(stateDir: string): Promise<string | null> {
  const path = join(stateDir, "bridge.sqlite");
  try { await access(path); } catch { return null; }
  // Loading node:sqlite prints an experimental-feature warning that would only confuse script output.
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes("SQLite")) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get("feishu.chat_id") as { value?: string } | undefined;
      return row?.value || null;
    } finally { db.close(); }
  } catch (error) {
    throw new Error(`无法只读打开桥接状态库 ${path}：${(error as Error).message}`);
  } finally { process.emitWarning = emitWarning; }
}

/** The part of the Feishu client that sending needs. */
export interface NotifyPort {
  sendCard(chatId: string, card: CardDefinition): Promise<string>;
  replyFile(rootMessageId: string, fileName: string, data: Buffer): Promise<string>;
}

/** Sends the card as a new topic's root, then the files into that topic in order. Returns the root message id. */
export async function sendNotification(port: NotifyPort, chatId: string, notifyCard: CardDefinition, attachments: readonly Attachment[]): Promise<string> {
  const rootId = await port.sendCard(chatId, notifyCard);
  for (const attachment of attachments) {
    try { await port.replyFile(rootId, attachment.name, attachment.data); } catch (error) {
      throw new Error(`话题已发出（${rootId}），但附件 ${attachment.name} 发送失败：${(error as Error).message}`);
    }
  }
  return rootId;
}

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, out: (line: string) => void = console.log): Promise<void> {
  const args = parseArgs(argv);
  const body = args.markdownFile !== null ? await readFile(args.markdownFile, "utf8").catch(() => {
    throw new Error(`找不到正文文件：${args.markdownFile}`);
  }) : args.text!;
  configureCardUi(2);
  const built = buildNotifyCard(args.title, body);
  const attachPaths = [...(args.markdownFile !== null && built.truncated ? [args.markdownFile] : []), ...args.attach];
  const attachments = await loadAttachments(attachPaths);
  if (args.dryRun) {
    out(JSON.stringify(built.card, null, 2));
    out(`附件：${attachPaths.length ? attachPaths.join("、") : "（无）"}`);
    return;
  }
  const merged = await loadEnv(args.envFile, env);
  const credentials = readCredentials(merged, args.envFile);
  const chatId = await readChatId(credentials.stateDir);
  if (!chatId) throw new Error("桥接还没有绑定飞书群");
  const rootId = await sendNotification(new FeishuClient(credentials.appId, credentials.appSecret), chatId, built.card, attachments);
  out(`已发送：${rootId}`);
}

async function main(): Promise<void> {
  try { await run(process.argv.slice(2)); } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
