import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Verification } from '../contracts/index.ts';
import type { PreparedTask } from './task.ts';
import { workspacePath, digest, now, snapshot, sanitize, errorText } from './util.ts';

export function killOwnedProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)],
      { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  } else { try { process.kill(-pid, 'SIGKILL'); } catch { /* Fallback below. */ } }
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
}
interface ChildResult { exitCode: number | null; stdout: string; stderr: string; interrupted: boolean; settled:boolean; }
export async function runVerifier(script: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ChildResult> {
  if (signal.aborted) return { exitCode: null, stdout: '', stderr: 'Verification cancelled', interrupted: true, settled:true };
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [script, ...args], { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let interrupted = false; let finished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, settled:boolean): void => {
      if (finished) return; finished = true;
      clearTimeout(timer); if (watchdog) clearTimeout(watchdog);
      signal.removeEventListener('abort', terminate);
      resolve({ exitCode: code, stdout, stderr, interrupted, settled });
    };
    const terminate = (): void => {
      if (finished || interrupted) return;
      interrupted = true;
      if (child.pid) killOwnedProcessTree(child.pid);
      watchdog = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null,false); }, 2000);
    };
    const timer = setTimeout(terminate, timeoutMs);
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdout.on('data', (buffer: Buffer) => { stdout = (stdout + buffer.toString('utf8')).slice(0, 65536); });
    child.stderr.on('data', (buffer: Buffer) => { stderr = (stderr + buffer.toString('utf8')).slice(0, 65536); });
    child.on('error', (error) => { stderr += error.message; finish(null,child.pid===undefined); });
    child.on('close', (code) => finish(code,true));
  });
}
export async function verify(prepared: PreparedTask, runId: string, runDir: string, deadline: number, signal: AbortSignal,
  record: (kind: string, data: Record<string, unknown>) => void, secrets: string[]): Promise<Verification> {
  const checks: Verification['checks'] = [];
  let executionUncertain=false;
  const frozen = { verification: prepared.input.verification, scripts: Object.fromEntries(Object.entries(prepared.verifierScripts).map(([key, path]) => [key, digest(readFileSync(path))])) };
  if (digest(JSON.stringify(frozen)) !== prepared.task.verificationSpec.digest) throw new Error('Frozen verification specification changed');
  for (const [index, check] of prepared.input.verification.checks.entries()) {
    if (signal.aborted || Date.now() >= deadline) {
      checks.push({ name: check.name, status: 'not_run', evidenceRefs: [], message: 'Run cancelled or duration budget exhausted' }); continue;
    }
    record('verification.check_start', { name: check.name, kind: check.kind });
    try {
      if (check.kind === 'file') {
        const path = workspacePath(prepared.workspace, check.path);
        const content = readFileSync(path);
        const passed = content.equals(Buffer.from(check.equals, 'utf8'));
        const evidenceFile = join(runDir, 'verification', `result-${index}.json`);
        writeFileSync(evidenceFile, JSON.stringify({ path: check.path, expectedDigest: digest(check.equals), actualDigest: digest(content), passed }));
        checks.push({ name: check.name, status: passed ? 'passed' : 'failed', evidenceRefs: [evidenceFile] });
      } else {
        const result = await runVerifier(prepared.verifierScripts[String(index)], check.args ?? [], prepared.workspace,
          Math.max(1, Math.min(check.timeoutMs, deadline - Date.now())), signal);
        if(!result.settled)executionUncertain=true;
        const outputFile = join(runDir, 'verification', `result-${index}.json`);
        writeFileSync(outputFile, JSON.stringify(sanitize(result, secrets), null, 2));
        const status = result.interrupted || result.exitCode === null ? 'error' : result.exitCode === 0 ? 'passed' : 'failed';
        checks.push({ name: check.name, status, ...(result.exitCode === null ? {} : { exitCode: result.exitCode }), evidenceRefs: [outputFile],
          ...(result.interrupted ? { message: 'Verifier timed out or was cancelled' } : {}) });
      }
    } catch (error) { checks.push({ name: check.name, status: 'error', evidenceRefs: [], message: sanitize(errorText(error), secrets) as string }); }
    record('verification.check_end', { check: checks.at(-1) });
  }
  const status: Verification['status'] = checks.length > 0 && checks.every((check) => check.status === 'passed') ? 'passed'
    : checks.some((check) => check.status === 'error') ? 'error' : checks.every((check) => check.status === 'not_run') ? 'not_run' : 'failed';
  return { schemaVersion: 1, verificationId: randomUUID(), runId, spec: prepared.task.verificationSpec,
    status, checks, executionUncertain, artifactDigest: snapshot(prepared.workspace).digest, checkedAt: now() };
}
