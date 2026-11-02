import {spawn} from 'node:child_process';
import {openSync,closeSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {QueueStore,alive,type JobStatus} from './store.ts';
import {RunStore} from '../state/store.ts';
import {executeTask} from '../execution/engine.ts';
import {terminal,errorText,sanitize} from '../util.ts';
const cli=fileURLToPath(new URL('../cli.ts',import.meta.url));
export function reconcile(queue:QueueStore,startup=false){
 const runs=new RunStore(queue.root);try{for(const job of queue.list().filter(j=>['starting','running'].includes(j.status))){
  if(job.status==='starting'){if(startup)queue.finish(job.id,'interrupted','Scheduler exited during dispatch; task was not automatically replayed');continue;}
  let run;try{run=runs.get(job.runId);}catch{/* Worker may not have created the Run yet. */}
  if(run&&terminal(run.status)){queue.finish(job.id,run.status as JobStatus);continue;}
  if(job.cancelled&&run)runs.requestCancel(job.runId);
  if(!alive(job.pid)){
   if(run&&!terminal(run.status)){runs.transition(job.runId,'interrupted',{error:{category:'worker_missing',message:'Queue worker exited; explicit checkpoint recovery is required',retryable:false}});runs.flushTrace(job.runId);runs.saveReport(job.runId);}
   queue.finish(job.id,'interrupted','Worker exited; no automatic retry');
  }
 }}finally{runs.close();}
}
export async function queueWorker(state:string,id:string):Promise<number>{
 const queue=new QueueStore(state);const job=queue.workerClaim(id);if(!job){queue.close();return 0;}
 let timer:ReturnType<typeof setInterval>|undefined;
 try{
  if(queue.inputHash(job.file)!==job.hash)throw new Error('Queued task or verifier snapshot changed');
  const cancel=()=>{if(queue.get(id).cancelled){const runs=new RunStore(state);try{try{runs.requestCancel(job.runId);}catch{/* Retry once Run creation completes. */}}finally{runs.close();}}};
  timer=setInterval(cancel,100);
  const run=await executeTask(job.file,state,job.runId,()=>cancel());
  queue.finish(id,run.status as JobStatus);return run.status==='completed'?0:2;
 }catch(error){
  // Run creation can precede an unexpected failure: retain it as interrupted, never replay it.
  const runs=new RunStore(state);try{let run;try{run=runs.get(job.runId);}catch{}
   if(run){if(!terminal(run.status))runs.transition(job.runId,'interrupted',{error:{category:'queue_worker_error',message:'Queue worker failed; inspect its log before recovery',retryable:false}});queue.finish(id,runs.get(job.runId).status as JobStatus,'Worker failed; inspect local log');}
   else queue.finish(id,'failed','Task could not start; inspect local log');
  }finally{runs.close();}
  console.error(sanitize(errorText(error)));return 2;
 }finally{if(timer)clearInterval(timer);queue.close();}
}
export async function schedule(state:string,concurrency:number,drain=false):Promise<void>{
 const queue=new QueueStore(state),token=randomUUID();let acquired=false;
 const stop=()=>queue.stop();
 try{
  queue.acquire(concurrency,token);acquired=true;reconcile(queue,true);process.on('SIGINT',stop);process.on('SIGTERM',stop);
  process.send?.({type:'scheduler_ready',pid:process.pid});if(process.connected)process.disconnect();
  while(queue.scheduler()?.token===token&&!queue.scheduler()?.stop){
   reconcile(queue);
   for(let job=queue.claim(token);job;job=queue.claim(token)){
    mkdirSync(join(state,'logs'),{recursive:true});const log=openSync(join(state,'logs',`queue-${job.id}.log`),'a',0o600);
    const jobId=job.id;
    try{const child=spawn(process.execPath,[cli,'queue','_worker',jobId,'--state',state],{detached:true,windowsHide:true,stdio:['ignore',log,log]});child.on('error',()=>{const stateQueue=new QueueStore(state);try{stateQueue.finish(jobId,'failed','Worker could not be launched');}finally{stateQueue.close();}});child.on('exit',()=>{const stateQueue=new QueueStore(state);try{if(stateQueue.get(jobId).status==='starting')stateQueue.finish(jobId,'interrupted','Worker exited before startup confirmation; no automatic retry');}finally{stateQueue.close();}});child.unref();}
    catch{queue.finish(job.id,'failed','Worker could not be launched');}finally{closeSync(log);}
   }
   if(drain&&!queue.list().some(j=>['queued','starting','running'].includes(j.status)))break;
   await delay(100);
  }
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(acquired)queue.release(token);queue.close();}
}
export async function startScheduler(state:string,concurrency:number){
 mkdirSync(join(state,'logs'),{recursive:true});const log=openSync(join(state,'logs','scheduler.log'),'a',0o600);
 try{return await new Promise<{pid:number}>((done,reject)=>{
  const child=spawn(process.execPath,[cli,'queue','work','--state',state,'--concurrency',String(concurrency)],{detached:true,windowsHide:true,stdio:['ignore',log,log,'ipc']});
  const timeout=setTimeout(()=>{child.disconnect();child.unref();reject(new Error('Scheduler startup timed out; inspect scheduler.log'));},30000);
  child.on('error',error=>{clearTimeout(timeout);reject(error);});child.on('exit',code=>{clearTimeout(timeout);reject(new Error(`Scheduler exited during startup (${code}); inspect scheduler.log`));});
  child.on('message',message=>{if(message&&typeof message==='object'&&'type' in message&&message.type==='scheduler_ready'){clearTimeout(timeout);child.unref();done({pid:child.pid!});}});
 });}finally{closeSync(log);}
}
