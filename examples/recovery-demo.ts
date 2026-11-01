import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDemo } from '../src/demo.ts';
import { RunStore } from '../src/store.ts';
import { workerAlive } from '../src/recovery.ts';
import type { TaskInput } from '../src/task.ts';

const root=resolve('.artifacts','m3-demo');mkdirSync(root,{recursive:true});const folder=mkdtempSync(join(root,'run-'));const state=join(folder,'state');
const taskFile=createDemo();const input=JSON.parse(readFileSync(taskFile,'utf8')) as TaskInput;
if(input.model.mode!=='scripted')throw new Error('Scripted demo expected');
input.model.responses.splice(input.model.responses.length-1,0,{calls:[{name:'wait',arguments:{durationMs:1200}}]});
input.tools.push('wait');writeFileSync(taskFile,JSON.stringify(input,null,2));
function command(args:string[]):Array<Record<string,unknown>>{
  const output=execFileSync(process.execPath,[resolve('bin/harness.mjs'),...args,'--state',state],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:20000});
  return output.trim().split('\n').filter(Boolean).map((line)=>JSON.parse(line) as Record<string,unknown>);
}
const created=command(['run',taskFile,'--detach']).find((line)=>line.status==='created');if(!created)throw new Error('No Run');const parentId=String(created.runId);
let killed=false;
try{
  let pid:number|undefined;
  for(let count=0;count<300;count++){
    const store=new RunStore(state);try{if(store.operations(parentId).some((operation)=>operation.toolName==='wait'&&operation.status==='running')){pid=store.get(parentId).workerPid;break;}}finally{store.close();}await sleep(10);
  }
  if(!pid)throw new Error('Demo wait did not start');process.kill(pid,'SIGKILL');killed=true;
  for(let count=0;count<100&&workerAlive(pid);count++)await sleep(10);
  const plan=command(['resume',parentId,'--dry-run'])[0];assert.equal(plan.eligible,true);
  const resumed=command(['resume',parentId]);const child=resumed.find((line)=>line.status==='completed');assert(child);
  const store=new RunStore(state);
  try{
    const parent=store.report(parentId);const recovery=store.report(String(child.runId));
    const writes=[...store.operations(parentId),...store.operations(String(child.runId))].filter((operation)=>operation.toolName==='write');
    assert.equal(writes.length,1);assert.equal(recovery.run.resumedFromRunId,parentId);assert.equal(recovery.verification?.status,'passed');assert.equal(recovery.run.usage.toolCalls,4);
    const evidence={state,taskFile,plan,parent,recovery,writeAttemptsAcrossChain:writes.length};
    const report=join(folder,'recovery-report.json');writeFileSync(report,JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({parentRunId:parentId,resumedRunId:child.runId,status:child.status,writeAttemptsAcrossChain:writes.length,totalToolAttempts:recovery.run.usage.toolCalls,report}));
  }finally{store.close();}
}finally{
  if(!killed)try{command(['cancel',parentId]);}catch{/* Own demo already exited. */}
}
