import {statSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {TSchema} from 'typebox';
import {ToolExecutionError} from './tool-errors.ts';
import {HarnessError,digest,workspacePath} from '../util.ts';
export interface ReadCorrectionState {used:number;targets:string[];pending:string[];}
export interface CorrectionResult {content:Array<{type:'text';text:string}>;details:Record<string,unknown>;isError:true;}
export function fileReadContract<T extends TSchema,D>(definition:ToolDefinition<T,D>,workspace:string):ToolDefinition<T,D>{
 return {...definition,description:definition.description+' Host contract: read accepts a regular FILE path, never a directory or workspace root. Directory listing is unsupported. Use filenames supplied by the task. When a structured read-input error is returned, choose a different valid file path rather than repeating the failed target.',execute:async(id,params,signal,onUpdate,ctx)=>{
  const raw=(params as Record<string,unknown>).path;
  if(typeof raw!=='string')throw new HarnessError('scope_denied','Read requires a workspace file path');
  const target=workspacePath(workspace,raw);const status=statSync(target);
  if(!status.isFile())throw Object.assign(new Error(status.isDirectory()?'READ_EXPECTED_FILE: read accepts a regular file, not a directory; directory listing is unsupported. Choose a file named by the task.':'READ_UNSUPPORTED_TARGET: only regular files are supported.'),{code:status.isDirectory()?'EISDIR':'EINVAL'});
  return definition.execute(id,params,signal,onUpdate,ctx);
 }};
}
export function correctableReadFailure(error:unknown):error is ToolExecutionError{return error instanceof ToolExecutionError&&error.failure.outcome==='no_effect'&&['EISDIR','ENOENT','ENOTDIR'].includes(error.failure.code??'')&&['invalid_input','not_found'].includes(error.failure.category);}
export class ReadCorrectionGate {
 private state:ReadCorrectionState;private accepted=new Set<string>();private workspace:string;private limit:number;private persist:(next:ReadCorrectionState,kind:string,payload:Record<string,unknown>)=>void;
 constructor(workspace:string,limit:number,initial:ReadCorrectionState,persist:(next:ReadCorrectionState,kind:string,payload:Record<string,unknown>)=>void){
  validateReadCorrectionState(limit,initial);
  this.workspace=workspace;this.limit=limit;this.persist=persist;this.state=structuredClone(initial);
 }
 offer(toolCallId:string,args:Record<string,unknown>,error:unknown,signal:AbortSignal):CorrectionResult|undefined{
  if(!this.limit||signal.aborted||!correctableReadFailure(error))return undefined;
  const failure=error.failure;
  if(failure.outcome!=='no_effect'||!['EISDIR','ENOENT','ENOTDIR'].includes(failure.code??'')||!['invalid_input','not_found'].includes(failure.category))return undefined;
  if(typeof args.path!=='string')return undefined;
  const target=workspacePath(this.workspace,args.path);let canonical=resolve(target);try{canonical=realpathSync(target);}catch{/* Missing file identity is its scoped absolute path. */}
  const key=digest(process.platform==='win32'?canonical.toLowerCase():canonical);
  if(this.state.targets.includes(key))throw new HarnessError('read_correction_repeated','The same invalid read target failed again; refusing an error loop');
  if(this.state.used>=this.limit)throw new HarnessError('read_correction_limit','Read input correction allowance exhausted');
  const next={used:this.state.used+1,targets:[...this.state.targets,key],pending:[...this.state.pending,toolCallId]};
  this.persist(next,'read.correction_offered',{toolCallId,code:failure.code,category:failure.category,outcome:'no_effect',targetDigest:key,used:next.used,limit:this.limit});this.state=next;this.accepted.add(toolCallId);
  return{isError:true,content:[{type:'text',text:JSON.stringify({error:{tool:'read',code:failure.code,category:failure.category,outcome:'no_effect'},correction:{remaining:this.limit-next.used,expected:'existing regular file inside the task workspace',hint:failure.code==='EISDIR'?'The target is a directory. Directory listing is unsupported. Read a file named in the task.':'The file or an intermediate directory was not found. Use an alternative filename explicitly available in the task or known evidence. Do not guess private settings.',repeatSameTarget:false}})}],details:{harnessReadCorrection:{toolCallId,code:failure.code,remaining:this.limit-next.used}}};
 }
 consumeError(id:string):boolean{return this.accepted.delete(id);}
 successfulRead(id:string):void{if(!this.state.pending.length)return;const prior=[...this.state.pending];const next={...this.state,pending:[]};this.persist(next,'read.correction_followup',{toolCallId:id,offeredCallIds:prior});this.state=next;}
 snapshot():ReadCorrectionState{return structuredClone(this.state);}
}

export function validateReadCorrectionState(limit:number,initial:ReadCorrectionState):void{
 if(!Array.isArray(initial.targets)||!Array.isArray(initial.pending))throw new HarnessError('invalid_correction_state','Correction ledger arrays are missing');
 if(!Number.isInteger(limit)||limit<0||limit>2||!Number.isInteger(initial.used)||initial.used<0||initial.used>limit||new Set(initial.targets).size!==initial.targets.length||initial.targets.length!==initial.used||initial.targets.some(key=>! /^[a-f0-9]{64}$/.test(key))||new Set(initial.pending).size!==initial.pending.length||initial.pending.length>initial.used||initial.pending.some(id=>typeof id!=='string'||!id))throw new HarnessError('invalid_correction_state','Read correction allowance cannot be reset or enlarged');
}
