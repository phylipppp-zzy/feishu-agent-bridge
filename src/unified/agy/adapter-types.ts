import {isGenericSessionTitle} from '../session-title.js';
import type {
  PlatformAcknowledgement,
  PlatformInputBlock,
  PlatformObservation,
} from '../adapter.js';
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
  Session,
  Turn,
} from '../contracts.js';
import { contractError } from '../errors.js';
import { textAttachmentBlock } from '../text-attachment.js';
import { imageMediaType } from '../../image-media.js';

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
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', reasoningEfforts: [...AGY_REASONING_EFFORTS] },
];

export const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60_000;
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
  handoff: unsupported('agy ACP does not support live terminal handoff'),
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
  handoff: unsupported('agy ACP does not support live terminal handoff'),
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

export type ActiveTurnState = {
  turnId: string;
  generation: number;
  model: string | null;
  startedAt: string;
  assistantMessageId: string | null;
  assistantSequence: number | null;
  assistantRevision: number;
  assistantText: string;
  assistantFinalized: boolean;
  interrupted: boolean;
  inProgressToolCalls: Set<string>;
};

export type PendingAgyRequest = {
  rpcId: string | number;
  generation: number;
  toolCallId: string | null;
  interaction: Interaction;
  allowOptionId: string;
  denyOptionId: string;
  propertyTypes: Record<string, string>;
  answer: Answer | null;
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
  readonly active: Set<string>;
  readonly controlEpoch: Map<string, number>;
  readonly knownSessions: Map<string, LiveSessionMeta>;
  readonly activeTurns: Map<string, ActiveTurnState>;
  readonly sessionTurns: Map<string, Map<string, Turn>>;
  readonly liveMessages: Map<string, Message[]>;
  readonly requests: Map<string, PendingAgyRequest>;
  readonly listSnapshots: Map<string, ListSnapshot>;
  readonly recentDiscovery: Map<string, RecentDiscoveryState>;
  readonly existingSnapshots: Map<string, ExistingSnapshotState>;
  isClosed(): boolean;
  nextSequence(): number;
  ref(id: string): NativeSessionRef;
  check(ref: NativeSessionRef): string;
  emit(observation: PlatformObservation): void;
  emitInteraction(interaction: Interaction): void;
  buildSession(
    id: string,
    summary: AgyDiscoveredSession | null,
    liveMeta?: LiveSessionMeta,
    createdAtOverride?: string,
  ): Session & { subagentCount?: number };
  upsertLiveMessage(sessionId: string, message: Message): void;
  putSessionTurn(sessionId: string, turn: Turn): void;
  pruneSnapshots(): void;
}

export const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
export const isRecord = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

export const ack = (nativeReference: string | null = null): PlatformAcknowledgement => ({
  status: 'submitted',
  nativeReference,
});

export function isGenericAgyTitle(title: string | undefined, sessionId: string): boolean {
  return isGenericSessionTitle(title) || title?.trim() === `Antigravity 会话 · ${sessionId.slice(0, 8)}`;
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
  if (isRecord(prop.items)) {
    return extractSchemaChoices(prop.items);
  }
  return [];
}

export function convertSchemaValue(rawValue: string, propType: string | undefined): unknown {
  if (propType === 'boolean') {
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
  }
  if (propType === 'number' || propType === 'integer') {
    const n = Number(rawValue);
    if (Number.isFinite(n)) return propType === 'integer' ? Math.trunc(n) : n;
  }
  return rawValue;
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
