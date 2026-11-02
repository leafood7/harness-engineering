import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {canonical,digest,HarnessError} from '../util.ts';
export interface StrategyProfile {id:string;status:'stable'|'candidate';instructions:string;summary:'index'|'anchored';readContract?:boolean;maxReadCorrections?:number;hypothesis:string|null;evidence:Array<Record<string,unknown>>;}
export function loadProfile(id='stable.v1'):StrategyProfile {
 const registry=JSON.parse(readFileSync(new URL('../../strategies/profiles.json',import.meta.url),'utf8')) as {schemaVersion:number;defaultProfile:string;profiles:StrategyProfile[]};
 if(registry.schemaVersion!==1||registry.defaultProfile!=='stable.v1')throw new HarnessError('invalid_strategy','Unsupported strategy registry or changed default');
 const profile=registry.profiles.find(profile=>profile.id===id);
 if(!profile||!['stable','candidate'].includes(profile.status)||!['index','anchored'].includes(profile.summary)||typeof profile.instructions!=='string'||profile.instructions.length>2000||!Array.isArray(profile.evidence))throw new HarnessError('invalid_strategy','Unknown or invalid bounded strategy profile');
 for(const evidence of profile.evidence){if(typeof evidence.baseline!=='string')throw new HarnessError('invalid_strategy','Strategy evidence must reference a baseline');const root=fileURLToPath(new URL('../../',import.meta.url));if((!evidence.baseline.startsWith('benchmarks/baselines/')&&!evidence.baseline.startsWith('benchmarks/experiments/'))||evidence.baseline.includes('..'))throw new HarnessError('invalid_strategy','Evidence must remain inside local baseline records');const report=JSON.parse(readFileSync(resolve(root,evidence.baseline),'utf8'));if(evidence.trialKey){const row=report.rows.find((row:{key:string})=>row.key===evidence.trialKey);if(!row||row.runId!==evidence.runId||!row.eventRefs.some((ref:{sequence:number})=>ref.sequence===evidence.sequence))throw new HarnessError('invalid_strategy','Candidate evidence reference is not present');}else if(evidence.limitation==='nativeCompactions=0; quality unmeasured'&&report.overall.nativeCompactions!==0)throw new HarnessError('invalid_strategy','Baseline limitation reference differs');}
 if(profile.readContract!==undefined&&typeof profile.readContract!=='boolean')throw new HarnessError('invalid_strategy','Read contract flag must be boolean');
 if(profile.maxReadCorrections!==undefined&&(!Number.isInteger(profile.maxReadCorrections)||profile.maxReadCorrections<0||profile.maxReadCorrections>2||(profile.maxReadCorrections>0&&!profile.readContract)))throw new HarnessError('invalid_strategy','Read input correction is limited to two under the file contract');
 if(id==='stable.v1'&&(profile.status!=='stable'||profile.instructions!==''||profile.summary!=='index'||profile.hypothesis!==null||profile.readContract||(profile.maxReadCorrections??0)!==0))throw new HarnessError('default_strategy_changed','Stable profile cannot be replaced by a candidate');
 if(id!=='stable.v1'&&(profile.status!=='candidate'||typeof profile.hypothesis!=='string'||!profile.hypothesis.trim()))throw new HarnessError('invalid_strategy','Candidate requires an unverified hypothesis');
 return structuredClone(profile);
}
export const strategyDigest=(profile:StrategyProfile):string=>digest(canonical(profile));
