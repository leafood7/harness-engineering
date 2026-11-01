import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run, Event, RunStatus, Verification, Approval, Checkpoint, Operation } from '../contracts/index.ts';
import { now, terminal, HarnessError, sanitize, canonical, digest } from './util.ts';

const transitions: Record<RunStatus, RunStatus[]> = {
  created: ['initializing', 'cancelling', 'failed', 'interrupted'],
  initializing: ['running', 'cancelling', 'failed', 'interrupted'],
  running: ['waiting_approval', 'verifying', 'cancelling', 'failed', 'interrupted'],
  waiting_approval: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  verifying: ['completed', 'failed', 'cancelling', 'interrupted'],
  completed: [], failed: [], interrupted: [], cancelled: []
};
export class RunStore {
  db: DatabaseSync;
  root: string;
  secrets: string[];
  constructor(root: string, secrets: string[] = []) {
    this.root = resolve(root); this.secrets = secrets;
    mkdirSync(join(this.root, 'runs'), { recursive: true });
    this.root = realpathSync(this.root);
    this.db = new DatabaseSync(join(this.root, 'state.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version !== 0 && version.user_version !== 1 && version.user_version !== 2 && version.user_version !== 3) throw new Error('Unsupported state database schema');
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, cancel_at TEXT);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,sequence));
      CREATE TABLE IF NOT EXISTS verifications (run_id TEXT PRIMARY KEY REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resumptions(parent_id TEXT PRIMARY KEY REFERENCES runs(id), child_id TEXT NOT NULL UNIQUE REFERENCES runs(id));
      PRAGMA user_version=3;`);
  }
  close(): void { this.db.close(); }
  get(id: string): Run {
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id) as { body: string } | undefined;
    if (!row) throw new HarnessError('run_not_found', `Run not found: ${id}`);
    return JSON.parse(row.body) as Run;
  }
  create(run: Run, parent?: Run): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      run.eventSequence = 1;
      const event: Event = { schemaVersion: 1, eventId: randomUUID(), runId: run.runId, sequence: 1, occurredAt: now(),
        source: 'harness', kind: 'run.created', payload: {}, artifactRefs: [] };
      this.db.prepare('INSERT INTO runs(id,body) VALUES (?,?)').run(run.runId, JSON.stringify(run));
      this.db.prepare('INSERT INTO events(run_id,sequence,body) VALUES (?,?,?)').run(run.runId, 1, JSON.stringify(event));
      if (parent) {
        const current = this.get(parent.runId);
        if (current.resumedByRunId || this.db.prepare('SELECT child_id FROM resumptions WHERE parent_id=?').get(parent.runId)) throw new HarnessError('already_resumed', 'This Run already has a recovery child');
        if (current.eventSequence !== parent.eventSequence || !['interrupted','cancelled'].includes(current.status)) throw new HarnessError('recovery_source_changed', 'Recovery source changed; inspect it again');
        this.db.prepare('INSERT INTO resumptions(parent_id,child_id) VALUES (?,?)').run(parent.runId, run.runId);
        current.resumedByRunId = run.runId; current.eventSequence++;
        const linked: Event = { schemaVersion:1,eventId:randomUUID(),runId:current.runId,sequence:current.eventSequence,occurredAt:now(),source:'harness',kind:'recovery.claimed',payload:{childRunId:run.runId},artifactRefs:[] };
        this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(current),current.runId);
        this.db.prepare('INSERT INTO events(run_id,sequence,body) VALUES (?,?,?)').run(current.runId,current.eventSequence,JSON.stringify(linked));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events(id: string): Event[] {
    return (this.db.prepare('SELECT body FROM events WHERE run_id=? ORDER BY sequence').all(id) as Array<{ body: string }>).map((row) => JSON.parse(row.body) as Event);
  }
  mutate(id: string, change: (run: Run) => void, kind: string, payload: Record<string, unknown>, source: Event['source'] = 'harness', verification?: Verification): Run {
    this.db.exec('BEGIN IMMEDIATE');
    let run: Run;
    try {
      run = this.get(id); change(run);
      run.eventSequence++;
      const event: Event = { schemaVersion: 1, eventId: randomUUID(), runId: id, sequence: run.eventSequence, occurredAt: now(),
        source, kind, payload: sanitize(payload, this.secrets) as Record<string, unknown>, artifactRefs: [] };
      this.db.prepare('INSERT INTO events(run_id,sequence,body) VALUES (?,?,?)').run(id, event.sequence, JSON.stringify(event));
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run), id);
      if (verification) this.db.prepare('INSERT OR REPLACE INTO verifications(run_id,body) VALUES (?,?)').run(id, JSON.stringify(verification));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return run;
  }
  transition(id: string, status: RunStatus, patch: Partial<Run> = {}): Run {
    return this.mutate(id, (run) => {
      if (status === 'completed' && this.cancelAt(id)) throw new HarnessError('cancelled', 'Cancellation requested before completion');
      if (!transitions[run.status].includes(status)) throw new HarnessError('invalid_transition', `${run.status} -> ${status}`);
      Object.assign(run, patch, { status });
      if (terminal(status)) {
        run.endedAt = now(); delete run.pendingApprovalId;
        for (const approval of this.approvals(id)) {
          if (approval.status === 'pending' || approval.status === 'approved') {
            approval.status = 'cancelled'; approval.reason = `Run ended: ${status}`; this.saveApproval(approval);
          }
        }
      }
    }, 'run.status', { status });
  }
  requestCancel(id: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.get(id);
      if (terminal(run.status)) { this.db.exec('COMMIT'); return false; }
      this.db.prepare('UPDATE runs SET cancel_at=COALESCE(cancel_at,?) WHERE id=?').run(now(), id);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cancelAt(id: string): string | undefined {
    const row = this.db.prepare('SELECT cancel_at FROM runs WHERE id=?').get(id) as { cancel_at: string | null } | undefined;
    return row?.cancel_at ?? undefined;
  }
  verification(id: string): Verification | undefined {
    const row = this.db.prepare('SELECT body FROM verifications WHERE run_id=?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Verification : undefined;
  }
  flushTrace(id: string): void {
    const run = this.get(id);
    const file = join(run.runDir, 'events.jsonl');
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, this.events(id).map((event) => JSON.stringify(event)).join('\n') + '\n');
    renameSync(temporary, file);
  }
  checkpoints(id:string): Checkpoint[] {
    return (this.db.prepare('SELECT body FROM checkpoints WHERE run_id=? ORDER BY rowid').all(id) as Array<{body:string}>).map((row)=>JSON.parse(row.body) as Checkpoint);
  }
  latestCheckpoint(id:string): Checkpoint | undefined { return this.checkpoints(id).at(-1); }
  saveCheckpoint(checkpoint:Checkpoint): void {
    this.mutate(checkpoint.runId,(run)=>{
      checkpoint.eventSequence=run.eventSequence+1;
      this.db.prepare('INSERT INTO checkpoints(id,run_id,body) VALUES (?,?,?)').run(checkpoint.checkpointId,checkpoint.runId,JSON.stringify(checkpoint));
      run.latestCheckpointId=checkpoint.checkpointId;
    },'checkpoint.saved',{checkpointId:checkpoint.checkpointId,phase:checkpoint.phase,canVerify:checkpoint.canVerify,workspaceDigest:checkpoint.workspaceDigest,modelCursor:checkpoint.modelCursor});
  }
  operations(id:string): Operation[] {
    return (this.db.prepare('SELECT body FROM operations WHERE run_id=? ORDER BY rowid').all(id) as Array<{body:string}>).map((row)=>JSON.parse(row.body) as Operation);
  }
  /** Operation records participate in the surrounding state/event transaction. */
  saveOperation(operation:Operation): void {
    this.db.prepare('INSERT OR REPLACE INTO operations(id,run_id,body) VALUES (?,?,?)').run(operation.operationId,operation.runId,JSON.stringify(operation));
  }
  approvals(id: string): Approval[] {
    return (this.db.prepare('SELECT body FROM approvals WHERE run_id=? ORDER BY rowid').all(id) as Array<{body:string}>).map((row) => JSON.parse(row.body) as Approval);
  }
  approval(id: string): Approval {
    const row = this.db.prepare('SELECT body FROM approvals WHERE id=?').get(id) as {body:string} | undefined;
    if (!row) throw new HarnessError('approval_not_found', 'Approval not found');
    return JSON.parse(row.body) as Approval;
  }
  private saveApproval(approval: Approval): void {
    this.db.prepare('INSERT OR REPLACE INTO approvals(id,run_id,body) VALUES (?,?,?)').run(approval.approvalId, approval.runId, JSON.stringify(approval));
  }
  requestApproval(approval: Approval): void {
    this.mutate(approval.runId, (run) => {
      if (run.status !== 'running' || this.cancelAt(run.runId)) throw new HarnessError('cancelled', 'Run is not accepting approval requests');
      this.saveApproval(approval); run.status = 'waiting_approval'; run.pendingApprovalId = approval.approvalId;
    }, 'approval.requested', { approval });
  }
  settleApproval(id: string, status: 'expired' | 'cancelled' | 'invalidated', reason: string): void {
    const initial = this.approval(id);
    this.mutate(initial.runId, (run) => {
      const approval = this.approval(id);
      if (!['pending','approved'].includes(approval.status)) throw new HarnessError('approval_stale', 'Approval is already resolved');
      approval.status = status; approval.reason = reason; this.saveApproval(approval);
      if (run.pendingApprovalId === id) { delete run.pendingApprovalId; if (run.status === 'waiting_approval') run.status = 'running'; }
    }, `approval.${status}`, { approvalId: id, reason });
  }
  decideApproval(id: string, requestDigest: string, approved: boolean, actor: string, reason?: string): Approval {
    const initial = this.approval(id);
    this.mutate(initial.runId, (run) => {
      const approval = this.approval(id);
      if (run.status !== 'waiting_approval' || run.pendingApprovalId !== id || this.cancelAt(run.runId) || approval.status !== 'pending') throw new HarnessError('approval_stale', 'Approval is no longer pending');
      if (Date.now() >= Date.parse(approval.expiresAt)) throw new HarnessError('approval_expired', 'Approval request has expired');
      if (approval.policyDigest !== run.policy.digest) throw new HarnessError('policy_changed', 'Approval belongs to an older policy');
      if (approval.requestDigest !== requestDigest) throw new HarnessError('approval_digest_mismatch', 'Decision does not match the request digest');
      const binding: unknown = JSON.parse(readFileSync(approval.requestFile, 'utf8'));
      if (digest(canonical(binding)) !== requestDigest) throw new HarnessError('approval_tampered', 'Approval request artifact changed');
      approval.status = approved ? 'approved' : 'rejected'; approval.actor = actor; approval.reason = reason; approval.decidedAt = now(); this.saveApproval(approval);
    }, approved ? 'approval.approved' : 'approval.rejected', { approvalId: id, requestDigest, actor, reason });
    return this.approval(id);
  }
  /** Called only inside the attempt authorization transaction. */
  consumeApproval(id: string, run: Run, requestDigest: string): void {
    const approval = this.approval(id);
    if (approval.runId !== run.runId || approval.status !== 'approved' || approval.requestDigest !== requestDigest || approval.policyDigest !== run.policy.digest) {
      throw new HarnessError('approval_stale', 'Approval does not authorize this exact attempt');
    }
    if (Date.now() >= Date.parse(approval.expiresAt)) throw new HarnessError('approval_expired', 'Approval expired before execution');
    approval.status = 'consumed'; approval.consumedAt = now(); this.saveApproval(approval);
    delete run.pendingApprovalId;
    if (run.status === 'waiting_approval') run.status = 'running';
  }
  report(id: string): { run: Run; verification?: Verification; approvals: Approval[]; checkpoints: Array<Omit<Checkpoint,'files'>>; operations: Operation[] } {
    return { run: this.get(id), verification: this.verification(id), approvals: this.approvals(id), checkpoints: this.checkpoints(id).map(({files,...summary})=>summary), operations: this.operations(id) };
  }
  saveReport(id: string): void {
    const run = this.get(id);
    writeFileSync(join(run.runDir, 'report.json'), JSON.stringify(sanitize(this.report(id), this.secrets), null, 2));
  }
}
export function sdkIdentity(): Run['pi'] {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version?: string; integrity?: string }> };
  const sdk = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
  if (!sdk?.version || !sdk.integrity) throw new Error('Locked Pi SDK dependency is missing');
  return { package: '@earendil-works/pi-coding-agent', version: sdk.version, integrity: sdk.integrity };
}
