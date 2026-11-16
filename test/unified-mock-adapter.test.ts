import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createMockAdapter, normalizeMockEvent } from '../src/unified/mock-adapter.js';
import { mapMockProviderError } from '../src/unified/errors.js';
import type { UnifiedService } from '../src/unified/adapter.js';
import type { WriteContext } from '../src/unified/contracts.js';

const context: WriteContext = { operationId: 'op', idempotencyKey: 'key', targetId: 's', expectedRevision: 1, controlGeneration: 1, identity: { subject: 'u', source: 'test' } };
async function consume(adapter: UnifiedService) {
  const sessions = await adapter.listSessions({ limit: 5 });
  const snapshot = await adapter.getSnapshot(sessions.items[0]!.sessionId);
  const subscription = await adapter.subscribeEvents('s', snapshot.cursor, 10);
  const operation = await adapter.submitInput({ context, mode: 'new', blocks: [{ type: 'text', text: 'hello' }] });
  return { title: snapshot.value.session.title, messages: snapshot.value.messages, interactions: snapshot.value.interactions, subscription, status: operation.status };
}
test('same consumer runs against both synthetic providers and normalizes both wire formats', async () => {
  assert.deepEqual(await consume(createMockAdapter('claude')), await consume(createMockAdapter('codex')));
  assert.deepEqual(normalizeMockEvent({ provider: 'claude', uuid: 'e', text: 'hi', extra: 1 }), normalizeMockEvent({ provider: 'codex', id: 'e', content: 'hi', extra: { ignored: true } }));
  for (const provider of ['claude', 'codex'] as const) {
    const a = createMockAdapter(provider);
    await assert.rejects(a.updateSessionSettings({ context, payload: { model: null, preferences: {} } }), (e: any) => e.code === 'unsupported');
    assert.equal((await a.subscribeEvents('s', 'bad', 1)).status, 'snapshot_required');
  }
});
test('attachment transmits bytes with verified length and digest and idempotency', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const a = createMockAdapter(provider); const content = new TextEncoder().encode('attachment');
    const payload = { name: 'a.txt', mediaType: 'text/plain', size: content.length, contentDigest: createHash('sha256').update(content).digest('hex'), content };
    const staged = await a.stageInputArtifact({ context, payload });
    assert.equal(staged.status, 'completed');
    assert.deepEqual(await a.readArtifact('s', staged.operationId, 'mock'), content);
    await assert.rejects(a.stageInputArtifact({ context, payload: { ...payload, content: new Uint8Array([1]) } }), (e: any) => e.code === 'invalid_request');
    await assert.rejects(a.stageInputArtifact({ context, payload: { ...payload, name: 'different' } }), (e: any) => e.code === 'idempotency_conflict');
  }
});
test('synthetic native failures map to stable codes with conservative unknown fallback', () => {
  for (const [claude, codex, expected] of [['overloaded','turn_busy','busy'], ['permission_denied','forbidden','unauthorized'], ['disconnected','offline','temporarily_unavailable'], ['unsupported','not_implemented','unsupported'], ['result_lost','receipt_lost','outcome_unknown']] as const) {
    assert.deepEqual(mapMockProviderError('claude', claude), mapMockProviderError('codex', codex));
    assert.equal(mapMockProviderError('claude', claude).code, expected);
  }
  assert.equal(mapMockProviderError('codex', 'new-code').code, 'outcome_unknown');
});

test('both synthetic providers exercise R01–R10 service paths', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const a = createMockAdapter(provider); let n = 0;
    const ctx = () => ({ ...context, operationId: `op${++n}`, idempotencyKey: `key${n}` });
    assert.equal((await a.listSessions({ limit: 5 })).items.length, 1);
    assert.equal((await a.attachSession({ context: ctx(), payload: { provider, hostId:'h', serviceId:'v', nativeSessionId:'n', mode:'interactive' } })).status, 'completed');
    assert.equal((await a.createSession({ context: ctx(), payload: { provider, project:'p', model:null } })).status, 'completed');
    assert.equal((await a.submitInput({ context: ctx(), mode:'queue', blocks:[{type:'text',text:'hi'}] })).status, 'completed');
    assert.equal((await a.readHistory('s',{limit:5})).items.length, 0);
    const i = await a.getInteraction('i'); assert.equal((await a.listInteractions('s',{limit:5})).items.length,1);
    assert.equal((await a.resolveInteraction({context:ctx(),interactionId:i.interactionId,expectedConnectionGeneration:1,answer:{kind:'question',values:['yes']},toolInputDigest:null})).status,'completed');
    assert.equal((await a.requestControl({context:ctx(),payload:{owner:'u',strategy:'wait'}})).status,'completed');
    assert.equal((await a.interruptTurn({context:ctx(),payload:{turnId:'t'}})).status,'completed');
    assert.equal((await a.getSnapshot('s')).value.session.sessionId,'s');
  }
});
