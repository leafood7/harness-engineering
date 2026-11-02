import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
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
    assert.equal(run.model.mode,config.model.mode);assert.deepEqual(saved.config.model,config.model.mode==='live'?config.model:{mode:'scripted',responses:definition.offlineResponses});assert.equal(saved.config.context.projection,flags.context?'bounded':'none');assert.equal(saved.config.context.compaction,flags.context?'evidence':'off');assert.equal(run.status,row.status);assert.equal(row.success,run.status==='completed'&&verification?.status==='passed');assert.equal(row.score,(verification?.checks.filter(check=>check.status==='passed').length??0)/definition.checks.length);assert.equal(row.failure,failureClass(run,verification?.status));assert.equal(row.tokens,run.usage.tokens);assert.equal(row.estimatedCostUsd,run.usage.costUsd);assert.equal(row.modelRequests,events.filter(event=>event.kind==='model.request').length);assert.equal(row.usageUncertain,!!run.modelInFlight||!!run.modelUsageUncertain);
    for(const reference of row.eventRefs)assert(events.some(event=>event.runId===reference.runId&&event.sequence===reference.sequence&&event.kind===reference.kind));
    const context=readContext(run.runDir);if(!flags.memory)assert.equal(context.memories.length,0);for(const memory of context.memories){assert.equal(memory.workspace,run.task!.workspace.path);assert(definition.memories?.some(entry=>entry.relevant&&entry.content===memory.content));scopeChecks++;}
    const initial=JSON.parse(readFileSync(join(run.runDir,'initial-workspace.json'),'utf8'));for(const file of initial.files){const original=readFileSync(join(casesRoot,row.caseId,'workspace',file.path),'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n');assert.equal(file.sha256,digest(original));}
    const expectedVerifier=readFileSync(join(casesRoot,row.caseId,'verify.cjs'),'utf8').replaceAll('\r\n','\n');const verdicts=[];
    for(const [index,name]of definition.checks.entries()){
     const frozen=join(run.runDir,'verification',`check-${index}.cjs`);assert.equal(readFileSync(frozen,'utf8'),expectedVerifier);const checked=await runVerifier(frozen,[name],run.task!.workspace.path,5000,new AbortController().signal);assert(checked.settled&&!checked.interrupted);const passed=checked.exitCode===0;verdicts.push(passed);checksReexecuted++;if(verification)assert.equal(passed,verification.checks[index].status==='passed');
    }
    if(row.success){assert(verdicts.every(Boolean));verifiedRuns++;}else failedRuns++;
   }finally{state.close();}
 }
 const report=buildReport(store);assert.equal(canonical(report),canonical(JSON.parse(readFileSync(join(folder,'report.json'),'utf8'))));const experiences=store.experiences();assert.equal(experiences.length,failedRuns);for(const record of experiences){assert.equal(record.diagnosis,null);assert.equal(record.diagnosisStatus,'not_established');assert.equal(record.eligibleForAutomaticPolicy,false);assert(record.evidence.length>0);}
 const audit={auditedAt:new Date().toISOString(),status:'passed',batchTrials:rows.length,independentChecksReexecuted:checksReexecuted,verifiedSuccessfulRuns:verifiedRuns,preservedFailedRuns:failedRuns,selectedMemoryScopeChecks:scopeChecks,experienceRecords:experiences.length,runtimeDigest:metadata.runtimeDigest,suiteDigest:metadata.suiteDigest,knownEstimatedCostUsd:report.overall.knownEstimatedCostUsd,usageUncertain:report.overall.uncertainUsageTrials,notes:['Independent fixed checkers were rerun with model credentials absent from verifier subprocesses.','Post-hoc checks do not upgrade runs that failed before official verification.','Raw conversations, state and memory databases remain local.']};writeFileSync(join(folder,'audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit));
}finally{store.close();}
