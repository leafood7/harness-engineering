import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { RunStore, sdkIdentity } from '../src/store.ts';
import { workspacePath, sanitize, now, terminal } from '../src/util.ts';
import type { Run, Event } from '../contracts/index.ts';
import type { TaskInput } from '../src/task.ts';

const root = resolve('.artifacts', 'tests'); mkdirSync(root, { recursive: true });
const cli = resolve('bin/harness.mjs');
interface Result { code: number; output: Array<Record<string, unknown>>; stderr: string; }
function command(args: string[]): Result {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 5 * 1024 * 1024 });
    return { code: 0, output: output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>), stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 99, output: (failure.stdout ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>), stderr: failure.stderr ?? '' };
  }
}
function fixture(): { folder: string; workspace: string; state: string; file: string; input: TaskInput } {
  const folder = mkdtempSync(join(root, 'case-'));
  const workspace = join(folder, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'answer.txt'), 'before');
  const input: TaskInput = { schemaVersion: 1, taskId: 'integration', input: 'Set answer.txt to after', workspace,
    tools: ['read', 'write', 'edit', 'wait'], budget: { maxDurationMs: 10000, maxToolCalls: 5, maxTokens: 100000 },
    model: { mode: 'scripted', responses: [
      { calls: [{ name: 'write', arguments: { path: 'answer.txt', content: 'after' } }] }, { text: 'done' }
    ] }, verification: { version: '1', checks: [{ kind: 'file', name: 'answer', path: 'answer.txt', equals: 'after' }] } };
  return { folder, workspace, state: join(folder, 'state'), file: join(folder, 'task.json'), input };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, detach = false): { id: string; result: Result } {
  writeFileSync(f.file, JSON.stringify(f.input));
  const result = command(['run', f.file, '--state', f.state, ...(detach ? ['--detach'] : [])]);
  const created = result.output.find((line) => line.status === 'created');
  assert(created, `No run was created: ${result.stderr} ${JSON.stringify(result.output)}`);
  return { id: String(created.runId), result };
}
function report(f: Fixture, id: string): ReturnType<RunStore['report']> {
  const store = new RunStore(f.state); try { return store.report(id); } finally { store.close(); }
}
async function until(f: Fixture, id: string, predicate: (run: Run, events: Event[]) => boolean): Promise<Run> {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const store = new RunStore(f.state);
    try { const run = store.get(id); if (predicate(run, store.events(id))) return run; } finally { store.close(); }
    await sleep(30);
  }
  throw new Error('Timed out waiting for worker');
}
async function finishCancelled(f: Fixture, id: string): Promise<Run> {
  const result = command(['cancel', id, '--state', f.state]); assert.equal(result.code, 0);
  return until(f, id, (run) => terminal(run.status));
}

test('real Pi package completes a file task with an independent verifier and durable ordered events', () => {
  const f = fixture();
  writeFileSync(join(f.folder, 'verify.cjs'), "const assert=require('node:assert/strict');const fs=require('node:fs');assert.equal(fs.readFileSync('answer.txt','utf8'),'after');");
  f.input.verification.checks.push({ kind: 'node', name: 'independent-node', script: './verify.cjs', timeoutMs: 2000 });
  const { id, result } = run(f); assert.equal(result.code, 0);
  const data = report(f, id);
  assert.equal(data.run.status, 'completed'); assert.equal(data.verification?.status, 'passed');
  assert.equal(data.run.usage.toolCalls, 1); assert.equal(data.verification?.checks.length, 2);
  assert.equal(data.run.pi.version, '1.4.0'); assert(data.run.sessionFile && existsSync(data.run.sessionFile));
  const store = new RunStore(f.state);
  try {
    const events = store.events(id);
    assert.deepEqual(events.map((e) => e.sequence), Array.from({ length: events.length }, (_, i) => i + 1));
    const jsonl = readFileSync(join(data.run.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(jsonl, events);
    assert(events.some((e) => e.kind === 'pi.agent_settled'));
    assert(events.some((e) => e.kind === 'policy.decision' && e.payload.allowed === true));
    assert(events.findIndex((e) => e.kind === 'verification.result') < events.findIndex((e) => e.kind === 'run.status' && e.payload.status === 'completed'));
  } finally { store.close(); }
  const inspected = command(['inspect', id, '--state', f.state, '--events']);
  assert.equal(inspected.code, 0); assert(Array.isArray(inspected.output[0].events));
});

test('model claiming success cannot bypass independent verification', () => {
  const f = fixture(); f.input.model = { mode: 'scripted', responses: [{ text: 'Everything is fixed. All tests passed.' }] };
  const { id, result } = run(f); assert.equal(result.code, 2);
  assert.equal(report(f, id).run.error?.category, 'verification_failed');
  assert.equal(report(f, id).verification?.status, 'failed');
});

test('tool execution failures produce a failed run and cannot become success', () => {
  const f = fixture(); f.input.model = { mode: 'scripted', responses: [{ calls: [{ name: 'read', arguments: { path: 'missing.txt' } }] }, { text: 'done' }] };
  const { id, result } = run(f); assert.equal(result.code, 2); assert.equal(report(f, id).run.error?.category, 'tool_failed');
  assert.equal(report(f, id).verification, undefined);
});

test('unallowed tool requests are rejected without writing', () => {
  const f = fixture(); f.input.tools = ['read'];
  const { id } = run(f); assert.equal(report(f, id).run.error?.category, 'tool_denied');
  assert.equal(readFileSync(join(f.workspace, 'answer.txt'), 'utf8'), 'before');
});

test('path traversal is denied before a write', () => {
  const f = fixture(); f.input.model = { mode: 'scripted', responses: [{ calls: [{ name: 'write', arguments: { path: '../outside.txt', content: 'BAD' } }] }, { text: 'done' }] };
  const { id } = run(f); assert.equal(report(f, id).run.error?.category, 'scope_denied');
  assert.equal(existsSync(join(f.folder, 'outside.txt')), false);
});

test('tool budget blocks the second tool before its effect', () => {
  const f = fixture(); f.input.budget.maxToolCalls = 1;
  f.input.model = { mode: 'scripted', responses: [
    { calls: [{ name: 'read', arguments: { path: 'answer.txt' } }] },
    { calls: [{ name: 'write', arguments: { path: 'answer.txt', content: 'after' } }] }, { text: 'done' }
  ] };
  const { id } = run(f); const data = report(f, id);
  assert.equal(data.run.error?.category, 'tool_budget_exceeded'); assert.equal(data.run.usage.toolCalls, 1);
  assert.equal(readFileSync(join(f.workspace, 'answer.txt'), 'utf8'), 'before');
});

test('token budget is checked before tools from an over-budget response execute', () => {
  const f = fixture(); f.input.budget.maxTokens = 1;
  const { id } = run(f); assert.equal(report(f, id).run.error?.category, 'token_budget_exceeded');
  assert.equal(readFileSync(join(f.workspace, 'answer.txt'), 'utf8'), 'before');
});

test('duration budget aborts a running cooperative tool', () => {
  const f = fixture(); f.input.budget.maxDurationMs = 800;
  f.input.model = { mode: 'scripted', responses: [{ calls: [{ name: 'wait', arguments: { durationMs: 5000 } }] }, { text: 'done' }] };
  const started = Date.now(); const { id } = run(f);
  assert.equal(report(f, id).run.error?.category, 'duration_budget_exceeded'); assert(Date.now() - started < 5000);
});

test('a second CLI process can cancel a detached worker and cancellation persists', async () => {
  const f = fixture(); f.input.model = { mode: 'scripted', responses: [{ calls: [{ name: 'wait', arguments: { durationMs: 8000 } }] },
    { calls: [{ name: 'write', arguments: { path: 'answer.txt', content: 'after' } }] }, { text: 'done' }] };
  const { id } = run(f, true);
  try {
    await until(f, id, (_run, events) => events.some((e) => e.kind === 'tool.authorized'));
    const ended = await finishCancelled(f, id);
    assert.equal(ended.status, 'cancelled'); assert(ended.cancellation?.settledAt);
    assert.equal(readFileSync(join(f.workspace, 'answer.txt'), 'utf8'), 'before');
    assert.equal(report(f, id).verification, undefined);
    const again = command(['cancel', id, '--state', f.state]); assert.equal(again.output[0].accepted, false);
  } finally { if (!terminal(report(f, id).run.status)) await finishCancelled(f, id); }
});

test('cancellation during verification stops its child and prevents completed status', async () => {
  const f = fixture();
  writeFileSync(join(f.folder, 'verify.cjs'), "const fs=require('node:fs');fs.writeFileSync('verifier.pid',String(process.pid));setTimeout(()=>fs.writeFileSync('late.txt','BAD'),5000);");
  f.input.verification.checks = [{ kind: 'node', name: 'long-verifier', script: './verify.cjs', timeoutMs: 8000 }];
  const { id } = run(f, true);
  try {
    await until(f, id, () => existsSync(join(f.workspace, 'verifier.pid')));
    const pid = Number(readFileSync(join(f.workspace, 'verifier.pid'), 'utf8'));
    const ended = await finishCancelled(f, id); assert.equal(ended.status, 'cancelled');
    assert.equal(report(f, id).verification?.status, 'error');
    assert.throws(() => process.kill(pid, 0)); assert.equal(existsSync(join(f.workspace, 'late.txt')), false);
  } finally { if (!terminal(report(f, id).run.status)) await finishCancelled(f, id); }
});

test('verifier timeout becomes a failed run', () => {
  const f = fixture(); writeFileSync(join(f.folder, 'verify.cjs'), 'setInterval(()=>{},1000);');
  f.input.verification.checks = [{ kind: 'node', name: 'timeout', script: './verify.cjs', timeoutMs: 100 }];
  const { id, result } = run(f); assert.equal(result.code, 2);
  assert.equal(report(f, id).verification?.status, 'error'); assert.equal(report(f, id).run.error?.category, 'verification_failed');
});

test('the agent cannot replace the frozen verifier by changing its workspace original', () => {
  const f = fixture(); writeFileSync(join(f.workspace, 'verify.cjs'), "throw new Error('original verifier rejects');");
  f.input.model = { mode: 'scripted', responses: [{ calls: [{ name: 'write', arguments: { path: 'verify.cjs', content: 'process.exit(0);' } }] }, { text: 'done' }] };
  f.input.verification.checks = [{ kind: 'node', name: 'protected-check', script: './workspace/verify.cjs', timeoutMs: 1000 }];
  const { id } = run(f); assert.equal(report(f, id).run.status, 'failed');
  assert.equal(report(f, id).verification?.checks[0].exitCode, 1);
});

test('trace export failure blocks further tool effects while SQLite retains events', async () => {
  const f = fixture(); f.input.model = { mode: 'scripted', responses: [{ calls: [{ name: 'wait', arguments: { durationMs: 5000 } }] },
    { calls: [{ name: 'write', arguments: { path: 'answer.txt', content: 'after' } }] }, { text: 'done' }] };
  const { id } = run(f, true);
  try {
    const running = await until(f, id, (_run, events) => events.some((e) => e.kind === 'tool.authorized'));
    // Replace the export destination with a directory after the first tool starts.
    const path = join(running.runDir, 'events.jsonl'); renameSync(path, `${path}.before-fault`); mkdirSync(path);
    const ended = await until(f, id, (run) => terminal(run.status) && !!run.exportErrors?.length);
    assert.equal(ended.status, 'failed'); assert.equal(ended.error?.category, 'recording_failed'); assert(ended.exportErrors?.length);
    assert.equal(readFileSync(join(f.workspace, 'answer.txt'), 'utf8'), 'before');
    const store = new RunStore(f.state); try { assert(store.events(id).some((e) => e.kind === 'export.failed')); } finally { store.close(); }
  } finally { if (!terminal(report(f, id).run.status)) await finishCancelled(f, id); }
});

test('live mode without its explicit environment key fails without reading global credentials', () => {
  const f = fixture(); f.input.model = { mode: 'live', provider: 'anthropic', id: 'unused', apiKeyEnv: 'HARNESS_TEST_ABSENT_KEY_4972' };
  const { id } = run(f); assert.equal(report(f, id).run.error?.category, 'missing_api_key');
});

test('empty verification and malformed task schemas are rejected before a worker is started', () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.input, verification: { version: '1', checks: [] } }));
  const result = command(['run', f.file, '--state', f.state]); assert.equal(result.code, 2); assert.equal(result.output.length, 0);
  assert.equal(existsSync(join(f.state, 'state.sqlite')), false);
});

test('dead detached workers are reported as interrupted, never completed', async () => {
  const f = fixture(); f.input.model = { mode: 'scripted', responses: [{ calls: [{ name: 'wait', arguments: { durationMs: 8000 } }] }, { text: 'done' }] };
  const { id } = run(f, true);
  const current = await until(f, id, (run) => run.status === 'running');
  process.kill(current.workerPid, 'SIGKILL');
  await sleep(200);
  const inspected = command(['inspect', id, '--state', f.state]); assert.equal(inspected.code, 0);
  assert.equal(report(f, id).run.status, 'interrupted');
});

test('store transactions reject illegal state changes and honour a concurrent cancellation before completion', () => {
  const f = fixture(); const store = new RunStore(f.state);
  const run: Run = { schemaVersion: 1, runId: randomUUID(), taskId: 'transaction', status: 'created', pi: sdkIdentity(), harnessVersion: 'test',
    model: { mode: 'scripted', provider: 'test', id: 'test', parametersDigest: 'x' }, policy: { version: '1', digest: 'x' }, strategy: { version: '1', digest: 'x' },
    budget: f.input.budget, usage: { toolCalls: 0, tokens: null, costUsd: null }, createdAt: now(), workerPid: process.pid, eventSequence: 0, runDir: f.folder };
  try {
    store.create(run); const count = store.events(run.runId).length;
    assert.throws(() => store.transition(run.runId, 'completed'));
    assert.equal(store.events(run.runId).length, count); assert.equal(store.get(run.runId).status, 'created');
    store.transition(run.runId, 'initializing'); store.transition(run.runId, 'running'); store.transition(run.runId, 'verifying');
    store.requestCancel(run.runId); assert.throws(() => store.transition(run.runId, 'completed'));
    assert.equal(store.get(run.runId).status, 'verifying');
  } finally { store.close(); }
});

test('workspace path checks reject junction escape and unresolved symlink targets', () => {
  const f = fixture(); const outside = join(f.folder, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => workspacePath(f.workspace, 'link/escape.txt'));
  symlinkSync(join(f.folder, 'not-created'), join(f.workspace, 'broken'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => workspacePath(f.workspace, 'broken/escape.txt'));
});

test('trace sanitization removes explicit secrets and limits output', () => {
  const clean = sanitize({ authorization: 'Bearer abc', payload: 'prefix MY_PRIVATE_VALUE suffix', nested: { api_key: 'secret' }, long: 'x'.repeat(5000) }, ['MY_PRIVATE_VALUE']) as Record<string, unknown>;
  assert(!JSON.stringify(clean).includes('MY_PRIVATE_VALUE')); assert(!JSON.stringify(clean).includes('Bearer abc'));
  assert(String(clean.long).length < 4200);
});


test('report export errors remain visible in the authoritative run instead of claiming a report exists', async () => {
  const f = fixture();
  writeFileSync(join(f.folder, 'verify.cjs'), "require('node:fs').writeFileSync('verifier-ready.txt','ready');setTimeout(()=>process.exit(0),1000);");
  f.input.verification.checks = [{ kind: 'node', name: 'slow-success', script: './verify.cjs', timeoutMs: 3000 }];
  const { id } = run(f, true);
  try {
    const current = await until(f, id, () => existsSync(join(f.workspace, 'verifier-ready.txt')));
    mkdirSync(join(current.runDir, 'report.json'));
    const ended = await until(f, id, (run) => terminal(run.status) && !!run.exportErrors?.length);
    assert.equal(ended.status, 'completed'); assert.equal(report(f, id).verification?.status, 'passed');
    assert(ended.exportErrors?.some((message) => message.startsWith('report.json:')));
    const inspected = command(['inspect', id, '--state', f.state]);
    const inspectedRun = inspected.output[0].run as Run;
    assert(inspectedRun.exportErrors?.length);
  } finally { if (!terminal(report(f, id).run.status)) await finishCancelled(f, id); }
});
