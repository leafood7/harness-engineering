import { setTimeout as sleep } from 'node:timers/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import type { EffectivePolicy, ManagedToolName } from './tool-policy.ts';
import { toolMetadata } from './tool-policy.ts';
import type { ToolContext } from '../governance/approval.ts';
import { ToolExecutionError, classifyToolError } from './tool-errors.ts';
import { HarnessError } from '../util.ts';

export interface GovernorHooks {
  authorize(context: ToolContext, signal: AbortSignal): Promise<void>;
  record(kind: string, payload: Record<string, unknown>): void;
}
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function attempt<T>(execute: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number, graceMs: number,
  sideEffects: boolean): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let stopResolve: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { stopResolve = resolve; });
  const abort = (): void => { controller.abort(); stopResolve?.(); };
  parent.addEventListener('abort', abort, { once: true });
  const started = Date.now();
  timeout = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  if (parent.aborted) abort();
  const actual: Promise<Settled<T>> = Promise.resolve().then(() => {
    if (parent.aborted) throw new HarnessError('cancelled', 'Cancelled before execution');
    return execute(controller.signal);
  }).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  try {
    let result = await Promise.race([actual, stopped.then(() => undefined)]);
    if (!result) result = await Promise.race([actual, new Promise<undefined>((resolve) => { grace = setTimeout(() => resolve(undefined), graceMs); })]);
    timedOut ||= Date.now() - started >= timeoutMs;
    if (!result) throw new ToolExecutionError(classifyToolError(new Error('Tool still running'), sideEffects, timedOut, parent.aborted, false));
    if (timedOut || parent.aborted) throw new ToolExecutionError(classifyToolError(result.ok ? new Error('Tool completed after deadline') : result.error, sideEffects, timedOut, parent.aborted));
    if (!result.ok) throw new ToolExecutionError(classifyToolError(result.error, sideEffects));
    return result.value;
  } finally {
    if (timeout) clearTimeout(timeout); if (grace) clearTimeout(grace);
    parent.removeEventListener('abort', abort);
  }
}
export class ToolGovernor {
  policy: EffectivePolicy; hooks: GovernorHooks;
  constructor(policy: EffectivePolicy, hooks: GovernorHooks) { this.policy = policy; this.hooks = hooks; }
  async run<T>(toolName: string, toolCallId: string, args: Record<string, unknown>, signal: AbortSignal,
    execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const metadata = toolMetadata(toolName);
    if (!metadata) throw new HarnessError('tool_denied', 'Unknown managed tool');
    const rule = this.policy.tools[toolName as ManagedToolName];
    if (rule.retry.maxAttempts > 1 && !metadata.retryable) throw new HarnessError('invalid_policy', 'Side-effect tools cannot automatically retry');
    for (let number = 1; number <= rule.retry.maxAttempts; number++) {
      if (signal.aborted) throw new HarnessError('cancelled', 'Cancelled before tool attempt');
      const context: ToolContext = { toolName, toolCallId, args, attempt: number };
      await this.hooks.authorize(context, signal);
      if (signal.aborted) throw new HarnessError('cancelled', 'Cancelled after authorization');
      this.hooks.record('tool.attempt_start', { ...context, args: undefined, timeoutMs: rule.timeoutMs });
      const started = Date.now();
      try {
        const result = await attempt(execute, signal, rule.timeoutMs, this.policy.settleGraceMs, metadata.sideEffects);
        this.hooks.record('tool.attempt_end', { toolName, toolCallId, attempt: number, status: 'succeeded', durationMs: Date.now() - started });
        return result;
      } catch (error) {
        if (!(error instanceof ToolExecutionError)) throw error;
        this.hooks.record('tool.attempt_end', { toolName, toolCallId, attempt: number, status: 'failed', durationMs: Date.now() - started, failure: error.failure });
        if (!error.failure.retryable || number >= rule.retry.maxAttempts || signal.aborted) throw error;
        const delayMs = Math.min(rule.retry.maxDelayMs, rule.retry.initialDelayMs * 2 ** (number - 1));
        this.hooks.record('tool.retry_scheduled', { toolName, toolCallId, failedAttempt: number, nextAttempt: number + 1, delayMs, category: error.failure.category });
        try { await sleep(delayMs, undefined, { signal }); }
        catch { throw new HarnessError('cancelled', 'Cancelled during retry backoff'); }
      }
    }
    throw new HarnessError('retry_exhausted', 'Tool attempts exhausted');
  }
}
export function governedTool<TParams extends TSchema, TDetails>(definition: ToolDefinition<TParams, TDetails>, governor: ToolGovernor,
  runSignal: AbortSignal, fault: (error: unknown) => void): ToolDefinition<TParams, TDetails> {
  return { ...definition, executionMode: 'sequential', execute: async (id, params, signal, onUpdate, ctx) => {
    const frozenParams = structuredClone(params);
    const combined = signal ? AbortSignal.any([signal, runSignal]) : runSignal;
    try {
      return await governor.run(definition.name, id, frozenParams as Record<string, unknown>, combined,
        (attemptSignal) => definition.execute(id, frozenParams, attemptSignal, onUpdate, ctx));
    } catch (error) { fault(error); throw error; }
  } };
}
