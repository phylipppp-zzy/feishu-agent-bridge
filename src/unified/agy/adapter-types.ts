import {isGenericSessionTitle} from '../session-title.js';
import type {
  PlatformAcknowledgement,
  PlatformInputBlock,
  PlatformObservation,
} from '../adapter.js';
import type { ApprovalScope } from '../approval-policy.js';
import type {
  AgyCatalog,
  AgyDiscoveredSession,
  AgyTranscriptMessage,
} from '../agy-catalog.js';
import type { AgyAcpTransport, AgyEffortLevel } from '../agy-transport.js';
import type {
  Answer,
  Capabilities,
  Interaction,
  Message,
  ModelOption,
  NativeSessionRef,
  ResponseEvidence,
  Session,
  Turn,
} from '../contracts.js';
import { contractError } from '../errors.js';
import { textAttachmentBlock } from '../text-attachment.js';
import { imageMediaType } from '../../image-media.js';
import { isPlaceholderAgyTitle } from './catalog-summaries.js';

export const AGY_REASONING_EFFORTS: readonly AgyEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const DEFAULT_AGY_MODELS: readonly ModelOption[] = [
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'gemini-4-neon', label: 'Gemini 4 Neon', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
];

export const DEFAULT_PROMPT_MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_SESSION_IDLE_RELEASE_MS = 30 * 60_000;
export const DEFAULT_PROMPT_TIMEOUT_MS = DEFAULT_PROMPT_MAX_TIMEOUT_MS;
export const DEFAULT_WAKEUP_IDLE_MS = 1_500;
export const MAX_TURN_RESIDUAL_SNAPSHOTS = 64;
export const LIST_SNAPSHOT_TTL_MS = 120_000;
export const MAX_LIST_SNAPSHOTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const EFFORT_SUFFIX_RE = /^(.*?)(?:-tiered)?-(low|medium|high|xhigh|max)$/i;

const available = { status: 'available' as const };
const unsupported = (reason: string) => ({ status: 'unsupported' as const, reason });

export const readCaps: Capabilities = {
  view: available,
  send: unsupported('discovered agy session is read-only until attached'),
  queue: unsupported('discovered agy session is read-only until attached'),
  steer: unsupported('steer is available only for Codex'),
  answer: unsupported('discovered agy session is read-only until attached'),
  approve: unsupported('discovered agy session is read-only until attached'),
  interrupt: unsupported('discovered agy session is read-only until attached'),
  handoff: unsupported('discovered agy session is read-only until attached'),
  files: available,
  config: unsupported('discovered agy session is read-only until attached'),
};

export const liveCaps: Capabilities = {
  view: available,
  send: available,
  queue: unsupported('queue is coordinated by unified core'),
  steer: unsupported('steer is available only for Codex'),
  answer: available,
  approve: available,
  interrupt: available,
  handoff: available,
  files: available,
  config: available,
};

export type Obj = Record<string, unknown>;

export type LiveSessionMeta = {
  cwd: string;
  title: string;
  nativeTitle?: boolean;
  updatedAt?: string;
  createdAt?: string;
  models?: ModelOption[];
  effortConfigId?: string;
};

export type TurnResidualSnapshot = {
  turnId: string;
  generation: number;
  inProgressToolCallIds: Set<string>;
  observedAt: string;
};

export type SessionLockState = {
  generation: number;
  turnId: string;
  reason: string;
  lockedAt: string;
};

export type ActiveTurnState = {
  turnId: string;
  generation: number;
  model: string | null;
  startedAt: string;
  assistantMessageId: string | null;
  assistantSequence: number | null;
  assistantRevision: number;
  assistantText: string;
  needsParagraphBreak?: boolean;
  lastChunkMessageId?: string;
  assistantFinalized: boolean;
  interrupted: boolean;
  cancelRequested: boolean;
  cancelRequestedAt?: string;
  isWakeup?: boolean;
  wakeupTimer?: ReturnType<typeof setTimeout>;
  lastActivityAt?: number;
  inFlightServerRequests?: number;
  awaitingAsyncWakeup?: boolean;
  inProgressToolCalls: Set<string>;
  toolCalls: Map<string, Obj>;
  fullToolCalls: Set<string>;
  approvalRequestIds: Map<string, string | null>;
};

export type PendingAgyRequest = {
  rpcId: string | number;
  generation: number;
  turnId: string;
  toolCallId: string | null;
  interaction: Interaction;
  allowOptionId: string | null;
  allowAlwaysOptionId?: string | null;
  denyOptionId: string | null;
  propertyTypes: Record<string, string>;
  requiredFields?: Record<string, boolean>;
  answer: Answer | null;
  operationId: string | null;
  answerDigest: string | null;
  submission: 'writing' | 'submitted' | null;
  executed: boolean;
  closedSource: string | null;
};

export type ListSnapshot = {
  items: Session[];
  expires: number;
};

export type RecentDiscoveryState = {
  watermark: number;
  buffer: Session[];
  done: boolean;
  expires: number;
};

export type ExistingSnapshotState = {
  ids: string[];
  expires: number;
};

export interface AdapterContext {
  readonly transport: AgyAcpTransport;
  readonly catalog: AgyCatalog;
  readonly hostId: string;
  readonly serviceId: string;
  readonly approvalPolicy?: ApprovalScope;
  readonly wakeupIdleMs?: number;
  readonly promptIdleTimeoutMs?: number;
  readonly active: Set<string>;
  readonly controlChanges?: Set<string>;
  readonly controlEpoch: Map<string, number>;
  readonly knownSessions: Map<string, LiveSessionMeta>;
  readonly activeTurns: Map<string, ActiveTurnState>;
  readonly lockedSessions?: Map<string, SessionLockState>;
  readonly turnResiduals?: Map<string, TurnResidualSnapshot>;
  readonly recentTerminalTools?: Map<string, Set<string>>;
  readonly sessionTurns: Map<string, Map<string, Turn>>;
  readonly liveMessages: Map<string, Message[]>;
  readonly preLiveTranscriptIds: Map<string, Set<string>>;
  readonly requests: Map<string, PendingAgyRequest>;
  readonly listSnapshots: Map<string, ListSnapshot>;
  readonly recentDiscovery: Map<string, RecentDiscoveryState>;
  readonly existingSnapshots: Map<string, ExistingSnapshotState>;
  readonly acpTitles: Map<string, string>;
  acpTitlesExpiresAt?: number;
  acpTitlesRefresh?: Promise<void>;
  isClosed(): boolean;
  nextSequence(): number;
  ref(id: string): NativeSessionRef;
  check(ref: NativeSessionRef): string;
  emit(observation: PlatformObservation): void;
  emitInteraction(interaction: Interaction, evidence?: ResponseEvidence): void;
  emitSession?(ref: NativeSessionRef, id: string): void;
  buildSession(
    id: string,
    summary: AgyDiscoveredSession | null,
    liveMeta?: LiveSessionMeta,
    createdAtOverride?: string,
  ): Session & { subagentCount?: number };
  upsertLiveMessage(sessionId: string, message: Message): void;
  putSessionTurn(sessionId: string, turn: Turn): void;
  getSessionModel?(sessionId: string): string | null;
  recordTurnResidual?(sessionId: string, turnState: ActiveTurnState): void;
  pruneSnapshots(): void;
}

export const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
export const isRecord = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

export const ack = (nativeReference: string | null = null): PlatformAcknowledgement => ({
  status: 'submitted',
  nativeReference,
});

export function isGenericAgyTitle(title: string | undefined, sessionId: string): boolean {
  return isGenericSessionTitle(title) ||
    (title !== undefined && (isPlaceholderAgyTitle(title) || title.trim() === `Antigravity 会话 · ${sessionId.slice(0, 8)}`));
}

/** Strip trailing effort suffix (e.g. `-xhigh`, `-tiered-xhigh`) before passing model ID to CLI/ACP. */
export function stripAgyModelEffortSuffix(model: string): {
  baseModel: string;
  extractedEffort: AgyEffortLevel | null;
} {
  const trimmed = model.trim();
  const match = EFFORT_SUFFIX_RE.exec(trimmed);
  if (!match || !match[1]) {
    return { baseModel: trimmed, extractedEffort: null };
  }
  return {
    baseModel: match[1],
    extractedEffort: match[2]!.toLowerCase() as AgyEffortLevel,
  };
}

export function formatSessionTitle(baseTitle: string, subagentCount: number): string {
  if (subagentCount > 0) {
    return `${baseTitle} (${subagentCount} 子代理)`;
  }
  return baseTitle;
}

export function extractTextFromUpdateContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content)) {
    if (content.type === 'text' && typeof content.text === 'string') return content.text;
    if (typeof content.text === 'string' && !content.type) return content.text;
    return '';
  }
  if (Array.isArray(content)) {
    return content
      .map(item =>
        isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '',
      )
      .join('');
  }
  return '';
}

export function extractSchemaChoices(prop: Obj): string[] {
  if (Array.isArray(prop.enum)) {
    return prop.enum.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  if (Array.isArray(prop.oneOf)) {
    return prop.oneOf
      .map(item =>
        isRecord(item)
          ? typeof item.const === 'string'
            ? item.const
            : typeof item.title === 'string'
              ? item.title
              : ''
          : '',
      )
      .filter(s => s.trim().length > 0);
  }
  if (Array.isArray(prop.anyOf)) {
    const out: string[] = [];
    for (const branch of prop.anyOf) {
      if (!isRecord(branch)) continue;
      if (typeof branch.const === 'string' && branch.const.trim().length > 0) {
        out.push(branch.const);
      } else {
        out.push(...extractSchemaChoices(branch));
      }
    }
    return [...new Set(out)];
  }
  if (isRecord(prop.items)) {
    return extractSchemaChoices(prop.items);
  }
  return [];
}

function branchAllowsFreeText(node: Obj): boolean {
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.some(
      branch =>
        isRecord(branch) &&
        !Array.isArray(branch.enum) &&
        !Array.isArray(branch.oneOf) &&
        branch.const === undefined &&
        (branch.type === 'string' || branch.type === 'number' || branch.type === 'integer' || !branch.type),
    );
  }
  return false;
}

export function schemaAllowsFreeText(prop: Obj, choices: readonly string[]): boolean {
  if (choices.length === 0) return true;
  if (prop.type === 'array') {
    if (isRecord(prop.items)) {
      return branchAllowsFreeText(prop.items);
    }
    return false;
  }
  return branchAllowsFreeText(prop);
}

export function convertSchemaValue(rawValue: string, propType: string | undefined): unknown {
  const trimmed = rawValue.trim();
  if (propType === 'boolean') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    throw contractError('invalid_request', `invalid boolean value: ${rawValue}`);
  }
  if (propType === 'integer') {
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw contractError('invalid_request', `invalid integer value: ${rawValue}`);
    }
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) {
      throw contractError('invalid_request', `integer out of safe range: ${rawValue}`);
    }
    return n;
  }
  if (propType === 'number') {
    if (!trimmed) {
      throw contractError('invalid_request', `invalid number value: ${rawValue}`);
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw contractError('invalid_request', `invalid finite number value: ${rawValue}`);
    }
    return n;
  }
  return rawValue;
}

export function extractServerCurrentSettings(
  res: unknown,
): { model?: string; effort?: AgyEffortLevel } | null {
  if (!isRecord(res)) return null;
  let model: string | undefined;
  let effort: AgyEffortLevel | undefined;

  const rawModelId =
    (isRecord(res.models) && isString(res.models.currentModelId) && res.models.currentModelId) ||
    (isString(res.currentModelId) && res.currentModelId) ||
    (isString(res.modelId) && res.modelId) ||
    null;

  if (rawModelId) {
    const stripped = stripAgyModelEffortSuffix(rawModelId);
    if (stripped.baseModel) model = stripped.baseModel;
    if (stripped.extractedEffort) effort = stripped.extractedEffort;
  }

  if (Array.isArray(res.configOptions)) {
    const effortId = findEffortConfigId(res.configOptions);
    if (effortId) {
      for (const opt of res.configOptions) {
        if (!isRecord(opt) || opt.id !== effortId) continue;
        const val = isString(opt.currentValue)
          ? opt.currentValue.toLowerCase()
          : isString(opt.value)
            ? opt.value.toLowerCase()
            : null;
        if (val && AGY_REASONING_EFFORTS.includes(val as AgyEffortLevel)) {
          effort = val as AgyEffortLevel;
        }
      }
    }
  }

  if (!model && !effort) return null;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function normalizeTranscriptMessage(
  id: string,
  m: AgyTranscriptMessage,
  sequence: number,
): Message {
  return {
    messageId: m.messageId,
    sessionId: id,
    turnId: m.stepIndex !== null ? `step-${m.stepIndex}` : `line-${m.lineNumber}`,
    role: m.role,
    blocks: [{ type: 'text', text: m.text }],
    sequence,
    revision: 1,
    final: m.final,
    source: 'agy',
  };
}

export function findModeConfigId(configOptions: unknown[]): string | undefined {
  for (const opt of configOptions) {
    if (!isRecord(opt) || !isString(opt.id)) continue;
    if (opt.category === 'mode' || opt.id === 'mode' || opt.id === 'permission_mode') {
      return opt.id;
    }
  }
  return undefined;
}

export function findEffortConfigId(configOptions: unknown[]): string | undefined {
  for (const opt of configOptions) {
    if (!isRecord(opt) || !isString(opt.id)) continue;
    if (
      opt.category === 'thought_level' ||
      opt.id === 'thought_level' ||
      opt.id === 'reasoning_effort' ||
      opt.id === 'effort'
    ) {
      return opt.id;
    }
  }
  return undefined;
}

export function normalizeServerModels(rawModels: unknown[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const raw of rawModels) {
    if (!isRecord(raw) || !isString(raw.modelId)) continue;
    const { baseModel } = stripAgyModelEffortSuffix(raw.modelId);
    if (!baseModel || byId.has(baseModel)) continue;
    const label = isString(raw.name) ? raw.name : baseModel;
    byId.set(baseModel, {
      id: baseModel,
      label,
      reasoningEfforts: [...AGY_REASONING_EFFORTS],
    });
  }
  return [...byId.values()];
}

export function buildPromptBlocks(
  blocks: readonly PlatformInputBlock[],
): Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> {
  const promptBlocks: Array<
    { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
  > = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.text.trim()) {
        throw contractError('invalid_request', 'empty text block');
      }
      promptBlocks.push({ type: 'text', text: block.text });
      continue;
    }

    if (
      !(block.content instanceof Uint8Array) ||
      block.content.length === 0 ||
      block.content.length > MAX_ATTACHMENT_BYTES
    ) {
      throw contractError('invalid_request', 'invalid attachment size');
    }
    const bytes = Buffer.from(block.content);
    if (block.mediaType === 'text/plain') {
      let text: string;
      try {
        text = textAttachmentBlock(block.name, bytes, MAX_ATTACHMENT_BYTES);
      } catch {
        throw contractError('invalid_request', 'invalid text attachment');
      }
      promptBlocks.push({ type: 'text', text });
      continue;
    }

    const detected = imageMediaType(bytes);
    if (!detected) {
      if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mediaType)) {
        throw contractError('invalid_request', 'image signature does not match MIME');
      }
      throw contractError('unsupported', 'unsupported attachment type');
    }
    if (detected !== block.mediaType) {
      throw contractError('invalid_request', 'image signature does not match MIME');
    }
    promptBlocks.push({
      type: 'image',
      mimeType: detected,
      data: bytes.toString('base64'),
    });
  }

  return promptBlocks;
}
