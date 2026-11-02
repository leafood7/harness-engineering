import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {RunStore} from './store.ts';
import {inside,HarnessError} from '../util.ts';
export const overlaps=(a:string,b:string)=>inside(a,b)||inside(b,a);
export class WorkspaceLeases{
 db:DatabaseSync;root:string;
 constructor(root:string){mkdirSync(root,{recursive:true});this.root=realpathSync(root);this.db=new DatabaseSync(join(this.root,'leases.sqlite'));this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS leases(runId TEXT PRIMARY KEY,workspace TEXT NOT NULL,pid INTEGER NOT NULL)');}
 close(){this.db.close();}
 entries(){const entries=this.db.prepare('SELECT * FROM leases').all() as {runId:string;workspace:string;pid:number}[];for(const entry of entries){let alive=true;try{process.kill(entry.pid,0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}if(!alive){const runs=new RunStore(this.root);try{let uncertain=false;try{uncertain=!!runs.get(entry.runId).verifierInFlight;}catch{}if(!uncertain)this.db.prepare('DELETE FROM leases WHERE runId=?').run(entry.runId);}finally{runs.close();}}}return this.db.prepare('SELECT * FROM leases').all() as typeof entries;}
 blocked(workspace:string,except?:string){const direct=this.entries().find(entry=>entry.runId!==except&&overlaps(entry.workspace,workspace));if(direct)return direct;const runs=new RunStore(this.root);try{for(const row of runs.db.prepare('SELECT body FROM runs').all() as {body:string}[]){const run=JSON.parse(row.body);if(run.runId===except)continue;let live=true;try{process.kill(run.workerPid,0);}catch(error){live=(error as NodeJS.ErrnoException).code!=='ESRCH';}const active=run.verifierInFlight||live&&(!['completed','failed','cancelled','interrupted'].includes(run.status)||run.error?.toolFailure?.outcome==='unknown');if(active&&(!run.task?.workspace?.path||overlaps(run.task.workspace.path,workspace)))return {runId:run.runId,workspace:run.task?.workspace?.path??workspace,pid:run.workerPid};}}finally{runs.close();}return undefined;}
 acquire(runId:string,workspace:string){this.db.exec('BEGIN IMMEDIATE');try{const conflict=this.blocked(workspace);if(conflict)throw new HarnessError('workspace_busy',`工作目录正在被执行 ${conflict.runId} 占用，请等待结束或检查未停止的验收进程`);this.db.prepare('INSERT INTO leases VALUES(?,?,?)').run(runId,workspace,process.pid);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 release(runId:string){const runs=new RunStore(this.root);try{try{const run=runs.get(runId);if(run.verifierInFlight||run.error?.toolFailure?.outcome==='unknown')return;}catch{}this.db.prepare('DELETE FROM leases WHERE runId=? AND pid=?').run(runId,process.pid);}finally{runs.close();}}
}
