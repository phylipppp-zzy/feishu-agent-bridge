import type { UnifiedService } from '../adapter.js';
import type { Answer, Identity, Interaction, Operation, Provider } from '../contracts.js';
import { contractError } from '../errors.js';
import type { FeishuPort } from '../feishu-channel.js';
import { StoreError } from '../store.js';
import type { DecisionSyncStore } from './decision-store.js';
import type { AnswerDecisionResult, DecisionRecord } from './decision-types.js';

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
  shouldRefreshSource?: (card: {
    interactionId: string;
    sessionId: string;
    destination: string;
    messageId: string;
  }) => boolean;
  shouldDeliverSource?: (item: PendingItemView) => boolean;
  discoverCliNotices?: () => Promise<PendingCliNotice[]>;
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
  readonlyNotice?: never;
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
  readonlyNotice?: never;
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

export interface PendingCliNotice {
  provider: Provider;
  nativeSessionId: string;
  title: string;
  summary: string;
  project?: string | null;
  sourceSessionId?: string | null;
  sourceTopicUrl?: string | null;
}

export interface PendingCliNoticeItem extends PendingCliNotice {
  refId: `cli_notice:${Provider}:${string}`;
  kind: 'cli_notice';
  category: 'approval';
  readonlyNotice: true;
  sourceSessionId: string | null;
  sourceDestination: null;
  sourceTopicUrl: string | null;
  expiresAt: null;
}

export type PendingItemView = PendingInteractionItem | PendingDecisionItem | PendingCliNoticeItem;

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

export interface SubmitCliNoticePayload {
  kind: 'cli_notice';
  refId: string;
}

export const isCliNoticeRefId = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('cli_notice:');

/** Runtime callbacks enqueue work after durable acceptance. Direct callers may await it. */
export interface PendingSubmitNotifications {
  notifyOperation(operationId: string): void;
  notifyInteraction(sessionId: string, interactionId: string): void;
  notifyDecision?(decisionId: string): void;
  notifySummary(): void;
}

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

export interface PendingRootRow {
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

export interface PendingRefRow {
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

export const DEFAULT_PENDING_ROOT_KEY = 'pending-hub:singleton';
export const DEFAULT_PENDING_TOPIC_TITLE = '待处理';

export const PENDING_CATEGORY_LABELS: Record<PendingCategory, string> = {
  question: '模型问答',
  approval: '工具权限',
  business_decision: '业务决定',
  execution_auth: '执行授权',
};

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function fail(code: Parameters<typeof contractError>[0], message: string): never {
  throw new StoreError(contractError(code, message));
}

export function isSafePendingAppLink(url: string | null | undefined): url is string {
  if (!url || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && ['applink.feishu.cn', 'applink.larksuite.com'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function mapPendingRootRow(row: PendingRootRow): PendingHubRoot {
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

export const PENDING_HUB_SCHEMA_SQL = `
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
`;
