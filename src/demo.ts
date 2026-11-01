import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskInput } from './task.ts';

export function createDemo(requireApproval = false): string {
  const project = fileURLToPath(new URL('..', import.meta.url));
  const root = join(project, '.artifacts', 'demos');
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, 'run-'));
  mkdirSync(join(folder, 'workspace'));
  const fixture = join(project, 'examples', 'file-edit');
  copyFileSync(join(fixture, 'calc.cjs.initial'), join(folder, 'workspace', 'calc.cjs'));
  copyFileSync(join(fixture, 'verify.cjs'), join(folder, 'verify.cjs'));
  const config = JSON.parse(readFileSync(join(fixture, 'task.json'), 'utf8').replace(/^\uFEFF/, '')) as TaskInput;
  if (requireApproval) { config.policy = { version: 'm2.approval-demo', approvalTimeoutMs: 120000, tools: { write: { permission: 'ask' } } }; config.budget.maxDurationMs = 300000; }
  const file = join(folder, 'task.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
