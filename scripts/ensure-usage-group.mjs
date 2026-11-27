#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';
import { loadDefaultFeishuContext } from '../dist/src/unified/feishu-send.js';

export const DEFAULT_USAGE_GROUP_NAME = 'AI 用量监控';

function readOwnerOpenId(configPath) {
  if (!configPath || !existsSync(configPath)) return null;
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  const owner = parsed?.runtime?.ownerOpenId;
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}

export async function ensureUsageGroup(options = {}) {
  const name = (options.name ?? DEFAULT_USAGE_GROUP_NAME).trim();
  if (!name) {
    throw new Error('群名称不能为空（--name）。');
  }

  const ctx = loadDefaultFeishuContext({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.envPath ? { envPath: options.envPath } : {}),
  });
  const credentials = options.credentials ?? ctx.credentials;
  if (!credentials?.appId || !credentials?.appSecret) {
    throw new Error(`未找到飞书凭据（FEISHU_APP_ID / FEISHU_APP_SECRET），请检查 ${ctx.envPath}。`);
  }
  const ownerOpenId = options.ownerOpenId?.trim() || readOwnerOpenId(ctx.configPath);

  const client =
    options.client ??
    new Lark.Client({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.error,
    });

  let pageToken;
  const seenTokens = new Set();
  while (true) {
    const res = await client.im.chat.list({
      params: {
        user_id_type: 'open_id',
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (typeof res?.code === 'number' && res.code !== 0) {
      throw new Error(`im.chat.list 失败: code=${res.code} msg=${res.msg ?? ''}`);
    }
    const items = Array.isArray(res?.data?.items) ? res.data.items : [];
    const hit = items.find(
      (item) =>
        item &&
        item.chat_status !== 'dissolved' &&
        typeof item.chat_id === 'string' &&
        item.chat_id.trim() &&
        item.chat_id.trim() !== ctx.defaultChatId &&
        (!ownerOpenId || typeof item.owner_id !== 'string' || !item.owner_id.trim() || item.owner_id.trim() === ownerOpenId) &&
        typeof item.name === 'string' &&
        item.name.trim() === name,
    );
    if (hit) {
      return {
        ok: true,
        created: false,
        chatId: hit.chat_id.trim(),
        name: hit.name.trim(),
      };
    }
    const nextToken = typeof res?.data?.page_token === 'string' ? res.data.page_token.trim() : '';
    if (!res?.data?.has_more || !nextToken || seenTokens.has(nextToken)) {
      break;
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }

  if (!options.create) {
    return {
      ok: false,
      created: false,
      chatId: null,
      name,
    };
  }

  if (!ownerOpenId) {
    throw new Error(`未找到 runtime.ownerOpenId（${ctx.configPath}），无法建群并拉入群主。`);
  }

  const created = await client.im.chat.create({
    params: {
      user_id_type: 'open_id',
      set_bot_manager: true,
    },
    data: {
      name,
      description: 'AI 用量与额度每小时自动播报及即时查询群',
      owner_id: ownerOpenId,
      user_id_list: [ownerOpenId],
      chat_mode: 'group',
      group_message_type: 'chat',
    },
  });
  if (typeof created?.code === 'number' && created.code !== 0) {
    throw new Error(`im.chat.create 失败: code=${created.code} msg=${created.msg ?? ''}`);
  }
  const chatId = created?.data?.chat_id?.trim();
  if (!chatId) {
    throw new Error('im.chat.create 未返回有效的 chat_id。');
  }
  return {
    ok: true,
    created: true,
    chatId,
    name: created?.data?.name?.trim() || name,
  };
}

function parseCliArgs(argv) {
  let name = DEFAULT_USAGE_GROUP_NAME;
  let create = false;
  let configPath;
  let envPath;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--create') {
      create = true;
      continue;
    }
    if (arg === '--name') {
      const val = argv[++i];
      if (!val) throw new Error('--name 需要提供群名称。');
      name = val;
      continue;
    }
    if (arg === '--config') {
      const val = argv[++i];
      if (!val) throw new Error('--config 需要提供配置文件路径。');
      configPath = val;
      continue;
    }
    if (arg === '--env') {
      const val = argv[++i];
      if (!val) throw new Error('--env 需要提供凭据文件路径。');
      envPath = val;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return { name, create, configPath, envPath, help };
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(
        '用法: node scripts/ensure-usage-group.mjs [--name "AI 用量监控"] [--create] [--config <path>] [--env <path>]',
      );
      process.exit(0);
    }
    const result = await ensureUsageGroup(parsed);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}
