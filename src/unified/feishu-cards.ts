import type { Interaction, Operation, Session } from './contracts.js';

/** Presentation-neutral cards; an injected transport converts these to Feishu SDK payloads. */
export interface ChannelCard { title: string; text: string; actions: Array<{ label: string; value: Record<string, unknown>; url?: string }> }
export function sessionCard(session: Session): ChannelCard {
  return { title: session.title, text: `${session.native.provider} · ${session.project} · ${session.status}\n控制: ${session.control.input}`, actions: [
    { label: '查看（只读）', value: { action: 'bind', sessionId: session.sessionId, mode:'read_only' } },
    { label: '接入并续聊', value: { action: 'bind', sessionId: session.sessionId, mode:'interactive' } },
    { label: '会话控制', value: { action: 'panel', sessionId: session.sessionId } },
    { label: '查看文件', value: { action: 'artifacts', sessionId: session.sessionId } },
  ] };
}
export function interactionCard(i: Interaction, readOnly = false): ChannelCard {
  const text = i.kind === 'approval' ? `${i.tool}: ${i.action}\n范围: ${i.scope}` : i.kind === 'question' ? i.prompt : i.questions.map(q => `${q.id}: ${q.prompt}`).join('\n');
  const base = { action: 'answer', interactionId: i.interactionId, revision: i.revision, connectionGeneration: i.connectionGeneration };
  let actions: ChannelCard['actions'] = [];
  if (!readOnly && i.status === 'awaiting_answer') {
    if (i.kind === 'approval') actions = ['allow', 'deny'].map(decision => ({ label: decision === 'allow' ? '允许' : '拒绝', value: { ...base, answer: { kind: 'approval', decision, scope: i.scope }, toolInputDigest: i.toolInputDigest } }));
    else if (i.kind === 'question' && !i.multiple) actions = i.choices.map(choice => ({ label: choice, value: { ...base, answer: { kind: 'question', values: [choice] }, toolInputDigest: null } }));
  }
  return { title: i.kind === 'approval' ? '审批' : '问题', text: `${text}\n状态: ${i.status}${readOnly ? '\n此话题为只读，不能在此答复。外部终端启动的 Claude 若仅同步等待状态，需回原终端处理。' : i.kind !== 'approval' && i.status === 'awaiting_answer' ? '\n可通过答复入口提交文字或多选。' : ''}`, actions };
}
export function operationCard(op: Operation): ChannelCard {
  return { title: '操作回执', text: `${op.action}: ${op.status}${op.error ? ` · ${op.error.code}` : ''}`, actions: op.status === 'unknown' ? [{ label: '核对结果', value: { action: 'reconcile', operationId: op.operationId } }] : [] };
}
