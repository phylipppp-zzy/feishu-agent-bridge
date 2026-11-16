import { renderQuestionForm } from './feishu-question-forms.js';
import type { ChannelAction } from './feishu-channel.js';
import type { ChannelCard } from './feishu-cards.js';

/** Converts a presentation card into the Lark interactive card content object.
 * Pass JSON.stringify(result) as the SDK message content with msg_type=interactive. */
export function toFeishuCard(card: ChannelCard): object {
  if (card.form) return renderQuestionForm(card.form);
  return { config: { wide_screen_mode: true }, header: { title: { tag:'plain_text', content:card.title } }, elements: [
    { tag:'div', text:{ tag:'plain_text', content:card.text } },
    ...(card.actions.length ? [{tag:'action',actions:card.actions.map(a => ({tag:'button',text:{tag:'plain_text',content:a.label},type:'default',...(a.url ? {url:a.url} : {value:a.value})}))}] : []),
  ] };
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const counter = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
/** Parse only the verified transport's action.value, never identity/destination from value. */
function parseAction(value: unknown): ChannelAction {
  if (!object(value) || !str(value.action)) throw new Error('invalid card action');
  switch (value.action) {
    case 'panel': if ((value.sessionId === undefined || str(value.sessionId)) && (value.turnId === undefined || str(value.turnId)) && (value.inputId === undefined || str(value.inputId))) return {action:'panel',...(str(value.sessionId) ? {sessionId:value.sessionId}:{}),...(str(value.turnId) ? {turnId:value.turnId}:{}),...(str(value.inputId) ? {inputId:value.inputId}:{})}; break;
    case 'list': if ((value.cursor === undefined || str(value.cursor)) && (value.search === undefined || str(value.search))) return {action:'list',...(str(value.cursor) ? {cursor:value.cursor}:{}),...(str(value.search) ? {search:value.search}:{})}; break;
    case 'history': if (value.cursor === undefined || str(value.cursor)) return {action:'history',...(str(value.cursor) ? {cursor:value.cursor}:{})}; break;
    case 'upgrade': return {action:'upgrade'};
    case 'attach': if ((value.provider === 'claude' || value.provider === 'codex') && str(value.hostId) && str(value.serviceId) && str(value.nativeSessionId) && (value.mode === 'read_only' || value.mode === 'interactive')) return {action:'attach',provider:value.provider,hostId:value.hostId,serviceId:value.serviceId,nativeSessionId:value.nativeSessionId,mode:value.mode}; break;
    case 'stop': if (str(value.turnId) && counter(value.revision) && counter(value.controlGeneration)) return {action:'stop',turnId:value.turnId,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'cancel': if (str(value.inputId) && counter(value.revision) && counter(value.controlGeneration)) return {action:'cancel',inputId:value.inputId,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'control': if (str(value.owner) && (value.strategy === 'wait' || value.strategy === 'interrupt') && counter(value.revision) && counter(value.controlGeneration) && (value.release === undefined || typeof value.release === 'boolean')) return {action:'control',owner:value.owner,strategy:value.strategy,revision:value.revision,controlGeneration:value.controlGeneration,...(typeof value.release === 'boolean' ? {release:value.release}:{})}; break;
    case 'settings': if ((value.model === null || str(value.model)) && object(value.preferences) && Object.values(value.preferences).every(v => typeof v === 'string') && counter(value.revision) && counter(value.controlGeneration)) return {action:'settings',model:value.model,preferences:value.preferences as Record<string,string>,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'notifications': if (typeof value.enabled === 'boolean' && Array.isArray(value.eventTypes) && value.eventTypes.every(str) && counter(value.revision) && counter(value.controlGeneration)) return {action:'notifications',enabled:value.enabled,eventTypes:value.eventTypes,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'archive': if (typeof value.archived === 'boolean' && counter(value.revision) && counter(value.controlGeneration)) return {action:'archive',archived:value.archived,revision:value.revision,controlGeneration:value.controlGeneration}; break;
    case 'bind': if (str(value.sessionId) && (value.mode === undefined || value.mode === 'read_only' || value.mode === 'interactive')) return {action:'bind',sessionId:value.sessionId,...(value.mode ? {mode:value.mode} : {})}; break;
    case 'artifacts': if (value.sessionId === undefined || str(value.sessionId)) return value.sessionId === undefined ? {action:'artifacts'} : {action:'artifacts',sessionId:value.sessionId as string}; break;
    case 'file': if (str(value.artifactId) && str(value.contentVersion)) return {action:'file',artifactId:value.artifactId,contentVersion:value.contentVersion}; break;
    case 'reconcile': case 'finish': if (str(value.operationId)) return {action:value.action,operationId:value.operationId}; break;
    case 'answer': {
      if (!str(value.interactionId) || !counter(value.revision) || !counter(value.connectionGeneration) || !object(value.answer)) break;
      const answer = value.answer;
      if (answer.kind === 'approval' && (answer.decision === 'allow' || answer.decision === 'deny') && str(answer.scope) && str(value.toolInputDigest)) return {action:'answer',interactionId:value.interactionId,revision:value.revision,connectionGeneration:value.connectionGeneration,answer:{kind:'approval',decision:answer.decision,scope:answer.scope},toolInputDigest:value.toolInputDigest};
      if (answer.kind === 'question' && Array.isArray(answer.values) && answer.values.length && answer.values.every(str) && value.toolInputDigest === null) return {action:'answer',interactionId:value.interactionId,revision:value.revision,connectionGeneration:value.connectionGeneration,answer:{kind:'question',values:answer.values},toolInputDigest:null};
      if (answer.kind === 'question_group' && object(answer.answers) && Object.values(answer.answers).every(v => Array.isArray(v) && v.length > 0 && v.every(str)) && value.toolInputDigest === null) return {action:'answer',interactionId:value.interactionId,revision:value.revision,connectionGeneration:value.connectionGeneration,answer:{kind:'question_group',answers:answer.answers as Record<string,string[]>},toolInputDigest:null};
      break;
    }
  }
  throw new Error('invalid or unsupported card action');
}
/** Callback buttons must carry the binding epoch stamped by the channel. */
export function parseFeishuAction(value: unknown, formValues?: unknown): ChannelAction {
  if (object(value) && value.action === 'answer_form') { if (!str(value.bindingId) || !str(value.interactionId) || !counter(value.revision) || !counter(value.connectionGeneration) || !object(formValues) || JSON.stringify(formValues).length > 100_000) throw new Error('invalid question form callback'); return {action:'answer_form',bindingId:value.bindingId,interactionId:value.interactionId,revision:value.revision,connectionGeneration:value.connectionGeneration,fields:formValues}; }
  const action = parseAction(value);
  if (!object(value)) throw new Error('invalid card action');
  if (!['bind','list','finish'].includes(action.action) && !str(value.bindingId)) throw new Error('missing binding identity');
  return {...action,...(str(value.bindingId) ? {bindingId:value.bindingId}:{})};
}
/** Commands work identically for either provider; text without a slash is an input. */
export function parseFeishuText(text: string): ChannelAction {
  const input = text.trim(); if (!input) throw new Error('empty message');
  if (!input.startsWith('/')) return {action:'input',text:input,mode:'new'};
  const [command, ...parts] = input.split(/\s+/); const rest = parts.join(' ');
  switch (command) {
    case '/list': return rest ? {action:'list',search:rest} : {action:'list'};
    case '/bind': if (parts[0] && (!parts[1] || parts[1] === 'read_only' || parts[1] === 'interactive')) return {action:'bind',sessionId:parts[0],...(parts[1] ? {mode:parts[1] as 'read_only'|'interactive'} : {})}; break;
    case '/attach': { const [provider,hostId,serviceId,nativeSessionId,mode] = parts; return parseAction({action:'attach',provider,hostId,serviceId,nativeSessionId,mode}); }
    case '/stop': { const [turnId,r,g]=parts; return parseAction({action:'stop',turnId,revision:Number(r),controlGeneration:Number(g)}); }
    case '/cancel': { const [inputId,r,g]=parts; return parseAction({action:'cancel',inputId,revision:Number(r),controlGeneration:Number(g)}); }
    case '/control': { const [owner,strategy,r,g,release]=parts; return parseAction({action:'control',owner,strategy,revision:Number(r),controlGeneration:Number(g),release:release === 'release'}); }
    case '/settings': { const [model,r,g]=parts; return parseAction({action:'settings',model:model === '-' ? null : model,preferences:{},revision:Number(r),controlGeneration:Number(g)}); }
    case '/notifications': { const [enabled,r,g,...eventTypes]=parts; if (enabled !== 'on' && enabled !== 'off') break; return parseAction({action:'notifications',enabled:enabled === 'on',eventTypes,revision:Number(r),controlGeneration:Number(g)}); }
    case '/archive': { const [mode,r,g]=parts; if (mode !== 'on' && mode !== 'off') break; return parseAction({action:'archive',archived:mode === 'on',revision:Number(r),controlGeneration:Number(g)}); }
    case '/create': if ((parts[0] === 'claude' || parts[0] === 'codex') && parts[1]) return {action:'create',provider:parts[0],project:parts[1],model:parts[2] ?? null}; break;
    case '/answer': {
      const [interactionId, revision, generation, ...values] = parts;
      const r = Number(revision), g = Number(generation);
      if (interactionId && revision !== undefined && generation !== undefined && counter(r) && counter(g) && values.length) return {action:'answer',interactionId,revision:r,connectionGeneration:g,answer:{kind:'question',values},toolInputDigest:null};
      break;
    }
    case '/queue': if (rest) return {action:'input',text:rest,mode:'queue'}; break;
    case '/steer': if (rest) return {action:'input',text:rest,mode:'steer'}; break;
    case '/panel': return {action:'panel',...(parts[0] && parts[0] !== '-' ? {turnId:parts[0]} : {}),...(parts[1] && parts[1] !== '-' ? {inputId:parts[1]} : {})};
    case '/history': return {action:'history',...(rest ? {cursor:rest}:{})};
    case '/files': return {action:'artifacts'};
    case '/models': return {action:'models'};
    case '/pending': return {action:'pending'};
    case '/health': return {action:'health'};
    case '/upgrade': return {action:'upgrade'};
    case '/unbind': return {action:'unbind'};
    case '/finish': if (rest) return {action:'finish',operationId:rest}; break;
    case '/reconcile': if (rest) return {action:'reconcile',operationId:rest}; break;
  }
  throw new Error('invalid or unsupported command');
}
