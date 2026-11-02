import { readFileSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Run,Checkpoint } from '../../contracts/index.ts';
import { RunStore,sdkIdentity } from './store.ts';
import { TOOL_METADATA,effectivePolicy } from '../execution/tool-policy.ts';
import { validateTask,type TaskInput } from '../task.ts';
import { validateReadCorrectionState } from '../execution/read-correction.ts';
import { loadProfile,strategyDigest,type StrategyProfile } from '../strategy/catalog.ts';
import { readContext, validateContext, type ContextSnapshot } from '../context/manager.ts';
import { snapshot,digest,canonical,HarnessError } from '../util.ts';

export function workerAlive(pid:number):boolean {
  try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
export interface ResolvedRecovery {
  profile:StrategyProfile;source:Run;checkpoint:Checkpoint;context?:ContextSnapshot;input:TaskInput;workspace:string;verifierScripts:Record<string,string>;
  mode:'continue'|'verify_only';remaining:{toolCalls:number;tokens:number;durationMs:number;costUsd?:number};
}
export function resolveRecovery(store:RunStore,id:string):ResolvedRecovery {
  const source=store.get(id);
  if(workerAlive(source.workerPid))throw new HarnessError('source_worker_alive','Original Worker is still alive; cancel it or wait for it to exit');
  if(!['completed','failed','cancelled','interrupted'].includes(source.status))source.status='interrupted';
  if(source.resumedByRunId)throw new HarnessError('already_resumed',`Resume the latest child Run instead: ${source.resumedByRunId}`);
  if(!['interrupted','cancelled'].includes(source.status))throw new HarnessError('source_not_resumable','Only interrupted or cancelled Runs can resume');
  const checkpoint=store.latestCheckpoint(id);
  if(!checkpoint)throw new HarnessError('checkpoint_missing','No durable checkpoint is available');
  if(source.modelInFlight||source.modelUsageUncertain)throw new HarnessError('unmetered_model_call','Interrupted model usage is not confirmed; budget cannot be safely inherited');
  if(source.verifierInFlight)throw new HarnessError('verifier_outcome_unknown','Interrupted verifier may still have effects; do not automatically rerun it');
  const currentVersion=(JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')) as {version:string}).version;
  if(source.harnessVersion!==currentVersion)throw new HarnessError('harness_changed','Harness version differs from the checkpoint source');
  if(canonical(source.pi)!==canonical(sdkIdentity()))throw new HarnessError('sdk_changed','The installed SDK differs from the original Run');
  if(source.error?.toolFailure?.outcome==='unknown')throw new HarnessError('uncertain_side_effect','A tool outcome remains uncertain');
  const post=store.operations(id).filter((operation)=>operation.authorizedSequence>checkpoint.eventSequence||(operation.completedSequence??0)>checkpoint.eventSequence);
  if(post.some((operation)=>operation.sideEffects))throw new HarnessError('uncertain_side_effect','A write/edit occurred after the last complete checkpoint; inspect it instead of replaying it');
  const taskBytes=readFileSync(join(source.runDir,'task.json'));
  if(digest(taskBytes)!==checkpoint.taskSnapshotDigest)throw new HarnessError('task_snapshot_changed','Frozen task snapshot changed');
  if(digest(readFileSync(join(source.runDir,'policy.json')))!==checkpoint.policyFileDigest)throw new HarnessError('policy_snapshot_changed','Frozen policy snapshot changed');
  const saved=JSON.parse(taskBytes.toString('utf8')) as {config:unknown;task:{verificationSpec:{digest:string}};frozen:unknown};
  const input=validateTask(saved.config);
  if(!Number.isSafeInteger(checkpoint.modelCursor)||checkpoint.modelCursor<0||(input.model.mode==='scripted'&&checkpoint.modelCursor>input.model.responses.length))throw new HarnessError('checkpoint_invalid','Model cursor is not valid');
  if(checkpoint.modelCursor>0&&!checkpoint.sessionSnapshot&&!checkpoint.canVerify)throw new HarnessError('checkpoint_invalid','Checkpoint lacks the conversation history required to continue');
  if(digest(canonical({tools:input.tools,catalog:TOOL_METADATA,policy:effectivePolicy(input.policy),budget:input.budget,scope:input.workspace}))!==source.policy.digest)throw new HarnessError('policy_changed','Current effective policy differs from the original execution');
  const workspace=realpathSync(checkpoint.workspace);
  if(workspace!==source.task?.workspace.path)throw new HarnessError('workspace_changed','Workspace identity changed');
  if(snapshot(workspace).digest!==checkpoint.workspaceDigest)throw new HarnessError('workspace_changed','Workspace files differ from the checkpoint');
  const verifierScripts:Record<string,string>={};
  for(const [index,check] of input.verification.checks.entries())if(check.kind==='node')verifierScripts[String(index)]=join(source.runDir,'verification',`check-${index}.cjs`);
  const frozen={verification:input.verification,scripts:Object.fromEntries(Object.entries(verifierScripts).map(([index,path])=>[index,digest(readFileSync(path))]))};
  if(digest(JSON.stringify(frozen))!==saved.task.verificationSpec.digest)throw new HarnessError('verification_changed','Frozen verification changed');
  if(checkpoint.sessionSnapshot&&digest(readFileSync(checkpoint.sessionSnapshot))!==checkpoint.sessionDigest)throw new HarnessError('session_changed','Checkpoint session snapshot changed');
  let context:ContextSnapshot|undefined;
  if(source.contextDigest || checkpoint.contextFileDigest){
    if(!checkpoint.contextFileDigest || digest(readFileSync(join(source.runDir,'context.json')))!==checkpoint.contextFileDigest)throw new HarnessError('context_snapshot_changed','Frozen context file changed');
    context=readContext(source.runDir);validateContext(context,workspace,input.input);
    if(context.digest!==source.contextDigest)throw new HarnessError('context_snapshot_changed','Run context binding changed');
  }
  let profile=loadProfile(checkpoint.strategyFileDigest?source.strategy.version:input.strategy);
  if(checkpoint.strategyFileDigest){
    const bytes=readFileSync(join(source.runDir,'strategy.json'));
    profile=JSON.parse(bytes.toString('utf8')) as StrategyProfile;
    if(digest(bytes)!==checkpoint.strategyFileDigest||strategyDigest(JSON.parse(bytes.toString('utf8')))!==source.strategy.digest||strategyDigest(loadProfile(source.strategy.version))!==source.strategy.digest)throw new HarnessError('strategy_changed','Frozen or current strategy differs from the source');
  }
  if(checkpoint.nextPromptIndex!==undefined){
    const total=1+(input.followups?.length??0);
    if(!Number.isSafeInteger(checkpoint.nextPromptIndex)||checkpoint.nextPromptIndex<0||checkpoint.nextPromptIndex>total||(checkpoint.canVerify&&checkpoint.nextPromptIndex<total&&total>1))throw new HarnessError('checkpoint_invalid','Prompt progress cannot authorize final verification');
    if((source.nextPromptIndex??0)>checkpoint.nextPromptIndex)throw new HarnessError('prompt_progress_uncertain','Completed prompt progress lacks its durable checkpoint');
  }
  validateReadCorrectionState(profile.maxReadCorrections??0,{used:source.readCorrectionsUsed??0,targets:source.readCorrectionTargets??[],pending:source.readCorrectionPending??[]});
  const remaining={toolCalls:input.budget.maxToolCalls-source.usage.toolCalls,tokens:input.budget.maxTokens-(source.usage.tokens??0),
    durationMs:input.budget.maxDurationMs-(source.activeMs??input.budget.maxDurationMs),
    ...(input.budget.maxCostUsd===undefined?{}:{costUsd:input.budget.maxCostUsd-(source.usage.costUsd??0)})};
  if(remaining.durationMs<=0||(!checkpoint.canVerify&&(remaining.tokens<=0||remaining.toolCalls<=0))||(remaining.costUsd!==undefined&&remaining.costUsd<0))throw new HarnessError('budget_exhausted','No remaining budget for recovery');
  if(source.policy.digest!==JSON.parse(readFileSync(join(source.runDir,'policy.json'),'utf8')).digest)throw new HarnessError('policy_changed','Stored policy differs from frozen policy');
  return{profile,source,checkpoint,input,workspace,verifierScripts,context,mode:checkpoint.canVerify?'verify_only':'continue',remaining};
}
export function recoveryPlan(store:RunStore,id:string):Record<string,unknown>{
  try{const plan=resolveRecovery(store,id);return{eligible:true,sourceRunId:id,checkpointId:plan.checkpoint.checkpointId,mode:plan.mode,remaining:plan.remaining,
    operations:store.operations(id).map((operation)=>({tool:operation.toolName,attempt:operation.attempt,status:operation.status,sideEffects:operation.sideEffects})),sourceSessionId:plan.checkpoint.sourceSessionId};}
  catch(error){return{eligible:false,sourceRunId:id,reason:error instanceof HarnessError?error.code:'recovery_validation_failed',message:error instanceof Error?error.message:String(error)};}
}
