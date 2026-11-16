import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canTransitionOperation, checkIdempotency, payloadDigest, validateResolution, validateSubmitInput, type Interaction, type ResolveInteraction, type WriteContext } from '../src/unified/contracts.js';
import { contractError } from '../src/unified/errors.js';
const context: WriteContext = { operationId: 'op', idempotencyKey: 'key', targetId: 'session', expectedRevision: 3, controlGeneration: 2, identity: { subject: 'user', source: 'authenticated-channel' } };
const approval: Interaction = { kind: 'approval', interactionId: 'i', sessionId: 'session', turnId: 't', nativeRequestId: 'native', connectionGeneration: 7, revision: 3, status: 'awaiting_answer', expiresAt: '2030-01-01T00:00:00Z', toolInputDigest: 'digest', nativeResult: null, tool: 'shell', action: 'run', scope: 'one request' };
const resolve: ResolveInteraction = { context, interactionId: 'i', expectedConnectionGeneration: 7, answer: { kind: 'approval', decision: 'deny', scope: 'one request' }, toolInputDigest: 'digest' };
const now = Date.parse('2029-01-01T00:00:00Z');
test('idempotency digest is order independent but detects changed payload and rejects lossy values', () => {
  const digest = payloadDigest({ b: [1, 2], a: 'x' });
  assert.equal(digest, payloadDigest({ a: 'x', b: [1, 2] }));
  assert.equal(checkIdempotency({ idempotencyKey: 'key', payloadDigest: digest }, 'key', digest), 'same');
  assert.equal(checkIdempotency({ idempotencyKey: 'key', payloadDigest: digest }, 'key', payloadDigest({ a: 'changed', b: [1, 2] })), 'conflict');
  assert.throws(() => payloadDigest({ x: undefined })); assert.throws(() => payloadDigest([, 1])); assert.throws(() => payloadDigest(NaN));
});
test('approval validates session, revision, connection, expiry, scope and exact tool input', () => {
  assert.equal(validateResolution(resolve, approval, now).ok, true);
  for (const invalid of [
    { ...resolve, context: { ...context, targetId: 'other' } },
    { ...resolve, context: { ...context, expectedRevision: 2 } },
    { ...resolve, expectedConnectionGeneration: 6 },
    { ...resolve, toolInputDigest: 'changed' },
    { ...resolve, answer: { kind: 'approval' as const, decision: 'allow' as const, scope: 'all future requests' } },
  ]) assert.equal(validateResolution(invalid, approval, now).ok, false);
  assert.equal(validateResolution(resolve, { ...approval, status: 'answer_pending_delivery' }, now).ok, false);
  assert.equal(validateResolution(resolve, approval, Date.parse('2030-01-01T00:00:00Z')).ok, false);
});
test('input and operation states reject malformed data and unsafe transitions', () => {
  assert.equal(validateSubmitInput({ context, mode: 'queue', blocks: [{ type: 'text', text: 'hello' }] }).ok, true);
  assert.equal(validateSubmitInput({ context, mode: 'new', blocks: [{ type: 'text', text: ' ' }] }).ok, false);
  assert.equal(validateSubmitInput({ context: { ...context, controlGeneration: -1 }, mode: 'new', blocks: [{ type: 'text', text: 'x' }] }).ok, false);
  assert.equal(canTransitionOperation('received', 'completed'), false);
  assert.equal(canTransitionOperation('unknown', 'completed'), true);
  assert.equal(canTransitionOperation('completed', 'accepted'), false);
  assert.equal(contractError('outcome_unknown').suggestedAction, 'reconcile_operation');
  assert.equal(contractError('outcome_unknown').retryable, false);
});
test('events require valid envelope and interactions cannot reopen after final result', async () => {
  const { validateEvent, canTransitionInteraction } = await import('../src/unified/contracts.js');
  const event = { schemaVersion: 1 as const, eventId: 'e', sessionId: 's', objectId: 'i', objectRevision: 1, sequence: 5, type: 'interaction.resolved', occurredAt: '2029-01-01T00:00:00Z', receivedAt: '2029-01-01T00:00:01Z', operationId: null, cursor: 'c5', data: {} };
  assert.equal(validateEvent(event).ok, true);
  assert.equal(validateEvent({ ...event, schemaVersion: 2 as 1 }).ok, false);
  assert.equal(validateEvent({ ...event, sequence: -1 }).ok, false);
  assert.equal(canTransitionInteraction('awaiting_answer', 'answer_pending_delivery'), true);
  assert.equal(canTransitionInteraction('answer_pending_delivery', 'resolved'), true);
  assert.equal(canTransitionInteraction('resolved', 'awaiting_answer'), false);
});
test('question with options can explicitly permit free text', () => {
  const question: Interaction = { ...approval, kind: 'question', prompt: 'choose or write', choices: ['a', 'b'], multiple: false, allowFreeText: true };
  const request: ResolveInteraction = { ...resolve, answer: { kind: 'question', values: ['custom'] } };
  assert.equal(validateResolution(request, question, now).ok, true);
  assert.equal(validateResolution(request, { ...question, allowFreeText: false }, now).ok, false);
});

test('event data must be present and digest rejects non-JSON object properties', async () => {
  const { validateEvent } = await import('../src/unified/contracts.js');
  const base = { schemaVersion: 1 as const, eventId: 'e', sessionId: 's', objectId: 'i', objectRevision: 1, sequence: 0, type: 'x', occurredAt: '2029-01-01T00:00:00Z', receivedAt: '2029-01-01T00:00:00Z', operationId: null, cursor: 'c' };
  assert.equal(validateEvent(base as Parameters<typeof validateEvent>[0]).ok, false);
  assert.equal(validateEvent({ ...base, data: null }).ok, true);
  assert.equal(validateResolution(resolve, null as unknown as Interaction, now).ok, false);
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  assert.throws(() => payloadDigest(hidden));
});

test('wire schemas accept optional extensions and reject invalid values and attachment encoding', async () => {
  const { validateWire, schemas } = await import('../src/unified/validation.js');
  const { createHash } = await import('node:crypto');
  assert.equal(validateWire('context', context).ok, true);
  assert.equal(validateWire('context', { ...context, surprise: true }).ok, true);
  assert.equal(validateWire('context', { ...context, toString: 'x' }).ok, false);
  assert.equal(validateWire('context', { ...context, constructor: 'x' }).ok, false);
  assert.equal(validateWire('context', { ...context, surprise: undefined }).ok, false);
  assert.equal(validateWire('context', { ...context, criticalFields: ['surprise'], surprise: true }).ok, false);
  assert.equal(validateWire('context', { ...context, expectedRevision: 'invalid', surprise: true }).ok, false);
  assert.equal(validateWire('toString', {}).ok, false);
  assert.equal(validateWire('missing', {}).ok, false);
  const e = { schemaVersion: 1, eventId: 'e', sessionId: 's', objectId: 'o', objectRevision: 1, sequence: 1, type: 'x', occurredAt: '2029-01-01T00:00:00Z', receivedAt: '2029-01-01T00:00:00Z', operationId: null, cursor: 'c', data: { x: [null, 3] } };
  assert.equal(validateWire('event', e).ok, true);
  assert.equal(validateWire('event', { ...e, data: { x: undefined } }).ok, false);
  const b = Buffer.from('abc'); const a = { name:'a', mediaType:'text/plain', size:3, contentDigest:createHash('sha256').update(b).digest('hex'), contentBase64:b.toString('base64') };
  assert.equal(validateWire('wireArtifact',a).ok,true);
  assert.equal(validateWire('wireArtifact',{...a,contentBase64:'YQ'}).ok,false);
  assert.equal(validateWire('wireArtifact',{...a,size:2}).ok,false);
  assert.equal(validateWire('wireArtifact',{...a,contentDigest:'0'.repeat(64)}).ok,false);
  for (const name of ['session','turn','message','artifact','operation','interaction','snapshot','request.createSession','response.getSnapshot']) assert.equal(validateWire(name,{}).ok,false,name);
  assert.ok(Object.keys(schemas).filter(x => x.startsWith('request.')).length >= 26);
});

test('native observations retain ref and allow unknown turn input association', async () => {
  const { validateWire } = await import('../src/unified/validation.js');
  const ref = {provider:'codex',hostId:'h',serviceId:'v',nativeSessionId:'n'};
  const turn = {turnId:'t',sessionId:'n',status:'running',inputId:null,startedAt:null,endedAt:null,model:null,outputIds:[]};
  assert.equal(validateWire('turn',turn).ok,true);
  assert.equal(validateWire('observation',{type:'turn',ref,turn}).ok,true);
  assert.equal(validateWire('observation',{type:'turn',turn}).ok,false);
  assert.equal(validateWire('observation',{type:'turn',ref:{...ref,nativeSessionId:''},turn}).ok,false);
});

test('session observation rejects conflicting native references', async () => {
  const { validateWire } = await import('../src/unified/validation.js');
  const ref = {provider:'codex',hostId:'h',serviceId:'svc',nativeSessionId:'n1'};
  const capabilities = Object.fromEntries(['view','send','queue','steer','answer','approve','interrupt','handoff','files','config'].map(k => [k,{status:'available'}]));
  const session = {sessionId:'n1',native:ref,project:'p',title:'t',status:'idle',revision:0,capabilities,control:{serviceId:'svc',owner:null,input:'unknown',generation:0,operationId:null,reason:null}};
  assert.equal(validateWire('observation',{type:'session',ref,session,extra:'future'}).ok,true);
  assert.equal(validateWire('observation',{type:'session',ref,session:{...session,native:{...ref,nativeSessionId:'n2'}}}).ok,false);
  assert.equal(validateWire('observation',{type:'session',ref,session:{...session,native:{...ref,hostId:'other'}}}).ok,false);
});
