import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError, canonical, digest, now, inside } from '../util.ts';
import { RunStore } from '../state/store.ts';

export type MemorySource = { kind: 'manual'; reference: string; actor: string } | { kind: 'event'; runId: string; sequence: number; actor: string };
export interface MemoryInput { workspace: string; content: string; source: MemorySource; expiresAt?: string; }
export interface MemoryRecord extends MemoryInput { id: string; revision: number; status: 'active' | 'retired'; createdAt: string; updatedAt: string; digest: string; }
/** Explicitly authored facts; never populated automatically from model claims. */
export class MemoryStore {
  db: DatabaseSync;
  root: string;
  constructor(root: string) {
    this.root = resolve(root); mkdirSync(this.root, { recursive: true });
    this.root=realpathSync(this.root);
    this.db = new DatabaseSync(join(this.root, 'memory.sqlite'));
    const version=this.db.prepare('PRAGMA user_version').get() as {user_version:number};
    if(version.user_version!==0 && version.user_version!==1){this.db.close();throw new HarnessError('memory_schema_unsupported','Unsupported memory database schema');}
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_revisions(id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,revision)); PRAGMA user_version=1;');
  }
  close(): void { this.db.close(); }
  private validate(input: MemoryInput): MemoryInput {
    if (!input || typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content) > 16384) throw new HarnessError('invalid_memory', 'Memory content must contain 1..16384 UTF-8 bytes');
    if (typeof input.workspace !== 'string') throw new HarnessError('invalid_memory', 'An existing workspace is required');
    const workspace = realpathSync(input.workspace);
    if(!statSync(workspace).isDirectory() || inside(workspace,this.root))throw new HarnessError('invalid_memory_scope','Workspace must be a directory and memory state must be outside it');
    const source = input.source;
    if (!source || typeof source.actor !== 'string' || !source.actor.trim() || source.actor.length > 200) throw new HarnessError('invalid_memory', 'A source actor is required');
    if (source.kind === 'manual') {
      if (typeof source.reference !== 'string' || !source.reference.trim() || source.reference.length > 2048) throw new HarnessError('invalid_memory', 'A manual source reference is required');
    } else if (source.kind === 'event' && typeof source.runId === 'string' && Number.isSafeInteger(source.sequence) && source.sequence > 0) {
      const store = new RunStore(this.root);
      try {
        const run = store.get(source.runId);
        if (run.task?.workspace.path !== workspace || !store.events(source.runId).some(event => event.sequence === source.sequence)) throw new HarnessError('invalid_memory_source', 'Source event must exist in the same workspace');
      } finally { store.close(); }
    } else throw new HarnessError('invalid_memory_source', 'Source must be manual or an existing Run event');
    if (input.expiresAt !== undefined && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) throw new HarnessError('invalid_memory', 'Expiry must be a future timestamp');
    return { workspace, content: input.content.trim(), source: structuredClone(source), ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}) };
  }
  get(id: string): MemoryRecord {
    const row = this.db.prepare('SELECT body FROM memories WHERE id=?').get(id) as {body:string}|undefined;
    if (!row) throw new HarnessError('memory_not_found', 'Memory does not exist');
    return this.decode(row.body);
  }
  private decode(body:string):MemoryRecord {
    const record=JSON.parse(body) as MemoryRecord;const {digest:hash,...value}=record;
    if(digest(canonical(value))!==hash)throw new HarnessError('memory_corrupt','Memory content no longer matches its recorded digest');
    return record;
  }
  history(id: string): MemoryRecord[] {
    this.get(id);
    return (this.db.prepare('SELECT body FROM memory_revisions WHERE id=? ORDER BY revision').all(id) as {body:string}[]).map(row => this.decode(row.body));
  }
  private persist(record: Omit<MemoryRecord,'digest'>, expected?: number): MemoryRecord {
    const saved = { ...record, digest: digest(canonical(record)) };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (expected !== undefined && this.get(record.id).revision !== expected) throw new HarnessError('memory_conflict', 'Memory revision changed; inspect before correcting it');
      this.db.prepare('INSERT INTO memory_revisions(id,revision,body) VALUES(?,?,?)').run(saved.id,saved.revision,JSON.stringify(saved));
      this.db.prepare('INSERT INTO memories(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(saved.id,JSON.stringify(saved));
      this.db.exec('COMMIT'); return saved;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  put(input: MemoryInput): MemoryRecord {
    const value = this.validate(input); const timestamp = now();
    return this.persist({ ...value, id: randomUUID(), revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp });
  }
  revise(id: string, expected: number, input: MemoryInput): MemoryRecord {
    const value = this.validate(input); const old = this.get(id);
    if (old.workspace !== value.workspace) throw new HarnessError('memory_scope_changed', 'A correction cannot move memory between workspaces');
    return this.persist({ ...value, id, revision: old.revision + 1, status: 'active', createdAt: old.createdAt, updatedAt: now() }, expected);
  }
  retire(id: string, expected: number, actor: string): MemoryRecord {
    const old = this.get(id); const { digest: _digest, ...record } = old;
    if (!actor?.trim()) throw new HarnessError('invalid_memory', 'Retirement actor is required');
    return this.persist({ ...record, revision: old.revision + 1, status: 'retired', updatedAt: now(), source: { kind: 'manual', reference: `Retired revision ${old.revision}: ${old.digest}`, actor } }, expected);
  }
  search(workspace: string, query: string, limit = 8, maxBytes = 8192): MemoryRecord[] {
    const scope = realpathSync(workspace);
    if (!Number.isInteger(limit) || limit < 1 || limit > 32 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw new HarnessError('invalid_memory_query', 'Retrieval limits are outside supported bounds');
    const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const rows = (this.db.prepare("SELECT body FROM memories WHERE json_extract(body,'$.workspace')=? AND json_extract(body,'$.status')='active'").all(scope) as {body:string}[]).map(row => this.decode(row.body));
    const ranked = rows.filter(row => !row.expiresAt || Date.parse(row.expiresAt) > Date.now()).map(row => ({row,score:terms.reduce((score,term)=>score + (row.content.toLocaleLowerCase().includes(term)?1:0),0)})).filter(item=>!terms.length || item.score>0).sort((a,b)=>b.score-a.score || b.row.updatedAt.localeCompare(a.row.updatedAt) || a.row.id.localeCompare(b.row.id));
    const selected: MemoryRecord[] = []; let bytes=0;
    for(const {row} of ranked){const size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>maxBytes)continue;selected.push(row);bytes+=size;if(selected.length===limit)break;}
    return selected;
  }
}
