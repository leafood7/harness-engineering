import { Type,type Static } from 'typebox';
import { Check } from 'typebox/value';
import { readFileSync,readdirSync,lstatSync } from 'node:fs';
import { resolve,join,dirname,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskInput } from '../task.ts';
import { loadProfile } from '../strategy/catalog.ts';
import { canonical,digest,HarnessError } from '../util.ts';
const object={additionalProperties:false};
export const arms=['baseline','context','memory','combined'] as const;
export type Arm=typeof arms[number];
const positive=Type.Integer({minimum:1,maximum:1000000});
const Schema=Type.Object({profiles:Type.Optional(Type.Array(Type.String({pattern:'^[a-z][a-z0-9-]*\\.v[0-9]+$'}),{minItems:1,maxItems:4,uniqueItems:true})),schemaVersion:Type.Literal(1),suite:Type.String({minLength:1}),model:Type.Union([Type.Object({mode:Type.Literal('scripted')},object),Type.Object({mode:Type.Literal('live'),provider:Type.String({minLength:1}),id:Type.String({minLength:1}),apiKeyEnv:Type.String({pattern:'^[A-Za-z_][A-Za-z0-9_]*$'}),temperature:Type.Number({minimum:0,maximum:2})},object)]),cases:Type.Array(Type.String({pattern:'^[a-z][a-z0-9-]{0,63}$'}),{minItems:1,maxItems:20,uniqueItems:true}),arms:Type.Array(Type.Union(arms.map(arm=>Type.Literal(arm))),{minItems:1,maxItems:4,uniqueItems:true}),repeats:Type.Integer({minimum:1,maximum:10}),seed:Type.Integer({minimum:0,maximum:4294967295}),budget:Type.Object({maxEstimatedCostUsd:Type.Number({exclusiveMinimum:0,maximum:10}),maxTokens:positive},object),trialBudget:Type.Object({maxDurationMs:Type.Integer({minimum:1000,maximum:300000}),maxToolCalls:Type.Integer({minimum:1,maximum:32}),maxTokens:positive,maxCostUsd:Type.Number({exclusiveMinimum:0,maximum:1})},object),context:Type.Object({maxInputTokens:positive,outputReserveTokens:Type.Integer({minimum:64,maximum:8192}),toolResultMaxChars:Type.Integer({minimum:256,maximum:65536}),compactAtTokens:positive,keepRecentTokens:positive},object)},object);
export type BenchmarkConfig=Static<typeof Schema>;
export interface FixedCase {schemaVersion:1;id:string;category:'general'|'memory-dependent';prompt:string;checks:string[];offlineResponses:Extract<TaskInput['model'],{mode:'scripted'}>['responses'];followups?:string[];retention?:boolean;retentionProbe?:string;contextOverrides?:TaskInput['context'];memoryQuery?:string;memories?:Array<{content:string;relevant:boolean}>;}
export interface TrialSpec {profile?:string;key:string;caseId:string;arm:Arm;repetition:number;order:number;}
export const casesRoot=fileURLToPath(new URL('../../benchmarks/cases/',import.meta.url));
export function loadConfig(file:string):BenchmarkConfig {
 const config:unknown=JSON.parse(readFileSync(resolve(file),'utf8').replace(/^\uFEFF/,''));
 if(!Check(Schema,config))throw new HarnessError('invalid_benchmark','Benchmark configuration failed strict schema validation');
 if(config.cases.length*config.arms.length*config.repeats*(config.profiles?.length??1)>256)throw new HarnessError('invalid_benchmark','At most 256 trials are supported per batch');
 if(config.context.outputReserveTokens>=config.context.maxInputTokens || config.context.keepRecentTokens>=config.context.compactAtTokens)throw new HarnessError('invalid_benchmark','Context reserves and retained history must fit configured limits');
 for(const id of config.profiles??[])loadProfile(id);
 return config;
}
export function loadCase(id:string):FixedCase {
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(id))throw new HarnessError('invalid_case','Invalid case ID');
 const value=JSON.parse(readFileSync(join(casesRoot,id,'case.json'),'utf8')) as FixedCase;
 if(value.schemaVersion!==1 || value.id!==id || !['general','memory-dependent'].includes(value.category) || typeof value.prompt!=='string' || !Array.isArray(value.checks) || !value.checks.length || !value.checks.every(name=>typeof name==='string'&&/^[a-z-]+$/.test(name)) || !Array.isArray(value.offlineResponses))throw new HarnessError('invalid_case','Fixed case definition is malformed');
 return value;
}
export function fixedManifest(config:BenchmarkConfig):{suiteDigest:string;files:Array<{path:string;sha256:string}>} {
 const files:Array<{path:string;sha256:string}>=[];
 for(const id of config.cases){loadCase(id);const root=join(casesRoot,id);const walk=(dir:string):void=>{for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(dir,item.name);if(lstatSync(file).isSymbolicLink())throw new HarnessError('invalid_case','Symlinks are not accepted in fixed cases');if(item.isDirectory())walk(file);else files.push({path:relative(dirname(casesRoot),file).replaceAll('\\','/'),sha256:digest(readFileSync(file,'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n'))});}};walk(root);}
 return{suiteDigest:digest(canonical(files)),files};
}
export function trialPlan(config:BenchmarkConfig):TrialSpec[] {
 const trials:TrialSpec[]=[];
 for(let repetition=1;repetition<=config.repeats;repetition++)for(const caseId of config.cases)for(const arm of config.arms)for(const profile of config.profiles??['stable.v1'])trials.push({key:`${caseId}:${repetition}:${arm}`+(config.profiles?`:${profile}`:''),...(config.profiles?{profile}:{}),caseId,arm,repetition,order:0});
 let seed=config.seed>>>0;const random=():number=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 for(let i=trials.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[trials[i],trials[j]]=[trials[j],trials[i]];}
 return trials.map((trial,index)=>({...trial,order:index+1}));
}

export function runtimeManifest():{runtimeDigest:string;runtimeFiles:Array<{path:string;sha256:string}>}{
 const project=fileURLToPath(new URL('../../',import.meta.url));const files:Array<{path:string;sha256:string}>=[];
 const walk=(dir:string):void=>{for(const entry of readdirSync(join(project,dir),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(ts|mjs)$/.test(file))files.push({path:file.replaceAll('\\','/'),sha256:digest(readFileSync(join(project,file),'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n'))});}};
 for(const dir of ['src','contracts','bin'])walk(dir);for(const file of ['package.json','package-lock.json','tsconfig.json','strategies/profiles.json','strategies/review-policy.json'])files.push({path:file,sha256:digest(readFileSync(join(project,file),'utf8').replaceAll('\r\n','\n'))});
 return{runtimeDigest:digest(canonical(files)),runtimeFiles:files};
}
