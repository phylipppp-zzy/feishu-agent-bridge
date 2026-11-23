import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PlatformObservation, UnifiedService } from '../adapter.js';
import {
  payloadDigest,
  type Identity,
  type Operation,
  type Provider,
  type Session,
} from '../contracts.js';
import type { ChannelCard } from '../feishu-cards.js';
import { StoreError } from '../store.js';
import type { DecisionSyncStore } from './decision-store.js';
import {
  buildDecisionPendingItem,
  buildInteractionPendingItem,
  buildPendingRootCard,
  buildWithdrawnCard,
  formatPendingSummaryCard,
  isActionableDecision,
  isActionableInteraction,
  paginatePendingItems,
  renderPendingItemCard,
} from './pending-cards.js';
import { describePendingWithdrawalReason, executePendingSubmit } from './pending-submit.js';
import {
  DEFAULT_PENDING_ROOT_KEY,
  DEFAULT_PENDING_TOPIC_TITLE,
  PENDING_HUB_SCHEMA_SQL,
  fail,
  mapPendingRootRow,
  nonempty,
  type PendingEnvelope,
  type PendingHubOptions,
  type PendingHubPort,
  type PendingHubRoot,
  type PendingHubTextResult,
  type PendingItemView,
  type PendingPage,
  type PendingQuery,
  type PendingRefRow,
  type PendingRootRow,
  type PendingSubmitPayload,
  type PendingSubmitResult,
} from './pending-types.js';

/**
 * N2: Fixed "待处理" Hub view unifying 4 categories (question, approval, business_decision, execution_auth)
 * across claude, codex, and agy. Stores lightweight references only — never duplicates core's approval state machine.
 */
export class PendingHub {
  private readonly db: DatabaseSync;
  private readonly owner: Identity;
  private readonly destination: string;
  private readonly allowedDestinations: ReadonlySet<string> | null;
  private readonly service: UnifiedService & { dispatch?: (operationId: string) => Promise<Operation> };
  private readonly decisionStore: DecisionSyncStore | undefined;
  private readonly port: PendingHubPort;
  private readonly rootKey: string;
  private readonly topicTitle: string;
  private readonly autoDispatch: boolean;
  private readonly authorize:
    | ((identity: Identity, destination: string, targetId: string) => Promise<boolean> | boolean)
    | undefined;
  private readonly resolveTopicLink:
    | ((sessionId: string, hubDestination: string) => Promise<string | null> | string | null)
    | undefined;
  private readonly now: () => number;
  private readonly withdrawLocks = new Map<string, Promise<void>>();

  constructor(options: PendingHubOptions) {
    if (!options || !nonempty(options.dbPath)) fail('invalid_request', 'dbPath is required');
    if (!options.owner || !nonempty(options.owner.source) || !nonempty(options.owner.subject)) {
      fail('invalid_request', 'single fixed owner identity is required');
    }
    if (!nonempty(options.destination)) fail('invalid_request', 'destination is required');

    this.owner = { source: options.owner.source, subject: options.owner.subject };
    this.destination = options.destination;
    this.allowedDestinations = options.allowedDestinations ?? null;
    this.service = options.service;
    this.decisionStore = options.decisionStore;
    this.port = options.port;
    this.rootKey = options.rootKey?.trim() || DEFAULT_PENDING_ROOT_KEY;
    this.topicTitle = options.topicTitle?.trim() || DEFAULT_PENDING_TOPIC_TITLE;
    this.autoDispatch = options.autoDispatch ?? true;
    this.authorize = options.authorize;
    this.resolveTopicLink = options.resolveTopicLink;
    this.now = options.now ?? (() => Date.now());

    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(PENDING_HUB_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  getRoot(): PendingHubRoot | null {
    const row = this.db
      .prepare('SELECT * FROM pending_hub_roots_v1 WHERE hub_key=?')
      .get(this.rootKey) as PendingRootRow | undefined;
    return row ? mapPendingRootRow(row) : null;
  }

  getRef(refId: string): PendingRefRow | null {
    const row = this.db.prepare('SELECT * FROM pending_hub_refs_v1 WHERE ref_id=?').get(refId) as PendingRefRow | undefined;
    return row ?? null;
  }

  bindSourceSession(sessionId: string, sourceDestination: string): void {
    if (!nonempty(sessionId) || !nonempty(sourceDestination)) {
      fail('invalid_request', 'sessionId and sourceDestination are required');
    }
    this.db
      .prepare(
        `INSERT INTO pending_hub_sessions_v1(session_id, source_destination, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET source_destination=excluded.source_destination, updated_at=excluded.updated_at`,
      )
      .run(sessionId, sourceDestination, this.now());
  }

  getSourceDestination(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT source_destination FROM pending_hub_sessions_v1 WHERE session_id=?')
      .get(sessionId) as { source_destination: string } | undefined;
    return row?.source_destination ?? null;
  }

  /**
   * Registers an externally created source card messageId (e.g. rendered by FeishuChannel)
   * so that resolving via Hub or native terminal withdraws both cards.
   */
  trackSourceCard(params: {
    interactionId: string;
    category?: 'question' | 'approval';
    provider: Provider;
    sourceSessionId: string;
    sourceDestination: string;
    messageId: string;
    revision: number;
    connectionGeneration: number;
  }): void {
    this.bindSourceSession(params.sourceSessionId, params.sourceDestination);
    const category = params.category ?? 'question';
    const refId = `interaction:${params.interactionId}`;
    const existing = this.getRef(refId);
    const now = this.now();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO pending_hub_refs_v1(
            ref_id, category, provider, source_session_id, source_destination,
            interaction_id, decision_id, revision, connection_generation,
            source_card_message_id, hub_card_message_id, card_active, withdrawn_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 1, NULL, ?, ?)`,
        )
        .run(
          refId,
          category,
          params.provider,
          params.sourceSessionId,
          params.sourceDestination,
          params.interactionId,
          params.revision,
          params.connectionGeneration,
          params.messageId,
          now,
          now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE pending_hub_refs_v1
           SET category=?, source_destination=?, source_card_message_id=?, revision=?, connection_generation=?, updated_at=?
           WHERE ref_id=?`,
        )
        .run(
          category,
          params.sourceDestination,
          params.messageId,
          params.revision,
          params.connectionGeneration,
          now,
          refId,
        );
    }
  }

  private checkBaseAuth(identity?: Identity, targetDestination?: string): void {
    const actor = identity ?? this.owner;
    if (actor.source !== this.owner.source || actor.subject !== this.owner.subject) {
      fail('unauthorized', 'unauthorized pending hub user');
    }
    const dest = targetDestination ?? this.destination;
    if (this.allowedDestinations && !this.allowedDestinations.has(dest)) {
      fail('unauthorized', `unauthorized destination: ${dest}`);
    }
  }

  private async checkEnvelopeAuth(
    entryPoint: 'hub' | 'source',
    envelope: PendingEnvelope,
    targetId: string,
    expectedSourceDestination: string | null,
  ): Promise<void> {
    if (!envelope || !nonempty(envelope.eventId) || !nonempty(envelope.destination) || !envelope.identity) {
      fail('invalid_request', 'valid PendingEnvelope is required');
    }
    this.checkBaseAuth(envelope.identity, envelope.destination);

    if (entryPoint === 'hub') {
      const root = this.getRoot();
      const validHubDest = root?.topicDestination ?? root?.chatDestination ?? this.destination;
      if (envelope.destination !== validHubDest && envelope.destination !== this.destination) {
        fail('unauthorized', `wrong pending hub destination: ${envelope.destination}`);
      }
    } else {
      if (!expectedSourceDestination || envelope.destination !== expectedSourceDestination) {
        fail('unauthorized', `wrong source topic destination: ${envelope.destination}`);
      }
    }

    if (this.authorize) {
      const ok = await this.authorize(envelope.identity, envelope.destination, targetId);
      if (!ok) fail('unauthorized', 'pending hub authorization denied');
    }
  }

  async ensureRoot(): Promise<PendingHubRoot> {
    this.checkBaseAuth(this.owner, this.destination);
    const now = this.now();
    const deliveryId = `pending-root:${payloadDigest([
      this.rootKey,
      this.owner.source,
      this.owner.subject,
      this.destination,
    ])}`;

    let existingState: 'new' | 'active' | 'unknown' | 'rejected' = 'new';
    let existingRow: PendingRootRow | undefined;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      existingRow = this.db
        .prepare('SELECT * FROM pending_hub_roots_v1 WHERE hub_key=?')
        .get(this.rootKey) as PendingRootRow | undefined;
      if (existingRow) {
        if (
          existingRow.owner_source !== this.owner.source ||
          existingRow.owner_subject !== this.owner.subject ||
          existingRow.chat_destination !== this.destination
        ) {
          fail('unauthorized', 'pending hub root identity mismatch');
        }
        existingState = existingRow.state;
      } else {
        this.db
          .prepare(
            `INSERT INTO pending_hub_roots_v1(
              hub_key, owner_source, owner_subject, chat_destination,
              topic_destination, root_message_id, summary_message_id, summary_signature,
              creation_delivery_id, state, created_at, updated_at, last_error
            ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 'unknown', ?, ?, NULL)`,
          )
          .run(this.rootKey, this.owner.source, this.owner.subject, this.destination, deliveryId, now, now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    if (existingState === 'active' && existingRow) {
      return mapPendingRootRow(existingRow);
    }
    if (existingState === 'unknown') {
      fail('outcome_unknown', 'pending hub root creation outcome unknown; refusing duplicate root');
    }
    if (existingState === 'rejected') {
      fail('temporarily_unavailable', 'pending hub root creation was rejected');
    }

    const rootCard = buildPendingRootCard(this.topicTitle);
    const guard = async () => {
      this.checkBaseAuth(this.owner, this.destination);
      const current = this.getRoot();
      if (!current || current.creationDeliveryId !== deliveryId || current.state !== 'unknown') {
        fail('control_conflict', 'pending hub root state changed');
      }
    };

    try {
      if (this.port.createTopic) {
        const topicDest = await this.port.createTopic(
          this.destination,
          this.rootKey,
          rootCard,
          deliveryId,
          guard,
        );
        if (!nonempty(topicDest)) throw new Error('empty topic destination');
        const msgId = (await this.port.lookupMessageId?.(deliveryId)) ?? null;
        this.db
          .prepare(
            `UPDATE pending_hub_roots_v1
             SET state='active', topic_destination=?, root_message_id=COALESCE(?, root_message_id), updated_at=?, last_error=NULL
             WHERE hub_key=? AND state='unknown'`,
          )
          .run(topicDest, msgId, this.now(), this.rootKey);
      } else {
        let msgId = (await this.port.send(this.destination, rootCard, deliveryId, guard)) || null;
        if (!msgId) msgId = (await this.port.lookupMessageId?.(deliveryId)) ?? null;
        if (!msgId) throw new Error('empty root message id');
        this.db
          .prepare(
            `UPDATE pending_hub_roots_v1
             SET state='active', topic_destination=?, root_message_id=?, updated_at=?, last_error=NULL
             WHERE hub_key=? AND state='unknown'`,
          )
          .run(this.destination, msgId, this.now(), this.rootKey);
      }
      return this.getRoot()!;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.db
        .prepare("UPDATE pending_hub_roots_v1 SET last_error=?, updated_at=? WHERE hub_key=? AND state='unknown'")
        .run(msg, this.now(), this.rootKey);
      if (error instanceof StoreError) throw error;
      fail('outcome_unknown', `pending hub root creation outcome unknown: ${msg}`);
    }
  }

  private async resolveSourceLink(sessionId: string | null, hubDestination: string): Promise<string | null> {
    if (!sessionId) return null;
    if (this.resolveTopicLink) {
      return this.resolveTopicLink(sessionId, hubDestination);
    }
    if (this.port.topicLinkForSession) {
      return this.port.topicLinkForSession(hubDestination, sessionId);
    }
    return null;
  }

  private async collectAuthoritativePending(nowMs: number): Promise<PendingItemView[]> {
    const items: PendingItemView[] = [];
    const seenInteractions = new Set<string>();
    const hubDest = this.getRoot()?.topicDestination ?? this.destination;

    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    const sessions: Session[] = [];
    do {
      const page = await this.service.listSessions({ limit: 100, ...(cursor ? { cursor } : {}) });
      sessions.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (seenCursors.has(cursor) || seenCursors.size >= 100) break;
        seenCursors.add(cursor);
      }
    } while (cursor);

    for (const session of sessions) {
      let snapshot: Awaited<ReturnType<UnifiedService['getSnapshot']>>;
      try {
        snapshot = await this.service.getSnapshot(session.sessionId);
      } catch {
        continue;
      }
      const sourceDestination = this.getSourceDestination(session.sessionId);
      for (const interaction of snapshot.value.interactions) {
        seenInteractions.add(interaction.interactionId);
        if (
          !isActionableInteraction(
            interaction,
            snapshot.value.session,
            snapshot.value.connectionGeneration,
            nowMs,
          )
        ) {
          continue;
        }
        const sourceTopicUrl = await this.resolveSourceLink(session.sessionId, hubDest);
        items.push(
          buildInteractionPendingItem({
            interaction,
            session,
            sourceSessionId: session.sessionId,
            sourceDestination,
            sourceTopicUrl,
          }),
        );
      }
    }

    // Also re-check any bound source sessions that might not have appeared in listSessions
    const boundRows = this.db
      .prepare('SELECT session_id, source_destination FROM pending_hub_sessions_v1')
      .all() as Array<{ session_id: string; source_destination: string }>;
    for (const row of boundRows) {
      if (sessions.some((s) => s.sessionId === row.session_id)) continue;
      let snapshot: Awaited<ReturnType<UnifiedService['getSnapshot']>>;
      try {
        snapshot = await this.service.getSnapshot(row.session_id);
      } catch {
        continue;
      }
      for (const interaction of snapshot.value.interactions) {
        if (seenInteractions.has(interaction.interactionId)) continue;
        seenInteractions.add(interaction.interactionId);
        if (
          !isActionableInteraction(
            interaction,
            snapshot.value.session,
            snapshot.value.connectionGeneration,
            nowMs,
          )
        ) {
          continue;
        }
        const sourceTopicUrl = await this.resolveSourceLink(row.session_id, hubDest);
        items.push(
          buildInteractionPendingItem({
            interaction,
            session: snapshot.value.session,
            sourceSessionId: row.session_id,
            sourceDestination: row.source_destination,
            sourceTopicUrl,
          }),
        );
      }
    }

    if (this.decisionStore) {
      const decisions = this.decisionStore.listDecisions({ status: 'pending' });
      for (const decision of decisions) {
        if (!isActionableDecision(decision, nowMs)) continue;
        const sourceTopicUrl = await this.resolveSourceLink(decision.source.sessionId ?? null, hubDest);
        items.push(buildDecisionPendingItem(decision, sourceTopicUrl));
      }
    }

    items.sort((a, b) => a.refId.localeCompare(b.refId));
    return items;
  }

  /**
   * Lists currently pending items directly from authoritative Core & DecisionStore,
   * with category/provider/search filtering and cursor pagination.
   */
  async listPending(query: PendingQuery = {}, nowMs = this.now()): Promise<PendingPage> {
    const all = await this.collectAuthoritativePending(nowMs);
    return paginatePendingItems(all, query);
  }

  renderHubItemCard(item: PendingItemView, entryPoint: 'hub' | 'source', hubBindingId: string): ChannelCard {
    return renderPendingItemCard(item, entryPoint, hubBindingId, this.now());
  }

  formatSummaryCard(page: PendingPage, query: PendingQuery = {}): ChannelCard {
    return formatPendingSummaryCard(this.topicTitle, page, query);
  }

  async buildSummaryCard(query: PendingQuery = {}, nowMs = this.now()): Promise<ChannelCard> {
    const page = await this.listPending(query, nowMs);
    return this.formatSummaryCard(page, query);
  }

  async renderPage(
    envelope: PendingEnvelope & { cardMessageId?: string },
    query: PendingQuery = {},
    nowMs = this.now(),
  ): Promise<PendingPage> {
    await this.checkEnvelopeAuth('hub', envelope, 'hub:page', null);
    const page = await this.listPending(query, nowMs);
    const card = this.formatSummaryCard(page, query);
    const deliveryId = `pending-page:${payloadDigest([
      envelope.eventId,
      envelope.destination,
      envelope.cardMessageId ?? null,
      query,
    ])}`;
    if (envelope.cardMessageId) {
      await this.port.update(envelope.destination, envelope.cardMessageId, card, deliveryId);
    } else {
      await this.port.send(envelope.destination, card, deliveryId);
    }
    return page;
  }

  private async deliverOnce(
    destination: string,
    card: ChannelCard,
    deliveryId: string,
  ): Promise<string | null> {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO pending_hub_deliveries_v1 VALUES (?, 'unknown')")
      .run(deliveryId);
    if (!inserted.changes) {
      return (await this.port.lookupMessageId?.(deliveryId)) ?? null;
    }
    const msgId = (await this.port.send(destination, card, deliveryId)) || null;
    this.db.prepare("UPDATE pending_hub_deliveries_v1 SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return msgId ?? (await this.port.lookupMessageId?.(deliveryId)) ?? null;
  }

  private async updateOnce(
    destination: string,
    messageId: string,
    card: ChannelCard,
    deliveryId: string,
  ): Promise<boolean> {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO pending_hub_deliveries_v1 VALUES (?, 'unknown')")
      .run(deliveryId);
    if (!inserted.changes) return false;
    await this.port.update(destination, messageId, card, deliveryId);
    this.db.prepare("UPDATE pending_hub_deliveries_v1 SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return true;
  }

  /**
   * Synchronizes authoritative pending items to both source topics and the fixed Pending Hub,
   * and withdraws any active cards whose authoritative state is resolved/expired/cancelled/stale.
   * Never resurrects already-answered or expired items after restart.
   */
  async sync(options: { nowMs?: number; query?: PendingQuery } = {}): Promise<{
    activeCount: number;
    withdrawnRefs: string[];
  }> {
    const nowMs = options.nowMs ?? this.now();
    const root = await this.ensureRoot();
    const hubDest = root.topicDestination ?? root.chatDestination;
    const hubBindingId = createHash('sha256').update(this.rootKey).digest('hex').slice(0, 16);

    const activeItems = await this.collectAuthoritativePending(nowMs);
    const activeByRefId = new Map(activeItems.map((item) => [item.refId, item]));
    const withdrawnRefs: string[] = [];

    // 1. Withdraw any tracked active cards that are no longer actionable in authoritative stores
    const activeRefs = this.db
      .prepare('SELECT * FROM pending_hub_refs_v1 WHERE card_active=1')
      .all() as unknown as PendingRefRow[];
    for (const ref of activeRefs) {
      if (activeByRefId.has(ref.ref_id)) continue;
      const reason = await this.describeWithdrawalReason(ref);
      await this.withdrawRefCards(ref, reason, hubDest);
      withdrawnRefs.push(ref.ref_id);
    }

    // 2. Render/update cards for currently actionable items ONLY
    for (const item of activeItems) {
      const existing = this.getRef(item.refId);
      const itemRevision = item.provider !== 'decision' ? item.revision : item.version;
      const itemConnGen = item.provider !== 'decision' ? item.connectionGeneration : null;

      let sourceCardMessageId = existing?.source_card_message_id ?? null;
      let hubCardMessageId = existing?.hub_card_message_id ?? null;

      if (item.sourceDestination) {
        const sourceCard = this.renderHubItemCard(item, 'source', hubBindingId);
        if (!sourceCardMessageId) {
          const deliveryId = `pending-src:${payloadDigest([item.refId, item.sourceDestination, itemRevision])}`;
          sourceCardMessageId = await this.deliverOnce(item.sourceDestination, sourceCard, deliveryId);
        } else if (existing && existing.revision < itemRevision) {
          const deliveryId = `pending-src-upd:${payloadDigest([item.refId, item.sourceDestination, itemRevision])}`;
          await this.updateOnce(item.sourceDestination, sourceCardMessageId, sourceCard, deliveryId);
        }
      }

      const hubCard = this.renderHubItemCard(item, 'hub', hubBindingId);
      if (!hubCardMessageId) {
        const deliveryId = `pending-hub:${payloadDigest([item.refId, hubDest, itemRevision])}`;
        hubCardMessageId = await this.deliverOnce(hubDest, hubCard, deliveryId);
      } else if (existing && existing.revision < itemRevision) {
        const deliveryId = `pending-hub-upd:${payloadDigest([item.refId, hubDest, itemRevision])}`;
        await this.updateOnce(hubDest, hubCardMessageId, hubCard, deliveryId);
      }

      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO pending_hub_refs_v1(
            ref_id, category, provider, source_session_id, source_destination,
            interaction_id, decision_id, revision, connection_generation,
            source_card_message_id, hub_card_message_id, card_active, withdrawn_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
          ON CONFLICT(ref_id) DO UPDATE SET
            category=excluded.category,
            provider=excluded.provider,
            source_session_id=excluded.source_session_id,
            source_destination=COALESCE(excluded.source_destination, pending_hub_refs_v1.source_destination),
            revision=excluded.revision,
            connection_generation=excluded.connection_generation,
            source_card_message_id=COALESCE(excluded.source_card_message_id, pending_hub_refs_v1.source_card_message_id),
            hub_card_message_id=COALESCE(excluded.hub_card_message_id, pending_hub_refs_v1.hub_card_message_id),
            card_active=1,
            withdrawn_reason=NULL,
            updated_at=excluded.updated_at`,
        )
        .run(
          item.refId,
          item.category,
          item.provider,
          item.sourceSessionId,
          item.sourceDestination,
          item.category === 'question' || item.category === 'approval' ? item.interactionId : null,
          item.category === 'business_decision' || item.category === 'execution_auth' ? item.decisionId : null,
          itemRevision,
          itemConnGen,
          sourceCardMessageId,
          hubCardMessageId,
          now,
          now,
        );
    }

    // 3. Update Hub summary overview card
    await this.refreshSummaryCard(hubDest, options.query, nowMs);

    return {
      activeCount: activeItems.length,
      withdrawnRefs,
    };
  }

  private async describeWithdrawalReason(ref: PendingRefRow): Promise<string> {
    return describePendingWithdrawalReason(ref, this.service, this.decisionStore);
  }

  private async withdrawRefCards(ref: PendingRefRow, reason: string, hubDest: string): Promise<{
    sourceUpdated: boolean;
    hubUpdated: boolean;
  }> {
    const previous = this.withdrawLocks.get(ref.ref_id) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((r) => {
      release = r;
    });
    const tail = previous.then(() => lock);
    this.withdrawLocks.set(ref.ref_id, tail);
    await previous;

    try {
      const latest = this.getRef(ref.ref_id);
      if (!latest || latest.card_active === 0) {
        return { sourceUpdated: false, hubUpdated: false };
      }

      let sourceUpdated = false;
      let hubUpdated = false;
      const withdrawnCard = buildWithdrawnCard(latest.category, reason);
      const stamp = this.now();

      if (latest.source_card_message_id && latest.source_destination) {
        const deliveryId = `pending-withdraw-src:${payloadDigest([latest.ref_id, latest.source_card_message_id, latest.revision])}`;
        sourceUpdated = await this.updateOnce(
          latest.source_destination,
          latest.source_card_message_id,
          withdrawnCard,
          deliveryId,
        );
      }
      if (latest.hub_card_message_id) {
        const deliveryId = `pending-withdraw-hub:${payloadDigest([latest.ref_id, latest.hub_card_message_id, latest.revision])}`;
        hubUpdated = await this.updateOnce(hubDest, latest.hub_card_message_id, withdrawnCard, deliveryId);
      }

      this.db
        .prepare(
          'UPDATE pending_hub_refs_v1 SET card_active=0, withdrawn_reason=?, updated_at=? WHERE ref_id=?',
        )
        .run(reason, stamp, latest.ref_id);

      return { sourceUpdated, hubUpdated };
    } finally {
      release();
      if (this.withdrawLocks.get(ref.ref_id) === tail) {
        this.withdrawLocks.delete(ref.ref_id);
      }
    }
  }

  private async refreshSummaryCard(hubDest: string, query?: PendingQuery, nowMs = this.now()): Promise<void> {
    const rootRow = this.db
      .prepare('SELECT summary_message_id, summary_signature FROM pending_hub_roots_v1 WHERE hub_key=?')
      .get(this.rootKey) as { summary_message_id: string | null; summary_signature: string | null } | undefined;
    if (!rootRow) return;

    const summaryCard = await this.buildSummaryCard(query, nowMs);
    const signature = payloadDigest(summaryCard);
    if (rootRow.summary_message_id && rootRow.summary_signature === signature) return;

    if (!rootRow.summary_message_id) {
      const deliveryId = `pending-summary-init:${payloadDigest([this.rootKey, hubDest])}`;
      const msgId = await this.deliverOnce(hubDest, summaryCard, deliveryId);
      if (msgId) {
        this.db
          .prepare('UPDATE pending_hub_roots_v1 SET summary_message_id=?, summary_signature=?, updated_at=? WHERE hub_key=?')
          .run(msgId, signature, this.now(), this.rootKey);
      }
    } else {
      const deliveryId = `pending-summary-upd:${payloadDigest([this.rootKey, hubDest, signature])}`;
      const updated = await this.updateOnce(hubDest, rootRow.summary_message_id, summaryCard, deliveryId);
      if (updated) {
        this.db
          .prepare('UPDATE pending_hub_roots_v1 SET summary_signature=?, updated_at=? WHERE hub_key=?')
          .run(signature, this.now(), this.rootKey);
      }
    }
  }

  /**
   * Synchronizes card withdrawal when UnifiedCore emits a native observation
   * (e.g. native terminal answered first, or connection generation advanced).
   */
  async handleObservation(observation: PlatformObservation): Promise<void> {
    const root = this.getRoot();
    if (!root || root.state !== 'active') return;
    const hubDest = root.topicDestination ?? root.chatDestination;

    if (observation.type === 'interaction') {
      const refId = `interaction:${observation.interaction.interactionId}`;
      const ref = this.getRef(refId);
      if (ref && ref.card_active === 1 && observation.interaction.status !== 'awaiting_answer') {
        const nativeSource =
          observation.interaction.nativeResult && 'source' in observation.interaction.nativeResult
            ? observation.interaction.nativeResult.source
            : null;
        const reason =
          nativeSource === 'terminal'
            ? '已在原终端完成处理，两处卡片同步撤下'
            : await this.describeWithdrawalReason(ref);
        await this.withdrawRefCards(ref, reason, hubDest);
        await this.refreshSummaryCard(hubDest);
      }
      return;
    }

    if (observation.type === 'connection') {
      const activeRefs = this.db
        .prepare('SELECT * FROM pending_hub_refs_v1 WHERE card_active=1 AND interaction_id IS NOT NULL')
        .all() as unknown as PendingRefRow[];
      let changed = false;
      for (const ref of activeRefs) {
        if (ref.connection_generation !== null && ref.connection_generation < observation.connectionGeneration) {
          await this.withdrawRefCards(ref, '连接代数已更新，旧请求卡片已失效', hubDest);
          changed = true;
        }
      }
      if (changed) await this.refreshSummaryCard(hubDest);
    }
  }

  /**
   * Ordinary Hub chat text is NEVER interpreted as an approval or answer.
   */
  async handleHubText(envelope: PendingEnvelope, text: string): Promise<PendingHubTextResult> {
    await this.checkEnvelopeAuth('hub', envelope, 'hub:text', null);
    void text;
    return {
      handled: false,
      status: 'ignored_ordinary_chat',
      reason: 'ordinary hub chat text is never treated as approval or answer; use verified card action or explicit structured question form',
    };
  }

  async submitFromHub(envelope: PendingEnvelope, payload: PendingSubmitPayload): Promise<PendingSubmitResult> {
    return this.submitAnswer('hub', envelope, payload);
  }

  async submitFromSource(envelope: PendingEnvelope, payload: PendingSubmitPayload): Promise<PendingSubmitResult> {
    return this.submitAnswer('source', envelope, payload);
  }

  /**
   * Single-authority submission from either Source Topic or Pending Hub.
   * Atomically invokes UnifiedService.resolveInteraction or DecisionSyncStore.answerDecision,
   * and withdraws both source and Hub cards upon completion or conflict.
   */
  async submitAnswer(
    entryPoint: 'hub' | 'source',
    envelope: PendingEnvelope,
    payload: PendingSubmitPayload,
  ): Promise<PendingSubmitResult> {
    return executePendingSubmit(
      {
        destination: this.destination,
        rootKey: this.rootKey,
        autoDispatch: this.autoDispatch,
        service: this.service,
        decisionStore: this.decisionStore,
        now: this.now,
        getRoot: () => this.getRoot(),
        getRef: (refId) => this.getRef(refId),
        getSourceDestination: (sessionId) => this.getSourceDestination(sessionId),
        checkEnvelopeAuth: (ep, env, targetId, expectedSourceDest) =>
          this.checkEnvelopeAuth(ep, env, targetId, expectedSourceDest),
        describeWithdrawalReason: (ref) => this.describeWithdrawalReason(ref),
        withdrawRefCards: (ref, reason, hubDest) => this.withdrawRefCards(ref, reason, hubDest),
        refreshSummaryCard: (hubDest) => this.refreshSummaryCard(hubDest),
      },
      entryPoint,
      envelope,
      payload,
    );
  }
}
