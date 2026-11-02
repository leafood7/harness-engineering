import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {loadProfile,strategyDigest,type StrategyProfile} from './catalog.ts';
import {HarnessError} from '../util.ts';
export interface Selection {revision:number;profile:string;digest:string;}
/** Separate local activation state; the catalog and historical evidence are never edited. */
export class StrategyStore {
 db:DatabaseSync;
 constructor(root:string){
  mkdirSync(root,{recursive:true});this.db=new DatabaseSync(join(root,'strategies.sqlite'));
  this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS selection(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,profile TEXT NOT NULL,digest TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS history(revision INTEGER PRIMARY KEY,previous TEXT NOT NULL,profile TEXT NOT NULL,digest TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);`);
 }
 close(){this.db.close();}
 private pin(profile:StrategyProfile){
  const hash=strategyDigest(profile),old=this.db.prepare('SELECT digest FROM versions WHERE id=?').get(profile.id) as {digest:string}|undefined;
  if(old&&old.digest!==hash)throw new HarnessError('strategy_changed','A registered version cannot be overwritten; use a new version ID');
  this.db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?)').run(profile.id,hash,JSON.stringify(profile));return hash;
 }
 current():Selection{
  const row=this.db.prepare('SELECT revision,profile,digest FROM selection WHERE singleton=1').get() as unknown as Selection|undefined;
  return row??{revision:0,profile:'stable.v1',digest:strategyDigest(loadProfile())};
 }
 resolve(id?:string):StrategyProfile{
  if(id){const profile=loadProfile(id);this.pin(profile);return profile;}
  const selection=this.current(),profile=loadProfile(selection.profile);
  if(strategyDigest(profile)!==selection.digest)throw new HarnessError('strategy_changed','Active catalog version differs from the selected version');
  this.pin(profile);return profile;
 }
 history(){return this.db.prepare('SELECT * FROM history ORDER BY revision').all();}
 change(action:'switch'|'rollback',target:string|undefined,reason:string,expected?:number):Selection{
  if(!reason.trim()||reason.length>2000)throw new HarnessError('invalid_strategy_reason','Provide a reason of 1–2000 characters');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const before=this.current();
   if(expected!==undefined&&expected!==before.revision)throw new HarnessError('strategy_conflict','Selection changed; inspect current revision and retry');
   if(action==='rollback'){
    const last=this.db.prepare('SELECT previous FROM history ORDER BY revision DESC LIMIT 1').get() as {previous:string}|undefined;
    if(!last)throw new HarnessError('strategy_history_empty','No switch is available to roll back');target=last.previous;
   }
   if(!target)throw new HarnessError('invalid_strategy','A target version is required');
   const profile=loadProfile(target),hash=this.pin(profile);
   if(before.profile===target)throw new HarnessError('strategy_unchanged','This version is already active');
   this.pin(loadProfile(before.profile));
   if(strategyDigest(loadProfile(before.profile))!==before.digest)throw new HarnessError('strategy_changed','Current version changed');
   const next={revision:before.revision+1,profile:target,digest:hash};
   this.db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?)').run(next.revision,before.profile,target,hash,action,reason,new Date().toISOString());
   this.db.prepare('INSERT INTO selection VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,profile=excluded.profile,digest=excluded.digest').run(next.revision,target,hash);
   this.db.exec('COMMIT');return next;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
