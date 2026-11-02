import { mkdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Checkpoint } from '../../contracts/index.ts';
import { RunStore } from './store.ts';
import { snapshot,digest,now } from '../util.ts';

function durableWrite(path:string,data:string|Buffer):void {
  const temporary=`${path}.${process.pid}.tmp`;
  const fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);
}
export function saveCheckpoint(store:RunStore,id:string,workspace:string,phase:Checkpoint['phase'],session?:Pick<AgentSession,'sessionManager'|'sessionId'>,canVerify=false):Checkpoint {
  const run=store.get(id);const manifest=snapshot(workspace);
  const folder=join(run.runDir,'checkpoints');mkdirSync(folder,{recursive:true});
  const checkpointId=randomUUID();const source=session?.sessionManager.getSessionFile();
  let sessionSnapshot:string|undefined;let sessionDigest:string|undefined;
  if(source&&existsSync(source)){
    const bytes=readFileSync(source);sessionDigest=digest(bytes);sessionSnapshot=join(folder,`${checkpointId}.session.jsonl`);durableWrite(sessionSnapshot,bytes);
  }
  const checkpoint:Checkpoint={checkpointId,runId:id,createdAt:now(),eventSequence:0,phase,canVerify,
    workspace,workspaceDigest:manifest.digest,files:manifest.files,sessionSnapshot,sessionDigest,sourceSessionId:session?.sessionId,
    taskSnapshotDigest:digest(readFileSync(join(run.runDir,'task.json'))),policyFileDigest:digest(readFileSync(join(run.runDir,'policy.json'))),
    ...(existsSync(join(run.runDir,'context.json'))?{contextFileDigest:digest(readFileSync(join(run.runDir,'context.json')))}:{}),
    ...(existsSync(join(run.runDir,'strategy.json'))?{strategyFileDigest:digest(readFileSync(join(run.runDir,'strategy.json')))}:{}),
    ...(run.nextPromptIndex!==undefined?{nextPromptIndex:run.nextPromptIndex,promptInProgress:run.promptInProgress}:{}),
    modelCursor:run.modelCursor??0,usage:run.usage,activeMs:run.activeMs??0};
  store.saveCheckpoint(checkpoint);
  durableWrite(join(folder,`${checkpointId}.json`),JSON.stringify(checkpoint,null,2));
  return checkpoint;
}
