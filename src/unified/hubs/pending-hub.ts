import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PlatformObservation, UnifiedService } from '../adapter.js';
import {
  payloadDigest,
  type Identity,
  type Operation,
  type Provider,
} from '../contracts.js';
import { interactionStatusText, type ChannelCard } from '../feishu-cards.js';
import { StoreError } from '../store.js';
import type { DecisionSyncStore } from './decision-store.js';
import {
  buildAnsweredDecisionCard,
  buildDecisionPendingItem,
  buildInteractionPendingItem,
  buildPendingInteractionStatusCard,
  buildPendingRootCard,
  buildWithdrawnCard,
  formatPendingSummaryCard,
  isActionableDecision,
  isActionableInteraction,
  paginatePendingItems,
  renderPendingItemCard,
} from './pending-cards.js';
import { discoverPendingItems } from './pending-discovery.js';
import { executePendingSubmit } from './pending-submit.js';
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
  type PendingSubmitNotifications,
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
  private readonly shouldRefreshSource: PendingHubOptions['shouldRefreshSource'];
  private readonly refLocks = new Map<string, Promise<void>>();
  private summaryLock = Promise.resolve();
  private rootCreation: Promise<PendingHubRoot> | undefined;
  private summaryVersion = 0;

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
    this.shouldRefreshSource = options.shouldRefreshSource;

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
  async trackSourceCard(params: {
    interactionId: string;
    category?: 'question' | 'approval';
    provider: Provider;
    sourceSessionId: string;
    sourceDestination: string;
    messageId: string;
    revision: number;
    connectionGeneration: number;
  }): Promise<void> {
    this.bindSourceSession(params.sourceSessionId, params.sourceDestination);
    const refId = `interaction:${params.interactionId}`;
    await this.withRefLock(refId, async () => {
      this.recordSourceCard(refId, params);
      await this.refreshInteractionRefLocked(params.interactionId);
    });
  }

  private recordSourceCard(refId: string, params: Parameters<PendingHub['trackSourceCard']>[0]): void {
    const category = params.category ?? 'question';
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
           SET category=?, source_destination=?, source_card_message_id=?,
               revision=MAX(revision,?), connection_generation=?,
               withdrawn_reason=CASE WHEN source_card_message_id IS ? THEN withdrawn_reason ELSE NULL END,
               updated_at=?
           WHERE ref_id=?`,
        )
        .run(
          category,
          params.sourceDestination,
          params.messageId,
          params.revision,
          params.connectionGeneration,
          params.messageId,
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

  ensureRoot(): Promise<PendingHubRoot> {
    this.rootCreation ??= this.ensureRootOnce().finally(() => { this.rootCreation = undefined; });
    return this.rootCreation;
  }

  private async ensureRootOnce(): Promise<PendingHubRoot> {
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

  private collectAuthoritativePending(now: number): Promise<PendingItemView[]> {
    const hubDest = this.getRoot()?.topicDestination ?? this.destination;
    const boundSources = this.db.prepare('SELECT session_id, source_destination FROM pending_hub_sessions_v1')
      .all() as Array<{ session_id: string; source_destination: string }>;
    return discoverPendingItems({
      service: this.service,
      decisionStore: this.decisionStore,
      boundSources,
      resolveSourceLink: (sessionId) => this.resolveSourceLink(sessionId, hubDest),
    }, now);
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
    if (!inserted.changes) {
      const previous = this.db.prepare('SELECT state FROM pending_hub_deliveries_v1 WHERE delivery_id=?')
        .get(deliveryId) as { state: string } | undefined;
      if (previous?.state === 'sent') return false;
    }
    // PATCH of the current card is idempotent, including after a lost receipt.
    await this.port.update(destination, messageId, card, deliveryId);
    this.db.prepare("UPDATE pending_hub_deliveries_v1 SET state='sent' WHERE delivery_id=?").run(deliveryId);
    return true;
  }

  private async withRefLock<T>(refId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.refLocks.get(refId) ?? Promise.resolve();
    const work = previous.then(fn);
    const tail = work.then(() => {}, () => {});
    this.refLocks.set(refId, tail);
    try {
      return await work;
    } finally {
      if (this.refLocks.get(refId) === tail) this.refLocks.delete(refId);
    }
  }

  private async currentItem(item: PendingItemView, nowMs: number): Promise<PendingItemView | null> {
    if (item.provider === 'decision') {
      const decision = this.findDecision(item.decisionId);
      return decision && isActionableDecision(decision, nowMs)
        ? buildDecisionPendingItem(decision, item.sourceTopicUrl)
        : null;
    }
    const { value: snapshot } = await this.service.getSnapshot(item.sourceSessionId);
    const interaction = snapshot.interactions.find((candidate) => candidate.interactionId === item.interactionId);
    if (!interaction || !isActionableInteraction(interaction, snapshot.session, snapshot.connectionGeneration, nowMs)) {
      return null;
    }
    return buildInteractionPendingItem({
      interaction,
      session: snapshot.session,
      sourceSessionId: item.sourceSessionId,
      sourceDestination: this.getSourceDestination(item.sourceSessionId),
      sourceTopicUrl: item.sourceTopicUrl,
    });
  }

  private async deliverActionableItem(item: PendingItemView, hubDest: string, hubBindingId: string): Promise<void> {
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
      } else if (existing && existing.revision < itemRevision && this.canUpdateSource(existing)) {
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

  /** Revalidate each interaction inside the same lock used for targeted updates. */
  async sync(options: { nowMs?: number; query?: PendingQuery } = {}): Promise<{
    activeCount: number;
    withdrawnRefs: string[];
  }> {
    const nowMs = options.nowMs ?? this.now();
    const root = await this.ensureRoot();
    const hubDest = root.topicDestination ?? root.chatDestination;
    const hubBindingId = createHash('sha256').update(this.rootKey).digest('hex').slice(0, 16);

    const version = this.summaryVersion;
    const candidates = await this.collectAuthoritativePending(nowMs);
    const candidateIds = new Set(candidates.map((item) => item.refId));
    const active: PendingItemView[] = [];
    const withdrawnRefs: string[] = [];

    const tracked = this.db
      .prepare(`SELECT * FROM pending_hub_refs_v1 WHERE card_active=1
        OR (interaction_id IS NOT NULL AND
          (withdrawn_reason IN (?, ?, ?) OR withdrawn_reason LIKE '已通过%提交答复%'))`)
      .all('答复已提交，等待原端确认', '答复结果未知，请查看原会话', '已提交答复，等待确认回执') as unknown as PendingRefRow[];
    for (const ref of tracked) {
      if (candidateIds.has(ref.ref_id)) continue;
      const result = ref.interaction_id
        ? await this.refreshInteractionRef(ref.interaction_id, nowMs)
        : await this.refreshDecisionRef(ref.decision_id!, nowMs);
      if (result.sourceUpdated || result.hubUpdated) withdrawnRefs.push(ref.ref_id);
    }

    for (const candidate of candidates) {
      await this.withRefLock(candidate.refId, async () => {
        const item = await this.currentItem(candidate, nowMs);
        if (item) {
          await this.deliverActionableItem(item, hubDest, hubBindingId);
          active.push(item);
          return;
        }
        const result = candidate.provider === 'decision'
          ? await this.refreshDecisionRefLocked(candidate.decisionId, nowMs)
          : await this.refreshInteractionRefLocked(candidate.interactionId, nowMs);
        if (result.sourceUpdated || result.hubUpdated) withdrawnRefs.push(candidate.refId);
      });
    }

    const card = this.formatSummaryCard(paginatePendingItems(active, options.query), options.query);
    await this.queueSummaryUpdate(hubDest, card, version);
    return { activeCount: active.length, withdrawnRefs };
  }

  private canUpdateSource(ref: PendingRefRow): boolean {
    return !ref.interaction_id || !ref.source_session_id || !ref.source_destination || !ref.source_card_message_id ||
      !this.shouldRefreshSource || this.shouldRefreshSource({
        interactionId: ref.interaction_id,
        sessionId: ref.source_session_id,
        destination: ref.source_destination,
        messageId: ref.source_card_message_id,
      });
  }

  private async updateRefCards(
    ref: PendingRefRow,
    reason: string,
    revision: number,
    card = buildWithdrawnCard(ref.category, reason),
  ): Promise<PendingSubmitResult['withdrawnCards']> {
    if (ref.card_active === 0 && ref.withdrawn_reason === reason && ref.revision === revision) {
      return { sourceUpdated: false, hubUpdated: false };
    }
    const root = this.getRoot();
    const hubDest = root?.topicDestination ?? root?.chatDestination ?? this.destination;
    const update = (destination: string, messageId: string, entry: string) => {
      const deliveryId = `pending-withdraw-${entry}:${payloadDigest([ref.ref_id, messageId, revision, reason])}`;
      return this.updateOnce(destination, messageId, card, deliveryId);
    };
    const sourceId = ref.source_card_message_id;
    const sourceDest = ref.source_destination;
    const [source, hub] = await Promise.allSettled([
      sourceId && sourceDest && this.canUpdateSource(ref) ? update(sourceDest, sourceId, 'src') : false,
      ref.hub_card_message_id ? update(hubDest, ref.hub_card_message_id, 'hub') : false,
    ]);
    if (source.status === 'rejected') throw source.reason;
    if (hub.status === 'rejected') throw hub.reason;
    this.db
      .prepare(`UPDATE pending_hub_refs_v1
        SET card_active=0, withdrawn_reason=?, revision=?, updated_at=? WHERE ref_id=?`)
      .run(reason, revision, this.now(), ref.ref_id);
    return { sourceUpdated: source.value, hubUpdated: hub.value };
  }

  async refreshInteractionRef(interactionId: string, nowMs = this.now()): Promise<PendingSubmitResult['withdrawnCards']> {
    return this.withRefLock(`interaction:${interactionId}`, () => this.refreshInteractionRefLocked(interactionId, nowMs));
  }

  private async refreshInteractionRefLocked(
    interactionId: string,
    nowMs = this.now(),
  ): Promise<PendingSubmitResult['withdrawnCards']> {
    const ref = this.getRef(`interaction:${interactionId}`);
    if (!ref) return { sourceUpdated: false, hubUpdated: false };

    const interaction = await this.service.getInteraction(interactionId).catch(() => null);
    if (!interaction) return this.updateRefCards(ref, '该请求已不可用', ref.revision);

    const operation = await this.service.getResponseOperation?.(interactionId);
    const status = interactionStatusText(interaction, operation);
    if (status) {
      const card = buildPendingInteractionStatusCard(interaction, status, operation);
      return this.updateRefCards(ref, status, interaction.revision, card);
    }

    // Only an awaiting request needs a session-level check for expiry or lost control.
    const snapshot = await this.service.getSnapshot(interaction.sessionId).catch(() => null);
    if (snapshot && isActionableInteraction(interaction, snapshot.value.session, snapshot.value.connectionGeneration, nowMs)) {
      return { sourceUpdated: false, hubUpdated: false };
    }
    const reason = interaction.expiresAt !== null && Date.parse(interaction.expiresAt) <= nowMs
      ? '该请求已过期'
      : '原会话的连接或控制状态已变化，卡片已失效';
    return this.updateRefCards(ref, reason, interaction.revision);
  }

  async refreshDecisionRef(decisionId: string, nowMs = this.now()): Promise<PendingSubmitResult['withdrawnCards']> {
    return this.withRefLock(`decision:${decisionId}`, () => this.refreshDecisionRefLocked(decisionId, nowMs));
  }

  private findDecision(decisionId: string) {
    try {
      return this.decisionStore?.getDecision(decisionId);
    } catch (error) {
      // getDecision reports a missing key as invalid_request.
      if (!(error instanceof StoreError) || error.detail.code !== 'invalid_request') throw error;
      return undefined;
    }
  }

  private async refreshDecisionRefLocked(
    decisionId: string,
    nowMs: number,
  ): Promise<PendingSubmitResult['withdrawnCards']> {
    const ref = this.getRef(`decision:${decisionId}`);
    if (!ref) return { sourceUpdated: false, hubUpdated: false };
    const decision = this.findDecision(decisionId);
    if (!decision) return this.updateRefCards(ref, '该决定已不可用', ref.revision);
    if (isActionableDecision(decision, nowMs)) return { sourceUpdated: false, hubUpdated: false };
    if (decision.status === 'answered') {
      const answer = this.decisionStore?.getAnswers(decisionId)
        .find(a => a.decisionVersion === decision.version && a.decisionDigest === decision.digest);
      return this.updateRefCards(ref, '决定已确认', decision.version, buildAnsweredDecisionCard(decision, answer));
    }
    const reason = decision.status === 'cancelled' ? '决定已取消' : '决定已过期';
    return this.updateRefCards(ref, reason, decision.version);
  }

  private queueSummaryUpdate(hubDest: string, summaryCard: ChannelCard, version: number): Promise<void> {
    const work = this.summaryLock.then(async () => {
      if (version === this.summaryVersion) await this.writeSummaryCard(hubDest, summaryCard);
    });
    this.summaryLock = work.catch(() => {});
    return work;
  }

  private async refreshSummaryCard(): Promise<void> {
    const root = this.getRoot();
    if (!root) return;
    const version = this.summaryVersion;
    const card = await this.buildSummaryCard();
    await this.queueSummaryUpdate(root.topicDestination ?? root.chatDestination, card, version);
  }

  private async writeSummaryCard(hubDest: string, summaryCard: ChannelCard): Promise<void> {
    const rootRow = this.db
      .prepare('SELECT summary_message_id, summary_signature FROM pending_hub_roots_v1 WHERE hub_key=?')
      .get(this.rootKey) as { summary_message_id: string | null; summary_signature: string | null } | undefined;
    if (!rootRow) return;

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
      await this.port.update(hubDest, rootRow.summary_message_id, summaryCard, deliveryId);
      this.db
        .prepare('UPDATE pending_hub_roots_v1 SET summary_signature=?, updated_at=? WHERE hub_key=?')
        .run(signature, this.now(), this.rootKey);
    }
  }

  markSummaryDirty(): void {
    this.summaryVersion++;
  }

  /** Native observations target the relevant tracked cards and invalidate an older overview scan. */
  async handleObservation(observation: PlatformObservation): Promise<void> {
    if (observation.type === 'interaction' && observation.interaction.status !== 'awaiting_answer') {
      this.markSummaryDirty();
      await this.refreshInteractionRef(observation.interaction.interactionId);
    } else if (observation.type === 'connection') {
      this.markSummaryDirty();
      const refs = this.db.prepare(`SELECT interaction_id FROM pending_hub_refs_v1
        WHERE interaction_id IS NOT NULL AND provider=? AND connection_generation < ? AND
          (card_active=1 OR withdrawn_reason IN (?, ?))`).all(
        observation.ref.provider, observation.connectionGeneration,
        '答复已提交，等待原端确认', '答复结果未知，请查看原会话',
      ) as Array<{ interaction_id: string }>;
      await Promise.all(refs.map((ref) => this.refreshInteractionRef(ref.interaction_id)));
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
    notifications?: PendingSubmitNotifications,
  ): Promise<PendingSubmitResult> {
    return executePendingSubmit(
      {
        rootKey: this.rootKey,
        autoDispatch: this.autoDispatch && !notifications,
        service: this.service,
        decisionStore: this.decisionStore,
        now: this.now,
        getRef: (refId) => this.getRef(refId),
        getSourceDestination: (sessionId) => this.getSourceDestination(sessionId),
        checkEnvelopeAuth: (ep, env, targetId, expectedSourceDest) =>
          this.checkEnvelopeAuth(ep, env, targetId, expectedSourceDest),
        refresh: async (refId, operation, sessionId) => {
          this.markSummaryDirty();
          if (notifications) {
            if (sessionId) notifications.notifyInteraction(sessionId, refId.slice('interaction:'.length));
            else notifications.notifyDecision?.(refId.slice('decision:'.length));
            if (operation?.status === 'received') notifications.notifyOperation(operation.operationId);
            notifications.notifySummary();
            return { sourceUpdated: false, hubUpdated: false };
          }
          const updated = sessionId
            ? await this.refreshInteractionRef(refId.slice('interaction:'.length))
            : await this.refreshDecisionRef(refId.slice('decision:'.length));
          await this.refreshSummaryCard();
          return updated;
        },
      },
      entryPoint,
      envelope,
      payload,
    );
  }
}
