import type { DatabaseSync } from 'node:sqlite';
import { compactCardField, compactProjectName, sessionStatusLabel, sessionStatusTemplate, shortenHomePath } from './card-formatters.js';
import { payloadDigest, type Session } from './contracts.js';
import { providerDisplayLabel, providerTitlePrefix, type ChannelCard } from './feishu-cards.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';
import type { FeishuPort } from './feishu-channel.js';
import { isGenericSessionTitle, normalizeTopicTitle } from './session-title.js';

export class BindingExpired extends Error {}
export class ReadAuthorizationRevoked extends Error {}

export const TOPIC_TITLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS channel_topic_titles (
    destination TEXT NOT NULL,
    session_id TEXT NOT NULL,
    binding_scope TEXT NOT NULL,
    root_message_id TEXT NOT NULL,
    synced_title TEXT NOT NULL,
    retry_after INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(destination, session_id, binding_scope)
  );
`;

type TopicTitleRow = { rowid: number; synced_title: string; retry_after: number };
const inFlightRoots = new WeakMap<FeishuPort, Set<string>>();
const EXPIRED_ROOT_RETRY_AFTER = Number.MAX_SAFE_INTEGER;

export function topicRootCard(session: Session): ChannelCard {
  const template = sessionStatusTemplate(session.status);
  return {
    title: displayTopicTitle(session),
    text: `${providerDisplayLabel(session.native.provider)} · ${escapeCardMarkdown(shortenHomePath(session.project))} · ${sessionStatusLabel(session.status)}`,
    ...(template ? { template } : {}),
    actions: [],
  };
}

export function displayTopicTitle(session: Session): string {
  const provider = session.native.provider === 'agy' ? 'AGY' : providerTitlePrefix(session.native.provider);
  const project = compactProjectName(session.project).replace(/\s+/gu, ' ');
  const prefix = `[${provider} · ${compactCardField(project, 24)}]`;
  const fullPrefix = `[${provider} · ${project}]`;
  const title = session.title.replace(/\s+/gu, ' ').trim();
  const existingPrefix = [prefix, fullPrefix].find(candidate => title.startsWith(candidate));
  const description = existingPrefix ? title.slice(existingPrefix.length).trimStart() : title;
  return normalizeTopicTitle(`${prefix} ${description || '未命名会话'}`);
}

async function lookupRoot(port: FeishuPort, destination: string, creationDeliveryId?: string): Promise<string | null> {
  try {
    if (!port.isTopicDestination?.(destination)) return null;
    const rootId = await port.rootMessageId?.(destination);
    if (!rootId) return null;
    // createTopic can return an existing route. Only an actual creation records this delivery.
    if (creationDeliveryId !== undefined && await port.lookupMessageId?.(creationDeliveryId) !== rootId) return null;
    return rootId;
  } catch (error) {
    if (error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked) throw error;
    return null;
  }
}

function isCurrentTitleScope(db: DatabaseSync, destination: string, sessionId: string, scope: string): boolean {
  const binding = db.prepare('SELECT session_id,binding_id,revision,access_mode FROM channel_bindings WHERE destination=?').get(destination);
  return sessionId === binding?.session_id && scope === JSON.stringify(binding);
}

export async function recordNewTopicRootTitle(
  db: DatabaseSync,
  port: FeishuPort,
  destination: string,
  scope: string,
  session: Session,
  creationDeliveryId: string,
): Promise<void> {
  const rootId = await lookupRoot(port, destination, creationDeliveryId);
  if (!rootId || !isCurrentTitleScope(db, destination, session.sessionId, scope)) return;
  db.prepare(`
    INSERT OR IGNORE INTO channel_topic_titles(destination,session_id,binding_scope,root_message_id,synced_title)
    SELECT ?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM channel_topic_titles WHERE destination=? AND root_message_id=?
    )
  `).run(destination, session.sessionId, scope, rootId, displayTopicTitle(session), destination, rootId);
}

function titlePatchRetryAfter(error: unknown): number {
  const failure = error as { platformCode?: unknown; code?: unknown; response?: { data?: { code?: unknown } } } | null;
  const code = failure?.platformCode ?? failure?.response?.data?.code ?? failure?.code;
  if (code === 230031 || code === '230031') return EXPIRED_ROOT_RETRY_AFTER;
  if (code === 230429 || code === '230429') return Date.now() + 30_000;
  return 0;
}

export async function syncTopicRootTitle(
  db: DatabaseSync,
  port: FeishuPort,
  destination: string,
  scope: string,
  session: Session,
  stampCard: (card: ChannelCard) => ChannelCard,
  guard: () => Promise<void>,
): Promise<void> {
  const rootId = await lookupRoot(port, destination);
  if (!rootId) return;
  if (!isCurrentTitleScope(db, destination, session.sessionId, scope)) throw new BindingExpired('binding changed');
  const card = topicRootCard(session);
  const titleKey = [destination, session.sessionId, scope] as const;
  let roots = inFlightRoots.get(port);
  if (!roots) inFlightRoots.set(port, roots = new Set());
  if (roots.has(rootId)) return;
  roots.add(rootId);
  try {
    const expired = db.prepare(`
      SELECT 1 FROM channel_topic_titles WHERE destination=? AND root_message_id=? AND retry_after=? LIMIT 1
    `).get(destination, rootId, EXPIRED_ROOT_RETRY_AFTER);
    if (expired) return;
    const deliveryPrefix = `topic-title:${payloadDigest([destination, rootId])}:`;
    const rootDeliveries = `${deliveryPrefix}*`;
    const unsettled = db.prepare(`
      SELECT 1 FROM channel_deliveries WHERE delivery_id GLOB ? AND state='unknown' LIMIT 1
    `).get(rootDeliveries);
    const row = db.prepare(`
      SELECT rowid,synced_title,retry_after FROM channel_topic_titles
      WHERE destination=? AND session_id=? AND binding_scope=? AND root_message_id=?
    `).get(...titleKey, rootId) as TopicTitleRow | undefined;
    const lastApplied = db.prepare(`
      SELECT rowid,synced_title,retry_after FROM channel_topic_titles
      WHERE destination=? AND root_message_id=? AND synced_title<>''
      ORDER BY rowid DESC LIMIT 1
    `).get(destination, rootId) as TopicTitleRow | undefined;
    if (!unsettled && row?.rowid === lastApplied?.rowid && row?.synced_title === card.title) return;
    if (row && row.retry_after > Date.now()) return;

    const rememberTitle = () => db.prepare(`
      INSERT OR REPLACE INTO channel_topic_titles(destination,session_id,binding_scope,root_message_id,synced_title)
      VALUES (?,?,?,?,?)
    `).run(...titleKey, rootId, card.title);
    await guard();
    // For old installations with no title history, assume the original generic title.
    // When a root is reused, use the latest known title across binding scopes.
    if (!unsettled && lastApplied?.synced_title === card.title) {
      rememberTitle();
      return;
    }
    if (!unsettled && !row && !lastApplied && isGenericSessionTitle(session.title)) return;

    // A title can recur after an intervening rename. The last successful write
    // identifies this transition and lets us recover a patch accepted before a restart.
    const deliveryId = `${deliveryPrefix}${payloadDigest([...titleKey, lastApplied?.rowid ?? null, card.title])}`;
    const claimed = db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(deliveryId).changes;
    try {
      const alreadyPatched = !claimed && await port.lookupMessageId?.(deliveryId) === rootId;
      if (!alreadyPatched) {
        await guard();
        await port.update(destination, rootId, stampCard(card), deliveryId, guard);
      }
    } catch (error) {
      db.prepare("DELETE FROM channel_deliveries WHERE delivery_id=? AND state='unknown'").run(deliveryId);
      if (error instanceof BindingExpired || error instanceof ReadAuthorizationRevoked) throw error;
      await guard();
      const retryAfter = titlePatchRetryAfter(error);
      if (retryAfter) {
        db.prepare(`
          INSERT INTO channel_topic_titles(destination,session_id,binding_scope,root_message_id,synced_title,retry_after)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(destination,session_id,binding_scope) DO UPDATE SET
            root_message_id=excluded.root_message_id,
            synced_title=excluded.synced_title,
            retry_after=excluded.retry_after
        `).run(...titleKey, rootId, row?.synced_title ?? '', retryAfter);
      }
      return;
    }

    db.exec('SAVEPOINT topic_title_delivery');
    try {
      rememberTitle();
      db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(deliveryId);
      db.prepare("DELETE FROM channel_deliveries WHERE delivery_id GLOB ? AND state='unknown'").run(rootDeliveries);
      db.exec('RELEASE topic_title_delivery');
    } catch (error) {
      db.exec('ROLLBACK TO topic_title_delivery; RELEASE topic_title_delivery');
      throw error;
    }
    await guard();
  } finally {
    roots.delete(rootId);
  }
}
