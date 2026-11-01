/** M1 contracts. Timestamps are ISO 8601 UTC; missing usage is null. */
export interface Budget { maxDurationMs: number; maxToolCalls: number; maxTokens: number; maxCostUsd?: number; }
export interface Task {
  schemaVersion: 1; taskId: string; input: string;
  workspace: { path: string; initialSnapshot: string };
  toolAllowlist: string[]; budget: Budget;
  verificationSpec: { id: string; version: string; digest: string };
  createdAt: string;
}
export type RunStatus = 'created' | 'initializing' | 'running' | 'waiting_approval' | 'cancelling' | 'verifying' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface Run {
  contextDigest?: string;
  schemaVersion: 1; runId: string; taskId: string; status: RunStatus;
  sessionId?: string; sessionFile?: string;
  resumedFromRunId?: string;
  resumedByRunId?: string;
  latestCheckpointId?: string;
  modelCursor?: number;
  modelInFlight?: boolean;
  modelUsageUncertain?: boolean;
  verifierInFlight?: boolean;
  activeMs?: number;
  recovery?: { sourceCheckpointId:string; sourceSessionId?:string; mode:'continue'|'verify_only'; inheritedUsage:Run['usage']; inheritedActiveMs:number };
  pi: { package: string; version: string; integrity: string };
  harnessVersion: string;
  model: { mode: 'scripted' | 'live'; provider: string; id: string; parametersDigest: string };
  policy: { version: string; digest: string };
  strategy: { version: string; digest: string };
  budget: Budget; usage: { toolCalls: number; tokens: number | null; costUsd: number | null };
  createdAt: string; startedAt?: string; endedAt?: string; heartbeatAt?: string;
  workerPid: number; eventSequence: number; runDir: string; task?: Task; exportErrors?: string[]; pendingApprovalId?: string;
  cancellation?: { requestedAt: string; settledAt?: string; effects: 'none_confirmed' | 'present' | 'unknown' };
  error?: { category: string; message: string; retryable: boolean; toolFailure?: ToolFailure };
}
export interface Event {
  schemaVersion: 1; eventId: string; runId: string; sequence: number; occurredAt: string;
  source: 'pi' | 'harness' | 'verifier'; kind: string;
  correlationId?: string; parentEventId?: string;
  payload: Readonly<Record<string, unknown>>; artifactRefs: string[];
}
export interface Verification {
  schemaVersion: 1; verificationId: string; runId: string;
  spec: { id: string; version: string; digest: string };
  status: 'passed' | 'failed' | 'error' | 'not_run';
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'error' | 'not_run'; exitCode?: number; evidenceRefs: string[]; message?: string }>;
  artifactDigest: string; checkedAt: string; executionUncertain?:boolean;
}


/** M2 execution governance records. */
export interface ToolFailure {
  category: 'timeout' | 'transient' | 'not_found' | 'permission' | 'invalid_input' | 'cancelled' | 'unknown' | 'outcome_unknown';
  message: string; code?: string; retryable: boolean;
  outcome: 'no_effect' | 'confirmed' | 'unknown';
}
export interface Approval {
  approvalId: string; runId: string; toolCallId: string; toolName: string; attempt: number;
  requestDigest: string; argumentsDigest: string; policyDigest: string;
  preview: unknown; requestFile: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'invalidated' | 'consumed';
  createdAt: string; expiresAt: string; decidedAt?: string; consumedAt?: string;
  actor?: string; reason?: string;
}



/** M3 durable checkpoints and operation evidence. */
export interface Operation {
  operationId: string; runId: string; toolCallId: string; toolName: string; attempt: number;
  argumentsDigest: string; sideEffects: boolean;
  status: 'authorized' | 'running' | 'succeeded' | 'failed';
  authorizedSequence: number; completedSequence?: number; failure?: ToolFailure;
}
export interface Checkpoint {
  checkpointId: string; runId: string; createdAt: string; eventSequence: number;
  phase: 'ready' | 'turn_end' | 'agent_settled' | 'verifying'; canVerify: boolean;
  workspace: string; workspaceDigest: string;
  files: Array<{path:string;sha256:string;bytes:number}>;
  sessionSnapshot?: string; sessionDigest?: string; sourceSessionId?: string;
  taskSnapshotDigest: string; policyFileDigest: string;
  contextFileDigest?: string;
  modelCursor: number; usage: Run['usage']; activeMs: number;
}
