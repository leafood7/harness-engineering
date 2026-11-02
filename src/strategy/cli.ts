import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadProfile,strategyDigest} from './catalog.ts';
import {StrategyStore} from './store.ts';
import {BenchmarkStore} from '../benchmark/store.ts';
import {profileReport,compareProfiles} from '../benchmark/report.ts';
export function strategyCommand(args:string[],defaultState=resolve('.harness')):unknown{
 const positional:string[]=[];let state=defaultState,reason='',revision:number|undefined;
 for(let i=0;i<args.length;i++){
  const value=args[i];
  if(['--state','--reason','--expected-revision'].includes(value)){
   const next=args[++i];if(!next||next.startsWith('--'))throw new Error(`${value} requires a value`);
   if(value==='--state')state=resolve(next);else if(value==='--reason')reason=next;else {revision=Number(next);if(!Number.isSafeInteger(revision)||revision<0)throw new Error('Invalid revision');}
  }else if(value.startsWith('--'))throw new Error(`Unknown option: ${value}`);else positional.push(value);
 }
 const [action,target]=positional;
 if(action==='compare'&&target&&positional.length===2){const store=new BenchmarkStore(resolve(target));try{const meta=store.metadata();return profileReport(store.results(),meta.status==='completed',meta.reviewPolicy as Parameters<typeof compareProfiles>[2]|undefined);}finally{store.close();}}
 const store=new StrategyStore(state);
 try{
  if(action==='list'&&positional.length===1){const registry=JSON.parse(readFileSync(new URL('../../strategies/profiles.json',import.meta.url),'utf8'));return{defaultProfile:'stable.v1',current:store.current(),profiles:registry.profiles.map((entry:{id:string})=>({ ...loadProfile(entry.id),digest:strategyDigest(loadProfile(entry.id))})),automaticAdoption:false};}
  if(action==='inspect'&&target&&positional.length===2){const profile=loadProfile(target);return{profile,digest:strategyDigest(profile)};}
  if(action==='current'&&positional.length===1)return store.current();
  if(action==='history'&&positional.length===1)return store.history();
  if(action==='switch'&&target&&positional.length===2)return store.change('switch',target,reason,revision);
  if(action==='rollback'&&positional.length===1)return store.change('rollback',undefined,reason,revision);
  throw new Error('strategy list | inspect <id> | current | history | switch <id> --reason <text> | rollback --reason <text> [--state <directory>] [--expected-revision <number>] | compare <batch>');
 }finally{store.close();}
}
