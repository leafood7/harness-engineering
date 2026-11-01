import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionManager, type AgentSessionEvent, type ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import type { Run, ToolFailure, Operation } from '../../contracts/index.ts';
import { loadTask, prepareTask } from '../task.ts';
import { RunStore, sdkIdentity } from '../state/store.ts';
import { saveCheckpoint } from '../state/checkpoint.ts';
import { resolveRecovery } from '../state/recovery.ts';
import { freezeContext } from '../context/manager.ts';
import { PiAdapter } from '../runtime/pi-adapter.ts';
import { verify } from '../verification/verifier.ts';
import { TOOL_METADATA, toolMetadata, effectivePolicy } from './tool-policy.ts';
import { ApprovalGate, type ToolContext } from '../governance/approval.ts';
import { ToolGovernor } from './tool-governor.ts';
import { ToolExecutionError } from './tool-errors.ts';
import { now, digest, canonical, HarnessError, errorText, sanitize, terminal, workspacePath } from '../util.ts';

export async function executeTask(file: string, stateRoot: string, id: string, ready: (run: Run) => void, restoreFrom?:string): Promise<Run> {
  const preflight = new RunStore(stateRoot);
  let restoration:ReturnType<typeof resolveRecovery>|undefined;
  try{if(restoreFrom)restoration=resolveRecovery(preflight,restoreFrom);}finally{preflight.close();}
  const input = restoration?.input ?? loadTask(file);
  const policy = effectivePolicy(input.policy);
  const secrets = input.model.mode === 'live' && process.env[input.model.apiKeyEnv] ? [process.env[input.model.apiKeyEnv]!] : [];
  const store = new RunStore(stateRoot, secrets);
  const runDir = join(store.root, 'runs', id);
  mkdirSync(runDir, { recursive: false });
  const model = input.model.mode === 'scripted' ? { mode: 'scripted' as const, provider: 'harness-scripted', id: 'scripted-1' }
    : { mode: 'live' as const, provider: input.model.provider, id: input.model.id };
  const run: Run = { schemaVersion: 1, runId: id, taskId: input.taskId, status: 'created',
    pi: sdkIdentity(), harnessVersion: '0.4.0', model: { ...model, parametersDigest: digest(JSON.stringify(input.model)) },
    policy: { version: policy.version, digest: digest(canonical({ tools: input.tools, catalog: TOOL_METADATA, policy, budget: input.budget, scope: input.workspace })) },
    strategy: { version: 'execution.v2', digest: digest('single-session;bounded-safe-tool-retry;durable-checkpoints;conservative-resume;independent-verification') }, budget: input.budget,
    usage: restoration?structuredClone(restoration.source.usage):{ toolCalls: 0, tokens: null, costUsd: null }, createdAt: now(), workerPid: process.pid, eventSequence: 0, runDir,
    activeMs:restoration?.source.activeMs??0,modelCursor:restoration?.checkpoint.modelCursor??0,modelInFlight:false,modelUsageUncertain:false,verifierInFlight:false,
    ...(restoration?{resumedFromRunId:restoration.source.runId,recovery:{sourceCheckpointId:restoration.checkpoint.checkpointId,sourceSessionId:restoration.checkpoint.sourceSessionId,
      mode:restoration.mode,inheritedUsage:structuredClone(restoration.source.usage),inheritedActiveMs:restoration.source.activeMs??0}}:{}) };
  store.create(run,restoration?.source);
  ready(store.get(id));
  const adapter = new PiAdapter();
  const controller = new AbortController();
  const localStarted=Date.now();
  const inheritedActiveMs=restoration?.source.activeMs??0;
  const activeMs=(reserve=false):number=>Math.min(input.budget.maxDurationMs,inheritedActiveMs+Date.now()-localStarted+(reserve?250:0));
  const deadline = localStarted + input.budget.maxDurationMs-inheritedActiveMs;
  let reason: { category: string; message: string } | undefined;
  let settled = false;
  let finalToolFailure: ToolFailure | undefined;
  let possibleEffects = false;
  let confirmedEffects = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let prepared: ReturnType<typeof prepareTask> | undefined;
  function emit(kind: string, payload: Record<string, unknown>, source: 'harness' | 'pi' | 'verifier' = 'harness'): void {
    store.mutate(id, () => {}, kind, payload, source);
  }
  function stop(category: string, message: string): void {
    if (reason || terminal(store.get(id).status)) return;
    reason = { category, message: sanitize(message, secrets) as string };
    controller.abort();
    try {
      const requestedAt = store.cancelAt(id) ?? now();
      store.transition(id, 'cancelling', { cancellation: { requestedAt, effects: confirmedEffects ? 'present' : possibleEffects ? 'unknown' : 'none_confirmed' } });
      emit('run.stop_requested', reason);
    } catch { /* Finish attempts a durable failure below. */ }
    void adapter.abort().catch(() => {});
  }
  function control(): void {
    if (store.cancelAt(id)) stop('cancelled', 'Cancellation requested by user');
    else if (Date.now() >= deadline) stop('duration_budget_exceeded', 'Task duration budget exhausted');
  }
  function fault(error: unknown): void {
    if (error instanceof ToolExecutionError) {
      finalToolFailure = sanitize(error.failure, secrets) as ToolFailure;
      const category = error.failure.category === 'timeout' ? 'tool_timeout' : error.failure.category === 'outcome_unknown' ? 'tool_outcome_unknown' : 'tool_failed';
      stop(category, error.message);
    } else stop(error instanceof HarnessError ? error.code : 'execution_error', errorText(error));
  }
  function guard(event: ToolCallEvent): { block: true; reason: string } | undefined {
    control();
    let problem = reason;
    if (!problem && !input.tools.includes(event.toolName as typeof input.tools[number])) problem = { category: 'tool_denied', message: `Tool is not allowed: ${event.toolName}` };
    if (!problem && policy.tools[event.toolName as keyof typeof policy.tools]?.permission === 'deny') problem = { category: 'tool_denied', message: 'Tool is denied by policy' };
    const current = store.get(id);
    if (!problem && current.usage.toolCalls >= input.budget.maxToolCalls) problem = { category: 'tool_budget_exceeded', message: 'Tool call budget exhausted' };
    if (!problem && toolMetadata(event.toolName)?.requiresPath) {
      try {
        if (!('path' in event.input) || typeof event.input.path !== 'string' || !prepared) throw new HarnessError('scope_denied', 'Tool requires a workspace path');
        workspacePath(prepared.workspace, event.input.path);
      } catch (error) { problem = { category: 'scope_denied', message: errorText(error) }; }
    }
    const decision = problem ? 'deny' : policy.tools[event.toolName as keyof typeof policy.tools]?.permission ?? 'deny';
    emit('policy.decision', { tool: event.toolName, toolCallId: event.toolCallId, decision, allowed: !problem && decision === 'allow', reason: problem?.category });
    if (problem) { stop(problem.category, problem.message); return { block: true, reason: problem.message }; }
    return undefined;
  }
  async function authorize(context: ToolContext, signal: AbortSignal): Promise<void> {
    control();
    if (controller.signal.aborted || signal.aborted) throw new HarnessError('cancelled', 'Run is stopping');
    if (!prepared) throw new Error('Task is not prepared');
    const metadata = toolMetadata(context.toolName);
    const rule = policy.tools[context.toolName as keyof typeof policy.tools];
    if (!metadata || !input.tools.includes(context.toolName as typeof input.tools[number]) || rule.permission === 'deny') throw new HarnessError('tool_denied', 'Tool is denied');
    if (store.get(id).policy.digest !== run.policy.digest) throw new HarnessError('policy_changed', 'Run policy changed');
    if (store.get(id).usage.toolCalls >= input.budget.maxToolCalls) throw new HarnessError('tool_budget_exceeded', 'Tool attempt budget exhausted');
    if (metadata.requiresPath) {
      if (typeof context.args.path !== 'string') throw new HarnessError('scope_denied', 'Tool requires a path');
      workspacePath(prepared.workspace, context.args.path);
    }
    const gate = new ApprovalGate(store, id, prepared.workspace, policy);
    const receipt = rule.permission === 'ask' ? await gate.acquire(context, signal) : undefined;
    control();
    if (controller.signal.aborted || signal.aborted) throw new HarnessError('cancelled', 'Run is stopping');
    // Recheck path and binding immediately before the transaction that consumes approval.
    if (metadata.requiresPath) workspacePath(prepared.workspace, String(context.args.path));
    if (receipt && digest(canonical(gate.binding(context))) !== receipt.requestDigest) throw new HarnessError('approval_stale', 'Approved parameters or target changed');
    store.mutate(id, (current) => {
      if (store.cancelAt(id) || signal.aborted) throw new HarnessError('cancelled', 'Cancelled before tool execution');
      if (Date.now() >= deadline) throw new HarnessError('duration_budget_exceeded', 'Run deadline reached');
      if (current.policy.digest !== run.policy.digest) throw new HarnessError('policy_changed', 'Policy changed before tool execution');
      if (current.usage.toolCalls >= input.budget.maxToolCalls) throw new HarnessError('tool_budget_exceeded', 'Tool attempt budget exhausted');
      if (receipt) store.consumeApproval(receipt.approvalId, current, receipt.requestDigest);
      if (current.status !== 'running') throw new HarnessError('invalid_transition', 'Run is not executing');
      current.usage.toolCalls++;current.activeMs=activeMs(true);
      const operation:Operation={operationId:randomUUID(),runId:id,toolCallId:context.toolCallId,toolName:context.toolName,attempt:context.attempt,
        argumentsDigest:digest(canonical(context.args)),sideEffects:metadata.sideEffects,status:'authorized',authorizedSequence:current.eventSequence+1};
      store.saveOperation(operation);
    }, 'tool.authorized', { tool: context.toolName, toolCallId: context.toolCallId, attempt: context.attempt, approvalId: receipt?.approvalId });
    try { store.flushTrace(id); } catch (error) { throw new HarnessError('recording_failed', errorText(error)); }
    if (metadata.sideEffects) possibleEffects = true;
  }
  function recordAttempt(kind:string,payload:Record<string,unknown>):void {
    store.mutate(id,(current)=>{
      const operation=store.operations(id).filter((entry)=>entry.toolCallId===payload.toolCallId&&entry.attempt===payload.attempt).at(-1);
      if(operation&&(kind==='tool.attempt_start'||kind==='tool.attempt_end')){
        operation.status=kind==='tool.attempt_start'?'running':payload.status==='succeeded'?'succeeded':'failed';
        if(kind==='tool.attempt_end'){operation.completedSequence=current.eventSequence+1;operation.failure=payload.failure?sanitize(payload.failure,secrets) as ToolFailure:undefined;}
        store.saveOperation(operation);
      }
      current.activeMs=activeMs(true);
    },kind,payload);
  }
  const governor = new ToolGovernor(policy, { authorize, record: recordAttempt });
  function event(event: AgentSessionEvent): void {
    if (event.type === 'message_update') return; // Completed messages are authoritative; avoid token-by-token duplication.
    emit(`pi.${event.type}`, event as unknown as Record<string, unknown>, 'pi');
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message;
      const usage = message.usage;
      store.mutate(id, (run) => {
        run.modelInFlight=false;run.modelCursor=(run.modelCursor??0)+1;run.activeMs=activeMs(true);
        if(message.stopReason==='aborted'||message.stopReason==='error')run.modelUsageUncertain=true;
        if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) run.usage.tokens = (run.usage.tokens ?? 0) + usage.totalTokens;
        if (typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total)) run.usage.costUsd = (run.usage.costUsd ?? 0) + usage.cost.total;
      }, 'usage.updated', { usage });
      const current = store.get(id);
      if ((current.usage.tokens ?? 0) >= input.budget.maxTokens) stop('token_budget_exceeded', 'Token budget reached at response boundary');
      if (input.budget.maxCostUsd !== undefined && (current.usage.costUsd ?? 0) > input.budget.maxCostUsd) stop('cost_budget_exceeded', 'Cost budget exceeded at response boundary');
      if (message.stopReason === 'error') stop('model_error', message.errorMessage ?? 'Model request failed');
      if (message.stopReason === 'aborted' && !reason) stop('model_aborted', 'Model aborted without a host cancellation');
      for (const block of message.content) {
        if (block.type === 'toolCall' && !input.tools.includes(block.name as typeof input.tools[number])) stop('tool_denied', `Tool is not allowed: ${block.name}`);
      }
    }
    if (event.type === 'tool_execution_end') {
      if (event.isError && !reason) stop('tool_failed', 'A tool returned an error; inspect its recorded result');
      if (!event.isError && toolMetadata(event.toolName)?.sideEffects) confirmedEffects = true;
    }
    if(event.type==='turn_end'&&!reason&&prepared){
      const messages=adapter.session?.sessionManager.buildSessionContext().messages??[];
      const assistant=messages.filter((message)=>message.role==='assistant').at(-1);
      const canVerify=assistant?.role==='assistant'&&assistant.stopReason==='stop'&&!assistant.content.some((block)=>block.type==='toolCall');
      saveCheckpoint(store,id,prepared.workspace,'turn_end',adapter.session,canVerify);
    }
    if (event.type === 'agent_settled') {
      settled = true;
      if(!reason&&!event.aborted&&prepared)saveCheckpoint(store,id,prepared.workspace,'agent_settled',adapter.session,true);
    }
  }
  const signalStop = (): void => { try { store.requestCancel(id); control(); } catch (error) { fault(error); } };
  process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop);
  try {
    store.transition(id, 'initializing');
    writeFileSync(join(runDir, 'policy.json'), JSON.stringify({ ...run.policy, configuration: { tools: input.tools, catalog: TOOL_METADATA, policy, budget: input.budget, scope: input.workspace } }, null, 2));
    prepared = prepareTask(input, resolve(file), runDir, store.root,restoration?{workspace:restoration.workspace,verifierScripts:restoration.verifierScripts}:undefined);
    if(restoration&&prepared.task.workspace.initialSnapshot!==restoration.checkpoint.workspaceDigest)throw new HarnessError('workspace_changed','Workspace changed during recovery startup');
    const context = freezeContext(input,prepared.workspace,store.root,runDir,restoration?.context);
    store.mutate(id,current=>{current.contextDigest=context.digest;},'context.frozen',{digest:context.digest,memoryRefs:context.memories.map(row=>({id:row.id,revision:row.revision,digest:row.digest})),inherited:!!restoration?.context});
    store.mutate(id, (run) => { run.task = prepared!.task; }, 'task.prepared', { task: prepared.task, effectivePolicy: policy });
    store.mutate(id,(current)=>{current.activeMs=activeMs(true);},'budget.reserved',{inheritedActiveMs});
    const bootstrap=restoration?.checkpoint.sessionSnapshot?SessionManager.open(restoration.checkpoint.sessionSnapshot):undefined;
    saveCheckpoint(store,id,prepared.workspace,'ready',bootstrap?{sessionManager:bootstrap,sessionId:bootstrap.getSessionId()}:undefined,restoration?.mode==='verify_only');
    interval = setInterval(() => {
      try {
        control();
        store.db.prepare("UPDATE runs SET body=json_set(body,'$.heartbeatAt',?,'$.activeMs',?) WHERE id=?").run(now(),activeMs(true),id);
        store.flushTrace(id);
      } catch (error) { fault(new HarnessError('recording_failed', errorText(error))); }
    }, 100);
    control();
    if (!reason) {
      await adapter.initialize(prepared, runDir, { event, beforeTool: guard, fault, record:emit }, governor, controller.signal,restoration?{modelCursor:restoration.checkpoint.modelCursor,sessionSnapshot:restoration.checkpoint.sessionSnapshot}:undefined);
      store.mutate(id, (run) => {
        run.sessionId = adapter.session!.sessionId;
        run.sessionFile = adapter.session!.sessionManager.getSessionFile();
      }, 'session.bound', { sessionId: adapter.session!.sessionId });
      control();
      if (!reason) {
        store.transition(id, 'running', { startedAt: now() });
        saveCheckpoint(store,id,prepared.workspace,'ready',adapter.session,restoration?.mode==='verify_only');
        if(restoration?.mode==='verify_only')settled=true;
        else await adapter.prompt(restoration&&restoration.checkpoint.sessionSnapshot
          ? `Continue the original task from the restored checkpoint. Completed tool results are already in the session; do not repeat completed modifications. Original task: ${input.input}`:input.input);
        control();
        if (!settled && !reason) throw new HarnessError('not_settled', 'Pi did not emit agent_settled');
      }
    }
    if (!reason) {
      store.transition(id, 'verifying');
      saveCheckpoint(store,id,prepared.workspace,'verifying',adapter.session,true);
      store.mutate(id,(current)=>{current.verifierInFlight=true;current.activeMs=activeMs(true);},'verification.started',{});
      if (input.verification.checks.some((check) => check.kind === 'node')) possibleEffects = true;
      const verification = await verify(prepared, id, runDir, deadline, controller.signal, (kind, data) => emit(kind, data, 'verifier'), secrets);
      store.mutate(id, (current) => {current.verifierInFlight=verification.executionUncertain===true;current.activeMs=activeMs(true);}, 'verification.result', { verification }, 'verifier', verification);
      control();
      store.flushTrace(id);
      if (!reason && verification.status !== 'passed') stop('verification_failed', `Independent verification ${verification.status}`);
      if (!reason) store.transition(id, 'completed',{activeMs:activeMs()});
    }
  } catch (error) { fault(error); }
  finally {
    if (interval) clearInterval(interval);
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
    await adapter.abort().catch(() => {});
    adapter.dispose();
    if (reason && !terminal(store.get(id).status)) {
      const current = store.get(id);
      const cancellation = { requestedAt: current.cancellation?.requestedAt ?? now(), settledAt: now(), effects: confirmedEffects ? 'present' as const : possibleEffects ? 'unknown' as const : 'none_confirmed' as const };
      store.transition(id, reason.category === 'cancelled' ? 'cancelled' : 'failed', {
        activeMs:activeMs(), cancellation, error: { category: reason.category, message: reason.message, retryable: false, ...(finalToolFailure ? { toolFailure: finalToolFailure } : {}) }
      });
    }
    const exportFailure = (kind: string, error: unknown): void => {
      const message = sanitize(`${kind}: ${errorText(error)}`, secrets) as string;
      store.mutate(id, (run) => { run.exportErrors = [...(run.exportErrors ?? []), message]; },
        'export.failed', { artifact: kind, error: message, authoritativeStore: 'SQLite' });
    };
    try { store.flushTrace(id); } catch (error) { exportFailure('events.jsonl', error); }
    try { store.saveReport(id); } catch (error) { exportFailure('report.json', error); }
    if (store.get(id).exportErrors?.length) {
      try { store.flushTrace(id); } catch { /* Failure already recorded in SQLite. */ }
    }
  }
  const result = store.get(id);
  store.close();
  return result;
}
