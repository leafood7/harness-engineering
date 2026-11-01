import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { RunStore,sdkIdentity } from '../src/store.ts';
import { saveCheckpoint } from '../src/checkpoint.ts';
import { resolveRecovery,recoveryPlan } from '../src/recovery.ts';
import { prepareTask } from '../src/task.ts';
import type { TaskInput } from '../src/task.ts';
import type { Run,Operation } from '../contracts/index.ts';
import { TOOL_METADATA,effectivePolicy } from '../src/tool-policy.ts';
import { now,digest,canonical } from '../src/util.ts';
function fixture(nodeCheck=false){
 const root=resolve('.artifacts','m3-unit');mkdirSync(root,{recursive:true});const folder=mkdtempSync(join(root,'case-'));const workspace=join(folder,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'answer.txt'),'before');
 const file=join(folder,'task.json');const input:TaskInput={schemaVersion:1,taskId:'recovery-unit',input:'Set answer.txt to after',workspace,tools:['write'],budget:{maxDurationMs:10000,maxToolCalls:5,maxTokens:10000},model:{mode:'scripted',responses:[{calls:[{name:'write',arguments:{path:'answer.txt',content:'after'}}]},{text:'done'}]},verification:{version:'1',checks:nodeCheck?[{kind:'node',name:'verify',script:'./verify.cjs',timeoutMs:1000}]:[{kind:'file',name:'answer',path:'answer.txt',equals:'after'}]}};
 writeFileSync(file,JSON.stringify(input));writeFileSync(join(folder,'verify.cjs'),'process.exit(0);');const store=new RunStore(join(folder,'state'));const id=randomUUID();const runDir=join(store.root,'runs',id);mkdirSync(runDir);
 const policy=effectivePolicy(input.policy);const policyDigest=digest(canonical({tools:input.tools,catalog:TOOL_METADATA,policy,budget:input.budget,scope:input.workspace}));
 const run:Run={schemaVersion:1,runId:id,taskId:input.taskId,status:'created',pi:sdkIdentity(),harnessVersion:'0.3.0',model:{mode:'scripted',provider:'harness-scripted',id:'scripted-1',parametersDigest:'x'},policy:{version:policy.version,digest:policyDigest},strategy:{version:'m3.1',digest:'x'},budget:input.budget,usage:{toolCalls:0,tokens:null,costUsd:null},createdAt:now(),workerPid:2147483647,eventSequence:0,runDir,activeMs:100,modelCursor:0,modelInFlight:false,verifierInFlight:false};
 store.create(run);store.transition(id,'initializing');const prepared=prepareTask(input,file,runDir,store.root);writeFileSync(join(runDir,'policy.json'),JSON.stringify({digest:policyDigest}));store.mutate(id,(run)=>{run.task=prepared.task;},'test.prepare',{});store.transition(id,'running');const checkpoint=saveCheckpoint(store,id,workspace,'ready');store.transition(id,'interrupted');return{folder,workspace,file,input,store,id,runDir,checkpoint};
}
function reason(f:ReturnType<typeof fixture>){return recoveryPlan(f.store,f.id).reason;}
test('recovery preflight is read-only and reports remaining cumulative budgets',()=>{const f=fixture();try{f.store.mutate(f.id,(run)=>{run.usage={toolCalls:2,tokens:1000,costUsd:0};run.activeMs=2500;},'test.usage',{});const seq=f.store.get(f.id).eventSequence;assert.deepEqual(resolveRecovery(f.store,f.id).remaining,{toolCalls:3,tokens:9000,durationMs:7500});assert.equal(f.store.get(f.id).eventSequence,seq);}finally{f.store.close();}});
test('workspace edits after a checkpoint block automatic recovery',()=>{const f=fixture();try{writeFileSync(join(f.workspace,'answer.txt'),'external change');assert.equal(reason(f),'workspace_changed');}finally{f.store.close();}});
test('changed frozen task and policy snapshots are rejected',()=>{for(const name of ['task.json','policy.json']){const f=fixture();try{writeFileSync(join(f.runDir,name),'{}');assert.equal(reason(f),name==='task.json'?'task_snapshot_changed':'policy_snapshot_changed');}finally{f.store.close();}}});
test('changing an independent verifier cannot change resumed acceptance criteria',()=>{const f=fixture(true);try{writeFileSync(join(f.runDir,'verification','check-0.cjs'),'process.exit(99);');assert.equal(reason(f),'verification_changed');}finally{f.store.close();}});
test('checkpoint session snapshots have integrity validation',()=>{const f=fixture();try{const manager=SessionManager.create(f.workspace,join(f.runDir,'sessions'));manager.appendMessage({role:'user',content:'original user',timestamp:Date.now()});const cp=saveCheckpoint(f.store,f.id,f.workspace,'ready',{sessionManager:manager,sessionId:manager.getSessionId()});assert(cp.sessionSnapshot);writeFileSync(cp.sessionSnapshot,readFileSync(cp.sessionSnapshot,'utf8')+'\nBAD');assert.equal(reason(f),'session_changed');}finally{f.store.close();}});
test('writes beyond a full checkpoint cannot be replayed automatically',()=>{for(const status of ['authorized','running','succeeded'] as const){const f=fixture();try{f.store.mutate(f.id,(run)=>{const operation:Operation={operationId:randomUUID(),runId:f.id,toolCallId:'write-after-checkpoint',toolName:'write',attempt:1,argumentsDigest:'x',sideEffects:true,status,authorizedSequence:run.eventSequence+1};f.store.saveOperation(operation);},'test.write',{});assert.equal(reason(f),'uncertain_side_effect');}finally{f.store.close();}}});
test('pending read-only work may restart but unfinished model and verifier work remain blocked',()=>{const f=fixture();try{f.store.mutate(f.id,(run)=>{f.store.saveOperation({operationId:randomUUID(),runId:f.id,toolCallId:'read-pending',toolName:'read',attempt:1,argumentsDigest:'x',sideEffects:false,status:'running',authorizedSequence:run.eventSequence+1});},'test.read',{});assert.equal(recoveryPlan(f.store,f.id).eligible,true);for(const field of ['modelInFlight','modelUsageUncertain','verifierInFlight'] as const){f.store.mutate(f.id,(run)=>{run[field]=true;},'test.uncertain',{});assert.equal(reason(f),field==='verifierInFlight'?'verifier_outcome_unknown':'unmetered_model_call');f.store.mutate(f.id,(run)=>{run[field]=false;},'test.clear',{});}}finally{f.store.close();}});
test('exhausted budgets do not become fresh budgets after interruption',()=>{for(const kind of ['tools','tokens','time']){const f=fixture();try{f.store.mutate(f.id,(run)=>{if(kind==='tools')run.usage.toolCalls=run.budget.maxToolCalls;else if(kind==='tokens')run.usage.tokens=run.budget.maxTokens;else run.activeMs=run.budget.maxDurationMs;},'test.exhausted',{});assert.equal(reason(f),'budget_exhausted');}finally{f.store.close();}}});
test('recovery ownership commits atomically with one child per parent',()=>{const f=fixture();try{const parent=f.store.get(f.id);const clone=(id:string):Run=>({...parent,runId:id,status:'created',eventSequence:0,resumedFromRunId:f.id,resumedByRunId:undefined});const first=clone(randomUUID());f.store.create(first,parent);assert.equal(f.store.get(f.id).resumedByRunId,first.runId);const second=clone(randomUUID());assert.throws(()=>f.store.create(second,parent));assert.throws(()=>f.store.get(second.runId));assert.equal(reason(f),'already_resumed');}finally{f.store.close();}});
test('live Workers and old Runs without a checkpoint are refused',()=>{const f=fixture();try{f.store.mutate(f.id,(run)=>{run.workerPid=process.pid;},'test.live',{});assert.equal(reason(f),'source_worker_alive');f.store.mutate(f.id,(run)=>{run.workerPid=2147483647;},'test.dead',{});f.store.db.prepare('DELETE FROM checkpoints WHERE run_id=?').run(f.id);assert.equal(reason(f),'checkpoint_missing');}finally{f.store.close();}});

test('different Harness or effective policy versions cannot silently govern recovered work',()=>{
 for(const field of ['version','policy']){const f=fixture();try{f.store.mutate(f.id,(run)=>{if(field==='version')run.harnessVersion='different';else run.policy.digest='different';},'test.changed',{});assert.equal(reason(f),field==='version'?'harness_changed':'policy_changed');}finally{f.store.close();}}
});

test('invalid model cursors and absent conversation history cannot restart completed work from scratch',()=>{
 const f=fixture();try{
  const original=f.store.latestCheckpoint(f.id)!;
  for(const cursor of [-1,1]){const corrupted={...original,modelCursor:cursor};f.store.db.prepare('UPDATE checkpoints SET body=? WHERE id=?').run(JSON.stringify(corrupted),original.checkpointId);assert.equal(reason(f),'checkpoint_invalid');}
 }finally{f.store.close();}
});
