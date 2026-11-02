import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createDemo} from '../src/demo.ts';
import {QueueStore} from '../src/queue/store.ts';
import {schedule} from '../src/queue/scheduler.ts';
const root=resolve('.artifacts/queue-demos');mkdirSync(root,{recursive:true});const state=mkdtempSync(join(root,'run-'));
const queue=new QueueStore(state);
try{
 const jobs=queue.submit([createDemo(),createDemo(),createDemo()]);
 console.log(JSON.stringify({state,jobIds:jobs.map(j=>j.id),model:'offline scripted; no paid calls',concurrency:2}));
 await schedule(state,2,true);
 const results=queue.list();console.log(JSON.stringify({jobs:results.map(j=>({id:j.id,runId:j.runId,status:j.status})),state}));
 if(results.some(j=>j.status!=='completed'))process.exitCode=2;
}finally{queue.close();}
