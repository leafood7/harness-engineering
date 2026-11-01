import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { RunStore,sdkIdentity } from '../src/store.ts';
import { ApprovalGate } from '../src/approval.ts';
import { effectivePolicy } from '../src/tool-policy.ts';
import { now } from '../src/util.ts';
import type { Run,Approval } from '../contracts/index.ts';

function fixture(){
  const root=resolve('.artifacts','m2-approval-unit');mkdirSync(root,{recursive:true});const folder=mkdtempSync(join(root,'case-'));
  const workspace=join(folder,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'file.txt'),'before');
  const store=new RunStore(join(folder,'state'));const id=randomUUID();const runDir=join(store.root,'runs',id);mkdirSync(runDir);
  const run:Run={schemaVersion:1,runId:id,taskId:'test',status:'created',pi:sdkIdentity(),harnessVersion:'0.2.0',
    model:{mode:'scripted',provider:'test',id:'test',parametersDigest:'x'},policy:{version:'v1',digest:'frozen-policy'},strategy:{version:'1',digest:'x'},
    budget:{maxDurationMs:10000,maxToolCalls:5,maxTokens:10000},usage:{toolCalls:0,tokens:null,costUsd:null},createdAt:now(),workerPid:process.pid,eventSequence:0,runDir};
  store.create(run);store.transition(id,'initializing');store.transition(id,'running');
  const policy=effectivePolicy({version:'v1',approvalTimeoutMs:2000,tools:{write:{permission:'ask'}}});
  return{folder,workspace,store,id,policy,gate:new ApprovalGate(store,id,workspace,policy)};
}
async function pending(store:RunStore,id:string,after?:string):Promise<Approval>{
  for(let i=0;i<200;i++){const found=store.approvals(id).find((a)=>a.status==='pending'&&a.approvalId!==after);if(found)return found;await sleep(10);}throw new Error('No approval');
}

test('changed parameters create a new approval rather than inheriting a previous decision',async()=>{
  const f=fixture();const controller=new AbortController();const context={toolName:'write',toolCallId:'call',attempt:1,args:{path:'file.txt',content:'first'}};
  const waiting=f.gate.acquire(context,controller.signal);const settled=waiting.catch(()=>undefined);
  try{
    const first=await pending(f.store,f.id);context.args.content='changed';f.store.decideApproval(first.approvalId,first.requestDigest,true,'unit-test');
    const second=await pending(f.store,f.id,first.approvalId);assert.notEqual(second.argumentsDigest,first.argumentsDigest);assert.equal(f.store.approval(first.approvalId).status,'invalidated');
    f.store.decideApproval(second.approvalId,second.requestDigest,true,'unit-test');const receipt=await waiting;
    f.store.mutate(f.id,(run)=>{f.store.consumeApproval(receipt.approvalId,run,receipt.requestDigest);},'test.consume',{});
    assert.equal(f.store.approval(second.approvalId).status,'consumed');assert.equal(f.store.get(f.id).status,'running');
  }finally{controller.abort();await settled;f.store.close();}
});

test('approved receipts that expire before execution cannot consume authorization or tool budget',async()=>{
  const f=fixture();f.policy.approvalTimeoutMs=120;const controller=new AbortController();const waiting=f.gate.acquire({toolName:'write',toolCallId:'call',attempt:1,args:{path:'file.txt',content:'after'}},controller.signal);const settled=waiting.catch(()=>undefined);
  try{
    const approval=await pending(f.store,f.id);f.store.decideApproval(approval.approvalId,approval.requestDigest,true,'unit-test');const receipt=await waiting;await sleep(150);
    assert.throws(()=>f.store.mutate(f.id,(run)=>{f.store.consumeApproval(receipt.approvalId,run,receipt.requestDigest);run.usage.toolCalls++;},'test.consume',{}));
    assert.equal(f.store.get(f.id).usage.toolCalls,0);assert.equal(f.store.approval(approval.approvalId).status,'approved');
  }finally{controller.abort();await settled;f.store.close();}
});

test('authorization consumption and budget charging roll back together on a failed transaction',async()=>{
  const f=fixture();const controller=new AbortController();const waiting=f.gate.acquire({toolName:'write',toolCallId:'call',attempt:1,args:{path:'file.txt',content:'after'}},controller.signal);const settled=waiting.catch(()=>undefined);
  try{
    const approval=await pending(f.store,f.id);f.store.decideApproval(approval.approvalId,approval.requestDigest,true,'unit-test');const receipt=await waiting;
    assert.throws(()=>f.store.mutate(f.id,(run)=>{f.store.consumeApproval(receipt.approvalId,run,receipt.requestDigest);run.usage.toolCalls++;throw new Error('transaction interrupted');},'test.consume',{}));
    assert.equal(f.store.approval(approval.approvalId).status,'approved');assert.equal(f.store.get(f.id).usage.toolCalls,0);assert.equal(f.store.get(f.id).status,'waiting_approval');
    assert.throws(()=>f.store.mutate(f.id,(run)=>{f.store.consumeApproval(receipt.approvalId,{...run,runId:randomUUID()},receipt.requestDigest);},'test.cross_run',{}));
  }finally{controller.abort();await settled;f.store.close();}
});

test('database v1 upgrades to the current schema without losing existing run records',()=>{
  const root=resolve('.artifacts','m2-migration');mkdirSync(root,{recursive:true});const folder=mkdtempSync(join(root,'case-'));
  const db=new DatabaseSync(join(folder,'state.sqlite'));db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,body TEXT NOT NULL,cancel_at TEXT);PRAGMA user_version=1;');db.prepare('INSERT INTO runs VALUES(?,?,NULL)').run('historical',JSON.stringify({marker:'M1 record'}));db.close();
  const store=new RunStore(folder);try{const row=store.db.prepare('SELECT body FROM runs WHERE id=?').get('historical') as {body:string};assert.equal(JSON.parse(row.body).marker,'M1 record');assert.equal((store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,3);}finally{store.close();}
});
