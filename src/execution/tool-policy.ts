/** Metadata augments Pi tools. Side-effect tools never automatically retry. */
export const TOOL_METADATA = {
  read: { requiresPath: true, sideEffects: false, cancellation: 'best_effort', retryable: true, timeoutMs: 15000 },
  write: { requiresPath: true, sideEffects: true, cancellation: 'best_effort', retryable: false, timeoutMs: 15000 },
  edit: { requiresPath: true, sideEffects: true, cancellation: 'best_effort', retryable: false, timeoutMs: 15000 },
  wait: { requiresPath: false, sideEffects: false, cancellation: 'cooperative', retryable: true, timeoutMs: 120000 }
} as const;
export type ManagedToolName = keyof typeof TOOL_METADATA;
export function toolMetadata(name: string): typeof TOOL_METADATA[ManagedToolName] | undefined {
  return Object.hasOwn(TOOL_METADATA, name) ? TOOL_METADATA[name as ManagedToolName] : undefined;
}
export interface RetryPolicy { maxAttempts: number; initialDelayMs: number; maxDelayMs: number; }
export interface ToolRule { permission: 'allow' | 'deny' | 'ask'; timeoutMs: number; retry: RetryPolicy; }
export interface PolicyInput {
  version: string; approvalTimeoutMs?: number; settleGraceMs?: number;
  tools?: Partial<Record<ManagedToolName, { permission?: ToolRule['permission']; timeoutMs?: number; retry?: RetryPolicy }>>;
}
export interface EffectivePolicy { version: string; approvalTimeoutMs: number; settleGraceMs: number; tools: Record<ManagedToolName, ToolRule>; }
export function effectivePolicy(input?: PolicyInput): EffectivePolicy {
  const rules = Object.fromEntries(Object.entries(TOOL_METADATA).map(([name, metadata]) => {
    const override = input?.tools?.[name as ManagedToolName];
    return [name, { permission: 'allow', timeoutMs: metadata.timeoutMs,
      retry: { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 1000 }, ...override }];
  })) as Record<ManagedToolName, ToolRule>;
  return { version: input?.version ?? 'tool-governance.v1', approvalTimeoutMs: input?.approvalTimeoutMs ?? 30000, settleGraceMs: input?.settleGraceMs ?? 1000, tools: rules };
}
