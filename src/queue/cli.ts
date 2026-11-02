import {resolve} from 'node:path';
import {QueueStore,alive} from './store.ts';
import {schedule,startScheduler,queueWorker,reconcile} from './scheduler.ts';
import {RunStore} from '../state/store.ts';
export async function queueCommand(args:string[],defaultState:string):Promise<unknown>{
 let state=defaultState,concurrency=1,drain=false;const positional:string[]=[];
 for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--state'||arg==='--concurrency'){const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`${arg} requires a value`);if(arg==='--state')state=resolve(value);else concurrency=Number(value);}else if(arg==='--drain')drain=true;else if(arg.startsWith('--'))throw new Error(`Unknown option: ${arg}`);else positional.push(arg);}
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw new Error('Concurrency must be 1–16');
 const [action,...targets]=positional;
 if(action==='_worker'&&targets.length===1)return{exitCode:await queueWorker(state,targets[0])};
 if(action==='work'&&targets.length===0){await schedule(state,concurrency,drain);return{stopped:true};}
 if(action==='start'&&targets.length===0)return startScheduler(state,concurrency);
 const queue=new QueueStore(state);try{
  if(action==='submit')return{jobs:queue.submit(targets)};
  if(action==='list'&&!targets.length){reconcile(queue);return{jobs:queue.list()};}
  if(action==='status'&&!targets.length){reconcile(queue);const scheduler=queue.scheduler();return{scheduler:scheduler?{...scheduler,alive:alive(scheduler.pid)}:null,jobs:queue.list().reduce<Record<string,number>>((counts,j)=>{counts[j.status]=(counts[j.status]??0)+1;return counts;},{})};}
  if(action==='stop'&&!targets.length){queue.stop();return{stopRequested:true,runningTasks:'continue; restart scheduler to continue pending dispatch'};}
  if(action==='inspect'&&targets.length===1){reconcile(queue);const job=queue.get(targets[0]),runs=new RunStore(state);try{let run;try{run=runs.report(job.runId);}catch{}return{job,run};}finally{runs.close();}}
  if(action==='cancel'&&targets.length===1){const job=queue.cancel(targets[0]);reconcile(queue);return{job:queue.get(job.id)};}
  throw new Error('queue submit <task.json>... | list | inspect <job-id> | cancel <job-id> | status | start | work [--drain] | stop [--state <directory>] [--concurrency 1..16]');
 }finally{queue.close();}
}
