import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ToolGovernor, governedTool } from '../src/execution/tool-governor.ts';
import { effectivePolicy } from '../src/execution/tool-policy.ts';
import { classifyToolError, ToolExecutionError } from '../src/execution/tool-errors.ts';
import { HarnessError } from '../src/util.ts';

function setup(maxAttempts = 3) {
  const events: Array<{kind:string; payload:Record<string, unknown>}> = [];
  const calls: number[] = [];
  const policy = effectivePolicy({ version: 'test', settleGraceMs: 20, tools: {
    read: { timeoutMs: 1000, retry: { maxAttempts, initialDelayMs: 5, maxDelayMs: 7 } },
    wait: { timeoutMs: 20, retry: { maxAttempts, initialDelayMs: 5, maxDelayMs: 7 } }
  } });
  const governor = new ToolGovernor(policy, { authorize: async (context) => { calls.push(context.attempt); },
    record: (kind,payload) => { events.push({kind,payload}); } });
  return { governor, events, calls, policy };
}
const transient = (): Error => Object.assign(new Error('Resource busy'), {code:'EBUSY'});

test('transient read errors use bounded exponential backoff and succeed without exposing intermediate failure', async () => {
  const f = setup(); let attempts = 0;
  const result = await f.governor.run('read','call',{},new AbortController().signal, async () => {
    if (++attempts < 3) throw transient(); return 'actual result';
  });
  assert.equal(result,'actual result'); assert.deepEqual(f.calls,[1,2,3]);
  assert.deepEqual(f.events.filter((e)=>e.kind==='tool.retry_scheduled').map((e)=>e.payload.delayMs),[5,7]);
});

test('retry exhaustion has a final structured error and exactly the configured attempt count', async () => {
  const f = setup(2); let count=0;
  await assert.rejects(f.governor.run('read','call',{},new AbortController().signal,async()=>{count++;throw transient();}),
    (error:unknown)=>error instanceof ToolExecutionError && error.failure.category==='transient');
  assert.equal(count,2); assert.equal(f.events.filter((e)=>e.kind==='tool.retry_scheduled').length,1);
});

test('missing file, permission and unknown failures are not retried', async () => {
  for (const code of ['ENOENT','EACCES','EPERM','EINVAL','UNKNOWN']) {
    const f=setup(); let count=0;
    await assert.rejects(f.governor.run('read','call',{},new AbortController().signal,async()=>{count++;throw Object.assign(new Error('failure'),{code});}));
    assert.equal(count,1); assert.equal(f.events.filter((e)=>e.kind==='tool.retry_scheduled').length,0);
  }
});

test('cooperative timeouts abort each attempt, leave no overlap and eventually stop retrying', async () => {
  const f=setup(2); let active=0; let maxActive=0;
  await assert.rejects(f.governor.run('wait','call',{},new AbortController().signal,async(signal)=>{
    active++; maxActive=Math.max(active,maxActive);
    try{await sleep(1000,undefined,{signal});return 'late';}finally{active--;}
  }), (error:unknown)=>error instanceof ToolExecutionError && error.failure.category==='timeout');
  assert.equal(maxActive,1); assert.equal(active,0); assert.deepEqual(f.calls,[1,2]);
});

test('an unsettled uncooperative timeout is unknown and never replayed', async () => {
  const f=setup(3); let count=0; let finished=false;
  await assert.rejects(f.governor.run('wait','call',{},new AbortController().signal,async()=>{count++;await sleep(120);finished=true;return 'late';}),
    (error:unknown)=>error instanceof ToolExecutionError && error.failure.category==='outcome_unknown' && !error.failure.retryable);
  assert.equal(count,1); await sleep(150); assert(finished); assert.equal(f.calls.length,1);
});

test('write errors and write timeouts do not automatically repeat side effects', async () => {
  const f=setup(); f.policy.tools.write.timeoutMs=15;
  let effects=0;
  await assert.rejects(f.governor.run('write','call',{},new AbortController().signal,async(signal)=>{effects++;await sleep(100,undefined,{signal});return 'late';}),
    (error:unknown)=>error instanceof ToolExecutionError && !error.failure.retryable && error.failure.outcome==='unknown');
  assert.equal(effects,1);
  const classified=classifyToolError(transient(),true); assert.equal(classified.retryable,false);
});

test('unsafe retry configuration is also rejected by the execution layer', async () => {
  const f=setup(); f.policy.tools.write.retry.maxAttempts=2; let effects=0;
  await assert.rejects(f.governor.run('write','call',{},new AbortController().signal,async()=>{effects++;}),
    (error:unknown)=>error instanceof HarnessError && error.code==='invalid_policy');
  assert.equal(effects,0);
});

test('cancellation during retry backoff prevents the next attempt', async () => {
  const f=setup(); const controller=new AbortController(); let count=0;
  f.policy.tools.read.retry.initialDelayMs=1000; f.policy.tools.read.retry.maxDelayMs=1000;
  const original=f.governor.hooks.record;
  f.governor.hooks.record=(kind,payload)=>{original(kind,payload);if(kind==='tool.retry_scheduled')setTimeout(()=>controller.abort(),10);};
  await assert.rejects(f.governor.run('read','call',{},controller.signal,async()=>{count++;throw transient();}));
  assert.equal(count,1); assert.deepEqual(f.calls,[1]);
});

test('every retry must obtain a fresh attempt budget authorization', async () => {
  const f=setup(); let executions=0;
  f.governor.hooks.authorize=async(context)=>{if(context.attempt>1)throw new HarnessError('tool_budget_exceeded','No more attempts');};
  await assert.rejects(f.governor.run('read','call',{},new AbortController().signal,async()=>{executions++;throw transient();}),
    (error:unknown)=>error instanceof HarnessError && error.code==='tool_budget_exceeded');
  assert.equal(executions,1);
});

test('public Pi read tool operations pass through the governor and recover from one transient filesystem error', async () => {
  const root=resolve('.artifacts','tool-governor-unit');mkdirSync(root,{recursive:true});const folder=mkdtempSync(join(root,'read-'));
  writeFileSync(join(folder,'data.txt'),'real Pi read'); const f=setup();let accesses=0;
  const definition=createReadToolDefinition(folder,{operations:{access:async()=>{if(++accesses===1)throw transient();},readFile:readFile}});
  const wrapped=governedTool(definition,f.governor,new AbortController().signal,()=>{});
  const result=await wrapped.execute('pi-read',{path:'data.txt'},undefined,undefined,undefined as never);
  assert(result.content.some((block)=>block.type==='text' && block.text.includes('real Pi read')));
  assert.equal(accesses,2);assert.deepEqual(f.calls,[1,2]);
});

test('stable error codes drive classification rather than phrases suggesting retry', () => {
  assert.equal(classifyToolError(new Error('please retry later'),false).retryable,false);
  assert.equal(classifyToolError(Object.assign(new Error('not transient'),{code:'EACCES'}),false).category,'permission');
  assert.equal(classifyToolError(Object.assign(new Error('busy'),{code:'EBUSY'}),false).retryable,true);
});
