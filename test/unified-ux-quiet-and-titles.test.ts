import {displayTopicTitle} from '../src/unified/topic-title-sync.js';
import {deriveTitleFromInputBlocks, isGenericSessionTitle, normalizeTopicTitle} from '../src/unified/session-title.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedService } from '../src/unified/adapter.js';
import { shortenHomePath } from '../src/unified/card-formatters.js';
import type { Operation, Session, WriteContext } from '../src/unified/contracts.js';
import { contractError } from '../src/unified/errors.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { FeishuChannel, type FeishuPort } from '../src/unified/feishu-channel.js';
import { TaskTopicChannel } from '../src/unified/task-topic-channel.js';

const identity = { source: 'verified', subject: 'owner' };
const env = (eventId: string, destination = 'topic') => ({ eventId, destination, identity });
const session = {
  sessionId: 's', native: { provider: 'codex', hostId: 'h', serviceId: 'svc', nativeSessionId: 'n' },
  project: '/project', title: '会话名', status: 'idle', revision: 1,
  capabilities: Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(key => [key, {status:'available'}])),
  control: { serviceId: 'svc', owner: 'owner', input: 'available', generation: 1, operationId: null, reason: null },
} as Session;
const revisions = { revision: session.revision, controlGeneration: session.control.generation };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'unified-ux-'));
  const path = join(dir, 'channel.sqlite');
  const sent: ChannelCard[] = [];
  const updates: { id: string; card: ChannelCard }[] = [];
  const operations = new Map<string, Operation>();
  const port: FeishuPort = {
    async send(_d, card, _id, guard) {
      await guard?.();
      sent.push(card);
      return `msg-${sent.length}`;
    },
    async update(_d, id, card, _delivery, guard) {
      await guard?.();
      updates.push({ id, card });
    },
    async sendFile() {},
  };
  const receipt = (action: string, status: Operation['status'], context: WriteContext, result?: Operation['result']): Operation => {
    const op: Operation = {
      operationId: context.operationId, idempotencyKey: context.idempotencyKey, action,
      targetId: context.targetId, status, revision: 1, payloadDigest: '',
      error: status === 'failed' ? contractError('busy') : null,
      ...(result ? { result } : {}),
    };
    operations.set(op.operationId, op);
    return op;
  };
  const mockService: Partial<UnifiedService> = {
    async getSession() { return session; },
    async getOperation(id) { return operations.get(id)!; },
    async reconcile(id) { return operations.get(id)!; },
    async attachSession({ context }) { return receipt('attachSession', 'completed', context, { kind: 'session', sessionId: session.sessionId }); },
    async createSession({ context }) { return receipt('createSession', 'received', context); },
    async updateSessionSettings({ context }) { return receipt('updateSessionSettings', 'received', context); },
    async cancelQueuedInput({ context }) { return receipt('cancelQueuedInput', 'completed', context); },
    async interruptTurn({ context }) { return receipt('interruptTurn', 'received', context); },
    async stopOrCancelQueued(context) { return receipt('interruptTurn', 'received', context); },
    async getWorkState() {
      return { runningTurns: [{turnId:'t',sessionId:session.sessionId,status:'running',inputId:null,startedAt:null,endedAt:null,model:null,outputIds:[]}], queuedInputs: [], canArchive: false };
    },
    async submitInput({ context, mode }) { return receipt('submitInput', mode === 'queue' ? 'queued' : 'received', context); },
    async stageInputArtifact({ context }) { return receipt('stageInputArtifact', 'completed', context, { kind: 'artifact', artifactId: 'f', contentVersion: 'v' }); },
  };
  const service = mockService as UnifiedService;
  const authorize = async (candidate: { subject: string }) => candidate.subject === identity.subject;
  const channel = new FeishuChannel(service, port, authorize, path);
  const bindInteractive = async () => {
    await channel.handle(env('bind'), { action: 'bind', sessionId: session.sessionId, mode: 'interactive' });
    await channel.advanceCompleted();
    sent.length = 0;
  };
  return { channel, authorize, port, path, service, sent, updates, operations, bindInteractive,
    close() { channel.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('interactive bind, attach and upgrade only send the finished session panel', async () => {
  const x = setup();
  const { channel, sent } = x;
  try {
    await channel.handle(env('interactive-bind'), { action: 'bind', sessionId: session.sessionId, mode: 'interactive' });
    await channel.handle(env('attach','other-topic'), { action: 'attach', ...session.native, mode: 'interactive' });
    assert.equal(sent.length, 0);
    await channel.advanceCompleted();
    assert.deepEqual(sent.map(card => card.title), [session.title, session.title]);

    await channel.handle(env('open','read-only-topic'), { action: 'bind', sessionId: session.sessionId });
    sent.length = 0;
    await channel.handle(env('upgrade','read-only-topic'), { action: 'upgrade' });
    assert.equal(sent.length, 0);
    await channel.advanceCompleted();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.template, 'green');
    assert.equal(sent[0]!.text, '🤖 **Codex** · 📂 `/project` · 空闲\n✅ 已接入，现在可直接发送消息续聊\n电脑端接回：`codex resume n`');
    assert.deepEqual(sent[0]!.actions.map(action => action.label), ['查看历史', '切换模型', '查看文件', '会话控制']);
  } finally { x.close(); }
});

for (const lookup of [undefined, 'not_sent'] as const) test(`a committed upgrade recovers its original-card PATCH after a failed delivery (${lookup ?? 'no lookup'})`, async () => {
  const x = setup();
  try {
    await x.channel.handle(env('open'),{action:'bind',sessionId:session.sessionId,mode:'read_only'});
    const [before] = x.channel.bindingsForRestore();
    const sentCount = x.sent.length;
    const update = x.port.update;
    x.port.update = async () => { throw new Error('Feishu temporarily unavailable'); };
    const op = await x.channel.handle(
      {...env('upgrade-card'),cardMessageId:'source-panel'},
      {action:'upgrade',bindingId:before!.bindingId},
    ) as Operation;
    await assert.rejects(x.channel.advanceOperation(op.operationId),/temporarily unavailable/);
    const [committed] = x.channel.bindingsForRestore();
    assert.equal(committed?.accessMode,'interactive');
    assert.equal(committed?.revision,before!.revision+1);

    const deliveryId = `${op.operationId}:topic-reply`;
    assert.deepEqual(x.channel.pendingDeliveries().map(row => ({ ...row })), [{ deliveryId, state: 'unknown' }]);
    const lookedUp: string[] = [];
    if (lookup) x.port.lookupDelivery = async id => {
      lookedUp.push(id);
      return lookup;
    };
    x.port.update = update;
    const recovered = new FeishuChannel(x.service,x.port,x.authorize,x.path);
    try {
      await recovered.advanceCompleted();
      await recovered.advanceCompleted();
      assert.equal(x.sent.length,sentCount);
      assert.equal(x.updates.length,1);
      assert.deepEqual(lookedUp, lookup ? [deliveryId] : []);
      assert.deepEqual(recovered.pendingDeliveries(), []);
      assert.equal(x.updates[0]!.id,'source-panel');
      assert.match(x.updates[0]!.card.text,/✅ 已接入，现在可直接发送消息续聊/);
      assert.deepEqual(x.updates[0]!.card.actions.map(action=>action.value.action),['history','models','artifacts','panel']);
      assert.ok(x.updates[0]!.card.actions.every(action=>action.value.bindingId===committed?.bindingId));
      assert.deepEqual(recovered.bindingsForRestore(),[committed]);
    } finally { recovered.close(); }
  } finally { x.close(); }
});

test('binding recovery trusts a confirmed PATCH and does not retry an uncertain send', async () => {
  const x = setup();
  try {
    await x.channel.handle(env('open'), { action: 'bind', sessionId: session.sessionId });
    const [before] = x.channel.bindingsForRestore();
    const update = x.port.update;
    x.port.update = async (...args) => {
      await update(...args);
      throw new Error('PATCH receipt lost');
    };
    const patch = await x.channel.handle(
      { ...env('upgrade-card'), cardMessageId: 'source-panel' },
      { action: 'upgrade', bindingId: before!.bindingId },
    ) as Operation;
    await assert.rejects(x.channel.advanceOperation(patch.operationId), /PATCH receipt lost/);

    let sendAttempts = 0;
    x.port.send = async () => {
      sendAttempts++;
      throw new Error('send receipt lost');
    };
    const send = await x.channel.handle(env('attach', 'another-topic'), {
      action: 'attach', ...session.native, mode: 'interactive',
    }) as Operation;
    await assert.rejects(x.channel.advanceOperation(send.operationId), /send receipt lost/);

    x.port.lookupDelivery = async id => id === `${patch.operationId}:topic-reply` ? 'sent' : 'unknown';
    await x.channel.advanceCompleted();
    await x.channel.advanceCompleted();
    assert.equal(x.updates.length, 1);
    assert.equal(sendAttempts, 1);
    assert.deepEqual(x.channel.pendingDeliveries().map(row => ({ ...row })), [
      { deliveryId: `${send.operationId}:topic-reply`, state: 'unknown' },
    ]);
  } finally { x.close(); }
});

test('settings, cancel, stop and normal attachments are quiet; queued attachments retain the queue link', async () => {
  const x = setup();
  const { channel, sent } = x;
  try {
    await x.bindInteractive();
    await channel.handle(env('settings'), { action: 'settings', model: 'model', preferences: {}, ...revisions });
    await channel.handle(env('legacy-model'), { action: 'legacy_model', model: 'model', effort: 'medium' });
    await channel.handle(env('cancel'), { action: 'cancel', inputId: 'i', ...revisions });
    await channel.handle(env('stop'), { action: 'stop', turnId: 't', ...revisions });
    await channel.handle(env('legacy-stop'), { action: 'legacy_stop' });
    const attachment = { action: 'attachment', name: 'note.txt', mediaType: 'text/plain', content: new Uint8Array([97]) } as const;
    await channel.handle(env('attachment'), { ...attachment, mode: 'new' });
    await channel.advanceCompleted();
    assert.equal(sent.length, 0);
    await channel.handle(env('queue-attachment'), { ...attachment, mode: 'queue' });
    assert.equal(sent.length, 0);
    await channel.advanceCompleted();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /发送输入：已排队/);
    assert.deepEqual(sent[0]!.actions[0]?.label, '查看排队');
  } finally { x.close(); }
});

test('text create is quiet, the /new card updates in place, and delayed unknown create remains visible and actionable', async () => {
  const x = setup();
  const { channel, sent, updates, operations } = x;
  try {
    const create = { action: 'create', provider: 'codex', project: session.project, model: null } as const;
    const op = await channel.handle(env('create','main'), create) as Operation;
    assert.equal(sent.length, 0);
    await channel.handle({ ...env('new','main'), cardMessageId: 'new-menu' }, create);
    assert.equal(sent.length, 0);
    assert.deepEqual(updates.map(({id,card}) => [id,card.title,card.actions[0]?.value.action]), [['new-menu','正在创建会话','finish']]);

    operations.set(op.operationId, { ...op, status: 'unknown', revision: 2 });
    await channel.advanceCompleted();
    await channel.advanceCompleted();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /创建会话：结果未知/);
    assert.equal(sent[0]!.actions[0]?.value.action, 'reconcile');
    await assert.rejects(channel.handle(env('wrong-destination','unrelated'), { action:'reconcile', operationId:op.operationId }), /destination is not bound/);
    await channel.handle(env('reconcile','main'), { action:'reconcile', operationId:op.operationId });
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.text, /创建会话：结果未知/);
  } finally { x.close(); }
});

test('an unknown upgrade can be checked from its original read-only binding', async () => {
  const x = setup();
  try {
    await x.channel.handle(env('open'), { action:'bind', sessionId:session.sessionId });
    x.sent.length = 0;
    const attach = x.service.attachSession;
    x.service.attachSession = async request => {
      const op = { ...await attach(request), status:'unknown' as const, error:contractError('outcome_unknown') };
      x.operations.set(op.operationId,op);
      return op;
    };
    const op = await x.channel.handle(env('upgrade'), { action:'upgrade' }) as Operation;
    await x.channel.advanceCompleted();
    assert.equal(x.sent.length,1);
    assert.equal(x.sent[0]!.actions[0]?.value.action,'reconcile');
    assert.equal(x.channel.bindingsForRestore().find(binding => binding.destination==='topic')?.accessMode,'read_only');
    const checked = await x.channel.handle(env('check-upgrade'), { action:'reconcile', operationId:op.operationId }) as Operation;
    assert.equal(checked.status,'unknown');
    assert.equal(x.sent.length,2);
  } finally { x.close(); }
});

test('a failed stage still sends a named receipt', async () => {
  const x = setup();
  try {
    await x.bindInteractive();
    const stage = x.service.stageInputArtifact;
    x.service.stageInputArtifact = async request => ({ ...await stage(request), status: 'failed', error: contractError('busy') });
    await x.channel.handle(env('attachment-failed'), { action:'attachment', name:'note.txt', mediaType:'text/plain', content:new Uint8Array([97]), mode:'new' });
    assert.equal(x.sent.length, 1);
    assert.match(x.sent[0]!.text, /提交附件：失败/);
  } finally { x.close(); }
});

test('task input rejected by the service renders the user-facing operation name', async () => {
  const x = setup();
  const task = new TaskTopicChannel(x.service, x.port, x.authorize, x.path);
  try {
    task.registerTask({ taskId:'task', destination:'topic:task', rootGeneration:1, owner:identity });
    await task.mountTarget({ taskId:'task', targetId:'target', sessionId:session.sessionId, native:session.native, accessMode:'interactive', owner:identity, makeActive:true });
    x.service.submitInput = async () => { throw { detail: contractError('busy') }; };
    const result = await task.handle(env('task-input','topic:task'), { action:'input', text:'test', mode:'new' });
    assert.deepEqual(result, { status:'rejected', reason:'busy' });
    assert.equal(x.sent.length, 1);
    assert.match(x.sent[0]!.text, /发送输入：失败/);
  } finally {
    task.close();
    x.close();
  }
});

test('titles use the first nonempty text line, with an attachment name fallback and Unicode limits', () => {
  const file = {type: 'artifact' as const, artifactId: 'a', contentVersion: '1', name: '  进度   表.txt ', mediaType: 'text/plain', content: new Uint8Array()};
  assert.equal(deriveTitleFromInputBlocks([file]), '进度 表.txt');
  assert.equal(deriveTitleFromInputBlocks([file, {type: 'text', text: '\n本周  进展\r\n下一段'}]), '本周 进展');
  assert.equal(deriveTitleFromInputBlocks([{type: 'text', text: '🧪'.repeat(49)}]), '🧪'.repeat(47) + '…');
  assert.equal(normalizeTopicTitle('🧪'.repeat(61)), '🧪'.repeat(59) + '…');
  assert.equal(displayTopicTitle({ ...session, title: '[Codex · project] 已加前缀' }), '🟢 已加前缀');
  assert.equal(displayTopicTitle({ ...session, status: 'running', title: '🧪'.repeat(61) }), '🔵 ' + '🧪'.repeat(57) + '…');
  assert.equal(displayTopicTitle({ ...session, status: 'waiting_approval', title: '🔵 [AGY · zhangzy] 论文审稿' }), '🟡 论文审稿');
  assert.equal(displayTopicTitle({ ...session, native: { ...session.native, provider: 'agy' }, project: '' }), '🟢 会话名');
  assert.equal(shortenHomePath(homedir()), '~');
  assert.equal(shortenHomePath(`${homedir()}/work`), '~/work');
  assert.equal(shortenHomePath(`${homedir()}-other/work`), `${homedir()}-other/work`);
  assert.equal(normalizeTopicTitle('  '), '未命名会话');
  assert.equal(isGenericSessionTitle('Claude 会话 · ffffffff'), true);
  assert.equal(isGenericSessionTitle('调试 Claude 会话 · ffffffff'), false);
});
