export interface BridgeConfig {
  appId: string;
  appSecret: string;
  allowedRoot: string;
  codexHome: string;
  codexBin: string;
  stateDir: string;
  bindToken: string;
  scanIntervalMs: number;
  activeSessionQuietMs: number;
  cardUiVersion?: 1 | 2;
  /** Explicitly opt in to the intentionally unsandboxed Root execution mode. */
  executionMode?: "workspace-write" | "root-danger-full-access";
  rootGrantTtlMs?: number;
  rootFullAccessAck?: boolean;
  /** Explicitly allowed MCP server identifiers. Empty means no MCP escalation. */
  allowedMcpServers?: string[];
}

export interface SessionMetadata {
  sessionId: string;
  path: string;
  cwd: string;
  startedAt: string;
  source: string;
  firstUserText: string;
  /** Canonical user-facing title from Codex thread metadata. */
  title?: string | null;
  collaborationMode?: "default" | "plan" | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface ModelCapability {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
}

export interface VisibleMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  role: "user" | "assistant" | "progress";
  text: string;
}

export interface ChoiceOption { label: string; description: string; }
export interface ChoiceQuestion { id: string; header: string; question: string; options: ChoiceOption[]; }
export interface ChoiceRequest {
  id: string;
  sessionId: string;
  timestamp: string;
  questions: ChoiceQuestion[];
  expiresAt: number;
}

export type RemoteRequestType = "user_input" | "command_approval" | "file_approval" | "permissions" | "mcp_elicitation";
export type RemoteRequestStatus = "pending" | "submitting" | "resolved" | "expired" | "declined";

/** Persisted metadata deliberately excludes answers to secret questions. */
export interface PendingServerRequest {
  nonce: string;
  rpcId: string | number;
  epoch: number;
  type: RemoteRequestType;
  sessionId: string;
  turnId: string | null;
  itemId: string | null;
  openId: string;
  chatId: string;
  rootMessageId: string;
  cardMessageId: string | null;
  payload: Record<string, unknown>;
  status: RemoteRequestStatus;
  expiresAt: number;
}

/** A one-time Root authorization bound to exactly one queued task. */
export interface TaskRootGrant {
  nonce: string;
  taskId: string;
  sessionId: string;
  canonicalCwd: string;
  openId: string;
  chatId: string;
  epoch: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "cancelled";
}

export interface TurnState {
  sessionId: string;
  turnId: string;
  epoch: number;
  mode: "default" | "plan";
  state: "running" | "awaiting_input" | "awaiting_approval" | "completed" | "failed" | "interrupted";
  text: string;
  plan: string;
  rootMessageId: string;
  stream?: { cardId: string; messageId: string; elementId: string; sequence: number; lastSentAt: number };
}

export interface FileCursor {
  path: string;
  sessionId: string | null;
  parsedOffset: number;
  archivedOffset: number;
  carry: string;
  size: number;
  mtimeMs: number;
}

export interface IncomingFeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "group" | "p2p";
  rootId?: string;
  parentId?: string;
  senderOpenId: string;
  mentionedBot: boolean;
  text: string;
  imageKeys: string[];
}

export type CardDefinition = Record<string, unknown>;

export type CardDelivery = "replace" | "reply" | "send" | "none";

export type CardActionOutcome = CardDefinition & {
  delivery?: CardDelivery;
  card?: CardDefinition;
  rootMessageId?: string;
};

export interface IncomingCardAction {
  openId: string;
  chatId: string;
  openMessageId: string;
  action: string;
  value: Record<string, unknown>;
  formValues: Record<string, unknown>;
  option?: string;
}

export interface IncomingBotMenuAction {
  eventId: string;
  openId: string;
  eventKey: string;
}

export interface SentRootMessage {
  messageId: string;
  appLink: string | null;
  chatId: string;
  threadId: string | null;
}

export interface FeishuMessageMetadata {
  chatId: string | null;
  threadId: string | null;
  appLink: string | null;
}

export interface FeishuPort {
  start(
    onMessage: (message: IncomingFeishuMessage) => Promise<void>,
    onCardAction: (action: IncomingCardAction) => Promise<CardActionOutcome>,
    onBotMenuAction: (action: IncomingBotMenuAction) => Promise<void>,
  ): Promise<void>;
  createSessionRoot(chatId: string, title: string, detail: string, card?: CardDefinition): Promise<SentRootMessage>;
  replyText(rootMessageId: string, text: string): Promise<string>;
  replyFile(rootMessageId: string, fileName: string, data: Buffer): Promise<string>;
  downloadImage(messageId: string, imageKey: string): Promise<Buffer>;
  sendText(chatId: string, text: string): Promise<string>;
  sendCard(chatId: string, card: CardDefinition): Promise<string>;
  replyCard(rootMessageId: string, card: CardDefinition): Promise<string>;
  updateCard(messageId: string, card: CardDefinition): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  getMessageMetadata(messageId: string): Promise<FeishuMessageMetadata | null>;
  createStreamingReply?(rootMessageId: string, title: string): Promise<{ cardId: string; messageId: string; elementId: string; sequence: number }>;
  updateStreamingReply?(stream: { cardId: string; elementId: string; sequence: number }, content: string): Promise<number>;
  finishStreamingReply?(stream: { cardId: string; elementId: string; sequence: number }, summary: string): Promise<void>;
}

export interface QueuedTask {
  id: string;
  kind: "new" | "resume";
  sessionId: string | null;
  cwd: string;
  prompt: string;
  imageKeys: string[];
  sourceMessageId: string;
  chatId: string;
  rootMessageId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  status: "pending" | "running" | "awaiting_root_consent" | "awaiting_input" | "awaiting_approval" | "awaiting_sync" | "completed" | "failed" | "cancelled" | "interrupted";
  runCardMessageId: string | null;
  expectedSessionId: string | null;
  syncStatus: "none" | "awaiting" | "synced";
  lastSyncOffset: number | null;
  turnId?: string | null;
  /** Reason the task reached a terminal state, suitable for a concise user card. */
  terminalReason?: string | null;
  /** Authorization nonce while awaiting a Root-only execution. */
  rootGrantNonce?: string | null;
}
