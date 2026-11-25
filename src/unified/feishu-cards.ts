import type { QuestionForm } from './feishu-question-forms.js';
import type { Interaction, Operation, Provider, Session } from './contracts.js';
import { formatApprovalAction, formatResumeCommand, sessionStatusLabel, sessionStatusTemplate, shortenHomePath } from './card-formatters.js';
import { escapeCardMarkdown } from './feishu-card-wire.js';

export function providerDisplayLabel(provider: Provider): string {
  return providerTitlePrefix(provider);
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
export interface ChannelCard {
  schema?: '1.0' | '2.0';
  template?: 'blue' | 'green' | 'orange' | 'red' | 'grey';
  format?: 'markdown' | 'plain';
  executionLog?: { count: number; lines: readonly string[]; failedCount?: number; runningNote?: string };
  form?: QuestionForm;
  title: string;
  text: string;
  table?: ChannelCardTable;
  actions: Array<{ label: string; value: Record<string, unknown>; url?: string; type?: 'primary' | 'default' }>;
}
export function sessionCard(session: Session, accessMode: 'unbound' | 'read_only' | 'interactive' = 'unbound',
  statusLabel = sessionStatusLabel(session.status)): ChannelCard {
  const connected = session.control.input === 'available' && session.status !== 'read_only' && session.status !== 'unreachable';
  const controls: ChannelCard['actions'] = accessMode === 'unbound'
    ? [{label:'接入并续聊',value:{action:'bind',sessionId:session.sessionId,mode:'interactive'}}]
    : accessMode === 'read_only' ? [{label:'接入并续聊',value:{action:'upgrade'}}]
    : connected ? [] : [{label:'重新接入',value:{action:'upgrade'}}];
  const access = accessMode === 'interactive'
    ? connected ? '\n✅ 已接入，现在可直接发送消息续聊' : '\n⚠️ 连接暂不可用，可尝试重新接入。'
    : accessMode === 'read_only' ? '\n只读接入，可直接查看历史与文件。' : '';
  const template = accessMode === 'interactive' ? connected ? 'green' : 'orange'
    : accessMode === 'read_only' ? 'grey' : sessionStatusTemplate(session.status);
  const command = accessMode === 'unbound' ? null : formatResumeCommand(session.native);
  return { title:session.title, ...(template ? { template } : {}), text:`${providerDisplayLabel(session.native.provider)} · ${escapeCardMarkdown(shortenHomePath(session.project))} · ${statusLabel}${access}${command ? `\n电脑端接回：\`${command}\`` : ''}`, actions:[
    { label:'查看历史', value:{action:'history'} },
    ...(accessMode === 'interactive' && connected ? [{ label:'切换模型', value:{action:'models'} }] : []),
    ...controls,
    { label:'查看文件', value:{action:'artifacts',sessionId:session.sessionId} },
    { label:'会话控制', value:{action:'panel',sessionId:session.sessionId} },
  ] };
}

export function interactionStatusText(interaction: Interaction, operation?: Operation | null): string | null {
  if (operation?.status === 'completed') return '原端已确认答复';
  if (operation?.status === 'unknown') return '答复结果未知，请查看原会话';
  if (interaction.nativeResult?.status === 'rejected') return '原端未接受答复，请查看原会话';
  if (operation?.status === 'failed' || interaction.status === 'expired') {
    if (operation?.status === 'accepted') return '原请求已结束，答复结果未确认';
    return '原请求已过期或失效';
  }
  if (interaction.status === 'answer_pending_delivery' || (interaction.status === 'awaiting_answer' && operation && ['received','queued','accepted'].includes(operation.status))) return '答复已提交，等待原端确认';
  if (interaction.status === 'resolved') {
    if (operation?.status === 'accepted') return '原请求已结束，答复结果未确认';
    if (interaction.nativeResult?.status === 'unknown') return '答复结果未知，请查看原会话';
    return interaction.nativeResult?.status === 'accepted' && interaction.nativeResult.answer ? '原端已确认答复' : '已在原终端完成处理';
  }
  if (interaction.status === 'cancelled') return operation?.status === 'accepted'
    ? '原请求已结束，答复结果未确认' : '原请求已取消';
  return null;
}

export function interactionCard(
  i: Interaction & { allowAlways?: boolean; allowedScopes?: readonly string[] },
  readOnly = false,
  operation?: Operation | null,
): ChannelCard {
  const base = { action: 'answer', interactionId: i.interactionId, revision: i.revision, connectionGeneration: i.connectionGeneration };
  const status = interactionStatusText(i,operation);
  const awaiting = !status && i.status === 'awaiting_answer';
  const readonlyNote = '此话题为只读。请在原终端答复。';
  let actions: ChannelCard['actions'] = [];
  if (!readOnly && awaiting) {
    if (i.kind === 'approval') {
      const decisions = i.allowedDecisions ?? ['allow', 'deny'];
      actions = [];
      for (const decision of decisions) {
        if (decision === 'allow') {
          actions.push({
            label: i.scope === 'allow_always' ? '本会话允许' : '允许本次',
            type: 'primary',
            value: { ...base, answer: { kind: 'approval', decision: 'allow', scope: i.scope }, toolInputDigest: i.toolInputDigest },
          });
          const wantsSessionButton = i.scope !== 'allow_always' && (
            i.allowAlways === true ||
            i.allowedScopes?.includes('session') === true ||
            i.allowedScopes?.includes('allow_always') === true
          );
          if (wantsSessionButton) {
            const sessionScope = i.allowedScopes?.includes('allow_always') ? 'allow_always' : 'session';
            actions.push({
              label: '本会话允许',
              type: 'default',
              value: { ...base, answer: { kind: 'approval', decision: 'allow', scope: sessionScope }, toolInputDigest: i.toolInputDigest },
            });
          }
        } else {
          actions.push({
            label: '拒绝',
            type: 'default',
            value: { ...base, answer: { kind: 'approval', decision: 'deny', scope: i.scope }, toolInputDigest: i.toolInputDigest },
          });
        }
      }
    }
    else if (i.kind === 'question' && !i.multiple) actions = i.choices.map(choice => ({ label: choice, value: { ...base, answer: { kind: 'question', values: [choice] }, toolInputDigest: null } }));
  }
  if (i.kind === 'approval') {
    const view = formatApprovalAction(i.tool, i.action, i.scope);
    const answer = i.nativeResult?.status === 'accepted' ? i.nativeResult.answer : null;
    const denied = answer?.kind === 'approval' && answer.decision === 'deny';
    let title = `⚠️ 需人工确认 · ${view.toolLabel}`;
    let template: ChannelCard['template'] = readOnly ? 'grey' : 'orange';
    if (denied) { title = '审批 · 已拒绝'; template = 'grey'; }
    else if (operation?.status === 'failed' || i.nativeResult?.status === 'rejected') { title = '审批 · 提交失败'; template = 'red'; }
    else if (i.status === 'expired') { title = '审批 · 已过期'; template = 'grey'; }
    else if (i.status === 'cancelled') { title = '审批 · 已取消'; template = 'grey'; }
    else if (operation?.status === 'unknown' || i.nativeResult?.status === 'unknown' || (i.status === 'resolved' && operation?.status === 'accepted')) { title = '审批 · 结果未知'; template = 'grey'; }
    else if (operation?.status === 'completed' || (i.status === 'resolved' && answer)) { title = '审批 · 已确认'; template = 'green'; }
    else if (i.status === 'resolved') { title = '审批 · 已处理'; template = 'grey'; }
    else if (status) title = '审批 · 等待原端确认';
    const originalNote = awaiting && i.allowedDecisions?.length === 0 ? '请在原端处理此审批。' : '';
    return { title, template, format: 'markdown', text: [view.text, status, readOnly ? readonlyNote : originalNote].filter(Boolean).join('\n\n'), actions };
  }
  const resolved = i.status === 'resolved' || operation?.status === 'completed';
  const answer = i.nativeResult?.status === 'accepted' ? i.nativeResult.answer : null;
  const withAnswer = (prompt: string, values?: string[]) =>
    values?.length ? `${prompt}\n已答复：${values.join('、')}` : prompt;
  const text = i.kind === 'question'
    ? withAnswer(i.prompt, answer?.kind === 'question' ? answer.values : undefined)
    : i.questions.map(q => withAnswer(q.prompt, answer?.kind === 'question_group' ? answer.answers[q.id] : undefined)).join('\n');
  const note = resolved ? '' : readOnly ? readonlyNote : awaiting ? '可通过答复入口提交文字或多选。' : '';
  return {
    title: resolved ? '问题 · 已答复' : '问题',
    ...(resolved ? { template: 'green', format: 'plain' } : {}),
    text: [text, status, note].filter(Boolean).join('\n'),
    actions,
  };
}
export function operationCard(op: Operation): ChannelCard {
  const actions:Record<string,string>={submitInput:'发送输入',stageInputArtifact:'提交附件',interruptTurn:'中断当前回复',cancelQueuedInput:'取消排队输入',resolveInteraction:'提交答复',attachSession:'接入会话',createSession:'创建会话',requestControl:'切换控制',releaseControl:'释放控制',updateSessionSettings:'更新设置',archiveSession:'更新归档'};
  const statuses:Record<string,string>={received:'已接收，等待处理',queued:'已排队',accepted:'已提交，等待结果',completed:'已完成',failed:'失败',unknown:'结果未知，请先核对，不要重复提交'};
  const reasons:Record<string,string>={unsupported:'当前不支持此操作',busy:'目标已变化或正在处理，请刷新后查看',control_conflict:'控制状态已变化，请刷新',stale_revision:'会话状态已变化，请刷新',interaction_expired:'该问题或审批已失效',unauthorized:'没有操作权限',temporarily_unavailable:'暂时不可用',outcome_unknown:'结果未知，请先核对',invalid_request:'请求无效',idempotency_conflict:'操作与已有记录冲突',snapshot_required:'状态已过期，请刷新'};
  return { title:'操作回执',text:`${actions[op.action] ?? '操作'}：${statuses[op.status] ?? '状态未知'}${op.error ? `；${reasons[op.error.code] ?? '请查看当前会话状态'}` : ''}`,actions:op.status === 'unknown' ? [{label:'核对结果',value:{action:'reconcile',operationId:op.operationId}}] : [] };
}
