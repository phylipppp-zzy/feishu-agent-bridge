import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Lark from '@larksuiteoapi/node-sdk';
import { imageMediaType } from '../image-media.js';
import { SECRET_FILENAME_RE } from './agy/catalog-types.js';
import { encodeCard } from './feishu-card-wire.js';

export const DEFAULT_FEISHU_ENV_PATH = join(homedir(), '.config', 'feishu-claude-bridge', 'env');
export const DEFAULT_FEISHU_CONFIG_PATH = join(homedir(), '.config', 'feishu-unified-bridge', 'config.json');

export const MAX_FEISHU_FILE_BYTES = 30 * 1024 * 1024; // 30 MiB (Feishu IM file limit)
export const MAX_FEISHU_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB (Feishu IM image limit)

const SENSITIVE_PATH_SEGMENT_RE = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|feishu-claude-bridge\/env)(?:\/|$)/i;

const INTERNAL_TOPIC_SESSION_PREFIXES = [
  'task:',
  'pending-hub:',
  'watch-hub:',
  'mock-test:',
  'native-test:',
] as const;

export type FeishuUploadFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

export function isInternalTopicSessionId(sessionId: string): boolean {
  return INTERNAL_TOPIC_SESSION_PREFIXES.some((prefix) => sessionId.startsWith(prefix));
}

export function inferFeishuUploadFileType(fileName: string): FeishuUploadFileType {
  switch (extname(fileName).toLowerCase()) {
    case '.pdf':
      return 'pdf';
    case '.doc':
    case '.docx':
      return 'doc';
    case '.xls':
    case '.xlsx':
      return 'xls';
    case '.ppt':
    case '.pptx':
      return 'ppt';
    case '.mp4':
      return 'mp4';
    case '.opus':
      return 'opus';
    default:
      return 'stream';
  }
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuDefaultContext {
  credentials: FeishuCredentials | null;
  defaultChatId: string | null;
  sdkDbPath: string | null;
  coreDbPath: string | null;
  configPath: string;
  envPath: string;
}

export interface TopicRouteRow {
  destination: string;
  chatId: string;
  rootId: string;
  threadId: string | null;
  sessionId: string;
  provider?: string;
  nativeSessionId?: string;
  title?: string;
  updatedAt?: string;
}

export type ResolvedSendTarget =
  | {
      kind: 'topic';
      chatId: string | null;
      rootMessageId: string;
      sessionId?: string;
      destination?: string;
      resolvedBy: 'root' | 'session' | 'latest';
    }
  | {
      kind: 'chat';
      chatId: string;
      resolvedBy: 'chat' | 'default_chat';
    };

export interface TargetResolutionOptions {
  session?: string;
  rootMessageId?: string;
  chatId?: string;
  latest?: boolean;
  sdkDbPath?: string | null;
  coreDbPath?: string | null;
  defaultChatId?: string | null;
}

export interface InspectedSendFile {
  inputPath: string;
  resolvedPath: string;
  name: string;
  size: number;
  mode: 'image' | 'file';
  fileType?: FeishuUploadFileType;
  mediaType: string | null;
  downgradedToFile?: boolean;
  warning?: string;
  content: Buffer;
}

export interface InspectFilesOptions {
  asFile?: boolean;
  allowSensitive?: boolean;
  cwd?: string;
}

export interface FeishuSendTransport {
  sendText(target: ResolvedSendTarget, text: string): Promise<{ messageId: string }>;
  sendCard(target: ResolvedSendTarget, title: string, text: string): Promise<{ messageId: string }>;
  sendImage(target: ResolvedSendTarget, fileName: string, content: Buffer): Promise<{ messageId: string; imageKey: string }>;
  sendFile(
    target: ResolvedSendTarget,
    fileName: string,
    content: Buffer,
    fileType?: FeishuUploadFileType,
  ): Promise<{ messageId: string; fileKey: string }>;
}

export interface SendToFeishuOptions {
  files?: readonly string[];
  session?: string;
  rootMessageId?: string;
  chatId?: string;
  latest?: boolean;
  caption?: string;
  title?: string;
  asFile?: boolean;
  allowSensitive?: boolean;
  dryRun?: boolean;
  cwd?: string;
  configPath?: string;
  envPath?: string;
  sdkDbPath?: string;
  coreDbPath?: string;
  credentials?: FeishuCredentials;
  transport?: FeishuSendTransport;
}

export interface SentFileOutcome {
  inputPath: string;
  resolvedPath: string;
  name: string;
  size: number;
  mode: 'image' | 'file';
  fileType?: FeishuUploadFileType;
  status: 'sent' | 'dry_run';
  messageId?: string;
  fileKey?: string;
  imageKey?: string;
  downgradedToFile?: boolean;
  warning?: string;
}

export interface SendToFeishuResult {
  ok: true;
  dryRun: boolean;
  target: ResolvedSendTarget;
  captionMessageId?: string;
  files: SentFileOutcome[];
}

export class FeishuSendError extends Error {
  constructor(
    readonly code:
      | 'invalid_argument'
      | 'missing_credentials'
      | 'target_not_found'
      | 'ambiguous_session'
      | 'file_not_found'
      | 'invalid_file'
      | 'sensitive_file_blocked'
      | 'file_too_large'
      | 'api_error',
    message: string,
  ) {
    super(message);
    this.name = 'FeishuSendError';
  }
}

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function loadDefaultFeishuContext(options?: {
  configPath?: string;
  envPath?: string;
  env?: NodeJS.ProcessEnv;
}): FeishuDefaultContext {
  const env = options?.env ?? process.env;
  const envPath = options?.envPath ?? env.FEISHU_ENV_FILE?.trim() ?? DEFAULT_FEISHU_ENV_PATH;
  const configPath = options?.configPath ?? env.FEISHU_BRIDGE_CONFIG?.trim() ?? DEFAULT_FEISHU_CONFIG_PATH;

  let appId = env.FEISHU_APP_ID?.trim() || '';
  let appSecret = env.FEISHU_APP_SECRET?.trim() || '';
  if ((!appId || !appSecret) && existsSync(envPath)) {
    try {
      const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
      if (!appId && parsed.FEISHU_APP_ID) appId = parsed.FEISHU_APP_ID.trim();
      if (!appSecret && parsed.FEISHU_APP_SECRET) appSecret = parsed.FEISHU_APP_SECRET.trim();
    } catch {
      // Ignore unreadable env file here; caller validates credentials when needed.
    }
  }

  let defaultChatId: string | null = null;
  let sdkDbPath: string | null = null;
  let coreDbPath: string | null = null;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        sdkDb?: unknown;
        runtime?: { allowedDestinations?: unknown; destinations?: unknown; coreDb?: unknown };
      };
      if (typeof raw.sdkDb === 'string' && raw.sdkDb.trim()) {
        sdkDbPath = raw.sdkDb.trim();
      }
      if (typeof raw.runtime?.coreDb === 'string' && raw.runtime.coreDb.trim()) {
        coreDbPath = raw.runtime.coreDb.trim();
      }
      const dests = Array.isArray(raw.runtime?.allowedDestinations)
        ? raw.runtime.allowedDestinations
        : raw.runtime?.destinations;
      if (Array.isArray(dests) && typeof dests[0] === 'string' && dests[0].trim()) {
        defaultChatId = dests[0].trim();
      }
    } catch {
      // Ignore invalid config file here; caller reports missing route if needed.
    }
  }

  return {
    credentials: appId && appSecret ? { appId, appSecret } : null,
    defaultChatId,
    sdkDbPath,
    coreDbPath,
    configPath,
    envPath,
  };
}

function withReadOnlySqlite<T>(dbPath: string, missingLabel: string, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(dbPath)) {
    throw new FeishuSendError('target_not_found', `未找到${missingLabel}：${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface CoreSessionMeta {
  sessionId: string;
  provider?: string;
  nativeSessionId?: string;
  title?: string;
  updatedAt?: string;
  updatedAtMs?: number;
}

function readCoreSessionMetaMap(coreDbPath: string | null | undefined, sessionIds: readonly string[]): Map<string, CoreSessionMeta> {
  const map = new Map<string, CoreSessionMeta>();
  if (!coreDbPath || !sessionIds.length || !existsSync(coreDbPath)) return map;
  withReadOnlySqlite(coreDbPath, '核心数据库', (db) => {
    const stmt = db.prepare('SELECT id, value FROM sessions WHERE id = ?');
    for (const sid of sessionIds) {
      const row = stmt.get(sid) as { id: string; value: string } | undefined;
      if (!row) continue;
      try {
        const parsed = JSON.parse(row.value) as {
          title?: unknown;
          updatedAt?: unknown;
          native?: { provider?: unknown; nativeSessionId?: unknown };
        };
        const meta: CoreSessionMeta = { sessionId: row.id };
        if (typeof parsed.native?.provider === 'string') meta.provider = parsed.native.provider;
        if (typeof parsed.native?.nativeSessionId === 'string') meta.nativeSessionId = parsed.native.nativeSessionId;
        if (typeof parsed.title === 'string') meta.title = parsed.title;
        if (typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()) {
          const trimmed = parsed.updatedAt.trim();
          meta.updatedAt = trimmed;
          const parsedMs = Date.parse(trimmed);
          if (Number.isFinite(parsedMs)) meta.updatedAtMs = parsedMs;
        }
        map.set(row.id, meta);
      } catch {
        // Ignore malformed session row JSON.
      }
    }
  });
  return map;
}

function lookupSessionIdsByNativeId(coreDbPath: string | null | undefined, nativeQuery: string): string[] {
  if (!coreDbPath || !existsSync(coreDbPath)) return [];
  return withReadOnlySqlite(coreDbPath, '核心数据库', (db) => {
    const rows = db
      .prepare("SELECT id FROM sessions WHERE json_extract(value, '$.native.nativeSessionId') = ?")
      .all(nativeQuery) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  });
}

export function listFeishuTopics(sdkDbPath: string, limit = 20, coreDbPath?: string | null): TopicRouteRow[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rawTopics = withReadOnlySqlite(sdkDbPath, '路由数据库', (db) => {
    const rows = db
      .prepare(
        'SELECT rowid, destination, chat_id, root_id, thread_id, session_id FROM sdk_topic_routes ORDER BY rowid DESC',
      )
      .all() as Array<{
      rowid: number;
      destination: string;
      chat_id: string;
      root_id: string;
      thread_id: string | null;
      session_id: string;
    }>;
    return rows
      .filter((row) => !isInternalTopicSessionId(row.session_id))
      .map((row) => ({
        rowid: Number(row.rowid),
        destination: row.destination,
        chatId: row.chat_id,
        rootId: row.root_id,
        threadId: row.thread_id,
        sessionId: row.session_id,
      }));
  });
  const metaMap = readCoreSessionMetaMap(coreDbPath, rawTopics.map((t) => t.sessionId));
  rawTopics.sort((a, b) => {
    const aUpdated = metaMap.get(a.sessionId)?.updatedAtMs;
    const bUpdated = metaMap.get(b.sessionId)?.updatedAtMs;
    const aHas = aUpdated !== undefined && Number.isFinite(aUpdated);
    const bHas = bUpdated !== undefined && Number.isFinite(bUpdated);
    if (aHas && bHas && aUpdated !== bUpdated) return bUpdated - aUpdated;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return b.rowid - a.rowid;
  });
  return rawTopics.slice(0, safeLimit).map(({ rowid: _rowid, ...t }) => {
    const meta = metaMap.get(t.sessionId);
    return {
      ...t,
      ...(meta?.provider ? { provider: meta.provider } : {}),
      ...(meta?.nativeSessionId ? { nativeSessionId: meta.nativeSessionId } : {}),
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.updatedAt ? { updatedAt: meta.updatedAt } : {}),
    };
  });
}

export function resolveFeishuTarget(options: TargetResolutionOptions): ResolvedSendTarget {
  const explicitTargets = [
    options.rootMessageId ? '--root' : null,
    options.chatId ? '--chat' : null,
    options.session ? '--session' : null,
    options.latest ? '--latest' : null,
  ].filter((x): x is string => x !== null);

  if (explicitTargets.length > 1) {
    throw new FeishuSendError(
      'invalid_argument',
      `目标参数冲突：${explicitTargets.join(' 与 ')} 只能指定一个。`,
    );
  }

  if (options.rootMessageId) {
    return {
      kind: 'topic',
      chatId: null,
      rootMessageId: options.rootMessageId.trim(),
      resolvedBy: 'root',
    };
  }

  if (options.chatId) {
    return {
      kind: 'chat',
      chatId: options.chatId.trim(),
      resolvedBy: 'chat',
    };
  }

  if (options.session) {
    const query = options.session.trim();
    if (!query) {
      throw new FeishuSendError('invalid_argument', '--session 不能为空。');
    }
    if (!options.sdkDbPath) {
      throw new FeishuSendError('target_not_found', '未配置 sdkDb 路径，无法按 --session 解析飞书话题。');
    }
    return withReadOnlySqlite(options.sdkDbPath, '路由数据库', (db) => {
      const exact = db
        .prepare('SELECT destination, chat_id, root_id, thread_id, session_id FROM sdk_topic_routes WHERE session_id = ?')
        .all(query) as Array<{ destination: string; chat_id: string; root_id: string; session_id: string }>;
      if (exact.length === 1) {
        const hit = exact[0]!;
        return {
          kind: 'topic',
          chatId: hit.chat_id,
          rootMessageId: hit.root_id,
          sessionId: hit.session_id,
          destination: hit.destination,
          resolvedBy: 'session',
        };
      }
      if (exact.length > 1) {
        throw new FeishuSendError(
          'ambiguous_session',
          `会话 "${query}" 匹配到 ${exact.length} 个飞书话题，请改用 --root <root_id> 精确指定。`,
        );
      }

      // Resolve nativeSessionId (e.g. AGY/Codex/Claude UUID) via core.sqlite -> session_<hash>
      const mappedSessionIds = lookupSessionIdsByNativeId(options.coreDbPath, query);
      if (mappedSessionIds.length > 0) {
        const mappedHits: Array<{ destination: string; chat_id: string; root_id: string; session_id: string }> = [];
        const stmt = db.prepare(
          'SELECT destination, chat_id, root_id, thread_id, session_id FROM sdk_topic_routes WHERE session_id = ?',
        );
        for (const sid of mappedSessionIds) {
          const rows = stmt.all(sid) as Array<{ destination: string; chat_id: string; root_id: string; session_id: string }>;
          mappedHits.push(...rows);
        }
        if (mappedHits.length === 1) {
          const hit = mappedHits[0]!;
          return {
            kind: 'topic',
            chatId: hit.chat_id,
            rootMessageId: hit.root_id,
            sessionId: hit.session_id,
            destination: hit.destination,
            resolvedBy: 'session',
          };
        }
        if (mappedHits.length > 1) {
          const roots = mappedHits.slice(0, 5).map((r) => r.root_id).join(', ');
          throw new FeishuSendError(
            'ambiguous_session',
            `原生会话 "${query}" 匹配到多个飞书话题（${roots}），请改用 --root 精确指定。`,
          );
        }
      }

      const allRows = db
        .prepare('SELECT destination, chat_id, root_id, thread_id, session_id FROM sdk_topic_routes ORDER BY rowid DESC')
        .all() as Array<{ destination: string; chat_id: string; root_id: string; session_id: string }>;
      const suffixMatches = allRows.filter(
        (row) => !isInternalTopicSessionId(row.session_id) && (row.session_id.endsWith(`:${query}`) || row.session_id === query),
      );
      if (suffixMatches.length === 1) {
        const hit = suffixMatches[0]!;
        return {
          kind: 'topic',
          chatId: hit.chat_id,
          rootMessageId: hit.root_id,
          sessionId: hit.session_id,
          destination: hit.destination,
          resolvedBy: 'session',
        };
      }
      if (suffixMatches.length > 1) {
        const ids = suffixMatches.slice(0, 5).map((r) => r.session_id).join(', ');
        throw new FeishuSendError(
          'ambiguous_session',
          `会话标识 "${query}" 匹配到多个话题（${ids}），请提供完整 session_id 或 --root。`,
        );
      }
      throw new FeishuSendError(
        'target_not_found',
        `在飞书路由表中未找到会话 "${query}" 对应的话题。可先执行 feishu-send --list-topics 查看可用话题。`,
      );
    });
  }

  if (options.latest) {
    if (!options.sdkDbPath) {
      throw new FeishuSendError('target_not_found', '未配置 sdkDb 路径，无法使用 --latest。');
    }
    const topics = listFeishuTopics(options.sdkDbPath, 1, options.coreDbPath);
    const hit = topics[0];
    if (!hit) {
      throw new FeishuSendError('target_not_found', '路由表中没有任何飞书话题记录。');
    }
    return {
      kind: 'topic',
      chatId: hit.chatId,
      rootMessageId: hit.rootId,
      sessionId: hit.sessionId,
      destination: hit.destination,
      resolvedBy: 'latest',
    };
  }

  if (options.defaultChatId) {
    return {
      kind: 'chat',
      chatId: options.defaultChatId,
      resolvedBy: 'default_chat',
    };
  }

  throw new FeishuSendError(
    'target_not_found',
    '未指定发送目标，且无法从默认配置解析主群 chat_id。请传 --session / --root / --chat。',
  );
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const name = basename(normalized);
  return SECRET_FILENAME_RE.test(name) || SENSITIVE_PATH_SEGMENT_RE.test(normalized);
}

export async function inspectSendableFiles(
  filePaths: readonly string[],
  options?: InspectFilesOptions,
): Promise<InspectedSendFile[]> {
  if (!filePaths.length) {
    throw new FeishuSendError('invalid_argument', '请至少提供一个要发送的文件路径。');
  }
  const cwd = options?.cwd ?? process.cwd();
  const inspected: InspectedSendFile[] = [];

  for (const inputPath of filePaths) {
    const absPath = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(absPath);
    } catch {
      throw new FeishuSendError('file_not_found', `文件不存在或无法访问：${inputPath}`);
    }

    const st = await stat(resolvedPath);
    if (!st.isFile()) {
      throw new FeishuSendError('invalid_file', `路径不是普通文件（不支持直接发送目录）：${inputPath}`);
    }
    if (st.size <= 0) {
      throw new FeishuSendError('invalid_file', `飞书不支持发送空文件（0 字节）：${inputPath}`);
    }
    if (st.size > MAX_FEISHU_FILE_BYTES) {
      throw new FeishuSendError(
        'file_too_large',
        `文件超过飞书 30 MiB 单文件上限（${(st.size / (1024 * 1024)).toFixed(2)} MiB）：${inputPath}`,
      );
    }

    if (!options?.allowSensitive && (isSensitivePath(absPath) || isSensitivePath(resolvedPath))) {
      throw new FeishuSendError(
        'sensitive_file_blocked',
        `检测到敏感文件（凭据/密钥类），已默认拦截：${inputPath}。如确需发送，请显式添加 --allow-sensitive。`,
      );
    }

    const content = await readFile(resolvedPath);
    const name = basename(absPath);
    const detectedImage = imageMediaType(content);
    let mode: 'image' | 'file' = 'file';
    let downgradedToFile = false;
    let warning: string | undefined;

    if (detectedImage && !options?.asFile) {
      if (content.length <= MAX_FEISHU_IMAGE_BYTES) {
        mode = 'image';
      } else {
        mode = 'file';
        downgradedToFile = true;
        warning = `图片大小 ${(content.length / (1024 * 1024)).toFixed(2)} MiB 超过飞书图片消息 10 MiB 上限，已自动降级为文件消息发送。`;
      }
    } else if (extname(name).toLowerCase() === '.svg') {
      warning = 'SVG 无法作为飞书图片消息上传，已按普通文件发送（飞书手机端可能无法直接预览 SVG，建议先导出 PNG）。';
    }

    const fileType = mode === 'file' ? inferFeishuUploadFileType(name) : undefined;

    inspected.push({
      inputPath,
      resolvedPath,
      name,
      size: content.length,
      mode,
      ...(fileType ? { fileType } : {}),
      mediaType: detectedImage,
      ...(downgradedToFile ? { downgradedToFile: true } : {}),
      ...(warning ? { warning } : {}),
      content,
    });
  }

  return inspected;
}

function assertFeishuResponseOk(
  response: { code?: number | undefined; msg?: string | undefined } | undefined,
  action: string,
): void {
  if (!response) {
    throw new FeishuSendError('api_error', `飞书接口 ${action} 返回空响应。`);
  }
  if (typeof response.code === 'number' && response.code !== 0) {
    throw new FeishuSendError(
      'api_error',
      `飞书接口 ${action} 失败（code=${response.code}${response.msg ? `, msg=${response.msg}` : ''}）。`,
    );
  }
}

export function createLarkSendTransport(credentials: FeishuCredentials): FeishuSendTransport {
  const client = new Lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
  });

  const dispatchMessage = async (
    target: ResolvedSendTarget,
    msgType: 'text' | 'interactive' | 'file' | 'image',
    content: string,
  ): Promise<string> => {
    const response =
      target.kind === 'topic'
        ? await client.im.message.reply({
            path: { message_id: target.rootMessageId },
            data: { msg_type: msgType, content, reply_in_thread: true },
          })
        : await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: target.chatId, msg_type: msgType, content },
          });
    assertFeishuResponseOk(response, `im.message.${target.kind === 'topic' ? 'reply' : 'create'}(${msgType})`);
    const messageId = response.data?.message_id;
    if (!messageId) {
      throw new FeishuSendError('api_error', `飞书发送 ${msgType} 消息未返回 message_id。`);
    }
    return messageId;
  };

  return {
    async sendText(target, text) {
      const messageId = await dispatchMessage(target, 'text', JSON.stringify({ text }));
      return { messageId };
    },
    async sendCard(target, title, text) {
      const card = encodeCard({ title, text, actions: [] }, '2.0');
      const messageId = await dispatchMessage(target, 'interactive', JSON.stringify(card));
      return { messageId };
    },
    async sendImage(target, _fileName, content) {
      const uploaded = await client.im.image.create({
        data: { image_type: 'message', image: content },
      });
      const imageKey = uploaded?.image_key;
      if (!imageKey) {
        throw new FeishuSendError('api_error', '飞书图片上传失败，未返回 image_key。');
      }
      const messageId = await dispatchMessage(target, 'image', JSON.stringify({ image_key: imageKey }));
      return { messageId, imageKey };
    },
    async sendFile(target, fileName, content, fileType = inferFeishuUploadFileType(fileName)) {
      const uploaded = await client.im.file.create({
        data: { file_type: fileType, file_name: fileName, file: content },
      });
      const fileKey = uploaded?.file_key;
      if (!fileKey) {
        throw new FeishuSendError('api_error', `飞书文件上传失败（${fileName}），未返回 file_key。`);
      }
      const messageId = await dispatchMessage(target, 'file', JSON.stringify({ file_key: fileKey }));
      return { messageId, fileKey };
    },
  };
}

export async function sendToFeishu(options: SendToFeishuOptions): Promise<SendToFeishuResult> {
  const caption = options.caption?.trim();
  const title = options.title?.trim();
  const fileList = options.files ?? [];
  if (fileList.length === 0 && !caption && !title) {
    throw new FeishuSendError(
      'invalid_argument',
      '请至少提供一个要发送的文件路径，或通过 -m/--caption、-t/--title 提供说明消息。',
    );
  }

  const ctx = loadDefaultFeishuContext({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.envPath ? { envPath: options.envPath } : {}),
  });

  const target = resolveFeishuTarget({
    ...(options.session ? { session: options.session } : {}),
    ...(options.rootMessageId ? { rootMessageId: options.rootMessageId } : {}),
    ...(options.chatId ? { chatId: options.chatId } : {}),
    ...(options.latest ? { latest: true } : {}),
    sdkDbPath: options.sdkDbPath ?? ctx.sdkDbPath,
    coreDbPath: options.coreDbPath ?? ctx.coreDbPath,
    defaultChatId: ctx.defaultChatId,
  });

  const inspected =
    fileList.length > 0
      ? await inspectSendableFiles(fileList, {
          ...(options.asFile ? { asFile: true } : {}),
          ...(options.allowSensitive ? { allowSensitive: true } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
        })
      : [];

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      target,
      files: inspected.map((item) => ({
        inputPath: item.inputPath,
        resolvedPath: item.resolvedPath,
        name: item.name,
        size: item.size,
        mode: item.mode,
        ...(item.fileType ? { fileType: item.fileType } : {}),
        status: 'dry_run',
        ...(item.downgradedToFile ? { downgradedToFile: true } : {}),
        ...(item.warning ? { warning: item.warning } : {}),
      })),
    };
  }

  let transport = options.transport;
  if (!transport) {
    const credentials = options.credentials ?? ctx.credentials;
    if (!credentials) {
      throw new FeishuSendError(
        'missing_credentials',
        `未找到飞书应用凭据（FEISHU_APP_ID / FEISHU_APP_SECRET），请检查环境变量或 ${ctx.envPath}。`,
      );
    }
    transport = createLarkSendTransport(credentials);
  }

  let captionMessageId: string | undefined;
  if (caption || title) {
    if (title) {
      const cardBody = caption || (inspected.length > 0 ? `共发送 ${inspected.length} 个文件` : title);
      const res = await transport.sendCard(target, title, cardBody);
      captionMessageId = res.messageId;
    } else if (caption) {
      const res = await transport.sendText(target, caption);
      captionMessageId = res.messageId;
    }
  }

  const outcomes: SentFileOutcome[] = [];
  for (const item of inspected) {
    if (item.mode === 'image') {
      const res = await transport.sendImage(target, item.name, item.content);
      outcomes.push({
        inputPath: item.inputPath,
        resolvedPath: item.resolvedPath,
        name: item.name,
        size: item.size,
        mode: 'image',
        status: 'sent',
        messageId: res.messageId,
        imageKey: res.imageKey,
        ...(item.warning ? { warning: item.warning } : {}),
      });
    } else {
      const res = await transport.sendFile(target, item.name, item.content, item.fileType);
      outcomes.push({
        inputPath: item.inputPath,
        resolvedPath: item.resolvedPath,
        name: item.name,
        size: item.size,
        mode: 'file',
        ...(item.fileType ? { fileType: item.fileType } : {}),
        status: 'sent',
        messageId: res.messageId,
        fileKey: res.fileKey,
        ...(item.downgradedToFile ? { downgradedToFile: true } : {}),
        ...(item.warning ? { warning: item.warning } : {}),
      });
    }
  }

  return {
    ok: true,
    dryRun: false,
    target,
    ...(captionMessageId ? { captionMessageId } : {}),
    files: outcomes,
  };
}
