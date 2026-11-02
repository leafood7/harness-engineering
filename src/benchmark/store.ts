import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Run } from '../../contracts/index.ts';
import type { Arm,TrialSpec } from './suite.ts';
import { canonical,digest,now } from '../util.ts';
export interface TrialResult extends TrialSpec {
 readCorrectionOffers?:number;readCorrectionFollowups?:number;readInputErrors?:number;
 retention?:boolean;retainedProbeBeforeFinal?:boolean;nativeCompactionsBeforeFinal?:number;
 category:'general'|'memory-dependent';runId?:string;status:string;success:boolean;score:number;checksPassed:number;checksTotal:number;
 durationMs:number;tokens:number|null;estimatedCostUsd:number|null;usageUncertain:boolean;toolCalls:number;modelRequests:number;
 projectedRequests:number;nativeCompactions:number;maxProjectedBytes:number|null;retrieval:{selected:number;relevant:number;availableRelevant:number;precision:number|null;recall:number|null};
 failure?:string;verificationRef?:string;eventRefs:Array<{runId:string;sequence:number;kind:string}>;
}
export interface Experience {trialKey:string;runId?:string;classification:string;observedChecks:string[];evidence:TrialResult['eventRefs'];diagnosis:null;diagnosisStatus:'not_established';eligibleForAutomaticPolicy:false;}
export class BenchmarkStore {
 db:DatabaseSync;
 constructor(folder:string){mkdirSync(folder,{recursive:true});this.db=new DatabaseSync(join(folder,'benchmark.sqlite'));this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS trials(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS experiences(id TEXT PRIMARY KEY,body TEXT NOT NULL);');}
 close():void{this.db.close();}
 metadata():Record<string,unknown>{const row=this.db.prepare("SELECT body FROM metadata WHERE id='batch'").get() as {body:string}|undefined;if(!row)throw new Error('Batch metadata is missing');return JSON.parse(row.body) as Record<string,unknown>;}
 create(metadata:Record<string,unknown>):void{this.db.prepare("INSERT INTO metadata(id,body) VALUES('batch',?)").run(JSON.stringify({...metadata,createdAt:now()}));}
 beginTrial(spec:TrialSpec):void{const meta=this.metadata();this.db.prepare("UPDATE metadata SET body=? WHERE id='batch'").run(JSON.stringify({...meta,activeTrial:spec}));}
 finish(status:string):void{const meta=this.metadata();this.db.prepare("UPDATE metadata SET body=? WHERE id='batch'").run(JSON.stringify({...meta,status,finishedAt:now()}));}
 save(result:TrialResult,experience?:Experience):void{this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO trials(id,body,digest) VALUES(?,?,?)').run(result.key,JSON.stringify(result),digest(canonical(result)));if(experience)this.db.prepare('INSERT INTO experiences(id,body) VALUES(?,?)').run(result.key,JSON.stringify(experience));const meta=this.metadata();delete meta.activeTrial;this.db.prepare("UPDATE metadata SET body=? WHERE id='batch'").run(JSON.stringify(meta));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 results():TrialResult[]{return(this.db.prepare('SELECT body,digest FROM trials').all() as {body:string;digest:string}[]).map(row=>{const body=JSON.parse(row.body) as TrialResult;if(digest(canonical(body))!==row.digest)throw new Error('Trial result integrity check failed');return body;}).sort((a,b)=>a.order-b.order);}
 experiences():Experience[]{return(this.db.prepare('SELECT body FROM experiences').all() as {body:string}[]).map(row=>JSON.parse(row.body) as Experience);}
}
export function failureClass(run:Pick<Run,'status'|'error'>,verificationStatus?:string):string|undefined {
 if(run.status==='completed' && verificationStatus==='passed')return undefined;
 const category=run.error?.category;
 if(category==='verification_failed')return 'independent_verification_failed';
 if(category==='missing_api_key')return 'configuration';
 if(category==='model_error'||category==='model_aborted')return 'model_or_provider';
 if(category==='context_budget_exceeded')return 'context_capacity';
 if(category?.includes('budget'))return 'budget';
 if(category?.startsWith('tool_'))return 'tool_execution';
 if(category==='cancelled'||run.status==='cancelled')return 'cancelled';
 return category??'incomplete_run';
}
export function armFlags(arm:Arm):{context:boolean;memory:boolean}{return{context:arm==='context'||arm==='combined',memory:arm==='memory'||arm==='combined'};}
