import type { DatabaseSync } from 'node:sqlite';
import { formatInlineCode, sessionStatusLabel, sessionStatusTemplate, shortenHomePath } from './card-formatters.js';
import { payloadDigest, type Session } from './contracts.js';
import { providerBadgeColor, providerDisplayLabel, type ChannelCard } from './feishu-cards.js';
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
  CREATE TABLE IF NOT EXISTS channel_topic_custom_titles (
    destination TEXT NOT NULL,
    session_id TEXT NOT NULL,
    custom_title TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(destination, session_id)
  );
`;

type TopicTitleRow = { rowid: number; synced_title: string; retry_after: number };
const inFlightRoots = new WeakMap<FeishuPort, Set<string>>();
const EXPIRED_ROOT_RETRY_AFTER = Number.MAX_SAFE_INTEGER;

const STATUS_DOTS: Record<string, string> = {
  running: '🔵',
  waiting_approval: '🟡',
  waiting_question: '🟡',
  idle: '🟢',
  failed: '🔴',
  read_only: '⚪',
  archived: '⚪',
};

export function sessionStatusDot(status: Session['status']): string {
  return STATUS_DOTS[status] ?? '🟢';
}

function stripLegacyTitlePrefix(raw: string): string {
  let text = raw.replace(/\s+/gu, ' ').trim();
  // Strip repeated leading status dots
  text = text.replace(/^(?:[🔵🟡🟢🔴⚪]\s*)+/u, '').trim();
  // Strip legacy "[AGY · project] " / "[Codex · project] " / "[Claude · project] " prefix
  text = text.replace(/^\[(?:AGY|Antigravity|Codex|Claude)\s*·\s*[^\]]+\]\s*/iu, '').trim();
  return text;
}

export function getCustomTopicTitle(db: DatabaseSync, destination: string, sessionId: string): string | null {
  try {
    const row = db.prepare(
      'SELECT custom_title FROM channel_topic_custom_titles WHERE destination=? AND session_id=?'
    ).get(destination, sessionId) as { custom_title?: string } | undefined;
    const value = row?.custom_title?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function setCustomTopicTitle(db: DatabaseSync, destination: string, sessionId: string, title: string): string {
  const cleaned = stripLegacyTitlePrefix(title) || '未命名会话';
  db.prepare(`
    INSERT OR REPLACE INTO channel_topic_custom_titles(destination, session_id, custom_title, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(destination, sessionId, cleaned, Date.now());
  return cleaned;
}

export function topicRootCard(
  session: Session,
  customTitle?: string | null,
  options?: { externallyWorking?: boolean },
): ChannelCard {
  const effectiveStatus: Session['status'] = session.status === 'read_only' && options?.externallyWorking ? 'running' : session.status;
  const effective = { ...session, status: effectiveStatus, ...(customTitle ? { title: customTitle } : {}) };
  const fullTitle = stripLegacyTitlePrefix(effective.title) || '未命名会话';
  const template = sessionStatusTemplate(effectiveStatus);
  const projectText = shortenHomePath(session.project);
  const statusLabel = session.status === 'read_only' && options?.externallyWorking
    ? '终端运行中'
    : sessionStatusLabel(session.status);
  const providerLabel = providerDisplayLabel(session.native.provider);
  const metaLine = `${providerLabel} · \`${formatInlineCode(projectText)}\` · ${statusLabel}`;
  return {
    schema: '2.0',
    title: displayTopicTitle(effective),
    subtitle: `${projectText} · ${statusLabel}`,
    headerTags: [{ text: providerLabel, color: providerBadgeColor(session.native.provider) }],
    text: `**${escapeCardMarkdown(fullTitle)}**\n${metaLine}`,
    ...(template ? { template } : {}),
    actions: [],
  };
}

export function displayTopicTitle(session: Session): string {
  const dot = sessionStatusDot(session.status);
  const description = stripLegacyTitlePrefix(session.title);
  return normalizeTopicTitle(`${dot} ${description || '未命名会话'}`);
}

function rootCardSignature(card: ChannelCard): string {
  const tags = card.headerTags?.map(t => `${t.text}:${t.color ?? ''}`).join(',') ?? '';
  return `${card.title}\n${card.subtitle ?? ''}\n${tags}\n${card.template ?? ''}\n${card.text}`;
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
  const cardSig = rootCardSignature(topicRootCard(session, getCustomTopicTitle(db, destination, session.sessionId)));
  db.prepare(`
    INSERT OR IGNORE INTO channel_topic_titles(destination,session_id,binding_scope,root_message_id,synced_title)
    SELECT ?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM channel_topic_titles WHERE destination=? AND root_message_id=?
    )
  `).run(destination, session.sessionId, scope, rootId, cardSig, destination, rootId);
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
  options?: { externallyWorking?: boolean },
): Promise<void> {
  const rootId = await lookupRoot(port, destination);
  if (!rootId) return;
  if (!isCurrentTitleScope(db, destination, session.sessionId, scope)) throw new BindingExpired('binding changed');
  const customTitle = getCustomTopicTitle(db, destination, session.sessionId);
  const card = topicRootCard(session, customTitle, options);
  const cardSig = rootCardSignature(card);
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
    if (!unsettled && row?.rowid === lastApplied?.rowid && row?.synced_title === cardSig) return;
    if (row && row.retry_after > Date.now()) return;

    const rememberTitle = () => db.prepare(`
      INSERT OR REPLACE INTO channel_topic_titles(destination,session_id,binding_scope,root_message_id,synced_title)
      VALUES (?,?,?,?,?)
    `).run(...titleKey, rootId, cardSig);
    await guard();
    // For old installations with no title history, assume the original generic title.
    // When a root is reused, use the latest known title across binding scopes.
    if (!unsettled && lastApplied?.synced_title === cardSig) {
      rememberTitle();
      return;
    }
    if (!unsettled && !row && !lastApplied && !customTitle && isGenericSessionTitle(session.title)) return;

    // A title can recur after an intervening rename. The last successful write
    // identifies this transition and lets us recover a patch accepted before a restart.
    const deliveryId = `${deliveryPrefix}${payloadDigest([...titleKey, lastApplied?.rowid ?? null, cardSig])}`;
    const claimed = db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(deliveryId).changes;
    try {
      const alreadyPatched = !claimed && await port.lookupMessageId?.(deliveryId) === rootId;
      if (!alreadyPatched) {
        await guard();
        // Default unrecorded legacy roots to 1.0 so FeishuSdkPort's 200830 upgrade path runs;
        // newly created topics record '2.0' in sdk_card_schemas and still patch as Card 2.0.
        await port.update(destination, rootId, stampCard({ ...card, schema: '1.0' }), deliveryId, guard);
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
