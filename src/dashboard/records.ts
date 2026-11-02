import {WorkspaceLeases} from '../state/workspace-leases.ts';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RunStore} from '../state/store.ts';
import {resolveRecovery,recoveryPlan,workerAlive} from '../state/recovery.ts';
import {terminal,digest,workspacePath,HarnessError} from '../util.ts';
import type {Run} from '../../contracts/index.ts';

export function reconcileRuns(store:RunStore){
 for(const {body} of store.db.prepare('SELECT body FROM runs').all() as {body:string}[]){const run=JSON.parse(body) as Run;if(!terminal(run.status)&&!workerAlive(run.workerPid))store.transition(run.runId,'interrupted',{error:{category:'worker_missing',message:'执行进程已退出，请检查恢复条件',retryable:false}});}
}
export function runRow(run:Run){return {id:run.runId,runId:run.runId,taskId:run.taskId,workspace:run.task?.workspace.path??'尚未准备工作目录',status:terminal(run.status)?run.status:'running',phase:run.status,usage:run.usage,strategy:run.strategy.version,completedPrompts:run.nextPromptIndex??0,runError:run.error??null,exportErrors:run.exportErrors??[],cancelRequested:!!run.cancellation&&!terminal(run.status),created:run.createdAt,updated:run.heartbeatAt??run.endedAt??run.createdAt,kind:run.resumedFromRunId?'recovery':'direct'};}
const reasons:Record<string,string>={source_worker_alive:'原执行进程仍在运行，请先取消或等待它退出。',already_resumed:'这次执行已产生恢复记录，请转到后续执行查看。',source_not_resumable:'只有已中断或已取消的执行才能恢复。',checkpoint_missing:'没有完整检查点，不能从头冒充恢复。',harness_changed:'应用版本与原执行不同，请使用原版本处理这次记录。',sdk_changed:'Pi 依赖与原执行不同，不能直接恢复。',unmetered_model_call:'模型请求的用量未确认，无法安全继承剩余预算。',verifier_outcome_unknown:'上次验收进程是否停止尚不确定，不能自动重新验收。',uncertain_side_effect:'检查点之后的文件操作结果不确定，需要先人工检查。',workspace_changed:'工作目录与检查点不一致，恢复已被阻止。',strategy_changed:'原策略定义或快照已改变，恢复已被阻止。',budget_exhausted:'剩余预算不足以继续执行。',context_snapshot_changed:'原上下文快照已改变。',session_changed:'原会话记录已改变。',task_snapshot_changed:'原任务快照已改变。',policy_snapshot_changed:'原执行规则快照已改变。',verification_changed:'原验收规则已改变。',prompt_progress_uncertain:'执行轮次与持久检查点不一致。'};
export function recoveryView(store:RunStore,id:string):Record<string,unknown>&{explanation:string}{const plan=recoveryPlan(store,id);if(plan.eligible){const leases=new WorkspaceLeases(store.root);try{const workspace=store.get(id).task?.workspace.path;if(workspace){const conflict=leases.blocked(workspace,id);if(conflict)return {...plan,eligible:false,reason:'workspace_busy',explanation:'工作目录正在被其他执行占用，请等待其结束后重新检查。'};}}finally{leases.close();}}return {...plan,explanation:plan.eligible?'检查点、策略、目录及剩余预算检查通过。继续执行时会再次核对。':reasons[String(plan.reason)]??'恢复条件未满足，请查看下面的具体原因。'};}
export async function launchRecovery(root:string,id:string):Promise<{runId:string;message:string}>{
 const store=new RunStore(root);try{reconcileRuns(store);resolveRecovery(store,id);}finally{store.close();}
 // The existing CLI and engine recheck every guard and atomically claim one child.
 return new Promise((done,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.ts',import.meta.url)),'resume',id,'--state',root,'--detach'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('恢复启动尚未确认，请刷新原记录查看关联执行；不要重复提交。'));},35000);
  child.stdout.on('data',bytes=>{output=(output+bytes.toString()).slice(-16384);});child.stderr.resume();
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',()=>{clearTimeout(timer);const runs=new RunStore(root);try{const source=runs.get(id),linked=source.resumedByRunId;if(linked){done({runId:linked,message:'已创建关联的恢复执行，继续使用原策略与累计预算'});return;}const lease=new WorkspaceLeases(root);try{if(source.task&&lease.blocked(source.task.workspace.path,id)){reject(new HarnessError('workspace_busy','另一执行正在占用工作目录，请刷新关联记录后再操作'));return;}}finally{lease.close();}const message=output.split('\n').filter(Boolean).at(-1);reject(new Error(message?'恢复没有创建执行，请重新检查恢复条件。':'恢复启动失败，请查看原记录和本地日志。'));}finally{runs.close();}});
 });
}
export function lineage(store:RunStore,run:Run){const all=(store.db.prepare('SELECT body FROM runs').all() as {body:string}[]).map(row=>JSON.parse(row.body) as Run),map=new Map(all.map(r=>[r.runId,r]));let first=run;const seen=new Set<string>();while(first.resumedFromRunId&&map.has(first.resumedFromRunId)&&!seen.has(first.runId)){seen.add(first.runId);first=map.get(first.resumedFromRunId)!;}const chain:Run[]=[];seen.clear();let current:Run|undefined=first;while(current&&!seen.has(current.runId)){seen.add(current.runId);chain.push(current);current=current.resumedByRunId?map.get(current.resumedByRunId):undefined;}return chain.map(r=>({runId:r.runId,status:r.status,createdAt:r.createdAt,strategy:r.strategy.version,usage:r.usage,parent:r.resumedFromRunId}));}
export function fileChanges(store:RunStore,run:Run){
 try{
  const initial=JSON.parse(readFileSync(workspacePath(store.root,join(run.runDir,'initial-workspace.json')),'utf8')) as {files:{path:string;sha256:string;bytes:number}[]};
  if(!Array.isArray(initial.files)||!run.task||digest(JSON.stringify(initial.files))!==run.task.workspace.initialSnapshot)throw new Error('初始目录快照与执行记录不一致');
  const record=store.db.prepare("SELECT body FROM events WHERE run_id=? AND json_extract(body,'$.kind')='workspace.observed' ORDER BY sequence DESC LIMIT 1").get(run.runId) as {body:string}|undefined;
  let files:typeof initial.files,basis:string,at:string;
  if(record){const event=JSON.parse(record.body),bytes=readFileSync(workspacePath(store.root,join(run.runDir,'workspace-result.json')));if(digest(bytes)!==event.payload.fileDigest)throw new Error('文件变化记录被修改');const saved=JSON.parse(bytes.toString('utf8'));files=saved.files;basis='settled';at=saved.observedAt;}
  else {const cp=store.latestCheckpoint(run.runId);if(!cp)return {available:false,notice:'尚无可用的文件快照'};files=cp.files;basis='checkpoint';at=cp.createdAt;}
  const before=new Map(initial.files.map(f=>[f.path,f])),after=new Map(files.map(f=>[f.path,f]));const changes=[];
  for(const file of files){const previous=before.get(file.path);if(!previous||previous.sha256!==file.sha256)changes.push({path:file.path,kind:previous?'modified':'added',bytes:file.bytes});}
  for(const file of initial.files)if(!after.has(file.path))changes.push({path:file.path,kind:'deleted',bytes:0});
  return {available:true,basis,observedAt:at,total:changes.length,files:changes.slice(0,200),limited:changes.length>200,notice:basis==='settled'?'本次执行结束时观察到的目录变化，不代表每项都已通过验收。':'仅依据最近检查点，不是最终产出，也不会读取历史工作目录当前内容。'};
 }catch(error){return {available:false,notice:error instanceof Error?error.message:'文件变化记录不可用'};}
}
