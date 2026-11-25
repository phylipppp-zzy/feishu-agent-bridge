import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from './adapter.js';
import { payloadDigest } from './contracts.js';
import type { FeishuPort } from './feishu-channel.js';
import type { ChannelCard } from './feishu-cards.js';
import { BindingExpired, ReadAuthorizationRevoked } from './topic-title-sync.js';

export class FileCommandError extends Error {}

export async function exportSessionHistory(
  db: DatabaseSync, service: UnifiedService, port: FeishuPort, [destination, sessionId, scope]: [string, string, string],
  guard: () => Promise<void>, reply: (card: ChannelCard) => Promise<string | void>, onSend: () => void,
) {
  const collect = async () => {
    const items: Awaited<ReturnType<UnifiedService['readHistory']>>['items'] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    do {
      await guard();
      let page: Awaited<ReturnType<UnifiedService['readHistory']>>;
      try {
        page = await service.readHistory(sessionId, {limit:100, stable:true, ...(cursor ? {cursor} : {})});
      } catch {
        throw new FileCommandError('历史读取失败或分页期间发生变化，未生成完整导出。');
      }
      for (const message of page.items) {
        bytes += Buffer.byteLength(JSON.stringify(message));
        if (bytes > 16 * 1024 * 1024 || items.length >= 10000) throw new FileCommandError('历史超过导出资源限制，未生成完整导出。');
        items.push(message);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 1000) throw new FileCommandError('历史分页无效，未生成完整导出。');
        seen.add(cursor);
      }
    } while (cursor);
    return items;
  };
  const history = await collect();
  if (payloadDigest(history) !== payloadDigest(await collect())) throw new FileCommandError('历史在导出期间发生变化，请重试。');
  const text = history.map(message => `## ${message.role} (${message.messageId})\n\n${message.blocks.map(block =>
    block.type === 'text' ? block.text : `[文件 ${block.artifactId}]`).join('\n')}\n`).join('\n');
  const content = Buffer.from(text || '# 会话历史\n','utf8');
  if (content.length > 20 * 1024 * 1024) throw new FileCommandError('历史超过导出资源限制，未生成完整导出。');
  const id = `export:v1:${payloadDigest([scope,destination,sessionId,createHash('sha256').update(content).digest('hex')])}`;
  await guard();
  if (db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) {
    onSend();
    await port.sendFile(destination,'会话历史.md',content,id,guard);
    db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
    return {deliveryId:id};
  }
  const url = await port.fileMessageLink?.(destination,sessionId,id) ?? null;
  await guard();
  await reply(url
    ? {title:'历史已导出', text:'可打开原消息查看文件。', actions:[{label:'定位原文件消息',value:{},url}]}
    : {title:'导出状态未知', text:'尚无法定位原消息；不会重复上传。', actions:[]});
  return {deliveryId:id, status:url ? 'located' : 'unknown'};
}

export async function deliverProjectFiles(
  db: DatabaseSync, service: UnifiedService, port: FeishuPort, [destination, sessionId, scope]: [string, string, string],
  args: string, guard: () => Promise<void>, reply: (card: ChannelCard) => Promise<string | void>, onSend: () => void,
) {
  if (!service.selectProjectFiles) throw new Error('file selection unavailable');
  await guard();
  let files: Awaited<ReturnType<NonNullable<UnifiedService['selectProjectFiles']>>>;
  try {
    files = await service.selectProjectFiles(sessionId, args);
  } catch {
    throw new FileCommandError('文件选择失败：仅支持项目内路径和 *、?、[]、** 模式；凭据、符号链接、超限或不可读文件不会发送。');
  }
  if (files.length > 20 || files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024) {
    throw new FileCommandError('文件数量超过 20 个或总大小超过 20 MiB，未发送。');
  }
  const contents: Uint8Array[] = [];
  for (const file of files) {
    await guard();
    try {
      contents.push(await service.readArtifact(sessionId, file.artifactId, file.contentVersion));
    } catch {
      throw new FileCommandError('文件无法读取或已发生变化，请重新选择文件。');
    }
  }
  const results: Array<{name: string; status: 'sent' | 'located' | 'unknown'; url?: string | null}> = [];
  for (const [index, file] of files.entries()) {
    const id = `file:v2:${payloadDigest([scope, destination, sessionId, file.artifactId, file.contentVersion])}`;
    await guard();
    if (db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) {
      onSend();
      try {
        await port.sendFile(destination, file.name, contents[index]!, id, guard);
        db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
        results.push({name:file.name, status:'sent'});
      } catch (error) {
        if (error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked) throw error;
        results.push({name:file.name, status:'unknown'});
      }
    } else {
      const sent = db.prepare("SELECT 1 FROM channel_deliveries WHERE delivery_id=? AND state='sent'").get(id);
      const url = await port.fileMessageLink?.(destination, sessionId, id) ?? null;
      await guard();
      results.push({name:file.name, status:url ? 'located' : sent ? 'sent' : 'unknown', url});
    }
  }
  if (results.some(result => result.status === 'unknown')) {
    const labels = {sent:'已发送', located:'已发送', unknown:'发送结果未知'};
    await reply({title:'文件发送结果', format:'plain', text:results.map(r => `${r.name}：${labels[r.status]}`).join('\n'),
      actions:results.filter(r => r.url).map(r => ({label:`定位 ${r.name}`,value:{},url:r.url!}))});
  }
  return results;
}
