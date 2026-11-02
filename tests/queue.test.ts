import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {QueueStore} from '../src/queue/store.ts';
import {schedule,queueWorker,reconcile,startScheduler} from '../src/queue/scheduler.ts';
import {RunStore} from '../src/state/store.ts';
const root=resolve('.artifacts/queue-tests');mkdirSync(root,{recursive:true});
function fixture(){const dir=mkdtempSync(join(root,'case-')),state=join(dir,'state');mkdirSync(state);return {dir,state};}
function task(dir:string,name:string,wait=50){const workspace=join(dir,name);mkdirSync(workspace,{recursive:true});const file=join(dir,name+'.json');writeFileSync(file,JSON.stringify({schemaVersion:1,taskId:name,input:'Write done to answer.txt.',workspace,tools:['write','wait'],budget:{maxDurationMs:15000,maxToolCalls:5,maxTokens:100000},model:{mode:'scripted',responses:[{calls:[{name:'wait',arguments:{durationMs:wait}}]},{calls:[{name:'write',arguments:{path:'answer.txt',content:'done'}}]},{text:'done'}]},verification:{version:'1',checks:[{kind:'file',name:'answer',path:'answer.txt',equals:'done'}]}}));return file;}
async function until(check:()=>boolean,ms=20000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('Timed out');await delay(50);}}
test('batch validation is atomic and task/verifier input is frozen',()=>{const f=fixture(),file=task(f.dir,'one'),queue=new QueueStore(f.state);try{assert.throws(()=>queue.submit([file,join(f.dir,'missing.json')]));assert.equal(queue.list().length,0);const [job]=queue.submit([file]);writeFileSync(file,'changed');assert.equal(JSON.parse(readFileSync(job.file,'utf8')).taskId,'one');assert.equal(queue.inputHash(job.file),job.hash);queue.cancel(job.id);assert.equal(queue.get(job.id).status,'cancelled');}finally{queue.close();}});
test('claim enforces global concurrency and overlapping workspace exclusion',()=>{const f=fixture(),a=task(f.dir,'a'),b=task(f.dir,'b'),queue=new QueueStore(f.state);try{const [one,two,three]=queue.submit([a,a,b]);queue.acquire(2,'owner');assert.throws(()=>queue.acquire(2,'other'),/already running/);assert.equal(queue.claim('owner')!.id,one.id);assert.equal(queue.claim('owner')!.id,three.id);assert.equal(queue.claim('owner'),undefined);queue.finish(one.id,'completed');assert.equal(queue.claim('owner')!.id,two.id);queue.release('owner');}finally{queue.close();}});
test('uncertain startup is interrupted on restart and never requeued',()=>{const f=fixture(),queue=new QueueStore(f.state);try{const [job]=queue.submit([task(f.dir,'uncertain')]);queue.acquire(1,'owner');queue.claim('owner');reconcile(queue,true);assert.equal(queue.get(job.id).status,'interrupted');assert.equal(queue.claim('owner'),undefined);assert.equal(queue.workerClaim(job.id),undefined);}finally{queue.close();}});
test('queued cancellation prevents execution even after dispatch was claimed',async()=>{const f=fixture(),queue=new QueueStore(f.state);try{const [job]=queue.submit([task(f.dir,'cancel')]);queue.acquire(1,'owner');queue.claim('owner');queue.cancel(job.id);await queueWorker(f.state,job.id);assert.equal(queue.get(job.id).status,'cancelled');const runs=new RunStore(f.state);try{assert.throws(()=>runs.get(job.runId));}finally{runs.close();}}finally{queue.close();}});
test('tampered submitted snapshot fails before any Run or tool starts',async()=>{const f=fixture(),queue=new QueueStore(f.state);try{const [job]=queue.submit([task(f.dir,'tamper')]);queue.acquire(1,'owner');queue.claim('owner');writeFileSync(job.file,readFileSync(job.file,'utf8').replace('Write done','Tampered'));assert.equal(await queueWorker(f.state,job.id),2);assert.equal(queue.get(job.id).status,'failed');}finally{queue.close();}});
test('draining scheduler executes real independent tasks and exports verified results',async()=>{const f=fixture(),queue=new QueueStore(f.state);try{const jobs=queue.submit([task(f.dir,'first',200),task(f.dir,'second',200)]);await schedule(f.state,2,true);assert.deepEqual(queue.list().map(j=>j.status),['completed','completed']);const runs=new RunStore(f.state);try{for(const job of jobs){assert.equal(runs.get(job.runId).status,'completed');assert.equal(readFileSync(join(f.dir,job.taskId,'answer.txt'),'utf8'),'done');assert(runs.report(job.runId).verification);}}finally{runs.close();}}finally{queue.close();}});
test('background scheduler stops dispatch, survives restart and cooperatively cancels running tasks',async()=>{
 const f=fixture(),queue=new QueueStore(f.state);let pid:number|undefined;
 try{const jobs=queue.submit([task(f.dir,'slow',3000),task(f.dir,'later')]);pid=(await startScheduler(f.state,1)).pid;
 await until(()=>queue.get(jobs[0].id).status==='running');queue.stop();await until(()=>!queue.scheduler());
 assert.equal(queue.get(jobs[1].id).status,'queued');queue.cancel(jobs[0].id);
 await until(()=>{reconcile(queue);return queue.get(jobs[0].id).status==='cancelled';});
 pid=(await startScheduler(f.state,1)).pid;await until(()=>{reconcile(queue);return queue.get(jobs[1].id).status==='completed';});queue.stop();await until(()=>!queue.scheduler());
 }finally{queue.stop();queue.close();}
});
test('dead running worker becomes interrupted and is never automatically replayed',async()=>{
 const f=fixture(),queue=new QueueStore(f.state),[job]=queue.submit([task(f.dir,'crash',3000)]);queue.acquire(1,'owner');queue.claim('owner');
 const child=spawn(process.execPath,['bin/harness.mjs','queue','_worker',job.id,'--state',f.state],{cwd:resolve('.'),windowsHide:true,stdio:'ignore'});
 try{await until(()=>queue.get(job.id).status==='running');const runs=new RunStore(f.state);try{await until(()=>{try{return runs.events(job.runId).some(e=>e.kind==='tool.attempt_start');}catch{return false;}});}finally{runs.close();}
 const exited=new Promise(done=>child.once('exit',done));child.kill();await exited;reconcile(queue);assert.equal(queue.get(job.id).status,'interrupted');assert.equal(queue.claim('owner'),undefined);
 }finally{if(child.exitCode===null)child.kill();queue.close();}
});
test('queued node verifier is copied and included in snapshot integrity',()=>{
 const f=fixture(),file=task(f.dir,'verifier'),script=join(f.dir,'verify.cjs');writeFileSync(script,'process.exit(0)');const input=JSON.parse(readFileSync(file,'utf8'));input.verification.checks=[{kind:'node',name:'copied',script:'verify.cjs',args:[],timeoutMs:1000}];writeFileSync(file,JSON.stringify(input));
 const queue=new QueueStore(f.state);try{const [job]=queue.submit([file]);writeFileSync(script,'process.exit(1)');assert.equal(queue.inputHash(job.file),job.hash);const saved=JSON.parse(readFileSync(job.file,'utf8'));writeFileSync(saved.verification.checks[0].script,'process.exit(2)');assert.notEqual(queue.inputHash(job.file),job.hash);}finally{queue.close();}
});
test('restarting after scheduler crash adopts a live worker without duplicate execution',async()=>{
 const f=fixture(),queue=new QueueStore(f.state);let schedulerPid:number|undefined;
 try{const jobs=queue.submit([task(f.dir,'surviving',2000),task(f.dir,'pending')]);schedulerPid=(await startScheduler(f.state,1)).pid;
 await until(()=>queue.get(jobs[0].id).status==='running');process.kill(schedulerPid);
 await until(()=>{try{process.kill(schedulerPid!,0);return false;}catch{return true;}});
 schedulerPid=(await startScheduler(f.state,1)).pid;
 await until(()=>{reconcile(queue);return queue.list().every(j=>j.status==='completed');});
 const runs=new RunStore(f.state);try{for(const job of jobs)assert.equal(runs.events(job.runId).filter(e=>e.kind==='prompt.started').length,1);}finally{runs.close();}
 queue.stop();await until(()=>!queue.scheduler());
 }finally{queue.stop();queue.close();}
});
