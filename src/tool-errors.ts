import type { ToolFailure } from '../contracts/index.ts';
import { errorText } from './util.ts';
export class ToolExecutionError extends Error {
  failure: ToolFailure;
  constructor(failure: ToolFailure) { super(failure.message); this.failure = failure; }
}
export function classifyToolError(error: unknown, sideEffects: boolean, timedOut = false, cancelled = false, settled = true): ToolFailure {
  const message = errorText(error);
  const object = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = typeof object.code === 'string' ? object.code : /^(E[A-Z0-9]+)[: ,]/.exec(message)?.[1];
  const outcome = sideEffects ? 'unknown' as const : 'no_effect' as const;
  if (!settled) return { category: 'outcome_unknown', message: 'Tool did not settle after cancellation grace period', retryable: false, outcome: 'unknown' };
  if (cancelled) return { category: 'cancelled', message, code, retryable: false, outcome };
  if (timedOut) return { category: 'timeout', message: 'Tool deadline exceeded', code, retryable: !sideEffects, outcome };
  const categories: Record<string, ToolFailure['category']> = { ENOENT: 'not_found', ENOTDIR: 'not_found', EACCES: 'permission', EPERM: 'permission', EINVAL: 'invalid_input', EISDIR: 'invalid_input' };
  const transient = code !== undefined && ['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH'].includes(code);
  return { category: transient ? 'transient' : categories[code ?? ''] ?? 'unknown', message, code,
    retryable: transient && !sideEffects, outcome };
}
