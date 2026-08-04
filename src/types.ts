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
}

export interface SessionMetadata {
  sessionId: string;
  path: string;
  cwd: string;
  startedAt: string;
  source: string;
  firstUserText: string;
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
}

export interface CodexRunRequest {
  cwd: string;
  prompt: string;
  sessionId?: string;
  imagePaths?: string[];
  signal?: AbortSignal;
  model?: string;
  reasoningEffort?: string;
}

export interface CodexRunResult {
  sessionId: string;
  exitCode: number;
  assistantMessages: string[];
  stderr: string;
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
  status: "pending" | "running" | "awaiting_sync" | "completed" | "failed" | "cancelled" | "interrupted";
  runCardMessageId: string | null;
  expectedSessionId: string | null;
  syncStatus: "none" | "awaiting" | "synced";
  lastSyncOffset: number | null;
}
