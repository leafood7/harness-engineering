import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {loadProfile,strategyDigest} from '../src/strategy/catalog.ts';
import {BenchmarkStore,armFlags,failureClass} from '../src/benchmark/store.ts';
import {buildReport} from '../src/benchmark/report.ts';
import {loadCase,casesRoot,fixedManifest,runtimeManifest,type BenchmarkConfig,type TrialSpec} from '../src/benchmark/suite.ts';
import {RunStore} from '../src/state/store.ts';
import {runVerifier} from '../src/verification/verifier.ts';
import {canonical,digest} from '../src/util.ts';
import {readContext} from '../src/context/manager.ts';
const folder=resolve(process.argv[2]??'');assert(existsSync(join(folder,'benchmark.sqlite')),'Existing benchmark batch required');const store=new BenchmarkStore(folder);
try{
 const metadata=store.metadata(),config=metadata.config as BenchmarkConfig,plan=metadata.plan as TrialSpec[];assert.equal(metadata.status,'completed');assert.equal(fixedManifest(config).suiteDigest,metadata.suiteDigest);assert.equal(runtimeManifest().runtimeDigest,metadata.runtimeDigest);
 const rows=store.results();assert.equal(rows.length,plan.length);let checksReexecuted=0,verifiedRuns=0,failedRuns=0,scopeChecks=0;
 for(const row of rows){
   const spec=plan.find(item=>item.key===row.key)!;assert(spec);assert.equal(row.order,spec.order);const definition=loadCase(row.caseId),directory=join(folder,'trials',String(row.order).padStart(3,'0'));const state=new RunStore(join(directory,'state'));
   try{
    const run=state.get(row.runId!),verification=state.report(run.runId).verification,events=state.events(run.runId);const saved=JSON.parse(readFileSync(join(run.runDir,'task.json'),'utf8'));const flags=armFlags(row.arm);
    assert.equal(run.model.mode,config.model.mode);assert.deepEqual(saved.config.model,config.model.mode==='live'?config.model:{mode:'scripted',responses:definition.offlineResponses});assert.equal(saved.config.context.projection,flags.context?'bounded':'none');assert.equal(saved.config.context.compaction,flags.context?'evidence':'off');assert.equal(saved.config.strategy,spec.profile??'stable.v1');assert.deepEqual(saved.config.followups,definition.followups);const profile=loadProfile(spec.profile);assert.equal(run.strategy.digest,strategyDigest(profile));assert.deepEqual(JSON.parse(readFileSync(join(run.runDir,'strategy.json'),'utf8')),profile);if(run.status==='completed')assert.equal(run.nextPromptIndex,1+(definition.followups?.length??0));assert.equal(run.status,row.status);assert.equal(row.success,run.status==='completed'&&verification?.status==='passed');assert.equal(row.score,(verification?.checks.filter(check=>check.status==='passed').length??0)/definition.checks.length);assert.equal(row.failure,failureClass(run,verification?.status));assert.equal(row.tokens,run.usage.tokens);assert.equal(row.estimatedCostUsd,run.usage.costUsd);assert.equal(row.modelRequests,events.filter(event=>event.kind==='model.request').length);assert.equal(row.usageUncertain,!!run.modelInFlight||!!run.modelUsageUncertain);
    const operations=state.operations(run.runId),offers=events.filter(event=>event.kind==='read.correction_offered'),followups=events.filter(event=>event.kind==='read.correction_followup');
    assert.equal(row.readCorrectionOffers,offers.length);assert.equal(row.readCorrectionFollowups,followups.length);assert.equal(row.readInputErrors,operations.filter(op=>op.toolName==='read'&&op.status==='failed'&&['EISDIR','ENOENT','ENOTDIR'].includes(op.failure?.code??'')).length);assert.equal(run.readCorrectionsUsed,offers.length);assert(offers.length<=(profile.maxReadCorrections??0));assert.equal(run.usage.toolCalls,operations.length);
    const pending=new Set<string>();const targets=new Set<string>();
    for(const event of events){
      if(event.kind==='read.correction_offered'){
        const id=String(event.payload.toolCallId),operation=operations.filter(op=>op.toolName==='read'&&op.toolCallId===id&&op.status==='failed'&&(op.completedSequence??Infinity)<event.sequence).at(-1);assert(operation);assert.equal(operation.failure?.outcome,'no_effect');assert(['EISDIR','ENOENT','ENOTDIR'].includes(operation.failure?.code??''));assert.equal(event.payload.code,operation.failure?.code);assert.equal(targets.has(String(event.payload.targetDigest)),false);targets.add(String(event.payload.targetDigest));pending.add(id);assert.equal(event.payload.used,targets.size);
        assert(events.some(next=>next.sequence>event.sequence&&next.kind==='pi.tool_execution_end'&&next.payload.toolCallId===id&&next.payload.isError===true));
      }
      if(event.kind==='read.correction_followup'){
        const id=String(event.payload.toolCallId);assert(operations.some(op=>op.toolName==='read'&&op.toolCallId===id&&op.status==='succeeded'&&(op.completedSequence??Infinity)<event.sequence));for(const prior of event.payload.offeredCallIds as string[]){assert(pending.has(prior));pending.delete(prior);}
      }
    }
    assert.deepEqual([...(run.readCorrectionPending??[])].sort(),[...pending].sort());assert.deepEqual([...(run.readCorrectionTargets??[])].sort(),[...targets].sort());
    for(const reference of row.eventRefs)assert(events.some(event=>event.runId===reference.runId&&event.sequence===reference.sequence&&event.kind===reference.kind));
    const context=readContext(run.runDir);
    if(definition.retentionProbe){
      assert(!context.goal.includes(definition.retentionProbe));assert(!JSON.stringify(context.memories).includes(definition.retentionProbe));
      const final=events.filter(event=>event.kind==='prompt.started').at(-1);const count=events.filter(event=>event.kind==='context.compacted'&&event.sequence<(final?.sequence??0)).length;assert.equal(row.nativeCompactionsBeforeFinal,count);
      const checkpoint=state.checkpoints(run.runId).filter(cp=>cp.nextPromptIndex===(definition.followups?.length??0)&&cp.phase==='agent_settled').at(-1);
      const visible=checkpoint?.sessionSnapshot?JSON.stringify(SessionManager.open(checkpoint.sessionSnapshot).buildSessionContext().messages).includes(definition.retentionProbe):undefined;assert.equal(row.retainedProbeBeforeFinal,visible);
      if(final)assert(count>0,'Retention question must follow actual native compaction');
    }
    if(!flags.memory)assert.equal(context.memories.length,0);for(const memory of context.memories){assert.equal(memory.workspace,run.task!.workspace.path);assert(definition.memories?.some(entry=>entry.relevant&&entry.content===memory.content));scopeChecks++;}
    const initial=JSON.parse(readFileSync(join(run.runDir,'initial-workspace.json'),'utf8'));for(const file of initial.files){const original=readFileSync(join(casesRoot,row.caseId,'workspace',file.path),'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n');assert.equal(file.sha256,digest(original));}
    const expectedVerifier=readFileSync(join(casesRoot,row.caseId,'verify.cjs'),'utf8').replaceAll('\r\n','\n');const verdicts=[];
    for(const [index,name]of definition.checks.entries()){
     const frozen=join(run.runDir,'verification',`check-${index}.cjs`);assert.equal(readFileSync(frozen,'utf8'),expectedVerifier);const checked=await runVerifier(frozen,[name],run.task!.workspace.path,5000,new AbortController().signal);assert(checked.settled&&!checked.interrupted);const passed=checked.exitCode===0;verdicts.push(passed);checksReexecuted++;if(verification)assert.equal(passed,verification.checks[index].status==='passed');
    }
    if(row.success){assert(verdicts.every(Boolean));verifiedRuns++;}else failedRuns++;
   }finally{state.close();}
 }
 const report=buildReport(store);assert.equal(canonical(report),canonical(JSON.parse(readFileSync(join(folder,'report.json'),'utf8'))));const experiences=store.experiences();assert.equal(experiences.length,failedRuns);for(const record of experiences){assert.equal(record.diagnosis,null);assert.equal(record.diagnosisStatus,'not_established');assert.equal(record.eligibleForAutomaticPolicy,false);assert(record.evidence.length>0);}
 const audit={auditedAt:new Date().toISOString(),status:'passed',batchTrials:rows.length,independentChecksReexecuted:checksReexecuted,verifiedSuccessfulRuns:verifiedRuns,preservedFailedRuns:failedRuns,selectedMemoryScopeChecks:scopeChecks,experienceRecords:experiences.length,profiles:report.byProfile,retention:report.retentionByProfile,profileDecisions:report.profileComparisons.map(item=>({candidate:item.candidate,decision:item.decision,wins:item.wins.length,losses:item.losses.length,automaticAdoption:item.automaticAdoption})),runtimeDigest:metadata.runtimeDigest,suiteDigest:metadata.suiteDigest,knownEstimatedCostUsd:report.overall.knownEstimatedCostUsd,usageUncertain:report.overall.uncertainUsageTrials,notes:['Independent fixed checkers were rerun with model credentials absent from verifier subprocesses.','Post-hoc checks do not upgrade runs that failed before official verification.','Raw conversations, state and memory databases remain local.']};writeFileSync(join(folder,'audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit));
}finally{store.close();}
