import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Approval } from '../../contracts/index.ts';
import type { EffectivePolicy } from '../execution/tool-policy.ts';
import { toolMetadata } from '../execution/tool-policy.ts';
import { RunStore } from '../state/store.ts';
import { workspacePath, canonical, digest, now, sanitize, HarnessError } from '../util.ts';

export interface ToolContext { toolCallId: string; toolName: string; args: Record<string, unknown>; attempt: number; }
export interface ApprovalReceipt { approvalId: string; requestDigest: string; }
export class ApprovalGate {
  store: RunStore; runId: string; workspace: string; policy: EffectivePolicy;
  constructor(store: RunStore, runId: string, workspace: string, policy: EffectivePolicy) {
    this.store = store; this.runId = runId; this.workspace = workspace; this.policy = policy;
  }
  binding(context: ToolContext): Record<string, unknown> {
    let target: unknown = null;
    if (toolMetadata(context.toolName)?.requiresPath) {
      if (typeof context.args.path !== 'string') throw new HarnessError('scope_denied', 'Tool path is required');
      const path = workspacePath(this.workspace, context.args.path);
      if (existsSync(path)) {
        if (!statSync(path).isFile() || statSync(path).size > 32 * 1024 * 1024) throw new HarnessError('approval_target_invalid', 'Review requires a regular file of at most 32 MiB');
        target = { path: realpathSync(path), sha256: digest(readFileSync(path)) };
      } else target = { path, missing: true };
    }
    return { runId: this.runId, toolCallId: context.toolCallId, toolName: context.toolName, attempt: context.attempt,
      args: context.args, policyDigest: this.store.get(this.runId).policy.digest, workspace: this.workspace, target };
  }
  async acquire(context: ToolContext, signal: AbortSignal): Promise<ApprovalReceipt> {
    const expectedPolicy = this.store.get(this.runId).policy.digest;
    for (let refresh = 0; refresh < 5; refresh++) {
      if (signal.aborted || this.store.cancelAt(this.runId)) throw new HarnessError('cancelled', 'Cancelled while awaiting approval');
      const binding = this.binding(context);
      if (binding.policyDigest !== expectedPolicy) throw new HarnessError('policy_changed', 'Policy changed during execution');
      const approvalId = randomUUID();
      const folder = join(this.store.get(this.runId).runDir, 'approvals'); mkdirSync(folder, { recursive: true });
      const requestFile = join(folder, `${approvalId}.json`);
      writeFileSync(requestFile, JSON.stringify(binding, null, 2));
      const request: Approval = { approvalId, runId: this.runId, toolCallId: context.toolCallId, toolName: context.toolName,
        attempt: context.attempt, requestDigest: digest(canonical(binding)), argumentsDigest: digest(canonical(context.args)), policyDigest: expectedPolicy,
        preview: sanitize(binding, this.store.secrets), requestFile, status: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + this.policy.approvalTimeoutMs).toISOString() };
      this.store.requestApproval(request); this.store.flushTrace(this.runId);
      for (;;) {
        if (signal.aborted || this.store.cancelAt(this.runId)) {
          const current = this.store.approval(approvalId);
          if (current.status === 'pending' || current.status === 'approved') this.store.settleApproval(approvalId, 'cancelled', 'Run cancelled');
          throw new HarnessError('cancelled', 'Cancelled while awaiting approval');
        }
        const current = this.store.approval(approvalId);
        if (this.store.get(this.runId).policy.digest !== expectedPolicy) {
          if (current.status === 'pending' || current.status === 'approved') this.store.settleApproval(approvalId, 'invalidated', 'Policy changed');
          throw new HarnessError('policy_changed', 'Policy changed during approval');
        }
        if (Date.now() >= Date.parse(current.expiresAt)) {
          if (current.status === 'pending' || current.status === 'approved') this.store.settleApproval(approvalId, 'expired', 'Approval deadline exceeded');
          throw new HarnessError('approval_expired', 'Approval deadline exceeded');
        }
        if (current.status === 'rejected') throw new HarnessError('approval_rejected', 'Reviewer rejected this operation');
        if (current.status === 'approved') {
          const fresh = this.binding(context);
          if (fresh.policyDigest !== expectedPolicy) {
            this.store.settleApproval(approvalId, 'invalidated', 'Policy changed'); throw new HarnessError('policy_changed', 'Policy changed during approval');
          }
          if (digest(canonical(fresh)) !== current.requestDigest) {
            this.store.settleApproval(approvalId, 'invalidated', 'Arguments or target changed; a new review is required'); break;
          }
          if (digest(canonical(JSON.parse(readFileSync(current.requestFile, 'utf8')))) !== current.requestDigest) {
            this.store.settleApproval(approvalId, 'invalidated', 'Request artifact changed'); throw new HarnessError('approval_tampered', 'Approval request artifact changed');
          }
          return { approvalId, requestDigest: current.requestDigest };
        }
        if (current.status !== 'pending') throw new HarnessError('approval_stale', 'Approval is no longer usable');
        await sleep(30, undefined, { signal });
      }
    }
    throw new HarnessError('approval_churn', 'Too many changes while awaiting approval');
  }
}
