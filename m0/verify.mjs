import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { Type } from '../../pi/node_modules/typebox/build/index.mjs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '../../pi/packages/ai/src/providers/faux.ts';
import { createAgentSession } from '../../pi/packages/coding-agent/src/core/sdk.ts';
import { ModelRuntime } from '../../pi/packages/coding-agent/src/core/model-runtime.ts';
import { AuthStorage } from '../../pi/packages/coding-agent/src/core/auth-storage.ts';
import { SessionManager } from '../../pi/packages/coding-agent/src/core/session-manager.ts';
import { SettingsManager } from '../../pi/packages/coding-agent/src/core/settings-manager.ts';
import { DefaultResourceLoader } from '../../pi/packages/coding-agent/src/core/resource-loader.ts';

const root = resolve('.artifacts/m0');
mkdirSync(root, { recursive: true });
const output = mkdtempSync(join(root, 'run-'));
const evidence = [];
const results = [];
const sessions = [];
let deny = false;
let policyError = false;
let sideEffects = 0;
const faux = fauxProvider({ tokensPerSecond: 100000 });
const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider);
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: 'off' } });
async function open(manager) {
  const cwd = join(output, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(output, 'agent'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.on('session_start', () => { evidence.push({ source: 'extension', type: 'session_start' }); });
      pi.on('tool_call', (event) => {
        evidence.push({ source: 'extension', type: 'tool_call', tool: event.toolName, deny });
        if (policyError) throw new Error('M0 policy unavailable');
        if (deny) return { block: true, reason: 'M0 deny policy' };
      });
      pi.registerTool({ name: 'echo', label: 'Echo', description: 'Controlled local echo', parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, args) => { sideEffects++; return { content: [{ type: 'text', text: args.text }], details: {} }; } });
      pi.registerTool({ name: 'cooperative', label: 'Cooperative', description: 'Abort-aware delayed effect', parameters: Type.Object({}),
        execute: async (_id, _args, signal) => { await sleep(1000, undefined, { signal }); sideEffects++; return { content: [{ type: 'text', text: 'late' }], details: {} }; } });
      pi.registerTool({ name: 'uncooperative', label: 'Uncooperative', description: 'Ignores abort for boundary test', parameters: Type.Object({}),
        execute: async () => { await sleep(400); sideEffects++; return { content: [{ type: 'text', text: 'late' }], details: {} }; } });
    }] });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  const { session } = await createAgentSession({ cwd, agentDir: join(output, 'agent'), modelRuntime: runtime,
    model: faux.getModel(), thinkingLevel: 'off', settingsManager: settings, sessionManager: manager,
    resourceLoader: loader, tools: ['echo', 'cooperative', 'uncooperative', 'powershell'] });
  sessions.push(session);
  session.subscribe((event) => evidence.push({ source: 'session', sessionId: manager.getSessionId(), at: Date.now(), ...event }));
  await session.bindExtensions({ mode: 'headless' });
  return session;
}
async function check(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); results.push({ name, passed: true, durationMs: Date.now() - started, detail }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.error('FAIL', name, error); }
}
function toolResponse(name, args = {}) { return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' }); }
async function cancelDuring(session, toolName) {
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const unsubscribe = session.subscribe((event) => { if (event.type === 'tool_execution_start' && event.toolName === toolName) startedResolve(); });
  faux.setResponses([toolResponse(toolName), fauxAssistantMessage('must not continue')]);
  const run = session.prompt('run cancellation probe');
  try { await Promise.race([started, sleep(5000).then(() => { throw new Error('Tool did not start'); })]); await sleep(70); await session.abort(); await run; await session.waitForIdle(); }
  finally { unsubscribe(); }
}
try {
  const manager = SessionManager.create(join(output, 'workspace'), join(output, 'sessions'));
  const session = await open(manager);
  await check('session-prompt-events', async () => {
    faux.setResponses([fauxAssistantMessage('M0 hello')]);
    await session.prompt('hello');
    assert.equal(session.getLastAssistantText(), 'M0 hello');
    assert(evidence.some((e) => e.type === 'agent_settled'));
    assert(evidence.some((e) => e.type === 'session_start'));
    return { sessionId: manager.getSessionId() };
  });
  await check('tool-execution', async () => {
    faux.setResponses([toolResponse('echo', { text: 'verified' }), fauxAssistantMessage('echo finished')]);
    await session.prompt('echo');
    assert.equal(sideEffects, 1);
    assert(session.messages.some((m) => m.role === 'toolResult' && m.toolName === 'echo' && !m.isError));
  });
  await check('tool-interception-blocks-effect', async () => {
    deny = true;
    const before = sideEffects;
    try {
      faux.setResponses([toolResponse('echo', { text: 'denied' }), fauxAssistantMessage('blocked')]);
      await session.prompt('blocked echo');
      assert.equal(sideEffects, before);
      assert(session.messages.some((m) => m.role === 'toolResult' && m.isError && JSON.stringify(m).includes('M0 deny policy')));
    } finally { deny = false; }
  });
  await check('builtin-powershell-interception', async () => {
    const marker = join(output, 'workspace', 'blocked-effect.txt');
    deny = true;
    try {
      const command = `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value BAD`;
      faux.setResponses([toolResponse('powershell', { command }), fauxAssistantMessage('blocked builtin')]);
      await session.prompt('blocked builtin');
      assert.equal(existsSync(marker), false);
      assert(session.messages.some((m) => m.role === 'toolResult' && m.toolName === 'powershell' && m.isError));
    } finally { deny = false; }
  });
  await check('policy-error-blocks-effect', async () => {
    const before = sideEffects;
    policyError = true;
    try {
      faux.setResponses([toolResponse('echo', { text: 'fail closed' }), fauxAssistantMessage('policy unavailable')]);
      await session.prompt('policy error');
      assert.equal(sideEffects, before);
      assert(session.messages.some((m) => m.role === 'toolResult' && m.isError && JSON.stringify(m).includes('M0 policy unavailable')));
    } finally { policyError = false; }
  });
  await check('session-disk-reopen-and-continue', async () => {
    const file = manager.getSessionFile();
    assert(file && existsSync(file));
    const count = session.messages.length;
    session.dispose();
    const restoredManager = SessionManager.open(file);
    const restored = await open(restoredManager);
    assert.equal(restoredManager.getSessionId(), manager.getSessionId());
    assert.equal(restored.messages.length, count);
    faux.setResponses([(context) => { assert(JSON.stringify(context).includes('M0 hello')); return fauxAssistantMessage('resumed'); }]);
    await restored.prompt('continue');
    assert.equal(restored.getLastAssistantText(), 'resumed');
    return { file, restoredMessageCount: count };
  });
  const cancelSession = await open(SessionManager.inMemory(join(output, 'workspace')));
  await check('cooperative-tool-cancellation', async () => {
    const before = sideEffects;
    await cancelDuring(cancelSession, 'cooperative');
    await sleep(1100);
    assert.equal(sideEffects, before);
    assert(evidence.some((e) => e.type === 'agent_settled' && e.aborted));
    return { lateEffect: false };
  });
  await check('uncooperative-tool-cancellation-boundary', async () => {
    const before = sideEffects;
    await cancelDuring(cancelSession, 'uncooperative');
    await sleep(500);
    assert.equal(sideEffects, before + 1);
    return { lateEffect: true, conclusion: 'Abort is cooperative; arbitrary tools can still perform effects.' };
  });
  await check('powershell-child-process-cancellation', async () => {
    const workspace = join(output, 'workspace');
    const pidFile = join(workspace, 'child.pid');
    const heartbeat = join(workspace, 'heartbeat.txt');
    const marker = join(workspace, 'late-effect.txt');
    const childScript = join(workspace, 'child.cjs');
    const parentScript = join(workspace, 'parent.cjs');
    writeFileSync(childScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),80);setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'BAD'),1800);`);
    writeFileSync(parentScript, `const {spawn}=require('node:child_process');const c=spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'inherit',windowsHide:true});c.on('exit',()=>process.exit());`);
    const command = `& '${process.execPath.replaceAll("'", "''")}' '${parentScript.replaceAll("'", "''")}'`;
    faux.setResponses([toolResponse('powershell', { command }), fauxAssistantMessage('must not run')]);
    const run = cancelSession.prompt('launch owned local process');
    let pid;
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
      assert(existsSync(pidFile), 'Child failed to launch');
      pid = Number(readFileSync(pidFile, 'utf8'));
      await cancelSession.abort(); await run;
      await sleep(300);
      const snapshot = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : '';
      await sleep(2000);
      assert.equal(existsSync(marker), false, 'Late effect after abort');
      assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : '', snapshot, 'Heartbeat continued');
      assert.throws(() => process.kill(pid, 0), 'Child still alive');
      return { pid, heartbeatStopped: true, lateEffect: false };
    } finally {
      if (pid) { try { process.kill(pid, 0); spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch {} }
      await cancelSession.abort(); await run;
    }
  });
} finally {
  for (const session of sessions) session.dispose();
  writeFileSync(join(output, 'events.jsonl'), evidence.map((e, index) => JSON.stringify({ sequence: index + 1, ...e })).join('\n') + '\n');
  writeFileSync(join(output, 'results.json'), JSON.stringify({ timestamp: new Date().toISOString(), node: process.version, model: 'local faux provider; no network model calls', results }, null, 2));
  writeFileSync(join(root, 'latest.txt'), output);
  console.log('Evidence:', output);
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
