import {WorkspaceLeases} from '../state/workspace-leases.ts';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadTask} from '../task.ts';
import {digest,HarnessError} from '../util.ts';
const schedulerRuntimeVersion=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version as string;
export type JobStatus='queued'|'starting'|'running'|'completed'|'failed'|'cancelled'|'interrupted';
export interface Job {id:string;runId:string;taskId:string;file:string;hash:string;workspace:string;status:JobStatus;pid:number|null;cancelled:number;created:string;updated:string;error:string|null;}
export function alive(pid:number|null):boolean{if(!pid)return false;try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
const overlaps=(a:string,b:string)=>{const r=relative(a,b);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
export class QueueStore{
 db:DatabaseSync;root:string;
 constructor(root:string){this.root=resolve(root);mkdirSync(this.root,{recursive:true});this.root=realpathSync(this.root);this.db=new DatabaseSync(join(this.root,'queue.sqlite'));this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,runId TEXT NOT NULL UNIQUE,taskId TEXT NOT NULL,file TEXT NOT NULL,hash TEXT NOT NULL,workspace TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,cancelled INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL,error TEXT);
 CREATE TABLE IF NOT EXISTS queue_provenance(runId TEXT PRIMARY KEY,source TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS queue_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS queue_order(jobId TEXT PRIMARY KEY,rank REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS edits(jobId TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS scheduler_versions(token TEXT PRIMARY KEY,version TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS scheduler(singleton INTEGER PRIMARY KEY CHECK(singleton=1),token TEXT NOT NULL,pid INTEGER NOT NULL,concurrency INTEGER NOT NULL,stop INTEGER NOT NULL DEFAULT 0);`);}
 close(){this.db.close();}
 list():Job[]{return this.db.prepare('SELECT j.* FROM jobs j LEFT JOIN queue_order o ON o.jobId=j.id ORDER BY COALESCE(o.rank,j.rowid)').all() as unknown as Job[];}
 get(id:string):Job{const row=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!row)throw new HarnessError('queue_job_missing','Unknown queue job');return row as unknown as Job;}
 receipt(id:string,hash:string):Job[]|undefined{if(!/^[0-9a-f-]{36}$/.test(id)||!/^[0-9a-f]{64}$/.test(hash))throw new Error('提交标识或配置摘要无效');const row=this.db.prepare('SELECT hash,body FROM queue_requests WHERE id=?').get(id) as {hash:string;body:string}|undefined;if(!row)return;if(row.hash!==hash)throw new Error('提交标识对应另一份配置，请重新检查');return (JSON.parse(row.body) as string[]).map(id=>this.get(id));}
 submit(files:string[],request?:{id:string;hash:string;source?:string}):Job[]{
  if(request){const previous=this.receipt(request.id,request.hash);if(previous)return previous;}
  if(!files.length||files.length>100)throw new Error('Submit 1–100 task files');
  // Validate the entire batch before changing queue state. Freeze config and verifier bytes, not credentials.
  const prepared=files.map(file=>{file=resolve(file);const input=loadTask(file);input.workspace=realpathSync(resolve(dirname(file),input.workspace));
   if(overlaps(input.workspace,this.root))throw new Error('Queue state must be outside the task workspace');
   const scripts=input.verification.checks.map(check=>check.kind==='node'?readFileSync(resolve(dirname(file),check.script)):null);
   return {input,scripts};});
  const jobs:Job[]=[];this.db.exec('BEGIN IMMEDIATE');try{if(request){const previous=this.receipt(request.id,request.hash);if(previous){this.db.exec('COMMIT');return previous;}}
   for(const {input,scripts} of prepared){const id=randomUUID(),directory=join(this.root,'queue-inputs',id);mkdirSync(directory,{recursive:true});
    for(const [index,bytes] of scripts.entries())if(bytes){const check=input.verification.checks[index];if(check.kind==='node'){check.script=join(directory,`check-${index}.cjs`);writeFileSync(check.script,bytes);}}
    const file=join(directory,'task.json');writeFileSync(file,JSON.stringify(input));const hash=this.inputHash(file),at=new Date().toISOString();
    this.db.prepare('INSERT INTO jobs(id,runId,taskId,file,hash,workspace,status,created,updated) VALUES(?,?,?,?,?,?,?, ?,?)').run(id,randomUUID(),input.taskId,file,hash,input.workspace,'queued',at,at);const created=this.get(id);if(request?.source)this.db.prepare('INSERT INTO queue_provenance VALUES(?,?,?,?)').run(created.runId,request.source,'copy',at);jobs.push(created);
   }if(request)this.db.prepare('INSERT INTO queue_requests VALUES(?,?,?,?)').run(request.id,request.hash,JSON.stringify(jobs.map(j=>j.id)),new Date().toISOString());this.db.exec('COMMIT');return jobs;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 inputHash(file:string){const input=loadTask(file);return digest(JSON.stringify({bytes:readFileSync(file).toString('base64'),scripts:input.verification.checks.map(check=>check.kind==='node'?digest(readFileSync(check.script)):null)}));}
 scheduler(){return this.db.prepare('SELECT s.*,v.version FROM scheduler s LEFT JOIN scheduler_versions v ON v.token=s.token WHERE s.singleton=1').get() as {token:string;pid:number;concurrency:number;stop:number;version:string|null}|undefined;}
 acquire(concurrency:number,token:string){if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw new Error('Concurrency must be 1–16');this.db.exec('BEGIN IMMEDIATE');try{const current=this.scheduler();if(current&&alive(current.pid))throw new Error('Scheduler already running');this.db.prepare('INSERT INTO scheduler VALUES(1,?,?,?,0) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,pid=excluded.pid,concurrency=excluded.concurrency,stop=0').run(token,process.pid,concurrency);this.db.prepare('INSERT OR REPLACE INTO scheduler_versions VALUES(?,?)').run(token,schedulerRuntimeVersion);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 release(token:string){this.db.prepare('DELETE FROM scheduler WHERE token=?').run(token);}
 stop(){this.db.prepare('UPDATE scheduler SET stop=1 WHERE singleton=1').run();}
 claim(token:string):Job|undefined{this.db.exec('BEGIN IMMEDIATE');try{const owner=this.scheduler();if(owner?.token!==token||owner.stop){this.db.exec('COMMIT');return;}
  const jobs=this.list(),active=jobs.filter(j=>['starting','running'].includes(j.status));if(active.length>=owner.concurrency){this.db.exec('COMMIT');return;}
  const leases=new WorkspaceLeases(this.root);let next:Job|undefined;try{next=jobs.find(j=>j.status==='queued'&&!active.some(a=>overlaps(a.workspace,j.workspace)||overlaps(j.workspace,a.workspace))&&!leases.blocked(j.workspace));}finally{leases.close();}
  if(next)this.db.prepare("UPDATE jobs SET status='starting',updated=? WHERE id=? AND status='queued'").run(new Date().toISOString(),next.id);
  this.db.exec('COMMIT');return next?this.get(next.id):undefined;
 }catch(error){this.db.exec('ROLLBACK');throw error;}}
 move(id:string,direction:string){if(!['up','down'].includes(direction))throw new Error('队列方向无效');this.db.exec('BEGIN IMMEDIATE');try{const queued=this.list().filter(j=>j.status==='queued'),index=queued.findIndex(j=>j.id===id);if(index<0)throw new Error('只有等待中的任务可以调整顺序');const target=index+(direction==='up'?-1:1);if(target>=0&&target<queued.length){[queued[index],queued[target]]=[queued[target],queued[index]];for(const [rank,job] of queued.entries())this.db.prepare('INSERT INTO queue_order VALUES(?,?) ON CONFLICT(jobId) DO UPDATE SET rank=excluded.rank').run(job.id,rank-queued.length);}this.db.exec('COMMIT');return this.list();}catch(error){this.db.exec('ROLLBACK');throw error;}}
 replace(id:string,file:string,expectedHash:string,request?:{id:string;hash:string}){if(request){const receipt=this.receipt(request.id,request.hash);if(receipt)return receipt[0];}const task=loadTask(file);task.workspace=realpathSync(resolve(dirname(file),task.workspace));if(overlaps(task.workspace,this.root))throw new Error('任务数据目录必须在工作目录外');const directory=join(this.root,'queue-inputs',id,'revisions',randomUUID());mkdirSync(directory,{recursive:true});for(const [index,c] of task.verification.checks.entries())if(c.kind==='node'){const bytes=readFileSync(resolve(dirname(file),c.script));c.script=join(directory,`check-${index}.cjs`);writeFileSync(c.script,bytes);}const path=join(directory,'task.json');writeFileSync(path,JSON.stringify(task));const hash=this.inputHash(path);this.db.exec('BEGIN IMMEDIATE');try{if(request){const receipt=this.receipt(request.id,request.hash);if(receipt){this.db.exec('COMMIT');return receipt[0];}}const previous=this.get(id);if(previous.status!=='queued'||previous.hash!==expectedHash)throw new Error('任务已开始或配置已改变，请刷新后重试');this.db.prepare('INSERT INTO edits VALUES(?,?)').run(id,JSON.stringify({previousFile:previous.file,previousHash:previous.hash,file:path,hash,at:new Date().toISOString()}));this.db.prepare('UPDATE jobs SET file=?,hash=?,workspace=?,taskId=?,updated=? WHERE id=?').run(path,hash,task.workspace,task.taskId,new Date().toISOString(),id);if(request)this.db.prepare('INSERT INTO queue_requests VALUES(?,?,?,?)').run(request.id,request.hash,JSON.stringify([id]),new Date().toISOString());this.db.exec('COMMIT');return this.get(id);}catch(error){this.db.exec('ROLLBACK');throw error;}}
 workerClaim(id:string):Job|undefined{
  const result=this.db.prepare("UPDATE jobs SET status=CASE WHEN cancelled=1 THEN 'cancelled' ELSE 'running' END,pid=?,updated=? WHERE id=? AND status='starting'").run(process.pid,new Date().toISOString(),id);
  if(!result.changes)return;const job=this.get(id);return job.status==='running'?job:undefined;
 }
 finish(id:string,status:JobStatus,error:string|null=null){this.db.prepare("UPDATE jobs SET status=?,error=?,updated=? WHERE id=? AND status IN ('starting','running')").run(status,error,new Date().toISOString(),id);}
 cancel(id:string){this.get(id);this.db.prepare("UPDATE jobs SET cancelled=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated=? WHERE id=? AND status IN ('queued','starting','running')").run(new Date().toISOString(),id);return this.get(id);}
}
