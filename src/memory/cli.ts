import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryStore, type MemoryInput } from './store.ts';
export function memoryCommand(argv: string[], defaultState: string): unknown {
  const args:string[]=[];let state=defaultState;let revision:number|undefined;let actor:string|undefined;
  for(let i=0;i<argv.length;i++){
    const item=argv[i];
    if(['--state','--revision','--actor'].includes(item)){
      const value=argv[++i];if(!value || value.startsWith('--'))throw new Error(`${item} requires a value`);
      if(item==='--state')state=resolve(value);else if(item==='--revision')revision=Number(value);else actor=value;
    } else if(item.startsWith('--'))throw new Error(`Unknown memory option: ${item}`);else args.push(item);
  }
  const [command,target,extra]=args;
  const counts:Record<string,number>={put:2,revise:3,retire:2,search:3,history:2};
  if(!command || counts[command]!==args.length)throw new Error('memory put <input.json> | revise <id> <input.json> --revision N | retire <id> --revision N --actor name | search <workspace> <query> | history <id>; all accept --state');
  if(['revise','retire'].includes(command)&&(revision===undefined || !Number.isSafeInteger(revision) || revision<1))throw new Error('--revision must be a positive integer');
  const store=new MemoryStore(state);
  const input=(file:string)=>JSON.parse(readFileSync(resolve(file),'utf8').replace(/^\uFEFF/,'')) as MemoryInput;
  try{
    if(command==='put')return {memory:store.put(input(target!))};
    if(command==='revise')return {memory:store.revise(target!,revision!,input(extra!))};
    if(command==='retire')return {memory:store.retire(target!,revision!,actor??'')};
    if(command==='search')return {memories:store.search(target!,extra!)};
    return {revisions:store.history(target!)};
  }finally{store.close();}
}
