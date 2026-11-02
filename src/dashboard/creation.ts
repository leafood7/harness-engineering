import {Type,type Static} from 'typebox';
import {Check,Errors} from 'typebox/value';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,realpathSync,statSync,existsSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateTask,type TaskInput} from '../task.ts';
import {loadProfile} from '../strategy/catalog.ts';
import {StrategyStore} from '../strategy/store.ts';
import {QueueStore} from '../queue/store.ts';
import {inside,snapshot,workspacePath} from '../util.ts';
const options={additionalProperties:false};
const DraftSchema=Type.Object({taskId:Type.String({pattern:'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'}),goal:Type.String({minLength:1,maxLength:16000}),workspace:Type.String({minLength:1,maxLength:2048}),strategy:Type.String({maxLength:80}),mode:Type.Union([Type.Literal('live'),Type.Literal('offline')]),provider:Type.String({maxLength:100}),modelId:Type.String({maxLength:200}),apiKeyEnv:Type.String({pattern:'^[A-Za-z_][A-Za-z0-9_]*$'}),tools:Type.Array(Type.Union([Type.Literal('read'),Type.Literal('write'),Type.Literal('edit'),Type.Literal('wait')]),{uniqueItems:true}),durationSeconds:Type.Integer({minimum:1,maximum:3600}),maxToolCalls:Type.Integer({minimum:0,maximum:10000}),maxTokens:Type.Integer({minimum:1,maximum:10000000}),maxCostUsd:Type.Union([Type.Null(),Type.Number({minimum:0,maximum:1000})]),checkKind:Type.Union([Type.Literal('file'),Type.Literal('node')]),outputPath:Type.String({maxLength:2048}),expected:Type.String({maxLength:16000}),scriptPath:Type.String({maxLength:2048}),checkTimeoutSeconds:Type.Integer({minimum:1,maximum:120})},options);
export type TaskDraft=Static<typeof DraftSchema>;
export interface Issue {field:string;message:string;}
const labels:Record<string,string>={taskId:'任务名称须为1–80位英文字母、数字、点、短横线或下划线',goal:'请填写任务目标（最多16000字）',workspace:'请填写工作目录的完整路径',apiKeyEnv:'请填写密钥环境变量的名称，而不是密钥值',durationSeconds:'执行时长须为1–3600秒',maxToolCalls:'工具次数须为0–10000',maxTokens:'Token上限须为1–10000000',maxCostUsd:'费用上限须为0–1000美元，或留空',checkTimeoutSeconds:'验收时长须为1–120秒'};
export function parseDraft(value:unknown):{draft?:TaskDraft;issues:Issue[]}{if(!Check(DraftSchema,value))return {issues:[...Errors(DraftSchema,value)].slice(0,12).map(error=>{const field=error.instancePath.split('/')[1]??'';return {field,message:labels[field]??`请检查${field||'任务'}配置`};})};if(!value.goal.trim())return {issues:[{field:'goal',message:'请填写实际的任务目标，不能只有空格'}]};return {draft:structuredClone(value),issues:[]};}
const catalogs=new Map<string,Promise<ModelRuntime>>();
async function runtime(root:string){let cached=catalogs.get(root);if(!cached){const directory=join(root,'form-catalog');mkdirSync(directory,{recursive:true});cached=ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),allowModelNetwork:false,refreshOnCreate:false});catalogs.set(root,cached);}return cached;}
export async function creationOptions(root:string){const models=(await runtime(root)).getModels().map(model=>({provider:model.provider,id:model.id,name:model.name}));const registry=JSON.parse(readFileSync(new URL('../../strategies/profiles.json',import.meta.url),'utf8'));const strategies=new StrategyStore(root);try{return {models,strategies:registry.profiles.map((p:{id:string})=>loadProfile(p.id)),currentStrategy:strategies.current().profile};}finally{strategies.close();}}
export async function validateDraft(root:string,value:unknown):Promise<{valid:boolean;issues:Issue[];task?:TaskInput;summary?:Record<string,unknown>}>{
 const parsed=parseDraft(value);if(!parsed.draft)return {valid:false,issues:parsed.issues};const d=parsed.draft,issues:Issue[]=[];let workspace=d.workspace;
 try{if(!isAbsolute(workspace))throw new Error('请填写绝对路径');workspace=realpathSync(workspace);if(!statSync(workspace).isDirectory())throw new Error('不是目录');if(inside(workspace,realpathSync(root)))throw new Error('任务数据目录不能位于工作目录中');snapshot(workspace);}catch(error){issues.push({field:'workspace',message:'工作目录不可用：'+(error instanceof Error?error.message:'请检查路径')});}
 try{if(d.strategy)loadProfile(d.strategy);}catch{issues.push({field:'strategy',message:'策略版本不存在或定义无效'});}
 let check:TaskInput['verification']['checks'][number]|undefined;
 if(d.checkKind==='file'){
  if(!d.outputPath.trim())issues.push({field:'outputPath',message:'请填写待验收文件的相对路径'});
  else try{if(isAbsolute(d.outputPath))throw new Error('使用相对路径');const target=workspacePath(workspace,d.outputPath);if(existsSync(target)&&!statSync(target).isFile()){issues.push({field:'outputPath',message:'验收目标必须是文件，不能选择目录'});}else check={kind:'file',name:'文件内容完全匹配',path:d.outputPath,equals:d.expected};}catch{issues.push({field:'outputPath',message:'验收文件必须位于任务工作目录内，请填写相对路径'});}
 }else{
  try{if(!d.scriptPath.trim())throw new Error('请选择脚本');const script=resolve(workspace,d.scriptPath);if(!script.endsWith('.cjs')||!statSync(script).isFile())throw new Error('需要可读取的 .cjs 文件');readFileSync(script);check={kind:'node',name:'独立脚本验收',script,args:[],timeoutMs:d.checkTimeoutSeconds*1000};}catch{issues.push({field:'scriptPath',message:'请提供可读取的 .cjs 验收脚本路径'});}
 }
 let model:TaskInput['model'];
 if(d.mode==='offline'){
  if(d.checkKind!=='file')issues.push({field:'checkKind',message:'离线写文件练习仅支持文件内容验收'});
  if(d.maxToolCalls<1)issues.push({field:'maxToolCalls',message:'离线写文件练习至少需要1次工具调用预算'});
  if(!d.tools.includes('write'))issues.push({field:'tools',message:'离线写文件练习需要允许“写入文件”'});
  model={mode:'scripted',responses:[{calls:[{name:'write',arguments:{path:d.outputPath,content:d.expected}}]},{text:'离线写文件步骤已执行，等待独立验收。'}]};
 }else{
  if(!(await runtime(root)).getModel(d.provider,d.modelId))issues.push({field:'modelId',message:'模型不在当前已安装 Pi 的本地目录中，请重新选择'});
  if(!process.env[d.apiKeyEnv])issues.push({field:'apiKeyEnv',message:`启动操作台的进程中缺少 ${d.apiKeyEnv}，配置后请重启操作台`});
  model={mode:'live',provider:d.provider,id:d.modelId,apiKeyEnv:d.apiKeyEnv};
 }
 if(issues.length||!check)return {valid:false,issues};
 const task=validateTask({schemaVersion:1,taskId:d.taskId,input:d.goal,workspace,tools:d.tools,budget:{maxDurationMs:d.durationSeconds*1000,maxToolCalls:d.maxToolCalls,maxTokens:d.maxTokens,...(d.maxCostUsd===null?{}:{maxCostUsd:d.maxCostUsd})},...(d.strategy?{strategy:d.strategy}:{}),model,verification:{version:'form.v1',checks:[check]}});
 return {valid:true,issues:[],task,summary:{taskId:task.taskId,workspace,model:d.mode==='offline'?'离线固定写文件练习':`${d.provider} / ${d.modelId}`,strategy:d.strategy||'开始执行时的当前策略',tools:d.tools,budget:task.budget,verification:d.checkKind==='file'?'文件内容完全匹配':'独立 Node 验收脚本',queuedOnly:true}};
}
export async function createFormTask(root:string,value:unknown,request?:{id:string;hash:string;source?:string}){const result=await validateDraft(root,value);if(!result.valid||!result.task)return result;const directory=join(root,'form-inputs');mkdirSync(directory,{recursive:true});const file=join(directory,randomUUID()+'.json');writeFileSync(file,JSON.stringify(result.task,null,2));const queue=new QueueStore(root);try{return {...result,jobs:queue.submit([file],request)};}finally{queue.close();}}
export class TemplateStore{
 db:DatabaseSync;
 constructor(root:string){mkdirSync(root,{recursive:true});this.db=new DatabaseSync(join(root,'templates.sqlite'));this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,draft TEXT NOT NULL,createdAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS template_versions(id TEXT PRIMARY KEY,family TEXT NOT NULL,revision INTEGER NOT NULL,UNIQUE(family,revision)); CREATE TABLE IF NOT EXISTS template_names(family TEXT PRIMARY KEY,name TEXT NOT NULL)');}
 close(){this.db.close();}
 list():Array<{id:string;name:string;createdAt:string;family:string;revision:number}>{return this.db.prepare('SELECT t.id,COALESCE(n.name,t.name) AS name,t.createdAt,COALESCE(v.family,t.id) AS family,COALESCE(v.revision,1) AS revision FROM templates t LEFT JOIN template_versions v ON v.id=t.id LEFT JOIN template_names n ON n.family=COALESCE(v.family,t.id) ORDER BY t.rowid DESC').all() as Array<{id:string;name:string;createdAt:string;family:string;revision:number}>;}
 get(id:string){const row=this.db.prepare('SELECT * FROM templates WHERE id=?').get(id) as {id:string;name:string;draft:string;createdAt:string}|undefined;if(!row)throw new Error('模板不存在');const info=this.list().find(t=>t.id===id)!;return {...row,...info,draft:JSON.parse(row.draft) as TaskDraft};}
 rename(id:string,name:unknown){if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('模板名称须为1–80字');const template=this.get(id);this.db.prepare('INSERT INTO template_names VALUES(?,?) ON CONFLICT(family) DO UPDATE SET name=excluded.name').run(template.family,name.trim());return this.get(id);}
 version(id:string,value:unknown){const parsed=parseDraft(value);if(!parsed.draft)throw new Error(parsed.issues.map(i=>i.message).join('；'));if(parsed.draft.strategy)loadProfile(parsed.draft.strategy);this.db.exec('BEGIN IMMEDIATE');try{const source=this.get(id),revision=Math.max(...this.list().filter(t=>t.family===source.family).map(t=>t.revision))+1,newId=randomUUID();this.db.prepare('INSERT INTO templates VALUES(?,?,?,?)').run(newId,source.name,JSON.stringify(parsed.draft),new Date().toISOString());this.db.prepare('INSERT INTO template_versions VALUES(?,?,?)').run(newId,source.family,revision);this.db.exec('COMMIT');return this.get(newId);}catch(error){this.db.exec('ROLLBACK');throw error;}}
 save(name:unknown,value:unknown){if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('模板名称须为1–80字');const parsed=parseDraft(value);if(!parsed.draft)throw new Error(parsed.issues.map(i=>i.message).join('；'));if(parsed.draft.strategy)loadProfile(parsed.draft.strategy);const id=randomUUID();this.db.prepare('INSERT INTO templates VALUES(?,?,?,?)').run(id,name.trim(),JSON.stringify(parsed.draft),new Date().toISOString());return this.get(id);}
}
