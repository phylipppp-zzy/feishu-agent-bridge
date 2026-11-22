import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PlatformObservation, UnifiedService } from './adapter.js';
import {
  payloadDigest,
  validateResolution,
  type Answer,
  type Identity,
  type Interaction,
  type Operation,
  type Provider,
  type Session,
  type WriteContext,
} from './contracts.js';
import {
  DecisionSyncStore,
  type AnswerDecisionResult,
  type DecisionRecord,
} from './decision-sync.js';
import { contractError } from './errors.js';
import {
  interactionCard,
  providerDisplayLabel,
  providerTitlePrefix,
  type ChannelCard,
} from './feishu-cards.js';
import type { FeishuPort } from './feishu-channel.js';
import { decodeQuestionForm, questionForm } from './feishu-question-forms.js';
import { StoreError } from './store.js';

export const PENDING_CATEGORIES = [
  'question',
  'approval',
  'business_decision',
  'execution_auth',
] as const;

export type PendingCategory = (typeof PENDING_CATEGORIES)[number];
export type PendingSourceProvider = Provider | 'decision';

export type PendingHubPort = Pick<FeishuPort, 'send' | 'update'> &
  Partial<Pick<FeishuPort, 'createTopic' | 'lookupDelivery' | 'lookupMessageId' | 'topicLinkForSession'>>;

export interface PendingEnvelope {
  eventId: string;
  destination: string;
  identity: Identity;
}

export interface PendingHubOptions {
  dbPath: string;
  owner: Identity;
  destination: string;
  allowedDestinations?: ReadonlySet<string>;
  service: UnifiedService & { dispatch?: (operationId: string) => Promise<Operation> };
  decisionStore?: DecisionSyncStore;
  port: PendingHubPort;
  rootKey?: string;
  topicTitle?: string;
  autoDispatch?: boolean;
  authorize?: (identity: Identity, destination: string, targetId: string) => Promise<boolean> | boolean;
  resolveTopicLink?: (sessionId: string, hubDestination: string) => Promise<string | null> | string | null;
  now?: () => number;
}

export interface PendingQuery {
  category?: PendingCategory | 'all';
  provider?: PendingSourceProvider | 'all';
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface PendingInteractionItem {
  refId: string;
  category: 'question' | 'approval';
  provider: Provider;
  title: string;
  summary: string;
  sourceSessionId: string;
  sourceDestination: string | null;
  interactionId: string;
  revision: number;
  connectionGeneration: number;
  turnId: string;
  nativeRequestId: string;
  expiresAt: string | null;
  interaction: Interaction;
  sourceTopicUrl: string | null;
}

export interface PendingDecisionItem {
  refId: string;
  category: 'business_decision' | 'execution_auth';
  provider: 'decision';
  title: string;
  summary: string;
  decisionId: string;
  version: number;
  digest: string;
  sourceSessionId: string | null;
  sourceDestination: string | null;
  expiresAt: string | null;
  decision: DecisionRecord;
  sourceTopicUrl: string | null;
}

export type PendingItemView = PendingInteractionItem | PendingDecisionItem;

export interface PendingPage {
  items: PendingItemView[];
  total: number;
  nextCursor: string | null;
  countsByCategory: Record<PendingCategory, number>;
  countsByProvider: Record<PendingSourceProvider, number>;
}

export interface PendingHubRoot {
  hubKey: string;
  owner: Identity;
  chatDestination: string;
  topicDestination: string | null;
  rootMessageId: string | null;
  summaryMessageId: string | null;
  creationDeliveryId: string;
  state: 'unknown' | 'active' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

export interface SubmitInteractionPayload {
  kind: 'interaction';
  sourceSessionId: string;
  interactionId: string;
  revision: number;
  connectionGeneration: number;
  answer: Answer;
  toolInputDigest: string | null;
  cardMessageId?: string;
  targetScope?: string;
}

export interface SubmitQuestionFormPayload {
  kind: 'question_form';
  sourceSessionId: string;
  interactionId: string;
  revision: number;
  connectionGeneration: number;
  bindingId: string;
  fields: Record<string, unknown>;
  cardMessageId?: string;
}

export interface SubmitDecisionPayload {
  kind: 'decision';
  decisionId: string;
  expectedVersion: number;
  expectedDigest: string;
  selectedOptionId?: string | null;
  freeText?: string | null;
  rawUtterance?: string;
  cardMessageId?: string;
}

export type PendingSubmitPayload =
  | SubmitInteractionPayload
  | SubmitQuestionFormPayload
  | SubmitDecisionPayload;

export interface PendingSubmitResult {
  status: 'submitted';
  entryPoint: 'hub' | 'source';
  refId: string;
  operation?: Operation;
  decisionResult?: AnswerDecisionResult;
  withdrawnCards: {
    sourceUpdated: boolean;
    hubUpdated: boolean;
  };
}

export interface PendingHubTextResult {
  handled: false;
  status: 'ignored_ordinary_chat';
  reason: string;
}

const DEFAULT_ROOT_KEY = 'pending-hub:singleton';
const DEFAULT_TOPIC_TITLE = '待处理';

const CATEGORY_LABELS: Record<PendingCategory, string> = {
  question: '模型问答',
  approval: '工具权限',
  business_decision: '业务决定',
  execution_auth: '执行授权',
};

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function fail(code: Parameters<typeof contractError>[0], message: string): never {
  throw new StoreError(contractError(code, message));
}

function isSafeAppLink(url: string | null | undefined): url is string {
  if (!url || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && ['applink.feishu.cn', 'applink.larksuite.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

interface RootRow {
  hub_key: string;
  owner_source: string;
  owner_subject: string;
  chat_destination: string;
  topic_destination: string | null;
  root_message_id: string | null;
  summary_message_id: string | null;
  summary_signature: string | null;
  creation_delivery_id: string;
  state: 'unknown' | 'active' | 'rejected';
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

interface RefRow {
  ref_id: string;
  category: PendingCategory;
  provider: PendingSourceProvider;
  source_session_id: string | null;
  source_destination: string | null;
  interaction_id: string | null;
  decision_id: string | null;
  revision: number;
  connection_generation: number | null;
  source_card_message_id: string | null;
  hub_card_message_id: string | null;
  card_active: number;
  withdrawn_reason: string | null;
  created_at: number;
  updated_at: number;
}

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
    this.rootKey = options.rootKey?.trim() || DEFAULT_ROOT_KEY;
    this.topicTitle = options.topicTitle?.trim() || DEFAULT_TOPIC_TITLE;
    this.autoDispatch = options.autoDispatch ?? true;
    this.authorize = options.authorize;
    this.resolveTopicLink = options.resolveTopicLink;
    this.now = options.now ?? (() => Date.now());

    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS pending_hub_roots_v1 (
        hub_key TEXT PRIMARY KEY,
        owner_source TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        chat_destination TEXT NOT NULL,
        topic_destination TEXT,
        root_message_id TEXT,
        summary_message_id TEXT,
        summary_signature TEXT,
        creation_delivery_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_hub_sessions_v1 (
        session_id TEXT PRIMARY KEY,
        source_destination TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_hub_refs_v1 (
        ref_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_session_id TEXT,
        source_destination TEXT,
        interaction_id TEXT,
        decision_id TEXT,
        revision INTEGER NOT NULL,
        connection_generation INTEGER,
        source_card_message_id TEXT,
        hub_card_message_id TEXT,
        card_active INTEGER NOT NULL DEFAULT 1,
        withdrawn_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_hub_deliveries_v1 (
        delivery_id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private mapRoot(row: RootRow): PendingHubRoot {
    return {
      hubKey: row.hub_key,
      owner: { source: row.owner_source, subject: row.owner_subject },
      chatDestination: row.chat_destination,
      topicDestination: row.topic_destination,
      rootMessageId: row.root_message_id,
      summaryMessageId: row.summary_message_id,
      creationDeliveryId: row.creation_delivery_id,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getRoot(): PendingHubRoot | null {
    const row = this.db
      .prepare('SELECT * FROM pending_hub_roots_v1 WHERE hub_key=?')
      .get(this.rootKey) as RootRow | undefined;
    return row ? this.mapRoot(row) : null;
  }

  getRef(refId: string): RefRow | null {
    const row = this.db.prepare('SELECT * FROM pending_hub_refs_v1 WHERE ref_id=?').get(refId) as RefRow | undefined;
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
    let existingRow: RootRow | undefined;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      existingRow = this.db
        .prepare('SELECT * FROM pending_hub_roots_v1 WHERE hub_key=?')
        .get(this.rootKey) as RootRow | undefined;
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
      return this.mapRoot(existingRow);
    }
    if (existingState === 'unknown') {
      fail('outcome_unknown', 'pending hub root creation outcome unknown; refusing duplicate root');
    }
    if (existingState === 'rejected') {
      fail('temporarily_unavailable', 'pending hub root creation was rejected');
    }

    const rootCard: ChannelCard = {
      title: this.topicTitle,
      text: '待处理统一汇总视图：集中归集模型问答、工具权限、业务决定与执行授权。',
      actions: [],
    };
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

  private isActionableInteraction(
    interaction: Interaction,
    session: Session,
    snapshotConnectionGeneration: number | undefined,
    nowMs: number,
  ): boolean {
    if (interaction.status !== 'awaiting_answer') return false;
    if (interaction.expiresAt !== null) {
      const exp = Date.parse(interaction.expiresAt);
      if (!Number.isFinite(exp) || exp <= nowMs) return false;
    }
    if (session.status === 'read_only' || session.status === 'unreachable') return false;
    if (session.control.input !== 'available') return false;
    if (
      snapshotConnectionGeneration !== undefined &&
      interaction.connectionGeneration !== snapshotConnectionGeneration
    ) {
      return false;
    }
    return true;
  }

  private isActionableDecision(decision: DecisionRecord, nowMs: number): boolean {
    if (decision.status !== 'pending') return false;
    if (decision.expiresAt !== null) {
      const exp = Date.parse(decision.expiresAt);
      if (!Number.isFinite(exp) || exp <= nowMs) return false;
    }
    return true;
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
          !this.isActionableInteraction(
            interaction,
            snapshot.value.session,
            snapshot.value.connectionGeneration,
            nowMs,
          )
        ) {
          continue;
        }
        const category: 'question' | 'approval' = interaction.kind === 'approval' ? 'approval' : 'question';
        const title =
          interaction.kind === 'approval'
            ? `${providerTitlePrefix(session.native.provider)} 工具权限: ${interaction.tool}`
            : interaction.kind === 'question'
              ? `${providerTitlePrefix(session.native.provider)} 问题: ${interaction.prompt}`
              : `${providerTitlePrefix(session.native.provider)} 组合问题 (${interaction.questions.length} 项)`;
        const summary =
          interaction.kind === 'approval'
            ? `${interaction.tool}: ${interaction.action} (范围: ${interaction.scope})`
            : interaction.kind === 'question'
              ? interaction.prompt
              : interaction.questions.map((q) => q.prompt).join('；');
        const sourceTopicUrl = await this.resolveSourceLink(session.sessionId, hubDest);

        items.push({
          refId: `interaction:${interaction.interactionId}`,
          category,
          provider: session.native.provider,
          title,
          summary,
          sourceSessionId: session.sessionId,
          sourceDestination,
          interactionId: interaction.interactionId,
          revision: interaction.revision,
          connectionGeneration: interaction.connectionGeneration,
          turnId: interaction.turnId,
          nativeRequestId: interaction.nativeRequestId,
          expiresAt: interaction.expiresAt,
          interaction,
          sourceTopicUrl,
        });
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
          !this.isActionableInteraction(
            interaction,
            snapshot.value.session,
            snapshot.value.connectionGeneration,
            nowMs,
          )
        ) {
          continue;
        }
        const category: 'question' | 'approval' = interaction.kind === 'approval' ? 'approval' : 'question';
        const title =
          interaction.kind === 'approval'
            ? `${providerTitlePrefix(snapshot.value.session.native.provider)} 工具权限: ${interaction.tool}`
            : interaction.kind === 'question'
              ? `${providerTitlePrefix(snapshot.value.session.native.provider)} 问题: ${interaction.prompt}`
              : `${providerTitlePrefix(snapshot.value.session.native.provider)} 组合问题 (${interaction.questions.length} 项)`;
        const summary =
          interaction.kind === 'approval'
            ? `${interaction.tool}: ${interaction.action} (范围: ${interaction.scope})`
            : interaction.kind === 'question'
              ? interaction.prompt
              : interaction.questions.map((q) => q.prompt).join('；');
        const sourceTopicUrl = await this.resolveSourceLink(row.session_id, hubDest);

        items.push({
          refId: `interaction:${interaction.interactionId}`,
          category,
          provider: snapshot.value.session.native.provider,
          title,
          summary,
          sourceSessionId: row.session_id,
          sourceDestination: row.source_destination,
          interactionId: interaction.interactionId,
          revision: interaction.revision,
          connectionGeneration: interaction.connectionGeneration,
          turnId: interaction.turnId,
          nativeRequestId: interaction.nativeRequestId,
          expiresAt: interaction.expiresAt,
          interaction,
          sourceTopicUrl,
        });
      }
    }

    if (this.decisionStore) {
      const decisions = this.decisionStore.listDecisions({ status: 'pending' });
      for (const decision of decisions) {
        if (!this.isActionableDecision(decision, nowMs)) continue;
        const sourceTopicUrl = await this.resolveSourceLink(decision.source.sessionId ?? null, hubDest);
        items.push({
          refId: `decision:${decision.decisionId}`,
          category: decision.kind,
          provider: 'decision',
          title: `${decision.kind === 'business_decision' ? '业务决定' : '执行授权'}: ${decision.title}`,
          summary: decision.prompt,
          decisionId: decision.decisionId,
          version: decision.version,
          digest: decision.digest,
          sourceSessionId: decision.source.sessionId ?? null,
          sourceDestination: decision.source.destination ?? null,
          expiresAt: decision.expiresAt,
          decision,
          sourceTopicUrl,
        });
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
    const countsByCategory: Record<PendingCategory, number> = {
      question: 0,
      approval: 0,
      business_decision: 0,
      execution_auth: 0,
    };
    const countsByProvider: Record<PendingSourceProvider, number> = {
      claude: 0,
      codex: 0,
      agy: 0,
      decision: 0,
    };
    for (const item of all) {
      countsByCategory[item.category] += 1;
      countsByProvider[item.provider] += 1;
    }

    const search = query.search?.trim().toLowerCase();
    const filtered = all.filter((item) => {
      if (query.category && query.category !== 'all' && item.category !== query.category) return false;
      if (query.provider && query.provider !== 'all' && item.provider !== query.provider) return false;
      if (search) {
        const hay = `${item.refId} ${item.category} ${item.provider} ${item.title} ${item.summary} ${item.sourceSessionId ?? ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const limit = query.limit ?? 5;
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      fail('invalid_request', 'invalid pending pagination cursor or limit');
    }

    const slice = filtered.slice(start, start + limit);
    const nextCursor = start + limit < filtered.length ? String(start + limit) : null;
    return {
      items: slice,
      total: filtered.length,
      nextCursor,
      countsByCategory,
      countsByProvider,
    };
  }

  renderHubItemCard(item: PendingItemView, entryPoint: 'hub' | 'source', hubBindingId: string): ChannelCard {
    if (item.provider !== 'decision') {
      const base = interactionCard(item.interaction, false);
      const actions: ChannelCard['actions'] = base.actions.map((a) => ({
        ...a,
        value: {
          ...a.value,
          entry: entryPoint,
          category: item.category,
          sourceSessionId: item.sourceSessionId,
          bindingId: hubBindingId,
        },
      }));
      if (entryPoint === 'hub' && isSafeAppLink(item.sourceTopicUrl)) {
        actions.push({ label: '跳回源话题', value: {}, url: item.sourceTopicUrl });
      }
      const prefix =
        entryPoint === 'source'
          ? `【等待你处理 · ${CATEGORY_LABELS[item.category]}】`
          : `【待处理 · ${CATEGORY_LABELS[item.category]} · ${providerDisplayLabel(item.provider)}】`;
      const card: ChannelCard = {
        title: `${prefix}${base.title}`,
        text:
          entryPoint === 'source'
            ? `轻量等待引用 (${item.interactionId})\n${base.text}\n同一请求已在「待处理」汇总同步；任一入口提交后两处同时失效。`
            : `来源会话: ${item.sourceSessionId} (${providerDisplayLabel(item.provider)})\n${base.text}`,
        actions,
      };
      if (item.interaction.kind !== 'approval') {
        card.form = questionForm(item.interaction, hubBindingId, false, this.now());
      }
      return card;
    }

    const d = item.decision;
    const actions: ChannelCard['actions'] = d.options.map((opt) => ({
      label: opt.label,
      value: {
        action: 'decision_answer',
        entry: entryPoint,
        category: item.category,
        decisionId: d.decisionId,
        expectedVersion: d.version,
        expectedDigest: d.digest,
        selectedOptionId: opt.id,
        bindingId: hubBindingId,
      },
    }));
    if (entryPoint === 'hub' && isSafeAppLink(item.sourceTopicUrl)) {
      actions.push({ label: '跳回源话题', value: {}, url: item.sourceTopicUrl });
    }
    const specLine =
      d.kind === 'execution_auth' && d.executionSpec
        ? `\n执行目标: ${d.executionSpec.target} · 动作摘要: ${d.executionSpec.actionDigest} · 过期: ${d.executionSpec.expiry}`
        : '\n性质: 仅业务决定（绝不自动触发执行器/shell）';
    return {
      title: `【待处理 · ${CATEGORY_LABELS[item.category]}】${d.title}`,
      text: `ID: ${d.decisionId} (v${d.version})\n${d.prompt}${specLine}`,
      actions,
    };
  }

  async buildSummaryCard(query: PendingQuery = {}, nowMs = this.now()): Promise<ChannelCard> {
    const page = await this.listPending(query, nowMs);
    const headerLine = [
      `模型问答: ${page.countsByCategory.question} 项`,
      `工具权限: ${page.countsByCategory.approval} 项`,
      `业务决定: ${page.countsByCategory.business_decision} 项`,
      `执行授权: ${page.countsByCategory.execution_auth} 项`,
    ].join(' · ');
    const providerLine = `后端分布: Claude ${page.countsByProvider.claude} · Codex ${page.countsByProvider.codex} · Antigravity ${page.countsByProvider.agy} · 决定 ${page.countsByProvider.decision}`;
    const itemLines =
      page.items.length === 0
        ? ['当前没有待处理事项。']
        : page.items.map(
            (item, idx) =>
              `${idx + 1}. [${CATEGORY_LABELS[item.category]}] (${item.provider}) ${item.title}${item.sourceSessionId ? ` · 会话 ${item.sourceSessionId}` : ''}`,
          );
    const actions: ChannelCard['actions'] = [];
    for (const item of page.items) {
      if (isSafeAppLink(item.sourceTopicUrl)) {
        actions.push({ label: `跳回源: ${item.refId.slice(0, 18)}`, value: {}, url: item.sourceTopicUrl });
      }
    }
    if (page.nextCursor !== null) {
      actions.push({
        label: '下一页',
        value: {
          action: 'pending_page',
          cursor: page.nextCursor,
          ...(query.category ? { category: query.category } : {}),
          ...(query.provider ? { provider: query.provider } : {}),
        },
      });
    }
    return {
      title: `${this.topicTitle}汇总（共 ${page.total} 项）`,
      text: `${headerLine}\n${providerLine}\n\n${itemLines.join('\n')}`,
      actions,
    };
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
      .all() as unknown as RefRow[];
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

  private async describeWithdrawalReason(ref: RefRow): Promise<string> {
    if (ref.interaction_id) {
      try {
        const interaction = await this.service.getInteraction(ref.interaction_id);
        if (interaction.status === 'resolved') return '已由权威端处理并撤下';
        if (interaction.status === 'answer_pending_delivery') return '已提交答复，等待确认回执';
        if (interaction.status === 'expired') return '该请求已过期或连接已重建';
        if (interaction.status === 'cancelled') return '该请求已取消';
        return '原会话控制状态已变化，卡片已失效';
      } catch {
        return '该请求已不可用';
      }
    }
    if (ref.decision_id && this.decisionStore) {
      try {
        const decision = this.decisionStore.getDecision(ref.decision_id);
        if (decision.status === 'answered') return '决定已登记，卡片已失效';
        if (decision.status === 'expired') return '决定已过期';
        if (decision.status === 'cancelled') return '决定已取消';
      } catch {
        return '决定已不可用';
      }
    }
    return '待处理项已失效';
  }

  private async withdrawRefCards(ref: RefRow, reason: string, hubDest: string): Promise<{
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
      const withdrawnCard: ChannelCard = {
        title: `【已失效 · ${CATEGORY_LABELS[latest.category]}】`,
        text: `${reason}。本卡片操作已撤下，不可重复提交。`,
        actions: [],
      };
      const stamp = this.now();

      if (latest.source_card_message_id && latest.source_destination) {
        const deliveryId = `pending-withdraw-src:${payloadDigest([latest.ref_id, latest.source_card_message_id])}`;
        sourceUpdated = await this.updateOnce(
          latest.source_destination,
          latest.source_card_message_id,
          withdrawnCard,
          deliveryId,
        );
      }
      if (latest.hub_card_message_id) {
        const deliveryId = `pending-withdraw-hub:${payloadDigest([latest.ref_id, latest.hub_card_message_id])}`;
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
        .prepare("SELECT * FROM pending_hub_refs_v1 WHERE card_active=1 AND interaction_id IS NOT NULL")
        .all() as unknown as RefRow[];
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
    const hubDest = this.getRoot()?.topicDestination ?? this.destination;

    if (payload.kind === 'decision') {
      if (!this.decisionStore) fail('unsupported', 'decision store is not configured');
      const decision = this.decisionStore.getDecision(payload.decisionId);
      const refId = `decision:${decision.decisionId}`;
      const ref = this.getRef(refId);
      const expectedSourceDest = ref?.source_destination ?? decision.source.destination ?? null;

      await this.checkEnvelopeAuth(entryPoint, envelope, decision.decisionId, expectedSourceDest);
      if (payload.cardMessageId) {
        const expectedCardId = entryPoint === 'hub' ? ref?.hub_card_message_id : ref?.source_card_message_id;
        if (!expectedCardId || payload.cardMessageId !== expectedCardId) {
          fail('invalid_request', 'cardMessageId does not match tracked pending card');
        }
      }

      try {
        const decisionResult = this.decisionStore.answerDecision({
          decisionId: payload.decisionId,
          expectedVersion: payload.expectedVersion,
          expectedDigest: payload.expectedDigest,
          entryPoint: entryPoint === 'hub' ? 'feishu_hub' : 'feishu_source',
          idempotencyKey: `pending:${entryPoint}:${envelope.destination}:${envelope.eventId}`,
          actor: envelope.identity,
          selectedOptionId: payload.selectedOptionId ?? null,
          freeText: payload.freeText ?? null,
          ...(payload.rawUtterance !== undefined ? { rawUtterance: payload.rawUtterance } : {}),
          sourceDestination: envelope.destination,
        });

        const currentRef = this.getRef(refId);
        const withdrawnCards = currentRef
          ? await this.withdrawRefCards(currentRef, '决定已登记，卡片已撤下', hubDest)
          : { sourceUpdated: false, hubUpdated: false };
        await this.refreshSummaryCard(hubDest);

        return {
          status: 'submitted',
          entryPoint,
          refId,
          decisionResult,
          withdrawnCards,
        };
      } catch (error) {
        const currentRef = this.getRef(refId);
        if (currentRef && currentRef.card_active === 1) {
          const latest = this.decisionStore.getDecision(payload.decisionId);
          if (latest.status !== 'pending') {
            await this.withdrawRefCards(currentRef, '决定已由其他入口处理，卡片已撤下', hubDest);
            await this.refreshSummaryCard(hubDest);
          }
        }
        throw error;
      }
    }

    // Interaction path ('interaction' or 'question_form') — strictly delegates to UnifiedService single authority
    const sourceSessionId = payload.sourceSessionId;
    const interactionId = payload.interactionId;
    const refId = `interaction:${interactionId}`;
    const ref = this.getRef(refId);
    const expectedSourceDest = ref?.source_destination ?? this.getSourceDestination(sourceSessionId);

    await this.checkEnvelopeAuth(entryPoint, envelope, sourceSessionId, expectedSourceDest);

    if (payload.cardMessageId) {
      const expectedCardId = entryPoint === 'hub' ? ref?.hub_card_message_id : ref?.source_card_message_id;
      if (!expectedCardId || payload.cardMessageId !== expectedCardId) {
        fail('invalid_request', 'cardMessageId does not match tracked pending card');
      }
    }

    if (payload.kind === 'interaction' && payload.targetScope && payload.targetScope !== sourceSessionId) {
      fail('unauthorized', 'targetScope mismatch');
    }

    const session = await this.service.getSession(sourceSessionId);
    const interaction = await this.service.getInteraction(interactionId);
    const snapshot = await this.service.getSnapshot(sourceSessionId);

    if (interaction.sessionId !== sourceSessionId) {
      fail('invalid_request', 'interaction target session mismatch');
    }
    if (session.status === 'read_only' || session.control.input !== 'available') {
      fail('control_conflict', 'session is read-only or input control unavailable');
    }
    if (
      snapshot.value.connectionGeneration !== undefined &&
      interaction.connectionGeneration !== snapshot.value.connectionGeneration
    ) {
      if (ref && ref.card_active === 1) {
        await this.withdrawRefCards(ref, '连接代数已变化，旧请求卡片已撤下', hubDest);
        await this.refreshSummaryCard(hubDest);
      }
      fail('interaction_expired', 'interaction connection generation is stale');
    }

    let resolvedAnswer: Answer;
    let toolInputDigest: string | null;
    if (payload.kind === 'question_form') {
      const expectedBindingId = createHash('sha256').update(this.rootKey).digest('hex').slice(0, 16);
      if (entryPoint === 'hub' && payload.bindingId !== expectedBindingId) {
        fail('invalid_request', 'question form bindingId mismatch');
      }
      try {
        const decoded = decodeQuestionForm(
          {
            action: 'answer_form',
            bindingId: payload.bindingId,
            interactionId: payload.interactionId,
            revision: payload.revision,
            connectionGeneration: payload.connectionGeneration,
          },
          payload.fields,
          interaction,
          payload.bindingId,
          false,
          this.now(),
        );
        resolvedAnswer = decoded.answer;
        toolInputDigest = null;
      } catch (error) {
        fail(
          interaction.status !== 'awaiting_answer' ? 'interaction_expired' : 'invalid_request',
          error instanceof Error ? error.message : 'invalid question form',
        );
      }
    } else {
      resolvedAnswer = payload.answer;
      toolInputDigest = payload.toolInputDigest;
    }

    const opHash = createHash('sha256')
      .update(JSON.stringify([entryPoint, envelope.destination, envelope.eventId]))
      .digest('hex');
    const context: WriteContext = {
      operationId: `pending:${opHash}`,
      idempotencyKey: `pending:${opHash}`,
      targetId: sourceSessionId,
      expectedRevision: payload.revision,
      controlGeneration: session.control.generation,
      identity: envelope.identity,
    };

    const resolveReq = {
      context,
      interactionId,
      expectedConnectionGeneration: payload.connectionGeneration,
      answer: resolvedAnswer,
      toolInputDigest,
    };

    const preValid = validateResolution(resolveReq, interaction, this.now());
    if (!preValid.ok) {
      if (preValid.error.code === 'interaction_expired' && ref && ref.card_active === 1) {
        await this.withdrawRefCards(ref, '请求已失效，卡片已撤下', hubDest);
        await this.refreshSummaryCard(hubDest);
      }
      throw new StoreError(preValid.error);
    }

    let operation: Operation;
    try {
      operation = await this.service.resolveInteraction(resolveReq);
      if (this.autoDispatch && this.service.dispatch && operation.status === 'received') {
        operation = await this.service.dispatch(operation.operationId);
      }
    } catch (error) {
      const latest = await this.service.getInteraction(interactionId).catch(() => null);
      if (latest && latest.status !== 'awaiting_answer' && ref && ref.card_active === 1) {
        await this.withdrawRefCards(ref, await this.describeWithdrawalReason(ref), hubDest);
        await this.refreshSummaryCard(hubDest);
      }
      throw error;
    }

    const currentRef = this.getRef(refId);
    const withdrawnCards = currentRef
      ? await this.withdrawRefCards(
          currentRef,
          `已通过${entryPoint === 'hub' ? '待处理汇总' : '源话题'}提交答复，两处卡片已撤下`,
          hubDest,
        )
      : { sourceUpdated: false, hubUpdated: false };
    await this.refreshSummaryCard(hubDest);

    return {
      status: 'submitted',
      entryPoint,
      refId,
      operation,
      withdrawnCards,
    };
  }
}
