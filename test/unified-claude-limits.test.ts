import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/unified/claude-adapter.js';

const tick = () => new Promise(r => setImmediate(r));
test('rate limit and retries are safe observations, not extra queries or turn outcomes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-limit-')); const observations: any[] = [], queue: any[] = [];
  let wake: (() => void) | undefined, closed = false, calls = 0, input: any;
  const q: any = { async *[Symbol.asyncIterator]() { while (!closed || queue.length) { if (queue.length) yield queue.shift(); else await new Promise<void>(r => { wake = r; }); } }, close() { closed = true; wake?.(); } };
  const sdk: any = { query(args: any) { calls++; input = args.prompt; return q; }, listSessions: async () => [], getSessionMessages: async () => [] };
  const adapter = new ClaudeAdapter('host', 'service', dir, sdk); adapter.onObservation(o => observations.push(o));
  const push = async (v: any) => { queue.push(v); wake?.(); await tick(); };
  try {
    const id = (await adapter.create('/tmp', null)).nativeReference!;
    const ref = { provider: 'claude' as const, hostId: 'host', serviceId: 'service', nativeSessionId: id };
    await adapter.input(ref, 'new', [{type:'text',text:'test'}], { expectedConnectionGeneration: null, expectedControlGeneration: 1, assertCurrent() {} });
    assert.equal((await input[Symbol.asyncIterator]().next()).value.message.content, 'test');
    await push({type:'system', subtype:'api_retry', attempt:1, max_retries:4, retry_delay_ms:100, error_status:429, error:'rate_limit', private:'private secret'});
    await push({type:'system', subtype:'api_retry', attempt:2, max_retries:4, retry_delay_ms:200, error_status:null, error:'unknown', detail:'private secret'});
    await push({type:'rate_limit_event', rate_limit_info:{status:'allowed_warning', rateLimitType:'five_hour', resetsAt:123, private:'private secret'}});
    await push({type:'rate_limit_event', rate_limit_info:{status:'rejected', errorCode:'credits_required', rateLimitType:'seven_day', resetsAt:456}});
    await push({type:'rate_limit_event', rate_limit_info:{status:'allowed'}});
    const ev = observations.filter(o => o.type === 'event').map(o => o.event);
    assert.deepEqual(ev.map(e => e.type), ['provider.api_retry','provider.api_retry','provider.usage_limit','provider.usage_limit','provider.usage_available']);
    assert.deepEqual(ev[0].data, {attempt:1,maxRetries:4,retryDelayMs:100,httpStatus:429,errorType:'rate_limit'});
    assert.equal(ev[1].data.httpStatus, null); assert.equal(ev[2].data.status, 'allowed_warning');
    assert.equal(ev[3].data.errorCode, 'credits_required'); assert.equal(ev[4].data.status, 'allowed');
    assert.equal(JSON.stringify(ev).includes('private secret'), false);
    assert.deepEqual(observations.filter(o => o.type === 'turn').map(o => o.turn.status), ['running']);
    assert.equal(calls,1);
    await push({type:'result',subtype:'success',is_error:false});
    assert.deepEqual(observations.filter(o => o.type === 'turn').map(o => o.turn.status), ['running','completed']);
    assert.equal(calls,1);
  } finally { await adapter.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('unknown fields and SDK stream closure remain safely classified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-limit-')); const observations: any[] = []; let send!: (x: any) => void, finish!: () => void, calls = 0;
  const sdk: any = { query() { calls++; return { async *[Symbol.asyncIterator]() { yield await new Promise(r => {send = r;}); await new Promise<void>(r => {finish = r;}); }, close() {finish?.();} }; }, listSessions: async () => [], getSessionMessages: async () => [] };
  const adapter = new ClaudeAdapter('h','s',dir,sdk); adapter.onObservation(o => observations.push(o));
  try {
    const id=(await adapter.create('/tmp',null)).nativeReference!; const ref={provider:'claude' as const,hostId:'h',serviceId:'s',nativeSessionId:id};
    await adapter.input(ref,'new',[{type:'text',text:'test'}],{expectedConnectionGeneration:null,expectedControlGeneration:1,assertCurrent(){}});
    send({type:'system',subtype:'api_retry',attempt:1,max_retries:1,retry_delay_ms:1,error_status:null,error:'private secret'}); await tick();
    const e=observations.find(o => o.type==='event').event; assert.equal(e.data.errorType,'unknown'); assert.equal(JSON.stringify(e).includes('private secret'),false);
    finish(); await tick(); assert.equal(observations.filter(o => o.type==='turn').at(-1).turn.status,'failed'); assert.equal(calls,1);
  } finally { await adapter.close(); rmSync(dir,{recursive:true,force:true}); }
});
