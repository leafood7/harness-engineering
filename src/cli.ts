import { memoryCommand } from './memory/cli.ts';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RunStore } from './state/store.ts';
import { executeTask } from './execution/engine.ts';
import { resolveRecovery,recoveryPlan } from './state/recovery.ts';
import { loadTask } from './task.ts';
import { createDemo } from './demo.ts';
import { errorText, terminal, now, sanitize } from './util.ts';
import type { Run } from '../contracts/index.ts';

const defaultState = fileURLToPath(new URL('../.harness', import.meta.url));
const exitCode = (status: string): number => status === 'completed' ? 0 : status === 'cancelled' ? 3 : status === 'interrupted' ? 4 : 2;
const print = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function summary(run: Run): Record<string, unknown> {
  return { runId: run.runId, taskId: run.taskId, status: run.status, error: run.error,
    usage: run.usage, exportErrors: run.exportErrors, reportPath: join(run.runDir, 'report.json') };
}
function validateId(id: string | undefined): string {
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('A UUID run ID is required');
  return id;
}
function parse(argv: string[]): { args: string[]; state: string; detach: boolean; events: boolean; exportTrace: boolean; dryRun:boolean; approval: boolean; id?: string; digest?: string; actor?: string; reason?: string } {
  const result = { args: [] as string[], state: defaultState, detach: false, events: false, exportTrace: false, dryRun:false, approval: false, id: undefined as string | undefined, digest: undefined as string | undefined, actor: undefined as string | undefined, reason: undefined as string | undefined };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (['--state','--id','--digest','--actor','--reason'].includes(item)) {
      const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error(`${item} requires a value`);
      if (item === '--state') result.state = resolve(value);
      else if (item === '--id') result.id = value;
      else if (item === '--digest') result.digest = value;
      else if (item === '--actor') result.actor = value;
      else result.reason = value;
    } else if (item === '--detach') result.detach = true;
    else if (item === '--dry-run') result.dryRun=true;
    else if (item === '--approval') result.approval = true;
    else if (item === '--events') result.events = true;
    else if (item === '--export-trace') result.exportTrace = true;
    else if (item.startsWith('--')) throw new Error(`Unknown option: ${item}`);
    else result.args.push(item);
  }
  return result;
}
async function start(taskFile: string, state: string, detach: boolean, resumeFrom?:string): Promise<number> {
  if(!resumeFrom)loadTask(taskFile);
  const id = randomUUID();
  mkdirSync(join(state, 'logs'), { recursive: true });
  const log = openSync(join(state, 'logs', `${id}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), resumeFrom?'_resume_worker':'_worker', taskFile, '--state', state, '--id', id],
    { detached: detach, windowsHide: true, stdio: ['ignore', log, log, 'ipc'] });
  closeSync(log);
  return new Promise((resolvePromise, reject) => {
    let done = false;
    let cancellationPending = false;
    const finish = (code: number): void => {
      if (done) return; done = true;
      clearTimeout(startupTimer); process.removeListener('SIGINT', interrupt);
      resolvePromise(code);
    };
    const interrupt = (): void => {
      cancellationPending = true;
      try { const store = new RunStore(state); try { store.requestCancel(id); } finally { store.close(); } } catch { /* Retry when worker is ready. */ }
    };
    process.on('SIGINT', interrupt);
    const startupTimer = setTimeout(() => { interrupt(); }, 30000);
    child.on('message', (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === 'ready') {
        clearTimeout(startupTimer);
        print({ runId: id, status: 'created', stateRoot: state, workerPid: child.pid, detached: detach });
        if (cancellationPending) interrupt();
        if (detach) { child.disconnect(); child.unref(); finish(0); }
      }
    });
    child.on('error', (error) => { clearTimeout(startupTimer); process.removeListener('SIGINT', interrupt); if (!done) reject(error); });
    child.on('exit', () => {
      if (done) return;
      try {
        const store = new RunStore(state);
        try {
          let run = store.get(id);
          if (!terminal(run.status)) {
            run = store.transition(id, 'interrupted', { error: { category: 'worker_exited', message: 'Worker exited before a durable terminal result', retryable: false } });
            store.flushTrace(id); store.saveReport(id);
          }
          print(summary(run)); finish(run.exportErrors?.length ? 2 : exitCode(run.status));
        } finally { store.close(); }
      } catch (error) { print({ runId: id, status: 'error', message: errorText(error), log: join(state, 'logs', `${id}.log`) }); finish(2); }
    });
  });
}
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    if(argv[0]==='experience'){const {experienceCommand}=await import('./experience/cli.ts');print(experienceCommand(argv.slice(1),defaultState));return 0;}
    if(argv[0]==='dashboard'){const {dashboardCommand}=await import('./dashboard/server.ts');await dashboardCommand(argv.slice(1),defaultState);return 0;}
    if(argv[0]==='queue'){const {queueCommand}=await import('./queue/cli.ts');const result=await queueCommand(argv.slice(1),defaultState);print(result);return argv[1]==='_worker'&&(result as {exitCode?:number}).exitCode!==undefined?(result as {exitCode:number}).exitCode:0;}
    if(argv[0]==='strategy'){const {strategyCommand}=await import('./strategy/cli.ts');print(strategyCommand(argv.slice(1),defaultState));return 0;}
    if(argv[0]==='benchmark'){const {benchmarkCommand}=await import('./benchmark/runner.ts');return await benchmarkCommand(argv.slice(1));}
    if(argv[0]==='memory'){print(memoryCommand(argv.slice(1),defaultState));return 0;}
    const options = parse(argv);
    const [command, target] = options.args;
    if (options.args.length > 2) throw new Error('Too many positional arguments');
    if (!command || command === 'help') {
      console.log('Harness Engineering\n  experience inspect|collect|feedback|import|history|edit|review|reject ... [--state <directory>]\n  dashboard [--state <directory>] [--port <port>]\n  queue submit|list|inspect|cancel|status|start|work|stop ...\n  strategy list|inspect|current|history|switch|rollback|compare ...\n  benchmark plan|run|report <config-or-batch> [--output <directory>]\n  memory put|revise|retire|search|history ... [--state <directory>]\n  run <task.json> [--state <directory>] [--detach]\n  demo [--approval] [--state <directory>] [--detach]\n  inspect <run-id> [--state <directory>] [--events] [--export-trace]\n  cancel <run-id> [--state <directory>]\n  resume <run-id> [--dry-run] [--detach] [--state <directory>]\n  approve <approval-id> --digest <sha256> --actor <name> [--state <directory>]\n  reject <approval-id> --digest <sha256> --actor <name> [--reason <text>] [--state <directory>]');
      return 0;
    }
    if (command === '_worker'||command === '_resume_worker') {
      if (!target) throw new Error('Task path required');
      try {
        const parent=command==='_resume_worker'?validateId(target):undefined;
        const run = await executeTask(parent??resolve(target), options.state, validateId(options.id), (run) => {
          if (process.connected) process.send?.({ type: 'ready', runId: run.runId });
        },parent);
        if (process.connected) process.disconnect();
        return run.exportErrors?.length ? 2 : exitCode(run.status);
      } catch (error) {
        console.error(JSON.stringify({ error: 'worker_failed', message: sanitize(errorText(error)) }));
        if (process.connected) process.disconnect();
        return 2;
      }
    }
    if (command === 'run' || command === 'demo') {
      if (command === 'run' && !target) throw new Error('Task JSON path required');
      const task = command === 'demo' ? createDemo(options.approval) : resolve(target!);
      if (command === 'demo') print({ taskFile: task, model: 'scripted; no paid calls' });
      return await start(task, options.state, options.detach);
    }
    if(command==='resume'){
      const parent=validateId(target);const store=new RunStore(options.state);
      try{
        const source=store.get(parent);
        if(options.dryRun){const plan=recoveryPlan(store,parent);print(plan);return plan.eligible?0:2;}
        if(!terminal(source.status)&&!alive(source.workerPid))store.transition(parent,'interrupted',{error:{category:'worker_missing',message:'Original worker has exited',retryable:false}});
        resolveRecovery(store,parent);
      }finally{store.close();}
      return await start(parent,options.state,options.detach,parent);
    }
    if (command === 'approve' || command === 'reject') {
      const id = validateId(target);
      if (!options.actor?.trim()) throw new Error('--actor is required for an audit trail');
      if (!options.digest || !/^[0-9a-f]{64}$/i.test(options.digest)) throw new Error('--digest must match the request SHA-256');
      const store = new RunStore(options.state);
      try {
        const pending = store.approval(id);
        const run = store.get(pending.runId);
        if (!terminal(run.status) && !alive(run.workerPid)) store.transition(run.runId, 'interrupted', { error: { category: 'worker_missing', message: 'Approval worker is no longer alive', retryable: false } });
        const approval = store.decideApproval(id, options.digest, command === 'approve', options.actor.trim(), options.reason);
        print({ approval }); return 0;
      } finally { store.close(); }
    }
    if (command !== 'inspect' && command !== 'cancel') throw new Error(`Unknown command: ${command}`);
    const id = validateId(target);
    const store = new RunStore(options.state);
    try {
      let run = store.get(id);
      if (!terminal(run.status) && !alive(run.workerPid)) {
        run = store.transition(id, 'interrupted', { error: { category: 'worker_missing', message: 'Recorded worker is no longer alive', retryable: false } });
        store.flushTrace(id); store.saveReport(id);
      }
      if (command === 'cancel') { print({ runId: id, accepted: store.requestCancel(id), status: store.get(id).status }); return 0; }
      if (options.exportTrace) store.flushTrace(id);
      print({ ...store.report(id), workerAlive: !terminal(run.status) && alive(run.workerPid),
        cancelRequestedAt: store.cancelAt(id), ...(options.events ? { events: store.events(id) } : {}) });
      return 0;
    } finally { store.close(); }
  } catch (error) { console.error(JSON.stringify({ error: 'command_failed', message: sanitize(errorText(error)) })); return 2; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
