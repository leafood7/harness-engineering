import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { RunStore } from '../src/store.ts';
import type { Run,Approval,Event } from '../contracts/index.ts';
import type { TaskInput } from '../src/task.ts';
import { terminal } from '../src/util.ts';

const root=resolve('.artifacts','m2-integration');mkdirSync(root,{recursive:true});const cli=resolve('bin/harness.mjs');
function command(args:string[]):{code:number;lines:Array<Record<string,unknown>>;error:string}{
  try{const out=execFileSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:25000});return{code:0,lines:out.trim().split('\n').filter(Boolean).map((line)=>JSON.parse(line) as Record<string,unknown>),error:''};}
  catch(error){const failure=error as {status?:number;stdout?:string;stderr?:string};return{code:failure.status??99,lines:(failure.stdout??'').trim().split('\n').filter(Boolean).map((line)=>JSON.parse(line) as Record<string,unknown>),error:failure.stderr??''};}
}
function fixture(){
  const folder=mkdtempSync(join(root,'case-'));const workspace=join(folder,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'answer.txt'),'before');
  const input:TaskInput={schemaVersion:1,taskId:'m2-approval',input:'Change answer.txt to after',workspace,tools:['read','write','wait'],
    budget:{maxDurationMs:25000,maxToolCalls:5,maxTokens:100000},policy:{version:'approval-v1',approvalTimeoutMs:18000,tools:{write:{permission:'ask'}}},
    model:{mode:'scripted',responses:[{calls:[{name:'write',arguments:{path:'answer.txt',content:'after'}}]},{text:'done'}]},
    verification:{version:'1',checks:[{kind:'file',name:'answer',path:'answer.txt',equals:'after'}]}};
  return{folder,workspace,input,file:join(folder,'task.json'),state:join(folder,'state')};
}
type Fixture=ReturnType<typeof fixture>;
function start(f:Fixture):string{
  writeFileSync(f.file,JSON.stringify(f.input));const result=command(['run',f.file,'--state',f.state,'--detach']);
  assert.equal(result.code,0,result.error);const line=result.lines.find((line)=>line.status==='created');assert(line);return String(line.runId);
}
function data(f:Fixture,id:string){const store=new RunStore(f.state);try{return{...store.report(id),events:store.events(id)};}finally{store.close();}}
async function until(f:Fixture,id:string,predicate:(value:ReturnType<typeof data>)=>boolean){
  const begin=Date.now();while(Date.now()-begin<15000){const current=data(f,id);if(predicate(current))return current;await sleep(35);}throw new Error('Timed out waiting for M2 run');
}
async function pending(f:Fixture,id:string):Promise<Approval>{const value=await until(f,id,(value)=>value.approvals.some((a)=>a.status==='pending'));return value.approvals.find((a)=>a.status==='pending')!;}
function decide(f:Fixture,approval:Approval,yes=true,digest=approval.requestDigest){return command([yes?'approve':'reject',approval.approvalId,'--state',f.state,'--digest',digest,'--actor','integration-test',...(yes?[]:['--reason','Test rejection'])]);}
async function cleanup(f:Fixture,id:string){if(!terminal(data(f,id).run.status)){command(['cancel',id,'--state',f.state]);await until(f,id,(value)=>terminal(value.run.status));}}

test('ask policy performs no write until a separate CLI approves the exact request, then consumes it once',async()=>{
  const f=fixture();const id=start(f);
  try{
    const approval=await pending(f,id);assert.equal(data(f,id).run.status,'waiting_approval');assert.equal(data(f,id).run.usage.toolCalls,0);
    assert(data(f,id).events.some((event)=>event.kind==='policy.decision' && event.payload.decision==='ask' && event.payload.allowed===false));
    assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'before');assert(existsSync(approval.requestFile));
    assert.equal(decide(f,approval).code,0);
    const ended=await until(f,id,(value)=>terminal(value.run.status));assert.equal(ended.run.status,'completed');assert.equal(ended.verification?.status,'passed');
    assert.equal(ended.approvals[0].status,'consumed');assert.equal(ended.approvals[0].actor,'integration-test');assert.equal(ended.run.usage.toolCalls,1);
    assert.equal(decide(f,approval).code,2);
    const inspect=command(['inspect',id,'--state',f.state]);assert.equal(inspect.code,0);assert(Array.isArray(inspect.lines[0].approvals));
  }finally{await cleanup(f,id);}
});

test('rejected approval fails without changing the file',async()=>{
  const f=fixture();const id=start(f);try{const approval=await pending(f,id);assert.equal(decide(f,approval,false).code,0);
    const ended=await until(f,id,(value)=>terminal(value.run.status));assert.equal(ended.run.error?.category,'approval_rejected');assert.equal(ended.approvals[0].status,'rejected');assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'before');
  }finally{await cleanup(f,id);}
});

test('approval timeout expires the request and rejects a later decision',async()=>{
  const f=fixture();f.input.policy!.approvalTimeoutMs=200;const id=start(f);
  const ended=await until(f,id,(value)=>terminal(value.run.status));assert.equal(ended.run.error?.category,'approval_expired');assert.equal(ended.approvals[0].status,'expired');assert.equal(decide(f,ended.approvals[0]).code,2);assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'before');
});

test('cancellation while waiting for approval invalidates the pending request and starts no attempt',async()=>{
  const f=fixture();const id=start(f);try{const approval=await pending(f,id);command(['cancel',id,'--state',f.state]);
    const ended=await until(f,id,(value)=>terminal(value.run.status));assert.equal(ended.run.status,'cancelled');assert.equal(ended.approvals[0].status,'cancelled');assert.equal(ended.run.usage.toolCalls,0);assert.equal(decide(f,approval).code,2);
  }finally{await cleanup(f,id);}
});

test('incorrect approval digest is rejected while the valid request stays pending',async()=>{
  const f=fixture();const id=start(f);try{const approval=await pending(f,id);assert.equal(decide(f,approval,true,'0'.repeat(64)).code,2);
    assert.equal(data(f,id).approvals[0].status,'pending');assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'before');
    assert.equal(decide(f,approval).code,0);assert.equal((await until(f,id,(v)=>terminal(v.run.status))).run.status,'completed');
  }finally{await cleanup(f,id);}
});

test('changing the reviewed target invalidates the old approval and requires a new review',async()=>{
  const f=fixture();const id=start(f);try{const original=await pending(f,id);writeFileSync(join(f.workspace,'answer.txt'),'changed externally');assert.equal(decide(f,original).code,0);
    const value=await until(f,id,(v)=>v.approvals.some((a)=>a.status==='invalidated')&&v.approvals.some((a)=>a.status==='pending'));
    const replacement=value.approvals.find((a)=>a.status==='pending')!;assert.notEqual(replacement.requestDigest,original.requestDigest);assert.equal(value.run.usage.toolCalls,0);
    assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'changed externally');assert.equal(decide(f,replacement).code,0);
    const ended=await until(f,id,(v)=>terminal(v.run.status));assert.equal(ended.run.status,'completed');assert.deepEqual(ended.approvals.map((a)=>a.status),['invalidated','consumed']);
  }finally{await cleanup(f,id);}
});

test('changed policy invalidates a pending approval instead of granting the old permission',async()=>{
  const f=fixture();const id=start(f);try{await pending(f,id);const store=new RunStore(f.state);try{store.mutate(id,(run)=>{run.policy={version:'changed',digest:'changed-policy'};},'test.policy_changed',{});}finally{store.close();}
    const ended=await until(f,id,(v)=>terminal(v.run.status));assert.equal(ended.run.error?.category,'policy_changed');assert.equal(ended.approvals[0].status,'invalidated');assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'before');
  }finally{await cleanup(f,id);}
});

test('tampered review artifact cannot be approved with its previous digest',async()=>{
  const f=fixture();const id=start(f);try{const approval=await pending(f,id);writeFileSync(approval.requestFile,'{}');assert.equal(decide(f,approval).code,2);assert.equal(data(f,id).run.usage.toolCalls,0);
  }finally{await cleanup(f,id);}
});

test('explicit deny policy overrides a tool that appears in the allowlist',async()=>{
  const f=fixture();f.input.policy!.tools!.write!.permission='deny';const id=start(f);
  const ended=await until(f,id,(v)=>terminal(v.run.status));assert.equal(ended.run.error?.category,'tool_denied');assert.equal(ended.approvals.length,0);assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'before');
});

test('tool-level timeout and bounded retry have separate attempt records and a structured final cause',async()=>{
  const f=fixture();f.input.policy={version:'timeout-test',settleGraceMs:100,tools:{wait:{timeoutMs:30,retry:{maxAttempts:2,initialDelayMs:10,maxDelayMs:10}}}};
  f.input.model={mode:'scripted',responses:[{calls:[{name:'wait',arguments:{durationMs:5000}}]},{text:'done'}]};const id=start(f);
  const ended=await until(f,id,(v)=>terminal(v.run.status));assert.equal(ended.run.error?.category,'tool_timeout');assert.equal(ended.run.error?.toolFailure?.category,'timeout');assert.equal(ended.run.usage.toolCalls,2);
  const attempts=ended.events.filter((e)=>e.kind==='tool.attempt_end');assert.equal(attempts.length,2);assert(attempts.every((e)=>(e.payload.failure as {category:string}).category==='timeout'));
});

test('a retry cannot exceed the remaining Run tool budget',async()=>{
  const f=fixture();f.input.budget.maxToolCalls=1;f.input.policy={version:'retry-budget',tools:{wait:{timeoutMs:20,retry:{maxAttempts:3,initialDelayMs:10,maxDelayMs:10}}}};
  f.input.model={mode:'scripted',responses:[{calls:[{name:'wait',arguments:{durationMs:5000}}]},{text:'done'}]};const id=start(f);
  const ended=await until(f,id,(v)=>terminal(v.run.status));assert.equal(ended.run.error?.category,'tool_budget_exceeded');assert.equal(ended.run.usage.toolCalls,1);
});

test('unsafe automatic write retry configurations are rejected before execution',()=>{
  const f=fixture();f.input.policy={version:'unsafe',tools:{write:{retry:{maxAttempts:2,initialDelayMs:10,maxDelayMs:10}}}};writeFileSync(f.file,JSON.stringify(f.input));
  const result=command(['run',f.file,'--state',f.state]);assert.equal(result.code,2);assert(result.error.includes('side effects'));assert.equal(existsSync(join(f.state,'state.sqlite')),false);
});

test('Run duration still expires while approval is waiting',async()=>{
  const f=fixture();f.input.budget.maxDurationMs=700;const id=start(f);
  const ended=await until(f,id,(v)=>terminal(v.run.status));assert.equal(ended.run.error?.category,'duration_budget_exceeded');assert.equal(ended.run.usage.toolCalls,0);assert.equal(ended.approvals[0].status,'cancelled');
});

test('approval for a dead Worker is rejected and its pending requests are closed',async()=>{
  const f=fixture();const id=start(f);try{const approval=await pending(f,id);process.kill(data(f,id).run.workerPid,'SIGKILL');await sleep(150);
    assert.equal(decide(f,approval).code,2);const ended=data(f,id);assert.equal(ended.run.status,'interrupted');assert.equal(ended.approvals[0].status,'cancelled');assert.equal(readFileSync(join(f.workspace,'answer.txt'),'utf8'),'before');
  }finally{await cleanup(f,id);}
});
