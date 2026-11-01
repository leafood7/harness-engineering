import { mkdirSync,mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { executeTask } from '../src/execution/engine.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { RunStore } from '../src/state/store.ts';
import { readContext } from '../src/context/manager.ts';
import type { TaskInput } from '../src/task.ts';
const root=resolve('.artifacts','context-memory-demo');mkdirSync(root,{recursive:true});const folder=mkdtempSync(join(root,'run-'));const workspace=join(folder,'workspace');mkdirSync(workspace);const state=join(folder,'state');
writeFileSync(join(workspace,'source.txt'),'Long source evidence line.\n'.repeat(2000));writeFileSync(join(workspace,'answer.txt'),'before');
const memory=new MemoryStore(state);let memoryId:string;
try{const record=memory.put({workspace,content:'Answer format for this project is plain text: after',source:{kind:'manual',reference:'Demo owner convention',actor:'demo-owner'}});memoryId=record.id;}finally{memory.close();}
const input:TaskInput={schemaVersion:1,taskId:'context-memory-demo',input:'Read source.txt and write after to answer.txt',workspace,tools:['read','write'],budget:{maxDurationMs:20000,maxToolCalls:5,maxTokens:200000},context:{maxInputTokens:20000,toolResultMaxChars:512,compactAtTokens:256,keepRecentTokens:64},memory:{query:'Answer format',maxBytes:4096},model:{mode:'scripted',responses:[{calls:[{name:'read',arguments:{path:'source.txt',limit:1500}}]},{calls:[{name:'write',arguments:{path:'answer.txt',content:'after'}}]},{text:'Done'}]},verification:{version:'1',checks:[{kind:'file',name:'independent exact answer',path:'answer.txt',equals:'after'}]}};
const file=join(folder,'task.json');writeFileSync(file,JSON.stringify(input,null,2));const run=await executeTask(file,state,randomUUID(),()=>{});assert.equal(run.status,'completed',JSON.stringify(run.error));
const store=new RunStore(state);let result;
try{const events=store.events(run.runId);assert(events.some(event=>event.kind==='context.projected'));assert(events.some(event=>event.kind==='context.compacted'));assert.equal(store.report(run.runId).verification?.status,'passed');result={runId:run.runId,status:run.status,verification:store.report(run.runId).verification?.status,toolCalls:run.usage.toolCalls,projectedRequests:events.filter(event=>event.kind==='context.projected').length,nativeCompactions:events.filter(event=>event.kind==='context.compacted').length,memoryId,contextDigest:run.contextDigest,frozenMemoryRevision:readContext(run.runDir).memories[0].revision,sourceBytes:Buffer.byteLength(readFileSync(join(workspace,'source.txt'))),model:'local-scripted; no paid calls',reportPath:join(run.runDir,'report.json')};}finally{store.close();}
const revised=new MemoryStore(state);try{revised.revise(memoryId,1,{workspace,content:'Answer format is now JSON in future tasks',source:{kind:'manual',reference:'Demo owner correction',actor:'demo-owner'}});assert.equal(readContext(run.runDir).memories[0].revision,1);assert.equal(revised.history(memoryId).length,2);}finally{revised.close();}
writeFileSync(join(folder,'demo-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,memoryCorrectionHistory:2,existingRunSnapshotUnchanged:true}));
