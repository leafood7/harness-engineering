import {ExperienceStore} from '../experience/store.ts';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFileSync,openSync,closeSync,fstatSync,readSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve,isAbsolute,basename} from 'node:path';
import {QueueStore,alive,type Job} from '../queue/store.ts';
import {reconcile,startScheduler} from '../queue/scheduler.ts';
import {RunStore} from '../state/store.ts';
import {createDemo} from '../demo.ts';
import {terminal,HarnessError,workspacePath,canonical,digest} from '../util.ts';
import {reconcileRuns,runRow,recoveryView,launchRecovery,lineage,fileChanges} from './records.ts';
import {validateTask} from '../task.ts';
import {creationOptions,validateDraft,createFormTask,TemplateStore} from './creation.ts';
import {DashboardStore,sourceConfig,taskToDraft,enqueueConfig,storageInventory} from './management.ts';
import {outputList,outputFile,verificationDetails} from '../state/artifacts.ts';
import {WorkspaceLeases,overlaps} from '../state/workspace-leases.ts';
import {StrategyStore} from '../strategy/store.ts';
import type {Run} from '../../contracts/index.ts';

export async function startDashboard(stateRoot:string,port=4318){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Port must be 0–65535');
 const root=resolve(stateRoot),queue=new QueueStore(root);queue.close();
 const startedAt=new Date().toISOString(),version=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
 const compatibility=new QueueStore(root),oldScheduler=compatibility.scheduler();let upgradeNotice:string|null=null;try{if(oldScheduler&&alive(oldScheduler.pid)&&oldScheduler.version!==version){compatibility.stop();upgradeNotice='已停止旧版本调度器继续派发，原任务继续运行；请在退出后启动新版调度器。';}}finally{compatibility.close();}
 const token=randomBytes(32).toString('hex');
 const secrets=Object.entries(process.env).filter(([name,value])=>/key|token|secret|password|credential/i.test(name)&&value&&value.length>=8).map(([,value])=>value!);
 const redact=(value:unknown):unknown=>{
  if(typeof value==='string'){let text=value;for(const secret of secrets)text=text.split(secret).join('[redacted]');return text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi,'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{16,}/g,'[redacted]');}
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(authorization|password|secret|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)?'[redacted]':redact(item)]));
  return value;
 };
 function getRun(store:RunStore,id:string):Run|undefined{try{return store.get(id);}catch(error){if(error instanceof HarnessError&&error.code==='run_not_found')return;throw error;}}
 function row(job:Job,store:RunStore){const run=getRun(store,job.runId);return {...job,kind:'queue',phase:run?.status??job.status,usage:run?.usage??null,strategy:run?.strategy.version??null,completedPrompts:run?.nextPromptIndex??0,runError:run?.error??null,exportErrors:run?.exportErrors??[],cancelRequested:!!job.cancelled};}
 function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(redact(value)));}
 async function body(req:IncomingMessage):Promise<Record<string,unknown>>{const chunks:Buffer[]=[];let size=0;for await(const part of req){const bytes=Buffer.from(part);size+=bytes.length;if(size>262144)throw new Error('请求内容过大');chunks.push(bytes);}const result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('请求格式不正确');return result;}
 function logTail(id:string,queued=true){const path=workspacePath(root,join('logs',queued?`queue-${id}.log`:`${id}.log`));let fd:number;try{fd=openSync(path,'r');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {text:'',truncated:false};throw error;}
  try{const size=fstatSync(fd).size,limit=65536+Math.max(4096,...secrets.map(s=>Buffer.byteLength(s))),buffer=Buffer.alloc(Math.min(size,limit));readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));let raw=buffer.toString('utf8');if(size>buffer.length){const newline=raw.indexOf('\n');raw=newline<0?'日志末行过长，请查看本地日志文件。':raw.slice(newline+1);}const text=String(redact(raw)).slice(-65536);return {text,truncated:size>65536};}finally{closeSync(fd);}}
 let origin='';let startPending=false;
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   if(req.headers.host!==new URL(origin).host){json(res,403,{error:'仅允许通过本机操作台地址访问'});return;}
   if(req.headers.origin&&req.headers.origin!==origin){json(res,403,{error:'拒绝来自其他页面的请求'});return;}
   const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method;
   if(method==='GET'&&['/','/app.js','/management.js','/experience.js','/styles.css'].includes(path)){
    const name=path==='/'?'index.html':path.slice(1);res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});res.end(readFileSync(new URL(`../../apps/dashboard/${name}`,import.meta.url)));return;
   }
   if(!path.startsWith('/api/')){json(res,404,{error:'页面不存在'});return;}
   if(method!=='GET'&&(method!=='POST'||req.headers['x-harness-token']!==token||req.headers.origin!==origin)){json(res,403,{error:'操作来源校验失败，请刷新页面'});return;}
   const store=new QueueStore(root),runs=new RunStore(root),management=new DashboardStore(root);
   try{
    reconcile(store);reconcileRuns(runs);
    const experienceRun=/^\/api\/runs\/([0-9a-f-]{36})\/experience(?:\/(feedback|collect|suggestions))?$/.exec(path);
    const experienceCandidate=/^\/api\/experience\/([0-9a-f-]{36})(?:\/(history|change))?$/.exec(path);
    if(experienceRun||experienceCandidate){const experience=new ExperienceStore(root);try{
     if(experienceRun){const id=experienceRun[1],verb=experienceRun[2];if(method==='GET'&&!verb){json(res,200,experience.overview(id));return;}
      if(method==='POST'){const data=await body(req);if(verb==='feedback'){json(res,201,experience.feedback(id,data.note));return;}if(verb==='collect'){json(res,201,experience.collect(id));return;}if(verb==='suggestions'){if(typeof data.packetId!=='string'||experience.packet(data.packetId).runId!==id)throw new Error('证据包不属于当前执行');json(res,201,experience.save(data.packetId,data.candidates));return;}}}
     if(experienceCandidate){const id=experienceCandidate[1];if(method==='GET'){json(res,200,experienceCandidate[2]==='history'?experience.history(id):experience.get(id));return;}if(method==='POST'&&experienceCandidate[2]==='change'){const data=await body(req);json(res,200,experience.change(id,data.revision,data.action,data.proposal));return;}}
     throw new Error('不支持的经验操作');
    }finally{experience.close();}}
    if(method==='GET'&&path==='/api/service'){const strategy=new StrategyStore(root);try{json(res,200,{version,upgradeNotice:store.scheduler()?.version===version?null:upgradeNotice,node:process.version,startedAt,stateRoot:root,url:origin,defaultBudget:management.defaults(),strategy:strategy.current(),credentialStatus:['DEEPSEEK_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'].map(name=>({name,configured:!!process.env[name]})),storage:storageInventory(root)});}finally{strategy.close();}return;}
    if(method==='POST'&&path==='/api/service/stop'){res.once('finish',()=>server.close());json(res,200,{message:'页面服务正在关闭，后台任务及调度器继续运行'});return;}
    if(method==='POST'&&path==='/api/defaults'){const data=await body(req);const defaults=management.saveDefaults(data.budget,false);if(typeof data.strategy==='string'){const strategy=new StrategyStore(root);try{if(strategy.current().profile!==data.strategy)strategy.change('switch',data.strategy,'通过任务操作台手动设置默认策略',typeof data.revision==='number'?data.revision:undefined);}finally{strategy.close();}}management.saveDefaults(defaults);json(res,200,{defaults,message:'默认配置已保存，仅影响后续新任务'});return;}
    if(path==='/api/draft-state'){if(method==='GET'){json(res,200,management.draft(url.searchParams.get('id')??'current'));return;}if(method==='POST'){const data=await body(req);if(typeof data.id!=='string'||!data.id.trim())throw new Error('草稿标识不能为空');const clock=typeof data.clock==='number'?data.clock:undefined;const saved=data.clear?management.clearDraft(data.id,clock):management.saveDraft(data.id,data.draft,clock);json(res,200,{saved});return;}}
    if(method==='POST'&&path==='/api/maintenance'){const result=management.maintenance();const old=store.db.prepare("DELETE FROM queue_requests WHERE at<? AND NOT EXISTS (SELECT 1 FROM json_each(queue_requests.body) item JOIN jobs j ON j.id=item.value WHERE j.status NOT IN ('completed','failed','cancelled','interrupted'))").run(new Date(Date.now()-30*86400000).toISOString());json(res,200,{...result,expiredQueueReceipts:Number(old.changes)});return;}
    if(method==='POST'&&path==='/api/bulk'){
     const data=await body(req);if(!Array.isArray(data.ids)||!data.ids.length||data.ids.length>100||!data.ids.every(id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id)))throw new Error('请选择1–100项记录');if(!['cancel','archive','unarchive','export'].includes(String(data.action)))throw new Error('批量操作无效');const results=[];
     for(const id of data.ids as string[]){try{const job=store.list().find(j=>j.runId===id),run=getRun(runs,id);if(!job&&!run)throw new Error('记录不存在');if(data.action==='cancel'){if(job)store.cancel(job.id);if(run)runs.requestCancel(id);}else if(data.action==='archive'||data.action==='unarchive'){if(data.action==='archive'&&!terminal(job?.status??run!.status))throw new Error('请先停止任务，再归档');management.archive(id,data.action==='archive');}results.push({runId:id,ok:true,...(data.action==='export'?{record:run?{run,verification:runs.verification(id),origin:management.origin(id)}:{job}}:{})});}catch(error){results.push({runId:id,ok:false,error:error instanceof Error?error.message:'操作失败'});}}
     json(res,200,{results,message:`已处理 ${results.filter(r=>r.ok).length} 项，失败 ${results.filter(r=>!r.ok).length} 项`});return;
    }
    const taskAction=/^\/api\/tasks\/([0-9a-f-]{36})\/(move|replace|config)$/.exec(path);
    if(taskAction){const job=store.get(taskAction[1]);if(method==='GET'&&taskAction[2]==='config'){const source=sourceConfig(root,job.runId);json(res,200,{...source,draft:taskToDraft(source.task),origin:management.origin(job.runId)});return;}if(method==='POST'){const data=await body(req);if(taskAction[2]==='move'){json(res,200,{jobs:store.move(job.id,String(data.direction))});return;}if(taskAction[2]==='replace'){const valid=await validateDraft(root,data.draft);if(!valid.valid){json(res,422,valid);return;}const dir=join(root,'form-inputs');mkdirSync(dir,{recursive:true});const file=join(dir,randomBytes(16).toString('hex')+'.json');writeFileSync(file,JSON.stringify(valid.task));json(res,200,{jobs:[store.replace(job.id,file,String(data.expectedHash))],message:'等待任务配置已更新，旧版本仍保留'});return;}}}
    if(method==='GET'&&['/api/tasks','/api/records'].includes(path)){
     const status=url.searchParams.get('status')??'all',query=(url.searchParams.get('q')??'').toLowerCase().slice(0,200),offset=Number(url.searchParams.get('offset')??0);
     if(!Number.isSafeInteger(offset)||offset<0)throw new Error('无效的分页位置');
     const jobs=store.list(),queued=jobs.filter(j=>j.status==='queued'),bound=new Set(jobs.map(j=>j.runId)),rows=jobs.map(job=>({...row(job,runs),kind:'queue',queuePosition:queued.findIndex(j=>j.id===job.id)+1,canMoveUp:queued.findIndex(j=>j.id===job.id)>0,canMoveDown:queued.findIndex(j=>j.id===job.id)>=0&&queued.findIndex(j=>j.id===job.id)<queued.length-1}));if(path==='/api/records')for(const entry of runs.db.prepare('SELECT body FROM runs').all() as {body:string}[]){const run=JSON.parse(entry.body) as Run;if(!bound.has(run.runId))rows.push(runRow(run) as typeof rows[number]);}const archive=management.archived();const archiveMode=url.searchParams.get('archived')??'exclude',kind=url.searchParams.get('kind')??'all',since=url.searchParams.get('since'),until=url.searchParams.get('until');if((since&&Number.isNaN(Date.parse(since)))||(until&&Number.isNaN(Date.parse(until))))throw new Error('日期无效');if(since&&until&&Date.parse(since)>Date.parse(until))throw new Error('开始日期不能晚于结束日期');const all=rows.filter(r=>archiveMode==='all'||(archiveMode==='only'?archive.has(r.runId):!archive.has(r.runId))),filtered=all.filter(job=>(status==='all'||(status==='history'&&terminal(job.status))||(status==='active'?['starting','running'].includes(job.status):job.status===status))&&(kind==='all'||job.kind===kind)&&(!since||Date.parse(job.created)>=Date.parse(since))&&(!until||Date.parse(job.created)<=Date.parse(until))&&[job.taskId,job.id,job.runId,job.workspace,...(query?[getRun(runs,job.runId)?.task?.input??(()=>{try{return JSON.parse(readFileSync(job.file,'utf8')).input??'';}catch{return '';}})()]:[])].some(value=>String(value).toLowerCase().includes(query))).sort((a,b)=>path==='/api/tasks'?(a.status==='queued'&&b.status==='queued'?jobs.findIndex(j=>j.id===a.id)-jobs.findIndex(j=>j.id===b.id):(['starting','running'].includes(a.status)?0:a.status==='queued'?1:2)-(['starting','running'].includes(b.status)?0:b.status==='queued'?1:2)||b.created.localeCompare(a.created)):b.created.localeCompare(a.created));
     const scheduler=store.scheduler(),leases=new WorkspaceLeases(root);try{for(const r of filtered as Array<typeof rows[number]&{archived?:boolean;origin?:unknown;waitReason?:string}>){r.archived=archive.has(r.runId);r.origin=management.origin(r.runId);if(r.status==='queued'){const conflict=leases.blocked(r.workspace),busy=rows.some(other=>other.id!==r.id&&['starting','running'].includes(other.status)&&overlaps(other.workspace,r.workspace));r.waitReason=conflict?'工作目录被其他执行占用':busy?'同一目录的任务正在执行':!scheduler||!alive(scheduler.pid)?'调度器未启动':scheduler.stop?'后续派发已停止':'等待并发名额或下一次派发';}}}finally{leases.close();}json(res,200,{token,version,upgradeNotice:store.scheduler()?.version===version?null:upgradeNotice,stateRoot:root,scheduler:scheduler?{alive:alive(scheduler.pid),concurrency:scheduler.concurrency,stopping:!!scheduler.stop,version:scheduler.version,compatible:scheduler.version===version}:null,counts:all.reduce<Record<string,number>>((counts,job)=>{counts[job.status]=(counts[job.status]??0)+1;return counts;},{}),queueTotal:jobs.filter(j=>archiveMode==='all'||(archiveMode==='only'?archive.has(j.runId):!archive.has(j.runId))).length,total:all.length,filtered:filtered.length,offset,limit:50,tasks:filtered.slice(offset,offset+50),updatedAt:new Date().toISOString()});return;
    }
    const runMatch=/^\/api\/runs\/([0-9a-f-]{36})(?:\/(cancel|report|recovery|resume|config|output|download|verification))?$/.exec(path);
    if(runMatch){
     const run=runs.get(runMatch[1]),action=runMatch[2],job=store.list().find(j=>j.runId===run.runId);
     if(method==='GET'&&action==='config'){const source=sourceConfig(root,run.runId);json(res,200,{...source,draft:taskToDraft(source.task),origin:management.origin(run.runId)});return;}
     if(method==='GET'&&action==='verification'){json(res,200,verificationDetails(runs,run));return;}
     if(method==='GET'&&(action==='output'||action==='download')){const file=url.searchParams.get('path');if(!file){json(res,200,outputList(runs,run));return;}const evidence=outputFile(runs,run,file);if(action==='download'){const entry=url.searchParams.get('side')==='before'?evidence.before:evidence.after;if(entry?.text===undefined)throw new Error(entry?.reason??'没有保存可下载的文本');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`});res.end(String(redact(entry.text)));return;}json(res,200,evidence);return;}
     if(method==='GET'&&action==='recovery'){json(res,200,recoveryView(runs,run.runId));return;}
     if(method==='POST'&&action==='resume'){const plan=recoveryView(runs,run.runId);if(!plan.eligible){json(res,409,{error:plan.explanation,plan});return;}json(res,201,await launchRecovery(root,run.runId));return;}
     if(method==='POST'&&action==='cancel'){if(job)store.cancel(job.id);runs.requestCancel(run.runId);json(res,200,{message:'取消请求已记录，等待实际执行停止'});return;}
     if(method==='GET'&&action==='report'){res.setHeader('Content-Disposition',`attachment; filename="run-${run.runId}.json"`);json(res,200,runs.report(run.runId));return;}
     if(method==='GET'&&!action){
      const events=(runs.db.prepare('SELECT body FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 80').all(run.runId) as {body:string}[]).reverse().map(e=>JSON.parse(e.body));
      json(res,200,{task:job?{...row(job,runs),kind:'queue'}:runRow(run),run,goal:run.task?.input??null,verification:runs.verification(run.runId),events,eventsLimited:run.eventSequence>80,log:logTail(job?.id??run.runId,!!job),lineage:lineage(runs,run),files:fileChanges(runs,run),origin:management.origin(run.runId),outputs:outputList(runs,run),archived:management.archived().has(run.runId)});return;
     }
    }
    const match=/^\/api\/tasks\/([0-9a-f-]{36})(?:\/(cancel|report))?$/.exec(path);
    if(match){
     const job=store.get(match[1]);
     if(method==='POST'&&match[2]==='cancel'){store.cancel(job.id);reconcile(store);json(res,200,{task:row(store.get(job.id),runs),message:'取消请求已记录；运行中的任务会按原有流程停止'});return;}
     if(method==='GET'){
      const run=getRun(runs,job.runId);
      if(match[2]==='report'){if(!run){json(res,404,{error:'任务尚未产生执行报告'});return;}res.setHeader('Content-Disposition',`attachment; filename="run-${job.runId}.json"`);json(res,200,runs.report(job.runId));return;}
      if(!match[2]){
       const events=run?(runs.db.prepare('SELECT body FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 80').all(job.runId) as {body:string}[]).reverse().map(e=>JSON.parse(e.body)):[];
       let goal:string|null=null;try{const saved=JSON.parse(readFileSync(job.file,'utf8'));goal=typeof saved.input==='string'?saved.input:null;}catch{}
       json(res,200,{task:row(job,runs),run,goal,verification:run?runs.verification(job.runId):null,events,eventsLimited:!!run&&run.eventSequence>80,log:logTail(job.id),lineage:run?lineage(runs,run):[],files:run?fileChanges(runs,run):null,origin:management.origin(job.runId),outputs:run?outputList(runs,run):null,archived:management.archived().has(job.runId)});return;
      }
     }
    }
    if(method==='POST'&&path==='/api/task-config'){
     const data=await body(req),task=validateTask(data.task);if(!isAbsolute(task.workspace))throw new Error('工作目录必须使用绝对路径');if(task.strategy){const strategy=new StrategyStore(root);try{strategy.resolve(task.strategy);}finally{strategy.close();}}if(task.model.mode==='live'){if(!process.env[task.model.apiKeyEnv])throw new Error('缺少任务指定的密钥环境变量');const catalog=await creationOptions(root);const selectedModel=task.model;if(!catalog.models.some(m=>m.provider===selectedModel.provider&&m.id===selectedModel.id))throw new Error('模型不在本地目录中');}for(const check of task.verification.checks)if(check.kind==='node')check.script=resolve(task.workspace,check.script);
     if(typeof data.sourceRunId==='string')sourceConfig(root,data.sourceRunId);
     const request=typeof data.requestId==='string'?{id:data.requestId,hash:digest(canonical({task,source:data.sourceRunId??null,editing:data.editingJobId??null,expectedHash:data.expectedHash??null})),source:typeof data.sourceRunId==='string'?data.sourceRunId:undefined}:undefined;
     const prior=request?store.receipt(request.id,request.hash):undefined;if(prior){json(res,201,{jobs:prior});return;}if(typeof data.editingJobId==='string'){const directory=join(root,'form-inputs');mkdirSync(directory,{recursive:true});const file=join(directory,randomBytes(16).toString('hex')+'.json');writeFileSync(file,JSON.stringify(task));json(res,200,{jobs:[store.replace(data.editingJobId,file,String(data.expectedHash),request)],message:'等待任务已更新'});return;}
     const jobs=enqueueConfig(root,task,request);if(typeof data.sourceRunId==='string')for(const job of jobs)if(!management.origin(job.runId))management.link(job.runId,data.sourceRunId,'copy');json(res,201,{jobs,message:'已作为新任务入队，使用新的预算，与检查点恢复不同'});return;
    }
    if(method==='GET'&&path==='/api/creation-options'){json(res,200,{...await creationOptions(root),defaults:management.defaults()});return;}
    if(method==='POST'&&['/api/drafts/check','/api/drafts/submit'].includes(path)){const data=await body(req);if(path.endsWith('/check')){const checked=await validateDraft(root,data.draft);json(res,checked.valid?200:422,checked);return;}const request=typeof data.requestId==='string'?{id:data.requestId,hash:digest(canonical({draft:data.draft,source:data.sourceRunId??null,editing:data.editing??null})),source:typeof data.sourceRunId==='string'?data.sourceRunId:undefined}:undefined;if(request&&!/^[0-9a-f-]{36}$/.test(request.id))throw new Error('提交标识无效');const prior=request?store.receipt(request.id,request.hash):undefined;if(prior){json(res,201,{valid:true,jobs:prior});return;}if(typeof data.sourceRunId==='string')sourceConfig(root,data.sourceRunId);if(data.editing&&typeof data.editing==='object'){const edit=data.editing as {jobId:string;hash:string};const validated=await validateDraft(root,data.draft);if(!validated.valid){json(res,422,validated);return;}const directory=join(root,'form-inputs');mkdirSync(directory,{recursive:true});const file=join(directory,randomBytes(16).toString('hex')+'.json');writeFileSync(file,JSON.stringify(validated.task));json(res,200,{valid:true,jobs:[store.replace(edit.jobId,file,edit.hash,request)],message:'等待任务配置已更新'});return;}const result=await createFormTask(root,data.draft,request);if(result.valid&&'jobs' in result&&typeof data.sourceRunId==='string'){sourceConfig(root,data.sourceRunId);for(const job of result.jobs)if(!management.origin(job.runId))management.link(job.runId,data.sourceRunId,'copy');}json(res,result.valid?201:422,result);return;}
    const templateAction=/^\/api\/templates\/([0-9a-f-]{36})\/(rename|version)$/.exec(path);if(method==='POST'&&templateAction){const data=await body(req),templates=new TemplateStore(root);try{json(res,200,templateAction[2]==='rename'?templates.rename(templateAction[1],data.name):templates.version(templateAction[1],data.draft));}finally{templates.close();}return;}
    if(path==='/api/templates'||/^\/api\/templates\/[0-9a-f-]{36}$/.test(path)){
     const templates=new TemplateStore(root);try{
      if(method==='GET'){json(res,200,path==='/api/templates'?{templates:templates.list()}:templates.get(path.split('/').at(-1)!));return;}
      if(method==='POST'&&path==='/api/templates'){const data=await body(req);json(res,201,templates.save(data.name,data.draft));return;}
     }finally{templates.close();}
    }
    if(method==='POST'&&path==='/api/submit'){
     const data=await body(req);if(!Array.isArray(data.files)||!data.files.every(file=>typeof file==='string'&&file.trim()&&isAbsolute(file)))throw new Error('请填写有效的任务文件路径');
     const request=typeof data.requestId==='string'?{id:data.requestId,hash:digest(canonical({files:data.files}))}:undefined;json(res,201,{jobs:store.submit(data.files as string[],request)});return;
    }
    if(method==='POST'&&path==='/api/demo'){json(res,201,{jobs:store.submit([createDemo(),createDemo(),createDemo()]),message:'已加入三个离线示例任务，点击启动调度即可执行'});return;}
    if(method==='POST'&&path==='/api/scheduler/start'){
     const data=await body(req),concurrency=data.concurrency;if(typeof concurrency!=='number'||!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw new Error('同时运行数量应为 1–16');
     if(startPending||alive(store.scheduler()?.pid??null)){json(res,409,{error:'调度器已在启动或运行中'});return;}
     startPending=true;try{const started=await startScheduler(root,concurrency);json(res,200,{...started,message:'调度器已启动'});}finally{startPending=false;}return;
    }
    if(method==='POST'&&path==='/api/scheduler/stop'){store.stop();json(res,200,{message:'已停止后续派发，正在运行的任务继续'});return;}
    json(res,404,{error:'接口不存在'});
   }finally{store.close();runs.close();management.close();}
  }catch(error){if(!res.headersSent)json(res,error instanceof HarnessError&&['queue_job_missing','run_not_found'].includes(error.code)?404:error instanceof HarnessError&&['experience_conflict','workspace_busy','already_resumed','recovery_source_changed','source_worker_alive'].includes(error.code)?409:400,{error:error instanceof HarnessError&&error.code==='invalid_task'?'任务文件无法读取或格式不正确，请检查完整路径和任务内容。':error instanceof HarnessError&&error.code==='queue_job_missing'?'没有找到这个任务，请刷新队列。':error instanceof Error?error.message:'操作失败'});else res.end();}
 });
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>done());});
 const address=server.address();if(!address||typeof address==='string')throw new Error('Unable to bind dashboard');origin=`http://127.0.0.1:${address.port}`;
 return {server,url:origin,stateRoot:root};
}
export async function dashboardCommand(args:string[],defaultState:string){let state=defaultState,port=4318;for(let i=0;i<args.length;i++){if(args[i]==='--state'){const value=args[++i];if(!value)throw new Error('--state requires a directory');state=resolve(value);}else if(args[i]==='--port'){port=Number(args[++i]);}else throw new Error('dashboard [--state <directory>] [--port <port>]');}
 let dashboard:Awaited<ReturnType<typeof startDashboard>>;try{dashboard=await startDashboard(state,port);}catch(error){if((error as NodeJS.ErrnoException).code==='EADDRINUSE')throw new Error(`端口 ${port} 已被占用，请使用 --port 指定其他端口。`);throw error;}console.log(`任务操作台：${dashboard.url}\n任务数据：${dashboard.stateRoot}\n关闭此窗口只关闭页面服务，后台任务继续运行。`);return dashboard;
}
