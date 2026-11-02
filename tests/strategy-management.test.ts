import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StrategyStore} from '../src/strategy/store.ts';
import {strategyCommand} from '../src/strategy/cli.ts';
import {executeTask} from '../src/execution/engine.ts';
import {RunStore} from '../src/state/store.ts';
const root=resolve('.artifacts/strategy-management-tests');mkdirSync(root,{recursive:true});
const fixture=()=>mkdtempSync(join(root,'case-'));
test('selection persists across connections and rollback keeps append-only history',()=>{
 const state=fixture(),store=new StrategyStore(state);
 try{assert.equal(store.current().revision,0);assert.equal(store.current().profile,'stable.v1');
 const next=store.change('switch','read-correction.v1','Explicit local selection',0);assert.equal(next.revision,1);
 const peer=new StrategyStore(state);try{assert.equal(peer.resolve().id,'read-correction.v1');assert.equal(peer.resolve('stable.v1').id,'stable.v1');assert.throws(()=>peer.change('switch','file-contract.v1','stale',0),/Selection changed/);}finally{peer.close();}
 assert.equal(store.change('rollback',undefined,'Restore prior version',1).profile,'stable.v1');assert.equal(store.history().length,2);
 }finally{store.close();}
});
test('invalid selections and failed history writes leave active state unchanged',()=>{
 const store=new StrategyStore(fixture());try{
 assert.throws(()=>store.change('rollback',undefined,'Nothing yet'),/No switch/);
 assert.throws(()=>store.change('switch','unknown.v1','Invalid'),/Unknown/);
 assert.throws(()=>store.change('switch','read-correction.v1','  '),/reason/);
 store.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;");
 assert.throws(()=>store.change('switch','read-correction.v1','Injected failure'),/simulated disk/);
 assert.equal(store.current().revision,0);assert.equal(store.history().length,0);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM versions').get()!.n,0);
 }finally{store.close();}
});
test('an existing version cannot silently change its contents',()=>{
 const store=new StrategyStore(fixture());try{store.resolve('read-correction.v1');store.db.prepare('UPDATE versions SET digest=? WHERE id=?').run('modified','read-correction.v1');assert.throws(()=>store.resolve('read-correction.v1'),/cannot be overwritten/);assert.equal(store.current().profile,'stable.v1');}finally{store.close();}
});
test('CLI exposes current selection, switch, history and rollback in isolated state',()=>{
 const state=fixture();const call=(args:string[])=>strategyCommand([...args,'--state',state]) as {profile:string;revision:number};
 assert.equal(call(['current']).profile,'stable.v1');assert.equal(call(['switch','file-contract.v1','--reason','Use file contract','--expected-revision','0']).revision,1);
 assert.equal((strategyCommand(['history','--state',state]) as unknown[]).length,1);
 assert.equal(call(['rollback','--reason','Return to prior version']).profile,'stable.v1');
 assert.throws(()=>call(['switch','read-correction.v1','--expected-revision','NaN','--reason','bad']),/Invalid revision/);
});
test('tasks freeze active selection; later switch affects only future implicit tasks and resume retains original',async()=>{
 const state=fixture(),workspace=join(state,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'answer.txt'),'ok');
 const file=join(state,'task.json');const input={schemaVersion:1,taskId:'version-management',input:'Acknowledge.',workspace,tools:[],budget:{maxDurationMs:20000,maxToolCalls:5,maxTokens:200000},model:{mode:'scripted',responses:[{text:'done'}]},verification:{version:'1',checks:[{kind:'file',name:'answer',path:'answer.txt',equals:'ok'}]}};
 writeFileSync(file,JSON.stringify(input));const strategies=new StrategyStore(state);
 try{
 strategies.change('switch','read-correction.v1','Choose for new tasks');
 const first=await executeTask(file,state,randomUUID(),()=>{strategies.change('switch','file-contract.v1','Switch while first task is starting');});
 assert.equal(first.status,'completed',JSON.stringify(first.error));assert.equal(first.strategy.version,'read-correction.v1');
 assert.equal(JSON.parse(readFileSync(join(first.runDir,'strategy.json'),'utf8')).id,'read-correction.v1');
 const second=await executeTask(file,state,randomUUID(),()=>{});assert.equal(second.strategy.version,'file-contract.v1');assert.equal(second.status,'completed');
 const runs=new RunStore(state);try{runs.db.prepare("UPDATE runs SET body=json_set(body,'$.status','interrupted','$.workerPid',2147483647) WHERE id=?").run(first.runId);}finally{runs.close();}
 const resumed=await executeTask(first.runId,state,randomUUID(),()=>{},first.runId);assert.equal(resumed.status,'completed',JSON.stringify(resumed.error));assert.deepEqual(resumed.strategy,first.strategy);
 writeFileSync(file,JSON.stringify({...input,strategy:'stable.v1'}));const explicit=await executeTask(file,state,randomUUID(),()=>{});assert.equal(explicit.strategy.version,'stable.v1');assert.equal(explicit.status,'completed');
 }finally{strategies.close();}
});
import {spawn} from 'node:child_process';
test('two CLI writers using the same expected revision cannot both switch',async()=>{
 const state=fixture();
 const run=(id:string)=>new Promise<number>((done,reject)=>{
  const child=spawn(process.execPath,['bin/harness.mjs','strategy','switch',id,'--state',state,'--reason','Concurrent user selection','--expected-revision','0'],{cwd:resolve('.'),windowsHide:true,stdio:'ignore'});
  child.once('error',reject);child.once('exit',code=>done(code??-1));
 });
 const results=await Promise.all([run('file-contract.v1'),run('read-correction.v1')]);assert.equal(results.filter(code=>code===0).length,1);
 const store=new StrategyStore(state);try{assert.equal(store.current().revision,1);assert.equal(store.history().length,1);}finally{store.close();}
});
