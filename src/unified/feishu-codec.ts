import { renderQuestionForm } from './feishu-question-forms.js';
import type { ChannelAction } from './feishu-channel.js';
import type { ChannelCard } from './feishu-cards.js';
import type { PendingHubEntry, RuntimeTrustedAction } from './runtime.js';

/** Converts a presentation card into the Lark interactive card content object.
 * Pass JSON.stringify(result) as the SDK message content with msg_type=interactive. */
export function toFeishuCard(card: ChannelCard): object {
  if (card.form) return renderQuestionForm(card.form);
  const elements: unknown[] = [];
  if (card.table) {
    const renderColumns = (cells: string[], bold: boolean) =>
      card.table!.columns.map((col, idx) => ({
        tag: 'column',
        width: 'weighted',
        weight: col.weight ?? 1,
        vertical_align: 'top',
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: bold ? `**${cells[idx] ?? col.header}**` : (cells[idx] ?? ''),
            },
          },
        ],
      }));
    elements.push(
      {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'grey',
        columns: renderColumns(card.table.columns.map(c => c.header), true),
      },
      { tag: 'hr' },
      ...card.table.rows.map(row => ({
        tag: 'column_set',
        flex_mode: 'none',
        columns: renderColumns(row, false),
      })),
    );
    if (card.table.footer) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: card.table.footer } });
    }
  } else {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: card.text } });
  }
  if (card.actions.length) {
    elements.push({
      tag: 'action',
      actions: card.actions.map(a => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.label },
        type: 'default',
        ...(a.url ? { url: a.url } : { value: a.value }),
      })),
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: card.title.trim() || '未命名会话' } },
    elements,
  };
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const counter = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

const PENDING_ENTRIES = new Set<PendingHubEntry>(['hub', 'source', 'pending_hub']);
const INTERACTION_CATEGORIES = new Set<'question' | 'approval'>(['question', 'approval']);
const DECISION_CATEGORIES = new Set<'business_decision' | 'execution_auth'>(['business_decision', 'execution_auth']);
const PENDING_QUERY_CATEGORIES = new Set(['all', 'question', 'approval', 'business_decision', 'execution_auth']);
const PENDING_QUERY_PROVIDERS = new Set(['all', 'claude', 'codex', 'agy', 'decision']);
const WAVE2_BINDING_EXEMPT_ACTIONS = new Set([
  'bind',
  'list',
  'new_help',
  'finish',
  'inspect_unknown',
  'create',
  'switch_target',
  'confirm_handoff',
  'decision_answer',
  'pending_page',
]);

function parsePendingMeta(value: Record<string, unknown>): {
  entry?: PendingHubEntry;
  sourceSessionId?: string;
  category?: 'question' | 'approval';
} | undefined {
  let hasAny = false;
  const out: { entry?: PendingHubEntry; sourceSessionId?: string; category?: 'question' | 'approval' } = {};
  if (value.entry !== undefined) {
    if (typeof value.entry !== 'string' || !PENDING_ENTRIES.has(value.entry as PendingHubEntry)) {
      throw new Error('invalid pending hub entry');
    }
    out.entry = value.entry as PendingHubEntry;
    hasAny = true;
  }
  if (value.sourceSessionId !== undefined) {
    if (!nonempty(value.sourceSessionId)) throw new Error('invalid pending hub sourceSessionId');
    out.sourceSessionId = value.sourceSessionId;
    hasAny = true;
  }
  if (value.category !== undefined) {
    if (typeof value.category !== 'string' || !INTERACTION_CATEGORIES.has(value.category as 'question' | 'approval')) {
      throw new Error('invalid pending hub category');
    }
    out.category = value.category as 'question' | 'approval';
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

function parseTaskScope(
  value: Record<string, unknown>,
  requireTargetFields: boolean,
): {
  taskId: string;
  rootGeneration: number;
  activeRevision: number;
  targetId?: string;
  targetGeneration?: number;
  sessionId?: string;
  controlGeneration?: number;
} | undefined {
  const hasTaskField =
    value.taskId !== undefined ||
    value.rootGeneration !== undefined ||
    value.activeRevision !== undefined ||
    value.targetId !== undefined ||
    value.targetGeneration !== undefined;
  if (!hasTaskField) return undefined;
  if (value.entry !== undefined) throw new Error('conflicting task and pending hub scopes');
  if (!nonempty(value.taskId) || !counter(value.rootGeneration) || !counter(value.activeRevision)) {
    throw new Error('invalid task card scope');
  }
  if (requireTargetFields) {
    if (!nonempty(value.targetId) || !counter(value.targetGeneration) || !nonempty(value.sessionId)) {
      throw new Error('invalid task target scope');
    }
    if (value.controlGeneration !== undefined && !counter(value.controlGeneration)) {
      throw new Error('invalid task controlGeneration');
    }
  } else {
    if (value.targetId !== undefined && !nonempty(value.targetId)) throw new Error('invalid task targetId');
    if (value.targetGeneration !== undefined && !counter(value.targetGeneration)) throw new Error('invalid task targetGeneration');
    if (value.sessionId !== undefined && !nonempty(value.sessionId)) throw new Error('invalid task sessionId');
  }
  return {
    taskId: value.taskId,
    rootGeneration: value.rootGeneration,
    activeRevision: value.activeRevision,
    ...(value.targetId !== undefined ? { targetId: value.targetId as string } : {}),
    ...(value.targetGeneration !== undefined ? { targetGeneration: value.targetGeneration as number } : {}),
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId as string } : {}),
    ...(requireTargetFields && value.controlGeneration !== undefined ? { controlGeneration: value.controlGeneration as number } : {}),
  };
}

/** Parse only the verified transport's action.value, never identity/destination from value. */
function parseAction(value: unknown): RuntimeTrustedAction {
  if (!object(value) || !str(value.action)) throw new Error('invalid card action');
  switch (value.action) {
    case 'panel': if ((value.sessionId === undefined || str(value.sessionId)) && (value.turnId === undefined || str(value.turnId)) && (value.inputId === undefined || str(value.inputId))) return {action:'panel',...(str(value.sessionId) ? {sessionId:value.sessionId}:{}),...(str(value.turnId) ? {turnId:value.turnId}:{}),...(str(value.inputId) ? {inputId:value.inputId}:{})}; break;
    case 'inspect_unknown': if(str(value.operationId)&&(value.cursor===undefined||str(value.cursor))&&(value.nativeId===undefined||str(value.nativeId))&&!(value.cursor&&value.nativeId))return {action:'inspect_unknown',operationId:value.operationId,...(str(value.cursor)?{cursor:value.cursor}:{}),...(str(value.nativeId)?{nativeId:value.nativeId}:{})};break;
    case 'list': if ((value.cursor === undefined || str(value.cursor)) && (value.search === undefined || str(value.search)) && (value.provider === undefined || value.provider === 'all' || value.provider === 'claude' || value.provider === 'codex' || value.provider === 'agy')) return {action:'list',...(str(value.cursor) ? {cursor:value.cursor}:{}),...(str(value.search) ? {search:value.search}:{}),...(value.provider !== undefined ? {provider:value.provider}:{})}; break;
    case 'new_help': return {action:'new_help'};
    case 'history': if (value.cursor === undefined || str(value.cursor)) { const taskScope = parseTaskScope(value, false); return {action:'history',...(str(value.cursor) ? {cursor:value.cursor}:{}),...(taskScope ?? {})}; } break;
    case 'upgrade': return {action:'upgrade'};
    case 'attach': if ((value.provider === 'claude' || value.provider === 'codex' || value.provider === 'agy') && str(value.hostId) && str(value.serviceId) && str(value.nativeSessionId) && (value.mode === 'read_only' || value.mode === 'interactive')) return {action:'attach',provider:value.provider,hostId:value.hostId,serviceId:value.serviceId,nativeSessionId:value.nativeSessionId,mode:value.mode}; break;
    case 'stop': if (str(value.turnId) && counter(value.revision) && counter(value.controlGeneration)) { const taskScope = parseTaskScope(value, false); return {action:'stop',turnId:value.turnId,revision:value.revision,controlGeneration:value.controlGeneration,...(taskScope ?? {})}; } break;
    case 'cancel': if (str(value.inputId) && counter(value.revision) && counter(value.controlGeneration)) { const taskScope = parseTaskScope(value, false); return {action:'cancel',inputId:value.inputId,revision:value.revision,controlGeneration:value.controlGeneration,...(taskScope ?? {})}; } break;
    case 'control': if (str(value.owner) && (value.strategy === 'wait' || value.strategy === 'interrupt') && counter(value.revision) && counter(value.controlGeneration) && (value.release === undefined || typeof value.release === 'boolean')) return {action:'control',owner:value.owner,strategy:value.strategy,revision:value.revision,controlGeneration:value.controlGeneration,...(typeof value.release === 'boolean' ? {release:value.release}:{})}; break;
    case 'models': if (value.cursor === undefined || str(value.cursor)) { const taskScope = parseTaskScope(value, false); return {action:'models',...(str(value.cursor) ? {cursor:value.cursor}:{}),...(taskScope ?? {})}; } break;
    case 'settings': if ((value.model === null || str(value.model)) && object(value.preferences) && Object.values(value.preferences).every(v => typeof v === 'string') && counter(value.revision) && counter(value.controlGeneration)) { const taskScope = parseTaskScope(value, false); return {action:'settings',model:value.model,preferences:value.preferences as Record<string,string>,revision:value.revision,controlGeneration:value.controlGeneration,...(taskScope ?? {})}; } break;
    case 'notice_settings': if (['paused','completed','waiting','failed','legacy'].includes(String(value.field)) && typeof value.value==='boolean' && counter(value.settingsRevision) && counter(value.revision) && counter(value.controlGeneration)) return {action:'notice_settings',field:value.field as 'paused'|'completed'|'waiting'|'failed'|'legacy',value:value.value,settingsRevision:value.settingsRevision,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'notifications': if (typeof value.enabled === 'boolean' && Array.isArray(value.eventTypes) && value.eventTypes.every(str) && counter(value.revision) && counter(value.controlGeneration)) return {action:'notifications',enabled:value.enabled,eventTypes:value.eventTypes,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'archive': if (typeof value.archived === 'boolean' && counter(value.revision) && counter(value.controlGeneration)) return {action:'archive',archived:value.archived,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'bind': if (str(value.sessionId) && (value.mode === undefined || value.mode === 'read_only' || value.mode === 'interactive')) return {action:'bind',sessionId:value.sessionId,...(value.mode ? {mode:value.mode} : {})}; break;
    case 'create': if ((value.provider === 'claude' || value.provider === 'codex' || value.provider === 'agy') && str(value.project) && (value.model === null || str(value.model))) return {action:'create',provider:value.provider,project:value.project,model:value.model}; break;
    case 'artifacts': if ((value.sessionId === undefined || str(value.sessionId)) && (value.cursor === undefined || str(value.cursor))) return {action:'artifacts',...(str(value.sessionId) ? {sessionId:value.sessionId} : {}),...(str(value.cursor) ? {cursor:value.cursor} : {})}; break;
    case 'file': if (str(value.artifactId) && str(value.contentVersion)) { const taskScope = parseTaskScope(value, false); return {action:'file',artifactId:value.artifactId,contentVersion:value.contentVersion,...(taskScope ?? {})}; } break;
    case 'reconcile': case 'finish': if (str(value.operationId)) return {action:value.action,operationId:value.operationId}; break;
    case 'switch_target': {
      if (nonempty(value.targetId) && nonempty(value.taskId) && counter(value.rootGeneration) && counter(value.activeRevision)) {
        return {
          action: 'switch_target',
          taskId: value.taskId,
          rootGeneration: value.rootGeneration,
          activeRevision: value.activeRevision,
          targetId: value.targetId,
        };
      }
      break;
    }
    case 'confirm_handoff': {
      if (
        nonempty(value.handoffId) &&
        nonempty(value.taskId) &&
        nonempty(value.previewDigest) &&
        counter(value.targetGeneration) &&
        counter(value.activeRevision)
      ) {
        return {
          action: 'confirm_handoff',
          handoffId: value.handoffId,
          taskId: value.taskId,
          previewDigest: value.previewDigest,
          targetGeneration: value.targetGeneration,
          activeRevision: value.activeRevision,
        };
      }
      break;
    }
    case 'decision_answer': {
      if (!nonempty(value.decisionId) || !counter(value.expectedVersion) || !nonempty(value.expectedDigest)) break;
      if (value.selectedOptionId !== undefined && value.selectedOptionId !== null && !nonempty(value.selectedOptionId)) break;
      if (value.freeText !== undefined && value.freeText !== null && typeof value.freeText !== 'string') break;
      const hasOption = nonempty(value.selectedOptionId);
      const hasText = nonempty(value.freeText);
      if (!hasOption && !hasText) break;
      if (value.rawUtterance !== undefined && !nonempty(value.rawUtterance)) break;
      if (value.entry !== undefined && (typeof value.entry !== 'string' || !PENDING_ENTRIES.has(value.entry as PendingHubEntry))) break;
      if (value.category !== undefined && (typeof value.category !== 'string' || !DECISION_CATEGORIES.has(value.category as 'business_decision' | 'execution_auth'))) break;
      if (value.sourceSessionId !== undefined && !nonempty(value.sourceSessionId)) break;
      return {
        action: 'decision_answer',
        decisionId: value.decisionId,
        expectedVersion: value.expectedVersion,
        expectedDigest: value.expectedDigest,
        ...(value.selectedOptionId !== undefined ? { selectedOptionId: value.selectedOptionId as string | null } : {}),
        ...(value.freeText !== undefined ? { freeText: value.freeText as string | null } : {}),
        ...(value.rawUtterance !== undefined ? { rawUtterance: value.rawUtterance } : {}),
        ...(value.entry !== undefined ? { entry: value.entry as PendingHubEntry } : {}),
        ...(value.category !== undefined ? { category: value.category as 'business_decision' | 'execution_auth' } : {}),
        ...(value.sourceSessionId !== undefined ? { sourceSessionId: value.sourceSessionId } : {}),
      };
    }
    case 'pending_page': {
      if (value.cursor !== undefined && !nonempty(value.cursor)) break;
      if (value.category !== undefined && (typeof value.category !== 'string' || !PENDING_QUERY_CATEGORIES.has(value.category))) break;
      if (value.provider !== undefined && (typeof value.provider !== 'string' || !PENDING_QUERY_PROVIDERS.has(value.provider))) break;
      return {
        action: 'pending_page',
        ...(value.cursor !== undefined ? { cursor: value.cursor } : {}),
        ...(value.category !== undefined ? { category: value.category as 'all' | 'question' | 'approval' | 'business_decision' | 'execution_auth' } : {}),
        ...(value.provider !== undefined ? { provider: value.provider as 'all' | 'claude' | 'codex' | 'agy' | 'decision' } : {}),
      };
    }
    case 'answer': {
      if (!str(value.interactionId) || !counter(value.revision) || !counter(value.connectionGeneration) || !object(value.answer)) break;
      const pendingMeta = parsePendingMeta(value);
      const taskScope = parseTaskScope(value, true);
      if (pendingMeta && taskScope) break;
      const scopeExtra = { ...(pendingMeta ?? {}), ...(taskScope ?? {}) };
      const answer = value.answer;
      if (answer.kind === 'approval' && (answer.decision === 'allow' || answer.decision === 'deny') && str(answer.scope) && str(value.toolInputDigest)) return {action:'answer',interactionId:value.interactionId,revision:value.revision,connectionGeneration:value.connectionGeneration,answer:{kind:'approval',decision:answer.decision,scope:answer.scope},toolInputDigest:value.toolInputDigest,...scopeExtra} as RuntimeTrustedAction;
      if (answer.kind === 'question' && Array.isArray(answer.values) && answer.values.length && answer.values.every(str) && value.toolInputDigest === null) return {action:'answer',interactionId:value.interactionId,revision:value.revision,connectionGeneration:value.connectionGeneration,answer:{kind:'question',values:answer.values},toolInputDigest:null,...scopeExtra} as RuntimeTrustedAction;
      if (answer.kind === 'question_group' && object(answer.answers) && Object.values(answer.answers).every(v => Array.isArray(v) && v.length > 0 && v.every(str)) && value.toolInputDigest === null) return {action:'answer',interactionId:value.interactionId,revision:value.revision,connectionGeneration:value.connectionGeneration,answer:{kind:'question_group',answers:answer.answers as Record<string,string[]>},toolInputDigest:null,...scopeExtra} as RuntimeTrustedAction;
      break;
    }
  }
  throw new Error('invalid or unsupported card action');
}
/** Callback buttons must carry the binding epoch stamped by the channel. */
export function parseFeishuAction<T extends RuntimeTrustedAction = ChannelAction>(value: unknown, formValues?: unknown): T {
  if (object(value) && value.action === 'answer_form') {
    if (!str(value.interactionId) || !counter(value.revision) || !counter(value.connectionGeneration) || !object(formValues) || JSON.stringify(formValues).length > 100_000) {
      throw new Error('invalid question form callback');
    }
    const pendingMeta = parsePendingMeta(value);
    const taskScope = parseTaskScope(value, true);
    if (pendingMeta && taskScope) throw new Error('invalid question form callback');
    if (value.bindingId !== undefined && !str(value.bindingId)) throw new Error('invalid question form callback');
    if (!pendingMeta?.entry && !taskScope && !str(value.bindingId)) throw new Error('invalid question form callback');
    return {
      action: 'answer_form',
      ...(str(value.bindingId) ? { bindingId: value.bindingId } : {}),
      ...(pendingMeta ?? {}),
      ...(taskScope ?? {}),
      interactionId: value.interactionId,
      revision: value.revision,
      connectionGeneration: value.connectionGeneration,
      fields: formValues,
    } as T;
  }
  const action = parseAction(value);
  if (!object(value)) throw new Error('invalid card action');
  if (value.bindingId !== undefined && !str(value.bindingId)) throw new Error('invalid binding identity');
  const hasWave2Scope =
    WAVE2_BINDING_EXEMPT_ACTIONS.has(action.action) ||
    ('entry' in action && action.entry !== undefined) ||
    ('taskId' in action && action.taskId !== undefined);
  if (!hasWave2Scope && !str(value.bindingId)) throw new Error('missing binding identity');
  const attachBindingId =
    str(value.bindingId) && !['switch_target', 'confirm_handoff', 'pending_page'].includes(action.action)
      ? { bindingId: value.bindingId }
      : {};
  return { ...action, ...attachBindingId } as T;
}
/** Commands work identically for either provider; text without a slash is an input. */
export function parseFeishuText(text: string): ChannelAction {
  const input = text.trim(); if (!input) throw new Error('empty message');
  if (!input.startsWith('/')) return {action:'input',text:input,mode:'new'};
  const [command, ...parts] = input.split(/\s+/); const rest = parts.join(' ');
  switch (command) {
    case '/help': {
      if (parts.length === 0) return {action:'help'};
      if (parts.length === 1 && parts[0] === 'admin') return {action:'help',scope:'admin'};
      break;
    }
    case '/swarm': {
      const prompt = input.slice(command!.length).trim();
      return {action:'swarm',prompt,rawText:input};
    }
    case '/new': return {action:'new_help'};
    case '/sessions': return rest ? {action:'list',search:rest} : {action:'list'};
    case '/candidates': if(parts.length===1||parts.length===2)return {action:'inspect_unknown',operationId:parts[0]!,...(parts[1]?{nativeId:parts[1]}:{})};break;
    case '/model': return parts.length === 0 ? {action:'legacy_model'} : parts.length === 2 ? {action:'legacy_model',model:parts[0]!,effort:parts[1]!} : {action:'legacy_model',invalid:true};
    case '/list': return rest ? {action:'list',search:rest} : {action:'list'};
    case '/bind': if (parts[0] && (!parts[1] || parts[1] === 'read_only' || parts[1] === 'interactive')) return {action:'bind',sessionId:parts[0],...(parts[1] ? {mode:parts[1] as 'read_only'|'interactive'} : {})}; break;
    case '/attach': { const [provider,hostId,serviceId,nativeSessionId,mode] = parts; return parseAction({action:'attach',provider,hostId,serviceId,nativeSessionId,mode}) as ChannelAction; }
    case '/stop': { if(!parts.length) return {action:'legacy_stop'}; const [turnId,r,g]=parts; return parseAction({action:'stop',turnId,revision:Number(r),controlGeneration:Number(g)}) as ChannelAction; }
    case '/cancel': { const [inputId,r,g]=parts; return parseAction({action:'cancel',inputId,revision:Number(r),controlGeneration:Number(g)}) as ChannelAction; }
    case '/control': { const [owner,strategy,r,g,release]=parts; return parseAction({action:'control',owner,strategy,revision:Number(r),controlGeneration:Number(g),release:release === 'release'}) as ChannelAction; }
    case '/settings': { const [model,r,g]=parts; return parseAction({action:'settings',model:model === '-' ? null : model,preferences:{},revision:Number(r),controlGeneration:Number(g)}) as ChannelAction; }
    case '/notifications': { const [enabled,r,g,...eventTypes]=parts; if (enabled !== 'on' && enabled !== 'off') break; return parseAction({action:'notifications',enabled:enabled === 'on',eventTypes,revision:Number(r),controlGeneration:Number(g)}) as ChannelAction; }
    case '/archive': { const [mode,r,g]=parts; if (mode !== 'on' && mode !== 'off') break; return parseAction({action:'archive',archived:mode === 'on',revision:Number(r),controlGeneration:Number(g)}) as ChannelAction; }
    case '/create': if ((parts[0] === 'claude' || parts[0] === 'codex' || parts[0] === 'agy') && parts[1]) return {action:'create',provider:parts[0],project:parts[1],model:parts[2] ?? null}; break;
    case '/answer': {
      const [interactionId, revision, generation, ...values] = parts;
      const r = Number(revision), g = Number(generation);
      if (interactionId && revision !== undefined && generation !== undefined && counter(r) && counter(g) && values.length) return {action:'answer',interactionId,revision:r,connectionGeneration:g,answer:{kind:'question',values},toolInputDigest:null};
      break;
    }
    case '/queue': if (rest) return {action:'input',text:rest,mode:'queue'}; break;
    case '/steer': if (rest) return {action:'input',text:rest,mode:'steer'}; break;
    case '/': case '/status': case '/menu': return {action:'panel'};
    case '/panel': return {action:'panel',...(parts[0] && parts[0] !== '-' ? {turnId:parts[0]} : {}),...(parts[1] && parts[1] !== '-' ? {inputId:parts[1]} : {})};
    case '/ls': { const args=parts.filter(x=>x!=='-a'); if(args.length>1) break; return {action:'project_files',directory:args[0] ?? '.',showHidden:parts.includes('-a')}; }
    case '/deliver': if (rest) return {action:'deliver_files',args:input.slice(command!.length).trim()}; break;
    case '/export': if (!rest) return {action:'export'}; break;
    case '/history': return {action:'history',...(rest ? {cursor:rest}:{})};
    case '/file':
    case '/files': return {action:'artifacts'};
    case '/models': return {action:'models'};
    case '/pending': return {action:'pending'};
    case '/health': return {action:'health'};
    case '/upgrade': return {action:'upgrade'};
    case '/unbind': return {action:'unbind'};
    case '/task': {
      if (parts.length === 0) return {action:'task_panel'};
      if (parts[0] === 'mount') {
        if (parts[1] && parts.length <= 3 && (!parts[2] || parts[2] === 'read_only' || parts[2] === 'interactive')) {
          return {action:'task_mount',sessionId:parts[1],...(parts[2] ? {mode:parts[2] as 'read_only'|'interactive'} : {})};
        }
        break;
      }
      return {action:'task_create',title:rest};
    }
    case '/handoff': if (parts.length === 1 && parts[0]) return {action:'handoff_preview',targetId:parts[0]}; break;
    case '/finish': if (rest) return {action:'finish',operationId:rest}; break;
    case '/reconcile': if (rest) return {action:'reconcile',operationId:rest}; break;
  }
  throw new Error('invalid or unsupported command');
}
