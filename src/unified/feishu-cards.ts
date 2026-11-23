import type { QuestionForm } from './feishu-question-forms.js';
import type { Interaction, Operation, Provider, Session } from './contracts.js';

export function providerDisplayLabel(provider: Provider): string {
  return provider === 'agy' ? 'Antigravity (agy)' : provider;
}

export function providerTitlePrefix(provider: Provider): string {
  return provider === 'codex' ? 'Codex' : provider === 'agy' ? 'Antigravity' : 'Claude';
}

export interface ChannelCardTable {
  columns: Array<{ header: string; weight?: number }>;
  rows: string[][];
  footer?: string;
}
/** Presentation-neutral cards; an injected transport converts these to Feishu SDK payloads. */
export interface ChannelCard { form?: QuestionForm; title: string; text: string; table?: ChannelCardTable; actions: Array<{ label: string; value: Record<string, unknown>; url?: string }> }
export function sessionCard(session: Session): ChannelCard {
  return { title: session.title, text: `${providerDisplayLabel(session.native.provider)} · ${session.project} · ${session.status}\n控制: ${session.control.input}`, actions: [
    { label: '查看历史', value: { action: 'history' } },
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
  const actions:Record<string,string>={submitInput:'发送输入',interruptTurn:'中断当前回复',cancelQueuedInput:'取消排队输入',resolveInteraction:'提交答复',attachSession:'接入会话',createSession:'创建会话',requestControl:'切换控制',releaseControl:'释放控制',updateSessionSettings:'更新设置',archiveSession:'更新归档'};
  const statuses:Record<string,string>={received:'已接收，等待处理',queued:'已排队',accepted:'已提交，等待结果',completed:'已完成',failed:'失败',unknown:'结果未知，请先核对，不要重复提交'};
  const reasons:Record<string,string>={unsupported:'当前不支持此操作',busy:'目标已变化或正在处理，请刷新后查看',control_conflict:'控制状态已变化，请刷新',stale_revision:'会话状态已变化，请刷新',interaction_expired:'该问题或审批已失效',unauthorized:'没有操作权限',temporarily_unavailable:'暂时不可用',outcome_unknown:'结果未知，请先核对',invalid_request:'请求无效',idempotency_conflict:'操作与已有记录冲突',snapshot_required:'状态已过期，请刷新'};
  return { title:'操作回执',text:`${actions[op.action] ?? '操作'}：${statuses[op.status] ?? '状态未知'}${op.error ? `；${reasons[op.error.code] ?? '请查看当前会话状态'}` : ''}`,actions:op.status === 'unknown' ? [{label:'核对结果',value:{action:'reconcile',operationId:op.operationId}}] : [] };
}
